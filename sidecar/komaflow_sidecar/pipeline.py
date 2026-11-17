"""Analysis pipeline (docs/05 §12): layout for all pages, then crops, then OCR for all crops.
Models run in warm worker processes (ADR 0016); the control process never imports torch."""
from __future__ import annotations

import subprocess
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import backend as be
from . import paths
from .catalog import DEFAULTS
from .geometry import crop_object, map_class, xyxy_to_box


class Cancelled(Exception):
    pass


@dataclass
class Progress:
    stage: str = "queued"
    done: int = 0
    total: int = 0


@dataclass
class Control:
    """Cancellation and progress shared between the job and its runner."""

    cancel: threading.Event = field(default_factory=threading.Event)
    on_progress: Callable[[Progress], None] = lambda p: None
    proc: subprocess.Popen | None = None

    def check(self) -> None:
        if self.cancel.is_set():
            raise Cancelled()


def run_stage(stage: str, backend: str, job: dict, ctl: Control, workdir: Path) -> dict:
    """Runs one stage in its warm worker (ADR 0016); the model stays loaded for the next job."""
    from .pool import pool

    del workdir  # crops live in the caller's temp dir; the worker needs no files of its own
    return pool().run(stage, backend, job, ctl)


def analyze_batch(pages: list[dict], options: dict, ctl: Control | None = None) -> dict:
    """pages: [{page_id, image_path}] -> {pages: [{page_id, objects:[{type,box,score,source_text}], ...}], backend, timings}"""
    from PIL import Image

    ctl = ctl or Control()
    caps = be.capabilities()
    rocm_info = next(b for b in caps["backends"] if b["id"] == "rocm")
    cpu_ok = next(b for b in caps["backends"] if b["id"] == "cpu")["available"]
    backend = be.choose(options.get("backend", "auto"), rocm_info, cpu_ok)
    padding = int(options.get("ocr_padding_px", DEFAULTS["ocr_padding_px"]))
    class_map = options.get("class_map")
    stages = options.get("stages") or ["layout", "ocr"]
    # OCR on CPU is impractical (first page ~270 s): disabled (docs/05 §11).
    run_ocr = "ocr" in stages and backend == "rocm"
    warnings: list[str] = []
    if "ocr" in stages and not run_ocr:
        warnings.append("OCR is disabled on CPU; enter source text manually")

    with tempfile.TemporaryDirectory(prefix="komaflow-analyze-") as tmp:
        work = Path(tmp)
        layout = run_stage(
            "layout",
            backend,
            {"backend": backend, "model_dir": str(paths.model_dir("layout")), "threshold": options.get("layout_threshold"),
             "class_thresholds": options.get("class_thresholds") or {},
             "items": [{"id": p["page_id"], "image_path": p["image_path"]} for p in pages]},
            ctl,
            work,
        )
        result_pages = []
        crops: list[dict] = []
        for p, r in zip(pages, layout["results"]):
            objs = []
            for i, d in enumerate(r["detections"]):
                t = map_class(d["class"], class_map)
                box = xyxy_to_box(d["xyxy"], r["width"], r["height"])
                if t is None or box is None:
                    continue
                objs.append({"type": t, "box": box, "score": d["score"], "source_text": "", "_key": f"{p['page_id']}:{i}"})
            result_pages.append({"page_id": p["page_id"], "width": r["width"], "height": r["height"], "objects": objs,
                                 "timings": {"layout_s": r["seconds"]}})
            if run_ocr and objs:
                ctl.check()
                with Image.open(p["image_path"]) as im:
                    im = im.convert("RGB")
                    for o in objs:
                        path = work / f"crop-{len(crops)}.png"
                        crop_object(im, o["box"], 0, padding).save(path)
                        crops.append({"id": o["_key"], "image_path": str(path)})
        ocr_info = None
        if crops:
            ocr = run_stage("ocr", backend, {"backend": backend, "model_dir": str(paths.model_dir("ocr")), "items": crops}, ctl, work)
            ocr_info = {"info": ocr["info"], "peak_vram_mb": ocr["peak_vram_mb"]}
            texts = {r["id"]: r for r in ocr["results"]}
            for pg in result_pages:
                ocr_s = 0.0
                for o in pg["objects"]:
                    hit = texts.get(o["_key"])
                    if hit:
                        o["source_text"] = hit["text"]
                        ocr_s += hit["seconds"]
                pg["timings"]["ocr_s"] = round(ocr_s, 3)
        for pg in result_pages:
            for o in pg["objects"]:
                o.pop("_key", None)
    return {
        "backend": backend,
        "pages": result_pages,
        "warnings": warnings,
        "stages": {"layout": {"info": layout["info"], "peak_vram_mb": layout["peak_vram_mb"]}, "ocr": ocr_info},
    }


def ocr_batch(pages: list[dict], options: dict, ctl: Control | None = None) -> dict:
    """OCR of boxes that already exist (after the cleaner fixed the layout): one OCR process for all
    pages. pages: [{page_id, image_path, boxes: [{id, box, rotation?}]}] ->
    {pages: [{page_id, results: [{id, source_text}]}], backend}."""
    from PIL import Image

    ctl = ctl or Control()
    caps = be.capabilities()
    rocm_info = next(b for b in caps["backends"] if b["id"] == "rocm")
    if options.get("backend") == "cpu" or not rocm_info["available"]:
        raise RuntimeError("OCR needs the ROCm backend")
    backend = "rocm"
    padding = int(options.get("ocr_padding_px", DEFAULTS["ocr_padding_px"]))
    with tempfile.TemporaryDirectory(prefix="komaflow-ocr-") as tmp:
        work = Path(tmp)
        items: list[dict] = []
        owner: dict[str, str] = {}
        for p in pages:
            ctl.check()
            if not p["boxes"]:
                continue
            with Image.open(p["image_path"]) as im:
                im = im.convert("RGB")
                for b in p["boxes"]:
                    path = work / f"crop-{len(items)}.png"
                    crop_object(im, b["box"], float(b.get("rotation") or 0), padding).save(path)
                    key = f"{p['page_id']}:{b['id']}"
                    owner[key] = p["page_id"]
                    items.append({"id": key, "image_path": str(path)})
        out = run_stage("ocr", backend, {"backend": backend, "model_dir": str(paths.model_dir("ocr")), "items": items}, ctl, work) if items else {"results": []}
    by_page: dict[str, list[dict]] = {p["page_id"]: [] for p in pages}
    for r in out["results"]:
        by_page[owner[r["id"]]].append({"id": r["id"].split(":", 1)[1], "source_text": r["text"]})
    return {"backend": backend, "pages": [{"page_id": k, "results": v} for k, v in by_page.items()]}


def ocr_boxes(image_path: str, boxes: list[dict], options: dict, ctl: Control | None = None) -> dict:
    """«Перечитать OCR» for single boxes: [{id, box, rotation?}] -> {results: [{id, source_text}]}."""
    r = ocr_batch([{"page_id": "_", "image_path": image_path, "boxes": boxes}], options, ctl)
    return {"results": r["pages"][0]["results"], "backend": r["backend"]}


def inpaint_batch(items: list[dict], options: dict, ctl: Control | None = None) -> dict:
    """Auto-clean with LaMa: items [{id, image_path, mask_path, out_path}] (PNG mask, white = erase).
    Works on ROCm and CPU (LaMa is light enough for CPU). -> {results: [{id, out_path, masked_px}], backend}"""
    ctl = ctl or Control()
    caps = be.capabilities()
    if not caps["models"]["lama"]["installed"]:
        raise RuntimeError("LaMa model is not installed: komaflow-sidecar install --models lama")
    rocm_info = next(b for b in caps["backends"] if b["id"] == "rocm")
    cpu_ok = next(b for b in caps["backends"] if b["id"] == "cpu")["available"]
    backend = be.choose(options.get("backend", "auto"), rocm_info, cpu_ok)
    with tempfile.TemporaryDirectory(prefix="komaflow-inpaint-") as tmp:
        out = run_stage("inpaint", backend, {"backend": backend, "model_dir": str(paths.model_dir("lama")), "items": items}, ctl, Path(tmp))
    return {"backend": backend, "results": [{k: r[k] for k in ("id", "out_path", "masked_px")} for r in out["results"]]}
