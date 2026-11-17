"""Запуск одного воркера в отдельном процессе с таймаутами и сбором метрик."""
from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import psutil

from . import paths
from .logutil import log
from .metrics import GpuSources, Sampler, summarize


@dataclass
class WorkerOutcome:
    returncode: int | None
    status: str  # ok | failed | timeout | stalled | interrupted
    reason: str | None
    wall_time_s: float
    events: list[dict] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)


class ProgressTail:
    """Читает progress.jsonl воркера (по строке на событие)."""

    def __init__(self, path: Path):
        self.path = path
        self.pos = 0
        self.events: list[dict] = []
        self.phase = "starting"
        self.last_change = time.time()

    def poll(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as f:
            f.seek(self.pos)
            chunk = f.read()
            if not chunk.endswith("\n"):
                chunk = chunk[: chunk.rfind("\n") + 1]
            self.pos += len(chunk.encode("utf-8"))
        for line in chunk.splitlines():
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            self.events.append(ev)
            self.last_change = time.time()
            if "phase" in ev:
                self.phase = ev["phase"]


def kill_tree(pid: int) -> None:
    try:
        root = psutil.Process(pid)
    except psutil.Error:
        return
    procs = [root, *root.children(recursive=True)]
    for p in procs:
        try:
            p.kill()
        except psutil.Error:
            pass
    psutil.wait_procs(procs, timeout=10)


def run_worker(python: Path, job_path: Path, out_dir: Path, sources: GpuSources, cpu_count: int,
               hard_timeout_s: float, stall_timeout_s: float, extra_env: dict[str, str] | None = None,
               stop_flag=None, script: Path | None = None, skip_file: Path | None = None) -> WorkerOutcome:
    out_dir.mkdir(parents=True, exist_ok=True)
    progress = ProgressTail(out_dir / "progress.jsonl")
    env = dict(os.environ)
    for k in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"):
        env.pop(k, None)
    env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONNOUSERSITE="1",
               HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HOME=str(paths.MODELS),
               PADDLE_PDX_CACHE_HOME=str(paths.ROOT / ".cache" / "paddlex"),
               PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK="True")
    if extra_env:
        env.update(extra_env)
    baseline = sources.baseline()
    log_f = (out_dir / "worker.log").open("w", encoding="utf-8")
    t0 = time.time()
    proc = subprocess.Popen([str(python), "-X", "utf8", str(script or paths.WORKER_DIR / "worker.py"), str(job_path)],
                            stdout=log_f, stderr=subprocess.STDOUT, env=env, cwd=str(out_dir),
                            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    sampler = Sampler(sources, proc.pid, out_dir / "metrics.csv", lambda: progress.phase)
    sampler.start()
    status, reason = "ok", None
    try:
        while True:
            rc = proc.poll()
            progress.poll()
            if rc is not None:
                break
            now = time.time()
            if stop_flag is not None and stop_flag.is_set():
                status, reason = "interrupted", "прервано пользователем (Ctrl+C)"
                kill_tree(proc.pid)
                break
            if skip_file is not None and skip_file.exists():
                skip_file.unlink(missing_ok=True)
                status, reason = "skipped", f"остановлено пользователем досрочно через {now - t0:.0f} с (фаза: {progress.phase})"
                kill_tree(proc.pid)
                break
            if now - t0 > hard_timeout_s:
                status, reason = "timeout", f"превышен общий таймаут {hard_timeout_s:.0f} с (фаза: {progress.phase})"
                kill_tree(proc.pid)
                break
            if now - progress.last_change > stall_timeout_s:
                status, reason = "stalled", (f"нет прогресса {stall_timeout_s:.0f} с (фаза: {progress.phase}) — "
                                             "процесс завис или слишком медленный")
                kill_tree(proc.pid)
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        status, reason = "interrupted", "прервано пользователем (Ctrl+C)"
        kill_tree(proc.pid)
    finally:
        sampler.stop()
        sampler.join(timeout=5)
        log_f.close()
        progress.poll()
    rc = proc.poll()
    if status == "ok" and rc != 0:
        status = "failed"
        reason = f"воркер завершился с кодом {rc}"
        code = (rc & 0xFFFFFFFF) if rc is not None else None
        if code == 0xC0000005:
            reason += " (0xC0000005 ACCESS_VIOLATION — сбой в нативной библиотеке/драйвере)"
        elif code == 0xC0000409:
            reason += " (0xC0000409 — аварийное завершение нативного кода)"
        # нативные падения не оставляют Python-трейсбека — берём диагностическую строку из лога
        try:
            lines = (out_dir / "worker.log").read_text(encoding="utf-8", errors="replace").splitlines()
            diag = [ln.strip() for ln in lines if ln.startswith("[F") or "Error" in ln or "error:" in ln.lower()]
            if diag:
                reason += ": " + diag[-1][:400]
        except OSError:
            pass
    wall = time.time() - t0
    return WorkerOutcome(rc, status, reason, round(wall, 2), progress.events,
                         summarize(sampler.rows, baseline, cpu_count))
