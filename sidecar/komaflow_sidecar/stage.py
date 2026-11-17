"""Entry point of a stage process: `python -m komaflow_sidecar.stage <layout|ocr> <job.json> <out.json>`.

Each heavy stage runs in its own process that exits afterwards, so VRAM is always returned
(docs/05 §11: one heavy model in VRAM at a time). Progress goes to stdout as JSON lines:
  {"event": "loaded", "seconds": 3.1, "info": {...}}
  {"event": "progress", "done": 3, "total": 10}
The result is written to out.json at the end.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path


def emit(**kw) -> None:
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main(argv: list[str]) -> int:
    stage, job_path, out_path = argv
    job = json.loads(Path(job_path).read_text(encoding="utf-8"))
    fake = os.environ.get("KOMAFLOW_SIDECAR_FAKE") == "1"
    if stage == "layout":
        from .stages import layout as mod
    elif stage == "ocr":
        from .stages import ocr as mod
    elif stage == "inpaint":
        from .stages import inpaint as mod
    else:
        raise SystemExit(f"unknown stage {stage}")
    impl = mod.Fake(job) if fake else mod.Real(job)
    t0 = time.perf_counter()
    info = impl.load()
    emit(event="loaded", seconds=round(time.perf_counter() - t0, 2), info=info)
    items = job["items"]
    results = []
    for i, item in enumerate(items):
        t = time.perf_counter()
        r = impl.run(item)
        r["seconds"] = round(time.perf_counter() - t, 3)
        results.append(r)
        emit(event="progress", done=i + 1, total=len(items))
    out = {"stage": stage, "results": results, "info": info, "peak_vram_mb": impl.peak_vram_mb()}
    Path(out_path).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
