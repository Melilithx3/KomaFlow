"""komaflow-sidecar CLI.

  komaflow-sidecar analyze --pages <dir> --out <dir> [--backend auto|rocm|cpu] [--stages layout,ocr]
                           [--overlay] [--padding N] [--threshold T]
  komaflow-sidecar serve --token <token> [--port 0]
  komaflow-sidecar capabilities
  komaflow-sidecar install [--backends rocm,cpu] [--models layout,ocr]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}

COLORS = {"bubble": (37, 99, 235), "sfx": (220, 38, 38), "onomatopoeia": (217, 119, 6), "text": (22, 163, 74)}


def draw_overlay(image_path: Path, objects: list[dict], dest: Path) -> None:
    """Picture with numbered boxes for checking by eye (spike S2)."""
    from PIL import Image, ImageDraw

    im = Image.open(image_path).convert("RGB")
    dr = ImageDraw.Draw(im)
    for i, o in enumerate(objects, 1):
        b = o["box"]
        c = COLORS.get(o["type"], (200, 0, 200))
        dr.rectangle([b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]], outline=c, width=4)
        dr.rectangle([b["x"], b["y"], b["x"] + 34, b["y"] + 22], fill=c)
        dr.text((b["x"] + 4, b["y"] + 4), f"{i} {o['score']:.2f}", fill=(255, 255, 255))
    im.save(dest)


def cmd_analyze(a: argparse.Namespace) -> int:
    from .pipeline import Control, analyze_batch

    pages_dir = Path(a.pages)
    files = sorted(p for p in pages_dir.iterdir() if p.suffix.lower() in IMAGE_EXT)
    if not files:
        print(f"no images in {pages_dir}", file=sys.stderr)
        return 1
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    opts = {"backend": a.backend, "stages": a.stages.split(","), "ocr_padding_px": a.padding, "layout_threshold": a.threshold}
    ctl = Control(on_progress=lambda p: print(f"[{p.stage}] {p.done}/{p.total}", file=sys.stderr))
    t0 = time.perf_counter()
    res = analyze_batch([{"page_id": f.stem, "image_path": str(f)} for f in files], opts, ctl)
    res["total_seconds"] = round(time.perf_counter() - t0, 2)
    (out / "analysis.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    if a.overlay:
        for f, pg in zip(files, res["pages"]):
            draw_overlay(f, pg["objects"], out / f"{f.stem}.overlay.png")
    for w in res["warnings"]:
        print(f"warning: {w}", file=sys.stderr)
    print(f"{len(files)} page(s), backend {res['backend']}, {res['total_seconds']} s -> {out / 'analysis.json'}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="komaflow-sidecar")
    sub = p.add_subparsers(dest="cmd", required=True)
    an = sub.add_parser("analyze")
    an.add_argument("--pages", required=True)
    an.add_argument("--out", required=True)
    an.add_argument("--backend", default="auto", choices=["auto", "rocm", "cpu"])
    an.add_argument("--stages", default="layout,ocr")
    an.add_argument("--overlay", action="store_true")
    an.add_argument("--padding", type=int, default=8)
    an.add_argument("--threshold", type=float, default=None)
    sv = sub.add_parser("serve")
    sv.add_argument("--token", required=True)
    sv.add_argument("--port", type=int, default=0)
    sub.add_parser("capabilities")
    dr = sub.add_parser("doctor", help="check the engine and every installed model; saves a report")
    dr.add_argument("--backend", default="auto", choices=["auto", "rocm", "cpu"])
    dr.add_argument("--load-timeout", type=float, default=900.0, help="seconds to wait for one model to load")
    ins = sub.add_parser("install")
    ins.add_argument("--backends", default="rocm,cpu")
    ins.add_argument("--models", default="layout,ocr,lama")
    ins.add_argument("--models-only", action="store_true", help="only download models into the existing environment")
    a = p.parse_args(argv)

    if a.cmd == "analyze":
        return cmd_analyze(a)
    if a.cmd == "serve":
        from .server import serve

        serve(a.token, a.port)
        return 0
    if a.cmd == "doctor":
        from .doctor import run

        return run(a.backend, a.load_timeout)
    if a.cmd == "capabilities":
        from .backend import capabilities

        print(json.dumps(capabilities(), ensure_ascii=False, indent=2))
        return 0
    if a.cmd == "install":
        from .install import install

        install([b for b in a.backends.split(",") if b], [m for m in a.models.split(",") if m], models_only=a.models_only)
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
