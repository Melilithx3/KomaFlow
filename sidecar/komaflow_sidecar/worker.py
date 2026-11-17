"""Warm model worker (ADR 0016): `python -m komaflow_sidecar.worker <layout|ocr|inpaint>`.

The process loads its model once and keeps it between jobs, so repeated runs skip loading and the
MIOpen warm-up. Commands come as JSON lines on stdin, events go as JSON lines to stdout:
  {"cmd": "load", "job": {...}}            -> {"event": "loaded", "seconds", "info"}
  {"cmd": "run", "id": n, "job": {...}}    -> {"event": "progress", "id", "done", "total"} ...
                                              {"event": "result", "id", "results", "peak_vram_mb"}
                                              | {"event": "cancelled", "id"} | {"event": "error", "id", "message"}
  {"cmd": "park"}                          -> weights to CPU RAM, VRAM freed  -> {"event": "parked"}
  {"cmd": "cancel"}                        -> stops after the current item
  {"cmd": "exit"}
"""
from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
import traceback


def emit(**kw) -> None:
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def stage_module(stage: str):
    if stage == "layout":
        from .stages import layout as mod
    elif stage == "ocr":
        from .stages import ocr as mod
    elif stage == "inpaint":
        from .stages import inpaint as mod
    else:
        raise SystemExit(f"unknown stage {stage}")
    return mod


def main(argv: list[str]) -> int:
    stage = argv[0]
    mod = stage_module(stage)
    fake = os.environ.get("KOMAFLOW_SIDECAR_FAKE") == "1"
    cancel = threading.Event()
    commands: queue.Queue[dict] = queue.Queue()

    def reader() -> None:
        for line in sys.stdin:
            try:
                cmd = json.loads(line)
            except json.JSONDecodeError:
                continue
            if cmd.get("cmd") == "cancel":
                cancel.set()
            else:
                commands.put(cmd)
        commands.put({"cmd": "exit"})

    threading.Thread(target=reader, daemon=True).start()
    impl = None
    while True:
        cmd = commands.get()
        kind = cmd.get("cmd")
        if kind == "exit":
            return 0
        try:
            if kind == "load":
                t0 = time.perf_counter()
                impl = mod.Fake(cmd["job"]) if fake else mod.Real(cmd["job"])
                impl.should_stop = cancel.is_set
                info = impl.load()
                emit(event="loaded", seconds=round(time.perf_counter() - t0, 2), info=info)
            elif kind == "park":
                if impl is not None:
                    impl.park()
                emit(event="parked")
            elif kind == "run":
                assert impl is not None, "run before load"
                cancel.clear()
                job = cmd["job"]
                impl.job = job  # per-run options (thresholds, …); weights stay loaded
                impl.unpark()
                items = job["items"]
                results = []
                stopped = False
                for i, item in enumerate(items):
                    if cancel.is_set():
                        stopped = True
                        break
                    t = time.perf_counter()
                    r = impl.run(item)
                    r["seconds"] = round(time.perf_counter() - t, 3)
                    results.append(r)
                    emit(event="progress", id=cmd["id"], done=i + 1, total=len(items))
                if stopped or cancel.is_set():
                    emit(event="cancelled", id=cmd["id"])
                else:
                    emit(event="result", id=cmd["id"], results=results, peak_vram_mb=impl.peak_vram_mb())
        except Exception as e:  # noqa: BLE001 - reported to the control process
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()
            emit(event="error", id=cmd.get("id"), message=f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
