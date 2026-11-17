"""OCR stage: crop images -> text with PaddleOCR-VL-1.6 ("OCR:" prompt, model card).

Loading follows the benchmark adapter (reference/bench/bench/worker/adapters/paddleocr_vl.py,
transformers >= 5 native class). Mandatory workaround: `use_cache=True` at generation
(generation_config.json ships use_cache=false; without the KV cache a page never finishes).
Job: {"backend", "model_dir", "dtype", "items": [{"id", "image_path"}]}
Result per item: {"id", "text", "new_tokens", "truncated"}
"""
from __future__ import annotations

from pathlib import Path

from ..catalog import OCR_MAX_NEW_TOKENS, OCR_PROMPT, OCR_USE_CACHE
from ..geometry import clean_ocr_text

# Small crops are upscaled so short bubbles have enough pixels (model min_pixels guard).
MIN_SIDE = 64
MAX_PIXELS = 1280 * 28 * 28

from . import StageBase, fake_sleep


class Real(StageBase):
    def __init__(self, job: dict):
        self.job = job

    def load(self) -> dict:
        import transformers
        from transformers import AutoModelForImageTextToText, AutoProcessor

        from . import TorchDevice

        self.dev = TorchDevice(self.job["backend"])
        torch = self.dev.torch
        dtype = getattr(torch, self.job.get("dtype") or ("float16" if self.dev.kind == "rocm" else "float32"))
        self.dtype = dtype
        model_dir = str(Path(self.job["model_dir"]))
        self.processor = AutoProcessor.from_pretrained(model_dir)
        self.model = AutoModelForImageTextToText.from_pretrained(model_dir, dtype=dtype).to(self.dev.device).eval()
        return {**self.dev.info(), "model": "PaddleOCR-VL-1.6", "transformers": transformers.__version__,
                "dtype": str(dtype).replace("torch.", ""), "use_cache": OCR_USE_CACHE}

    def run(self, item: dict) -> dict:
        from PIL import Image

        image = Image.open(item["image_path"]).convert("RGB")
        w, h = image.size
        if min(w, h) < MIN_SIDE:
            k = MIN_SIDE / min(w, h)
            image = image.resize((max(1, round(w * k)), max(1, round(h * k))), Image.Resampling.LANCZOS)
        messages = [{"role": "user", "content": [{"type": "image", "image": image}, {"type": "text", "text": OCR_PROMPT}]}]
        ip = self.processor.image_processor
        min_px = getattr(ip, "min_pixels", None) or ip.size.shortest_edge
        inputs = self.processor.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=True, return_dict=True, return_tensors="pt",
            images_kwargs={"size": {"shortest_edge": min_px, "longest_edge": MAX_PIXELS}},
        )
        with self.dev.inference():
            batch = {}
            for k, v in inputs.items():
                if hasattr(v, "to"):
                    v = v.to(self.dev.device)
                    if v.is_floating_point():
                        v = v.to(self.dtype)
                batch[k] = v
            out = self.model.generate(**batch, max_new_tokens=OCR_MAX_NEW_TOKENS, do_sample=False, use_cache=OCR_USE_CACHE)
            new = out[0][batch["input_ids"].shape[-1]:].cpu()
        ids = new.tolist()
        eos = getattr(self.model.generation_config, "eos_token_id", None)
        eos_ids = set(eos if isinstance(eos, list) else [eos]) if eos is not None else set()
        hit = bool(ids) and ids[-1] in eos_ids
        text = self.processor.decode(new[:-1] if hit else new)
        return {"id": item["id"], "text": clean_ocr_text(text), "new_tokens": len(ids),
                "truncated": (not hit) and len(ids) >= OCR_MAX_NEW_TOKENS}

    def park(self) -> None:
        self.dev.park(self.model)

    def unpark(self) -> None:
        self.dev.unpark(self.model)

    def peak_vram_mb(self):
        return self.dev.peak_vram_mb()


class Fake(StageBase):
    def __init__(self, job: dict):
        self.job = job

    def load(self) -> dict:
        return {"model": "fake-ocr", "backend": self.job.get("backend")}

    def run(self, item: dict) -> dict:
        from PIL import Image

        fake_sleep(self)
        with Image.open(item["image_path"]) as im:
            w, h = im.size
        return {"id": item["id"], "text": f"テキスト {w}x{h}", "new_tokens": 3, "truncated": False}

    def peak_vram_mb(self):
        return None
