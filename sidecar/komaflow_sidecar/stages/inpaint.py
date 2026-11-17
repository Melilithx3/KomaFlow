"""Inpaint stage (auto-clean): mayocream/lama-manga (Big-LaMa) erases text under a mask.

Pre/post-processing as in the benchmark adapter (reference/bench/bench/worker/adapters/lama_manga.py):
image in [0,1], mask in {0,1}, symmetric pad to a multiple of 8, x = cat(image*(1-mask), mask),
result = mask*pred + (1-mask)*image. To keep it fast and light on VRAM only the area around the
mask (+ context margin) is processed and pasted back.
Job: {"backend", "model_dir", "items": [{"id", "image_path", "mask_path", "out_path"}]}
Result per item: {"id", "out_path", "masked_px"}
"""
from __future__ import annotations

import json
from pathlib import Path

CONTEXT_PX = 96  # surroundings the model sees around the mask


def mask_crop(mask_bbox: tuple[int, int, int, int] | None, w: int, h: int, pad_multiple: int = 8) -> tuple[int, int, int, int] | None:
    """Crop rectangle around the mask with context, clipped to the image, size rounded to `pad_multiple` when possible."""
    if mask_bbox is None:
        return None
    x0, y0, x1, y1 = mask_bbox
    x0 = max(0, x0 - CONTEXT_PX)
    y0 = max(0, y0 - CONTEXT_PX)
    x1 = min(w, x1 + CONTEXT_PX)
    y1 = min(h, y1 + CONTEXT_PX)
    return x0, y0, x1, y1

from . import StageBase, fake_sleep


class Real(StageBase):
    def __init__(self, job: dict):
        self.job = job

    def load(self) -> dict:
        from safetensors.torch import load_file

        from ..lama_arch import FFCResNetGenerator
        from . import TorchDevice

        self.dev = TorchDevice(self.job["backend"])
        model_dir = Path(self.job["model_dir"])
        cfg = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
        self.pad = int(cfg.get("pad_multiple", 8))
        net = FFCResNetGenerator(cfg["input_channels"], cfg["output_channels"], cfg["base_features"],
                                 cfg["downsampling_stages"], cfg["residual_blocks"], cfg["max_features"])
        net.load_state_dict(load_file(str(model_dir / "lama-manga.safetensors")), strict=True)
        self.net = net.eval().to(self.dev.device)
        return {**self.dev.info(), "model": "lama-manga", "dtype": "float32"}

    def run(self, item: dict) -> dict:
        import numpy as np
        import torch
        from PIL import Image

        im = Image.open(item["image_path"]).convert("RGB")
        m = Image.open(item["mask_path"]).convert("L")
        if m.size != im.size:
            raise ValueError(f"mask {m.size} != image {im.size}")
        crop = mask_crop(m.point(lambda v: 255 if v > 127 else 0).getbbox(), *im.size, pad_multiple=self.pad)
        if crop is None:
            im.save(item["out_path"])
            return {"id": item["id"], "out_path": item["out_path"], "masked_px": 0}
        sub = np.asarray(im.crop(crop), dtype=np.float32) / 255.0
        mask = (np.asarray(m.crop(crop)) > 127).astype(np.float32)
        h, w = mask.shape
        ph, pw = (-h) % self.pad, (-w) % self.pad
        rgb_p = np.pad(sub, ((0, ph), (0, pw), (0, 0)), mode="symmetric")
        mask_p = np.pad(mask, ((0, ph), (0, pw)), mode="symmetric")
        with self.dev.inference():
            img = torch.from_numpy(rgb_p).permute(2, 0, 1)[None].contiguous().to(self.dev.device)
            mk = torch.from_numpy(mask_p)[None, None].contiguous().to(self.dev.device)
            pred = self.net(torch.cat([img * (1 - mk), mk], dim=1))
            res = (mk * pred + (1 - mk) * img)[0, :, :h, :w].clamp(0, 1).permute(1, 2, 0).cpu().numpy()
        patch = Image.fromarray((res * 255.0 + 0.5).astype(np.uint8))
        im.paste(patch, crop[:2])
        im.save(item["out_path"])
        return {"id": item["id"], "out_path": item["out_path"], "masked_px": int(mask.sum())}

    def park(self) -> None:
        self.dev.park(self.net)

    def unpark(self) -> None:
        self.dev.unpark(self.net)

    def peak_vram_mb(self):
        return self.dev.peak_vram_mb()


class Fake(StageBase):
    """Test stand-in: paints masked pixels white."""

    def __init__(self, job: dict):
        self.job = job

    def load(self) -> dict:
        return {"model": "fake-lama", "backend": self.job.get("backend")}

    def run(self, item: dict) -> dict:
        from PIL import Image

        fake_sleep(self)
        im = Image.open(item["image_path"]).convert("RGB")
        m = Image.open(item["mask_path"]).convert("L").point(lambda v: 255 if v > 127 else 0)
        white = Image.new("RGB", im.size, (255, 255, 255))
        im.paste(white, (0, 0), m)
        im.save(item["out_path"])
        return {"id": item["id"], "out_path": item["out_path"], "masked_px": sum(1 for v in m.getdata() if v)}

    def peak_vram_mb(self):
        return None
