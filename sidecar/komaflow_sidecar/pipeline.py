"""Analysis pipeline (docs/05 §12): layout for all pages in one process, then crops, then OCR for all
crops in another process. The control process never imports torch."""
from __future__ import annotations

import json
import subprocess
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import backend as be
from . import paths
from .catalog import DEFAULTS
from .geometry import crop_rect, map_class, xyxy_to_box


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
    """Runs one stage in a child process and waits; killing it on cancel frees VRAM at once."""
    ctl.check()
    job_path = workdir / f"{stage}-job.json"
    out_path = workdir / f"{stage}-out.json"
    job_path.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    cmd = [str(be.stage_python(backend)), "-m", "komaflow_sidecar.stage", stage, str(job_path), str(out_path)]
    log_path = workdir / f"{stage}.log"
    with log_path.open("w", encoding="utf-8") as err:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True, encoding="utf-8", env=paths.stage_env())
        ctl.proc = proc
        killer = threading.Thread(target=_kill_on_cancel, args=(ctl, proc), daemon=True)
        killer.start()
        total = len(job["items"])
        ctl.on_progress(Progress(stage, 0, total))
        assert proc.stdout is not None
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("event") == "progress":
                ctl.on_progress(Progress(stage, int(ev["done"]), int(ev["total"])))
        code = proc.wait()
        ctl.proc = None
    ctl.check()
    if code != 0:
        tail = log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-20:]
        raise RuntimeError(f"{stage} stage failed (exit {code}):\n" + "\n".join(tail))
    return json.loads(out_path.read_text(encoding="utf-8"))


def _kill_on_cancel(ctl: Control, proc: subprocess.Popen) -> None:
    while proc.poll() is None:
        if ctl.cancel.wait(0.2):
            proc.kill()
            return


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
                        im.crop(crop_rect(o["box"], padding, r["width"], r["height"])).save(path)
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


def ocr_boxes(image_path: str, boxes: list[dict], options: dict, ctl: Control | None = None) -> dict:
    """«Перечитать OCR» for single boxes: [{id, box}] -> {results: [{id, source_text}]}."""
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
        items = []
        with Image.open(image_path) as im:
            im = im.convert("RGB")
            for b in boxes:
                p = work / f"crop-{len(items)}.png"
                im.crop(crop_rect(b["box"], padding, im.width, im.height)).save(p)
                items.append({"id": b["id"], "image_path": str(p)})
        out = run_stage("ocr", backend, {"backend": backend, "model_dir": str(paths.model_dir("ocr")), "items": items}, ctl, work)
    return {"results": [{"id": r["id"], "source_text": r["text"]} for r in out["results"]], "backend": backend}
