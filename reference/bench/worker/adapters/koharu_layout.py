"""mayocream/koharu-layout-highres — RF-DETR Seg 2XL (rfdetr), разметка страницы манги.

Загрузка: rfdetr.RFDETRSeg2XLarge(pretrain_weights=None, параметры из config.json репозитория)
+ load_state_dict(model.safetensors, strict=True) — файл весов используется как есть.
Инференс повторяет RFDETR.predict (resize до resolution×resolution → normalize → forward →
postprocess), но без привязки к устройствам cuda/cpu, чтобы работал и DirectML.

Выход (для каждого изображения):
  detections.json   — все детекции со score ≥ min(рекомендованных порогов), флаг прохождения порога класса
  instance_masks.npz — бинарные маски этих детекций (packbits, исходное разрешение)
  class_<имя>.png   — объединённая маска класса (детекции, прошедшие порог класса)
  overlay.png       — визуализация (маски + рамки)
  lama_mask.png     — text+onomatopoeia, расширенная на 4 px — вход для lama-manga
"""
from __future__ import annotations

import contextlib
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFilter
from safetensors.torch import load_file

from . import SkipImage  # noqa: F401
from ._attn import query_chunked_sdpa

PACKAGES = ["rfdetr", "torch", "torchvision", "torch-directml", "transformers", "safetensors", "supervision",
            "numpy", "pillow"]

COLORS = {"text": (230, 50, 50), "onomatopoeia": (240, 160, 0), "bubble": (40, 120, 230), "panel": (40, 170, 80)}
LAMA_CLASSES = ("text", "onomatopoeia")
LAMA_DILATE_PX = 4


class Adapter:
    def __init__(self, backend, job):
        self.be = backend
        self.p = job["params"]
        self.autocast = self.p.get("autocast")
        self.attn_chunk = self.p.get("attn_query_chunk")

    def load(self, model_dir: Path) -> None:
        from rfdetr import RFDETRSeg2XLarge

        cfg = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
        self.cfg = cfg
        assert cfg["architecture"] == "RFDETRSeg2XLarge", cfg["architecture"]
        self.classes = {int(k): v for k, v in cfg["classes"].items()}
        self.thr = cfg["recommended_thresholds"]
        self.min_thr = min(self.thr.values())
        res = int(cfg["resolution"])
        rf = RFDETRSeg2XLarge(pretrain_weights=None, num_classes=len(self.classes), resolution=res,
                              positional_encoding_size=res // 12, num_select=int(cfg["num_select"]), device="cpu")
        net = rf.model.model
        sd = load_file(str(model_dir / cfg["checkpoint"]))
        net.load_state_dict(sd, strict=True)  # расхождение архитектуры (другая версия rfdetr) → ошибка
        self.net = net.eval().to(self.be.device)
        self.post = rf.model.postprocess
        self.means, self.stds = list(rf.means), list(rf.stds)
        self.res = res
        from importlib.metadata import version

        self.info = {"rfdetr": version("rfdetr"),
                     "trained_with_rfdetr": cfg.get("rfdetr_version"), "resolution": res,
                     "num_select": cfg["num_select"], "tensors_loaded": len(sd), "strict_load": True,
                     "thresholds": self.thr, "autocast": self.autocast, "weights_dtype": "float32",
                     "attn_query_chunk": self.attn_chunk}

    def model_info(self) -> dict:
        return self.info

    def read_image(self, path: Path):
        im = Image.open(path)
        im.load()
        return im

    def prepare(self, im: Image.Image, img_meta: dict):
        import torchvision.transforms.functional as F

        rgb = im.convert("RGB")
        t = F.to_tensor(rgb)  # [0,1], CHW
        h, w = t.shape[1:]
        return (t, (h, w)), {"orig_size_wh": [w, h], "orig_mode": im.mode, "model_input_wh": [self.res, self.res]}

    def infer(self, inp):
        import torchvision.transforms.functional as F

        t, (h, w) = inp
        dev = self.be.device
        with self.be.no_grad():
            x = t.to(dev)
            x = F.resize(x, [self.res, self.res])
            x = F.normalize(x, self.means, self.stds)[None]
            with contextlib.ExitStack() as stack:
                if self.attn_chunk:
                    stack.enter_context(query_chunked_sdpa(int(self.attn_chunk)))
                if self.autocast:
                    stack.enter_context(torch.autocast(device_type="cuda", dtype=getattr(torch, self.autocast)))
                pred = self.net(x)
            if isinstance(pred, tuple):
                d = {"pred_logits": pred[1], "pred_boxes": pred[0]}
                if len(pred) == 3:
                    d["pred_masks"] = pred[2]
                pred = d
            pred = {k: (v.float() if torch.is_tensor(v) else v) for k, v in pred.items()}
            r = self.post(pred, target_sizes=torch.tensor([[h, w]], device=dev))[0]
            keep = r["scores"] > self.min_thr
            out = {"scores": r["scores"][keep].float().cpu(), "labels": r["labels"][keep].cpu(),
                   "boxes": r["boxes"][keep].float().cpu()}
            if "masks" in r:
                out["masks"] = r["masks"][keep].squeeze(1).bool().cpu()
        return out

    def save(self, out, out_dir: Path, rec: dict) -> list[str]:
        src = Image.open(rec["source"]).convert("RGB")
        w, h = src.size
        scores, labels, boxes = out["scores"].numpy(), out["labels"].numpy(), out["boxes"].numpy()
        masks = out["masks"].numpy() if "masks" in out else None
        dets = []
        for i in range(len(scores)):
            cname = self.classes.get(int(labels[i]), str(int(labels[i])))
            dets.append({"index": i, "class_id": int(labels[i]), "class": cname, "score": float(scores[i]),
                         "box_xyxy": [float(v) for v in boxes[i]],
                         "passes_class_threshold": bool(scores[i] >= self.thr.get(cname, 1.0)),
                         "mask_area_px": int(masks[i].sum()) if masks is not None else None})
        meta = {"source_image": rec["source"], "image_size_wh": [w, h], "thresholds": self.thr,
                "stored_min_score": self.min_thr, "detections": dets}
        files = ["detections.json"]
        (out_dir / "detections.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        if masks is not None:
            np.savez_compressed(out_dir / "instance_masks.npz", packed=np.packbits(masks, axis=-1),
                                shape=np.array(masks.shape))
            files.append("instance_masks.npz")
        overlay = src.copy()
        color_layer = Image.new("RGB", (w, h))
        alpha = Image.new("L", (w, h), 0)
        lama = np.zeros((h, w), dtype=bool)
        per_class: dict[str, np.ndarray] = {}
        for d in dets:
            if not d["passes_class_threshold"]:
                continue
            if masks is not None:
                m = masks[d["index"]]
                per_class.setdefault(d["class"], np.zeros((h, w), dtype=bool))
                per_class[d["class"]] |= m
                if d["class"] in LAMA_CLASSES:
                    lama |= m
                mi = Image.fromarray((m * 255).astype(np.uint8))
                color_layer.paste(COLORS.get(d["class"], (200, 0, 200)), mask=mi)
                alpha.paste(110, mask=mi)
        overlay = Image.composite(color_layer, overlay, alpha)
        dr = ImageDraw.Draw(overlay)
        for d in dets:
            if d["passes_class_threshold"]:
                c = COLORS.get(d["class"], (200, 0, 200))
                dr.rectangle(d["box_xyxy"], outline=c, width=3)
                dr.text((d["box_xyxy"][0] + 3, d["box_xyxy"][1] + 2), f"{d['class']} {d['score']:.2f}", fill=c)
        overlay.save(out_dir / "overlay.png")
        files.append("overlay.png")
        for cname, m in per_class.items():
            Image.fromarray((m * 255).astype(np.uint8)).save(out_dir / f"class_{cname}.png")
            files.append(f"class_{cname}.png")
        lm = Image.fromarray((lama * 255).astype(np.uint8))
        if LAMA_DILATE_PX:
            lm = lm.filter(ImageFilter.MaxFilter(2 * LAMA_DILATE_PX + 1))
        lm.save(out_dir / "lama_mask.png")
        files.append("lama_mask.png")
        counts: dict[str, int] = {}
        for d in dets:
            if d["passes_class_threshold"]:
                counts[d["class"]] = counts.get(d["class"], 0) + 1
        rec["detections_count"] = counts
        return files
