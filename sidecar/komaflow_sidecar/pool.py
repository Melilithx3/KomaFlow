"""Pool of warm model workers (ADR 0016).

One long-lived process per (model, backend). Before a model runs on the GPU the other GPU workers are
parked: their weights move to CPU RAM and VRAM is released, so only one heavy model occupies VRAM
(docs/05 §11) while all of them stay loaded. A worker exits after KOMAFLOW_SIDECAR_IDLE_MIN minutes
without work (default 60, 0 = never), on cancel that it does not honour within the grace period, or when
the sidecar stops.
"""
from __future__ import annotations

import atexit
import json
import os
import queue
import secrets
import socket
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from . import backend as be
from . import paths

if TYPE_CHECKING:
    from .pipeline import Control

CANCEL_GRACE_S = float(os.environ.get("KOMAFLOW_SIDECAR_CANCEL_GRACE", "3"))
CONNECT_TIMEOUT_S = 180.0  # Python + torch start-up of the worker


def load_timeout_s() -> float:
    """A cold model (download-free, but first MIOpen compile) may take minutes; never wait forever."""
    return float(os.environ.get("KOMAFLOW_SIDECAR_LOAD_TIMEOUT", "900"))


def idle_limit_s() -> float:
    return float(os.environ.get("KOMAFLOW_SIDECAR_IDLE_MIN", "60")) * 60


def _env_signature() -> tuple:
    keys = ("KOMAFLOW_SIDECAR_FAKE", "KOMAFLOW_SIDECAR_FAKE_ROCM", "KOMAFLOW_SIDECAR_FAKE_DELAY", "KOMAFLOW_SIDECAR_HOME", "KOMAFLOW_MODELS_DIR")
    return tuple(os.environ.get(k) for k in keys)


class WorkerError(RuntimeError):
    pass


@dataclass
class Worker:
    stage: str
    backend: str
    model_dir: str
    proc: subprocess.Popen
    log_path: str
    events: "queue.Queue[dict | None]" = field(default_factory=queue.Queue)
    state: str = "loading"  # loading | ready | parked | busy | dead
    loads: int = 0
    last_used: float = field(default_factory=time.monotonic)
    run_seq: int = 0
    conn: socket.socket | None = None
    connected: threading.Event = field(default_factory=threading.Event)

    def send(self, cmd: dict) -> None:
        if not self.connected.wait(CONNECT_TIMEOUT_S) or self.conn is None:
            raise WorkerError(f"{self.stage} worker did not connect:\n{self.stderr_tail()}")
        try:
            self.conn.sendall((json.dumps(cmd, ensure_ascii=False) + "\n").encode("utf-8"))
        except OSError as e:
            raise WorkerError(f"{self.stage} worker is gone: {e}\n{self.stderr_tail()}") from e

    def next_event(self, timeout: float | None) -> dict | None:
        try:
            ev = self.events.get(timeout=timeout)
        except queue.Empty:
            return {"event": "_timeout"}
        if ev is None:
            self.state = "dead"
            raise WorkerError(f"{self.stage} worker exited (code {self.proc.poll()}):\n{self.stderr_tail()}")
        return ev

    def stderr_tail(self, n: int = 20) -> str:
        try:
            with open(self.log_path, encoding="utf-8", errors="replace") as f:
                return "\n".join(f.read().splitlines()[-n:])
        except OSError:
            return ""

    def kill(self) -> None:
        self.state = "dead"
        try:
            self.proc.kill()
        except OSError:
            pass
        if self.conn is not None:
            try:
                self.conn.close()
            except OSError:
                pass


class Pool:
    def __init__(self) -> None:
        self.workers: dict[tuple, Worker] = {}
        self.lock = threading.RLock()
        threading.Thread(target=self._reaper, daemon=True).start()

    # ------------------------------------------------------------ lifecycle
    def _spawn(self, stage: str, backend: str, job: dict) -> Worker:
        logs = paths.logs_dir()
        logs.mkdir(parents=True, exist_ok=True)
        log_path = str(logs / f"worker-{stage}-{backend}.log")
        log = open(log_path, "a", encoding="utf-8")  # noqa: SIM115 - owned by the process
        log.write(f"\n==== {time.strftime('%Y-%m-%d %H:%M:%S')} start {stage} on {backend}\n")
        log.flush()
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(CONNECT_TIMEOUT_S)
        token = secrets.token_hex(16)
        proc = subprocess.Popen(
            [str(be.stage_python(backend)), "-u", "-m", "komaflow_sidecar.worker", stage, str(listener.getsockname()[1]), token],
            stdin=subprocess.DEVNULL,  # never a pipe: see worker.py
            stdout=log,
            stderr=subprocess.STDOUT,
            env=paths.stage_env(),
            **_no_window(),
        )
        w = Worker(stage, backend, job["model_dir"], proc, log_path)

        def pump() -> None:
            try:
                conn, _ = listener.accept()
            except OSError:
                w.events.put(None)
                return
            finally:
                listener.close()
            conn.settimeout(None)
            rfile = conn.makefile("r", encoding="utf-8", newline="\n")
            try:
                hello = json.loads(rfile.readline() or "{}")
            except json.JSONDecodeError:
                hello = {}
            if hello.get("token") != token:
                conn.close()
                w.events.put(None)
                return
            w.conn = conn
            w.connected.set()
            try:
                for line in rfile:
                    try:
                        w.events.put(json.loads(line))
                    except json.JSONDecodeError:
                        continue
            except OSError:
                pass
            w.events.put(None)

        threading.Thread(target=pump, daemon=True).start()
        threading.Thread(target=_send_quietly, args=(w, {"cmd": "load", "job": job}), daemon=True).start()
        return w

    def _get(self, stage: str, backend: str, job: dict, ctl: "Control") -> Worker:
        key = (stage, backend, job["model_dir"], _env_signature())
        with self.lock:
            w = self.workers.get(key)
            if w and (w.state == "dead" or w.proc.poll() is not None):
                self.workers.pop(key, None)
                w = None
            if w is None:
                w = self._spawn(stage, backend, job)
                self.workers[key] = w
        if w.state == "loading":
            from .pipeline import Progress

            ctl.on_progress(Progress(f"{stage}:loading", 0, len(job["items"])))
            started = time.monotonic()
            while True:
                ev = w.next_event(timeout=1.0)
                if ev["event"] == "_timeout":
                    if w.proc.poll() is not None:
                        self._drop(w)
                        raise WorkerError(f"{stage} worker exited while loading (code {w.proc.returncode}):\n{w.stderr_tail()}")
                    if time.monotonic() - started > load_timeout_s():
                        self._drop(w)
                        raise WorkerError(f"{stage} model did not load in {load_timeout_s():.0f} s:\n{w.stderr_tail()}")
                    if ctl.cancel.is_set():
                        self._drop(w)
                        from .pipeline import Cancelled

                        raise Cancelled()
                    continue
                if ev["event"] == "loaded":
                    w.state = "ready"
                    w.loads += 1
                    break
                if ev["event"] == "error":
                    self._drop(w)
                    raise WorkerError(f"{stage} model failed to load: {ev.get('message')}\n{w.stderr_tail()}")
        return w

    def _drop(self, w: Worker) -> None:
        with self.lock:
            for k, v in list(self.workers.items()):
                if v is w:
                    self.workers.pop(k)
        w.kill()

    def _park_others(self, keep: Worker) -> None:
        """Only one model on the GPU at a time: the others move to CPU RAM, staying loaded."""
        for w in list(self.workers.values()):
            if w is keep or w.backend != "rocm" or w.state != "ready":
                continue
            w.send({"cmd": "park"})
            while True:
                ev = w.next_event(timeout=120)
                if ev["event"] in ("parked", "_timeout", "error"):
                    w.state = "parked" if ev["event"] == "parked" else w.state
                    break

    def run(self, stage: str, backend: str, job: dict, ctl: "Control") -> dict:
        from .pipeline import Cancelled, Progress

        ctl.check()
        with self.lock:
            w = self._get(stage, backend, job, ctl)
            if backend == "rocm":
                self._park_others(w)
            w.state = "busy"
            w.run_seq += 1
            run_id = w.run_seq
        total = len(job["items"])
        ctl.on_progress(Progress(stage, 0, total))
        w.send({"cmd": "run", "id": run_id, "job": job})
        cancel_sent_at: float | None = None
        try:
            while True:
                ev = w.next_event(timeout=0.25)
                kind = ev["event"]
                if kind == "_timeout":
                    if w.proc.poll() is not None:
                        self._drop(w)
                        raise WorkerError(f"{stage} worker died (code {w.proc.returncode}):\n{w.stderr_tail()}")
                    if ctl.cancel.is_set():
                        if cancel_sent_at is None:
                            w.send({"cmd": "cancel"})
                            cancel_sent_at = time.monotonic()
                        elif time.monotonic() - cancel_sent_at > CANCEL_GRACE_S:
                            # the model is inside a long item (e.g. OCR generation): stop it hard
                            self._drop(w)
                            raise Cancelled()
                    continue
                if ev.get("id") != run_id:
                    continue
                if kind == "progress":
                    ctl.on_progress(Progress(stage, int(ev["done"]), int(ev["total"])))
                elif kind == "result":
                    w.state = "ready"
                    return {"stage": stage, "results": ev["results"], "info": {"worker_pid": w.proc.pid}, "peak_vram_mb": ev.get("peak_vram_mb")}
                elif kind == "cancelled":
                    w.state = "ready"
                    raise Cancelled()
                elif kind == "error":
                    w.state = "ready"
                    raise WorkerError(f"{stage} failed: {ev.get('message')}\n{w.stderr_tail()}")
        finally:
            w.last_used = time.monotonic()
            if w.state == "busy":
                w.state = "ready"

    # ------------------------------------------------------------ housekeeping
    def _reaper(self) -> None:
        while True:
            time.sleep(15)
            limit = idle_limit_s()
            if limit <= 0:
                continue
            with self.lock:
                for w in list(self.workers.values()):
                    if w.state in ("ready", "parked") and time.monotonic() - w.last_used > limit:
                        self._stop(w)

    def _stop(self, w: Worker) -> None:
        try:
            w.send({"cmd": "exit"})
            w.proc.wait(timeout=5)
        except (WorkerError, subprocess.TimeoutExpired):
            pass
        self._drop(w)

    def shutdown(self) -> None:
        with self.lock:
            for w in list(self.workers.values()):
                self._stop(w)

    def stats(self) -> list[dict]:
        return [
            {"stage": w.stage, "backend": w.backend, "state": w.state, "pid": w.proc.pid, "loads": w.loads, "idle_s": round(time.monotonic() - w.last_used)}
            for w in self.workers.values()
        ]


_pool: Pool | None = None


def pool() -> Pool:
    global _pool
    if _pool is None:
        _pool = Pool()
        atexit.register(_pool.shutdown)
    return _pool


def _no_window() -> dict:
    """No console window for workers on Windows."""
    if os.name == "nt":
        return {"creationflags": 0x08000000}  # CREATE_NO_WINDOW
    return {}


def _send_quietly(w: Worker, cmd: dict) -> None:
    """The first command waits for the connection; a failure surfaces as a dead worker."""
    try:
        w.send(cmd)
    except WorkerError:
        w.events.put(None)
