"""Warm model worker (ADR 0016): `python -m komaflow_sidecar.worker <stage> <port> <token>`.

The process loads its model once and keeps it between jobs. It talks to the control process over a
localhost TCP connection, NOT stdin/stdout: on Windows a thread blocked reading a pipe can freeze other
code that touches that handle (PyTorch / transformers check `isatty` while importing), which hung model
loading forever. stdin is /dev/null; stdout/stderr go to the worker log.
Commands and events are JSON lines:
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
import socket
import sys
import threading
import time
import traceback


class Channel:
    def __init__(self, port: int, token: str):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=30)
        self.sock.settimeout(None)
        self.lock = threading.Lock()
        self.rfile = self.sock.makefile("r", encoding="utf-8", newline="\n")
        self.emit(event="hello", token=token, pid=os.getpid())

    def emit(self, **kw) -> None:
        data = (json.dumps(kw, ensure_ascii=False) + "\n").encode("utf-8")
        with self.lock:
            self.sock.sendall(data)


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
    stage, port, token = argv[0], int(argv[1]), argv[2]
    ch = Channel(port, token)
    print(f"[worker {stage}] pid {os.getpid()} connected", flush=True)
    mod = stage_module(stage)
    fake = os.environ.get("KOMAFLOW_SIDECAR_FAKE") == "1"
    cancel = threading.Event()
    commands: queue.Queue[dict] = queue.Queue()

    def reader() -> None:
        try:
            for line in ch.rfile:
                try:
                    cmd = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if cmd.get("cmd") == "cancel":
                    cancel.set()
                else:
                    commands.put(cmd)
        except OSError:
            pass
        commands.put({"cmd": "exit"})  # control process went away

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
                print(f"[worker {stage}] loading model", flush=True)
                impl = mod.Fake(cmd["job"]) if fake else mod.Real(cmd["job"])
                impl.should_stop = cancel.is_set
                info = impl.load()
                print(f"[worker {stage}] loaded in {time.perf_counter() - t0:.1f} s", flush=True)
                ch.emit(event="loaded", seconds=round(time.perf_counter() - t0, 2), info=json.loads(json.dumps(info, default=str)))
            elif kind == "park":
                if impl is not None:
                    impl.park()
                ch.emit(event="parked")
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
                    ch.emit(event="progress", id=cmd["id"], done=i + 1, total=len(items))
                if stopped or cancel.is_set():
                    ch.emit(event="cancelled", id=cmd["id"])
                else:
                    ch.emit(event="result", id=cmd["id"], results=results, peak_vram_mb=impl.peak_vram_mb())
        except Exception as e:  # noqa: BLE001 - reported to the control process
            traceback.print_exc()
            sys.stdout.flush()
            ch.emit(event="error", id=cmd.get("id"), message=f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
