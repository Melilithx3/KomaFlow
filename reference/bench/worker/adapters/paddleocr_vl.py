"""PaddlePaddle/PaddleOCR-VL-1.6 — VLM-распознавание страницы целиком (задача Spotting).

Два независимых пути загрузки ОРИГИНАЛЬНЫХ весов (model.safetensors из HF-снапшота):
  * torch:  transformers >= 5 (родной класс), либо transformers 4.57 + custom code репозитория
            (params.remote_code=True) — для DirectML, где torch застрял на 2.4.1;
  * paddle: PaddleX, модуль doc_vlm (только VLM, без PP-DocLayout).

Предобработка повторяет model card: для Spotting страница < 1500 px по обеим сторонам
апскейлится ×2 (LANCZOS), max_pixels = 2048·28·28. Декодирование жадное (детерминированное).
"""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

from . import SkipImage  # noqa: F401

PACKAGES = ["torch", "transformers", "torch-directml", "safetensors", "tokenizers", "pillow",
            "paddlepaddle", "paddleocr", "paddlex", "numpy"]

PROMPTS = {"ocr": "OCR:", "table": "Table Recognition:", "formula": "Formula Recognition:",
           "chart": "Chart Recognition:", "spotting": "Spotting:", "seal": "Seal Recognition:"}
SPOTTING_UPSCALE_THRESHOLD = 1500


class Adapter:
    def __init__(self, backend, job):
        self.be = backend
        self.p = job["params"]
        self.task = self.p.get("task", "spotting")
        self.max_new_tokens = int(self.p.get("max_new_tokens", 2048))
        # None = как в generation_config.json модели (там use_cache=false); True = KV-кэш при генерации
        self.use_cache = self.p.get("use_cache")
        self.max_pixels = 2048 * 28 * 28 if self.task == "spotting" else 1280 * 28 * 28

    # ------------------------------------------------------------------ load
    def load(self, model_dir: Path) -> None:
        self.model_dir = model_dir
        if self.be.framework == "paddle":
            self._load_paddle(model_dir)
        else:
            self._load_torch(model_dir)

    def _load_torch(self, model_dir: Path) -> None:
        import torch
        import transformers

        self.torch = torch
        self.dtype = self.be.dtype(self.p.get("dtype", "bfloat16"))
        remote = bool(self.p.get("remote_code"))
        self.remote = remote
        if remote:
            from transformers import AutoModelForCausalLM, AutoProcessor

            self.processor = AutoProcessor.from_pretrained(str(model_dir), trust_remote_code=True)
            model = AutoModelForCausalLM.from_pretrained(str(model_dir), trust_remote_code=True, dtype=self.dtype)
        else:
            from transformers import AutoModelForImageTextToText, AutoProcessor

            self.processor = AutoProcessor.from_pretrained(str(model_dir))
            model = AutoModelForImageTextToText.from_pretrained(str(model_dir), dtype=self.dtype)
        self.model = model.to(self.be.device).eval()
        self.info = {"loader": "transformers " + transformers.__version__ + (" + trust_remote_code" if remote else " (native)"),
                     "class": type(model).__name__, "dtype": str(self.dtype).replace("torch.", ""),
                     "attn_implementation": getattr(model.config, "_attn_implementation", None),
                     "params_m": sum(p.numel() for p in model.parameters()) / 1e6}

    def _load_paddle(self, model_dir: Path) -> None:
        import paddlex
        from paddlex.inference import create_predictor

        # engine="paddle" явно: иначе PaddleX может выбрать transformers-бэкенд, а нам нужен именно Paddle
        self.pdx_model = create_predictor(model_name="PaddleOCR-VL-1.6-0.9B", model_dir=str(model_dir),
                                          device="cpu", engine="paddle")
        self.info = {"loader": f"paddlex {paddlex.__version__} create_predictor(doc_vlm, engine=paddle)",
                     "predictor_class": type(self.pdx_model).__name__,
                     "model_name": "PaddleOCR-VL-1.6-0.9B", "model_dir": str(model_dir)}

    def model_info(self) -> dict:
        return {**self.info, "task": self.task, "prompt": PROMPTS[self.task], "max_new_tokens": self.max_new_tokens,
                "max_pixels": self.max_pixels, "decoding": "greedy",
                "use_cache": "из generation_config (false)" if self.use_cache is None else self.use_cache}

    # ------------------------------------------------------------------ inputs
    def read_image(self, path: Path):
        im = Image.open(path)
        im.load()
        return im

    def prepare(self, im: Image.Image, img_meta: dict):
        orig_mode = im.mode
        image = im.convert("RGB")
        w, h = image.size
        meta = {"orig_size_wh": [w, h], "orig_mode": orig_mode, "upscaled_x2": False}
        if self.task == "spotting" and w < SPOTTING_UPSCALE_THRESHOLD and h < SPOTTING_UPSCALE_THRESHOLD:
            image = image.resize((w * 2, h * 2), Image.Resampling.LANCZOS)
            meta["upscaled_x2"] = True
        meta["model_input_wh"] = list(image.size)
        if self.be.framework == "paddle":
            return {"image": image}, meta
        messages = [{"role": "user", "content": [{"type": "image", "image": image},
                                                 {"type": "text", "text": PROMPTS[self.task]}]}]
        ip = self.processor.image_processor
        if self.remote:
            ip.max_pixels = self.max_pixels
            inputs = self.processor.apply_chat_template(messages, add_generation_prompt=True, tokenize=True,
                                                        return_dict=True, return_tensors="pt")
        else:
            # transformers 5: min/max pixels лежат в size.shortest_edge / size.longest_edge
            min_px = getattr(ip, "min_pixels", None) or ip.size.shortest_edge
            inputs = self.processor.apply_chat_template(
                messages, add_generation_prompt=True, tokenize=True, return_dict=True, return_tensors="pt",
                images_kwargs={"size": {"shortest_edge": min_px, "longest_edge": self.max_pixels}})
        if "image_grid_thw" in inputs:
            meta["image_grid_thw"] = inputs["image_grid_thw"].tolist()
        meta["prompt_tokens"] = int(inputs["input_ids"].shape[-1])
        return inputs, meta

    # ------------------------------------------------------------------ inference
    def infer(self, inputs):
        if self.be.framework == "paddle":
            return self._infer_paddle(inputs)
        torch = self.torch
        with self.be.no_grad():
            batch = {}
            for k, v in inputs.items():
                if hasattr(v, "to"):
                    v = v.to(self.be.device)
                    if v.is_floating_point():
                        v = v.to(self.dtype)
                batch[k] = v
            gen_kw = {} if self.use_cache is None else {"use_cache": bool(self.use_cache)}
            out = self.model.generate(**batch, max_new_tokens=self.max_new_tokens, do_sample=False, **gen_kw)
            new = out[0][batch["input_ids"].shape[-1]:].cpu()
        ids = new.tolist()
        eos = getattr(self.model.generation_config, "eos_token_id", None)
        eos_ids = set(eos if isinstance(eos, list) else [eos]) if eos is not None else set()
        hit_eos = bool(ids) and ids[-1] in eos_ids
        text = self.processor.decode(new[:-1] if hit_eos else new)
        return {"text": text, "new_tokens": len(ids), "stopped_by_eos": hit_eos,
                "truncated": (not hit_eos) and len(ids) >= self.max_new_tokens}

    def _infer_paddle(self, inputs):
        import numpy as np

        query = PROMPTS[self.task]
        res = list(self.pdx_model.predict({"image": np.asarray(inputs["image"]), "query": query},
                                          max_new_tokens=self.max_new_tokens, max_pixels=self.max_pixels,
                                          **({} if self.use_cache is None else {"use_cache": bool(self.use_cache)})))
        r = res[0]
        d = dict(r) if hasattr(r, "keys") else {"result": r}
        text = d.get("result") if isinstance(d.get("result"), str) else json.dumps(d, ensure_ascii=False, default=str)
        return {"text": text, "new_tokens": None, "stopped_by_eos": None, "truncated": None,
                "raw": {k: v for k, v in d.items() if k not in ("image", "input_img")}}

    def save(self, out, out_dir: Path, rec: dict) -> list[str]:
        (out_dir / "output.txt").write_text(out["text"], encoding="utf-8")  # сырой вывод модели без изменений
        files = ["output.txt", "output_meta.json"]
        if self.task == "spotting":
            files += self._save_spotting(out["text"], out_dir, rec)
        meta = {k: v for k, v in out.items() if k != "text"}
        times = rec.get("times_s") or []
        if out.get("new_tokens") and times:
            meta["tokens_per_s_median_run"] = out["new_tokens"] / sorted(times)[len(times) // 2]
        meta.update(source_image=rec["source"], input=rec.get("input"), task=self.task, prompt=PROMPTS[self.task])
        (out_dir / "output_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2, default=str),
                                                  encoding="utf-8")
        rec["preview"] = out["text"][:600]
        rec["generation"] = {k: meta.get(k) for k in ("new_tokens", "stopped_by_eos", "truncated", "tokens_per_s_median_run")}
        return files

    @staticmethod
    def _save_spotting(text: str, out_dir: Path, rec: dict) -> list[str]:
        """Разбор вывода Spotting: строка текста + 4 точки <|LOC_n|> (x,y), координаты 0..1000
        относительно страницы. Только для визуальной проверки; сырой текст — в output.txt."""
        import re

        from PIL import ImageDraw

        loc = re.compile(r"<\|LOC_(\d+)\|>")
        items = []
        for line in text.splitlines():
            nums = [int(n) for n in loc.findall(line)]
            label = loc.sub("", line).strip()
            if len(nums) >= 8 and label:
                items.append({"text": label, "quad_0_1000": [nums[i:i + 2] for i in range(0, 8, 2)]})
        src = Image.open(rec["source"]).convert("RGB")
        w, h = src.size
        dr = ImageDraw.Draw(src)
        for k, it in enumerate(items):
            pts = [(x * w / 1000, y * h / 1000) for x, y in it["quad_0_1000"]]
            it["quad_px"] = [[round(x, 1), round(y, 1)] for x, y in pts]
            dr.polygon(pts, outline=(220, 30, 30), width=2)
            dr.text((pts[0][0] + 2, pts[0][1] - 11), str(k + 1), fill=(220, 30, 30))
        src.save(out_dir / "overlay.png")
        (out_dir / "spotting_parsed.json").write_text(
            json.dumps({"source_image": rec["source"], "image_size_wh": [w, h], "lines": items},
                       ensure_ascii=False, indent=2), encoding="utf-8")
        rec["spotting_lines"] = len(items)
        return ["overlay.png", "spotting_parsed.json"]
