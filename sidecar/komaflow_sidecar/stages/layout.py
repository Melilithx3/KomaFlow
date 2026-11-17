"""Layout stage: page -> boxes with classes and scores.

Real: mayocream/koharu-layout-highres (RF-DETR Seg 2XL) loaded exactly like the benchmark adapter
(reference/bench/bench/worker/adapters/koharu_layout.py): rfdetr model built from config.json,
safetensors loaded strict, manual resize/normalize/forward/postprocess, chunked SDPA on ROCm.
Job: {"backend", "model_dir", "threshold": float|null, "class_thresholds": {class: float}, "items": [{"id", "image_path"}]}
Result per item: {"id", "width", "height", "detections": [{"class", "score", "xyxy"}]}
"""
from __future__ import annotations

import contextlib
import json
from pathlib import Path

from ..catalog import LAYOUT_ATTN_QUERY_CHUNK


def class_limit(job: dict, name: str, recommended: float) -> float:
    """Score threshold for a class: per-class setting, else the global one, else the model's recommendation."""
    per = (job.get("class_thresholds") or {}).get(name)
    if per is not None:
        return float(per)
    if job.get("threshold") is not None:
        return float(job["threshold"])
    return float(recommended)

from . import StageBase, fake_sleep


class Real(StageBase):
    def __init__(self, job: dict):
        self.job = job

    def load(self) -> dict:
        import torch
        from rfdetr import RFDETRSeg2XLarge
        from safetensors.torch import load_file

        from . import TorchDevice

        self.dev = TorchDevice(self.job["backend"])
        model_dir = Path(self.job["model_dir"])
        cfg = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
        assert cfg["architecture"] == "RFDETRSeg2XLarge", cfg["architecture"]
        self.classes = {int(k): v for k, v in cfg["classes"].items()}
        self.class_thr = cfg["recommended_thresholds"]
        self.min_thr = min(self.class_thr.values())
        res = int(cfg["resolution"])
        rf = RFDETRSeg2XLarge(
            pretrain_weights=None,
            num_classes=len(self.classes),
            resolution=res,
            positional_encoding_size=res // 12,
            num_select=int(cfg["num_select"]),
            device="cpu",
        )
        net = rf.model.model
        net.load_state_dict(load_file(str(model_dir / cfg["checkpoint"])), strict=True)
        self.net = net.eval().to(self.dev.device)
        self.post = rf.model.postprocess
        self.means, self.stds = list(rf.means), list(rf.stds)
        self.res = res
        self.torch = torch
        return {**self.dev.info(), "model": "koharu-layout-highres", "resolution": res, "thresholds": self.class_thr}

    def run(self, item: dict) -> dict:
        import torchvision.transforms.functional as F
        from PIL import Image

        from .._attn import query_chunked_sdpa

        im = Image.open(item["image_path"])
        im.load()
        t = F.to_tensor(im.convert("RGB"))
        h, w = t.shape[1:]
        with self.dev.inference():
            x = F.normalize(F.resize(t.to(self.dev.device), [self.res, self.res]), self.means, self.stds)[None]
            with contextlib.ExitStack() as stack:
                if self.dev.kind == "rocm":
                    stack.enter_context(query_chunked_sdpa(LAYOUT_ATTN_QUERY_CHUNK))
                pred = self.net(x)
            if isinstance(pred, tuple):
                pred = {"pred_logits": pred[1], "pred_boxes": pred[0]}
            pred = {k: (v.float() if self.torch.is_tensor(v) else v) for k, v in pred.items()}
            r = self.post(pred, target_sizes=self.torch.tensor([[h, w]], device=self.dev.device))[0]
        dets = []
        for score, label, box in zip(r["scores"].cpu().tolist(), r["labels"].cpu().tolist(), r["boxes"].cpu().tolist()):
            name = self.classes.get(int(label), str(label))
            limit = class_limit(self.job, name, self.class_thr.get(name, 1.0))
            if score >= limit:
                dets.append({"class": name, "score": round(float(score), 4), "xyxy": [float(v) for v in box]})
        return {"id": item["id"], "width": int(w), "height": int(h), "detections": dets}

    def park(self) -> None:
        self.dev.park(self.net)

    def unpark(self) -> None:
        self.dev.unpark(self.net)

    def peak_vram_mb(self):
        return self.dev.peak_vram_mb()


class Fake(StageBase):
    """Deterministic stand-in for tests and machines without models (KOMAFLOW_SIDECAR_FAKE=1)."""

    def __init__(self, job: dict):
        self.job = job

    def load(self) -> dict:
        import sys

        sys.stdin.isatty()  # real model libraries do this while importing; must not hang (ADR 0016)
        return {"model": "fake-layout", "backend": self.job.get("backend")}

    def run(self, item: dict) -> dict:
        from PIL import Image

        fake_sleep(self)
        with Image.open(item["image_path"]) as im:
            w, h = im.size
        dets = [
            {"class": "bubble", "score": 0.91, "xyxy": [w * 0.6, h * 0.05, w * 0.9, h * 0.3]},
            {"class": "text", "score": 0.88, "xyxy": [w * 0.1, h * 0.7, w * 0.4, h * 0.8]},
            {"class": "panel", "score": 0.99, "xyxy": [0, 0, w, h / 2]},
        ]
        dets = [d for d in dets if d["score"] >= class_limit(self.job, d["class"], 0.0)]
        return {"id": item["id"], "width": w, "height": h, "detections": dets}

    def peak_vram_mb(self):
        return None
