"""mayocream/lama-manga — Big-LaMa инпейнтинг.

Предобработка повторяет эталонную обёртку LaMa (TorchScript-модуль, из которого
получены веса, и IOPaint):
  image ∈ [0,1], mask ∈ {0,1};  pad до кратного 8 (symmetric);
  x = cat(image * (1 - mask), mask);  pred = generator(x);
  result = mask * pred + (1 - mask) * image
Маска: test_data/masks/<имя>.png (если есть), иначе маска text+onomatopoeia
из эталонного прогона koharu-layout (её путь передаёт оркестратор).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from safetensors.torch import load_file

from . import SkipImage  # noqa: F401  (экспорт для воркера)
from .lama_arch import FFCResNetGenerator

PACKAGES = ["torch", "torchvision", "torch-directml", "safetensors", "numpy", "pillow"]


class Adapter:
    def __init__(self, backend, job):
        self.be = backend
        self.job = job
        self.dev = backend.device
        self.masks: dict[str, str] = job.get("masks", {})

    def load(self, model_dir: Path) -> None:
        cfg = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
        self.cfg = cfg
        self.pad = int(cfg.get("pad_multiple", 8))
        net = FFCResNetGenerator(cfg["input_channels"], cfg["output_channels"], cfg["base_features"],
                                 cfg["downsampling_stages"], cfg["residual_blocks"], cfg["max_features"])
        sd = load_file(str(model_dir / "lama-manga.safetensors"))
        net.load_state_dict(sd, strict=True)  # любое расхождение архитектуры → исключение
        self.n_tensors = len(sd)
        self.net = net.eval().to(self.dev)

    def model_info(self) -> dict:
        return {"architecture": "FFCResNetGenerator (advimman/lama)", "tensors_loaded": self.n_tensors,
                "strict_load": True, "config": self.cfg, "dtype": "float32"}

    def read_image(self, path: Path):
        im = Image.open(path)
        im.load()
        return im

    def prepare(self, im: Image.Image, img_meta: dict):
        mpath = self.masks.get(img_meta["name"])
        if not mpath or not Path(mpath).exists():
            raise SkipImage("нет маски (ни пользовательской, ни из koharu-layout)")
        mode = im.mode
        rgb = np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0
        m = Image.open(mpath).convert("L")
        if m.size != im.size:
            raise SkipImage(f"размер маски {m.size} не совпадает с изображением {im.size}")
        mask = (np.asarray(m) > 127).astype(np.float32)
        h, w = mask.shape
        ph, pw = (-h) % self.pad, (-w) % self.pad
        rgb_p = np.pad(rgb, ((0, ph), (0, pw), (0, 0)), mode="symmetric")
        mask_p = np.pad(mask, ((0, ph), (0, pw)), mode="symmetric")
        img_t = torch.from_numpy(rgb_p).permute(2, 0, 1)[None].contiguous()
        mask_t = torch.from_numpy(mask_p)[None, None].contiguous()
        meta = {"orig_size_wh": [w, h], "orig_mode": mode, "padded_size_wh": [w + pw, h + ph],
                "mask_source": mpath, "mask_coverage_pct": float(mask.mean() * 100)}
        return (img_t, mask_t, (h, w)), meta

    def infer(self, inp):
        img_t, mask_t, (h, w) = inp
        with self.be.no_grad():
            img = img_t.to(self.dev)
            mask = mask_t.to(self.dev)
            x = torch.cat([img * (1 - mask), mask], dim=1)
            pred = self.net(x)
            res = mask * pred + (1 - mask) * img
            return res[0, :, :h, :w].cpu()

    def save(self, out, out_dir: Path, rec: dict) -> list[str]:
        arr = (out.clamp(0, 1).permute(1, 2, 0).numpy() * 255.0 + 0.5).astype(np.uint8)
        p = out_dir / "inpainted.png"
        Image.fromarray(arr).save(p)
        mp = out_dir / "mask_used.png"
        Image.open(rec["input"]["mask_source"]).save(mp)
        return [p.name, mp.name]
