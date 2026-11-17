"""Job queue: one worker thread, one job at a time (the GPU fits one heavy stage)."""
from __future__ import annotations

import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from .pipeline import Cancelled, Control, Progress


@dataclass
class Job:
    id: str
    kind: str
    run: Callable[[Control], Any]
    state: str = "queued"  # queued | running | done | failed | cancelled
    stage: str = "queued"
    done: int = 0
    total: int = 0
    result: Any = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    ctl: Control = field(default_factory=Control)

    def to_dict(self) -> dict:
        d: dict[str, Any] = {"id": self.id, "kind": self.kind, "state": self.state, "stage": self.stage,
                             "progress": {"done": self.done, "total": self.total}}
        if self.result is not None:
            d["result"] = self.result
        if self.error is not None:
            d["error"] = self.error
        return d


class JobQueue:
    def __init__(self, keep: int = 50):
        self.jobs: dict[str, Job] = {}
        self.q: queue.Queue[Job] = queue.Queue()
        self.keep = keep
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def submit(self, kind: str, run: Callable[[Control], Any]) -> Job:
        job = Job(id=uuid.uuid4().hex, kind=kind, run=run)

        def on_progress(p: Progress) -> None:
            job.stage, job.done, job.total = p.stage, p.done, p.total

        job.ctl.on_progress = on_progress
        with self.lock:
            self.jobs[job.id] = job
            old = sorted(self.jobs.values(), key=lambda j: j.created)[: max(0, len(self.jobs) - self.keep)]
            for j in old:
                if j.state in ("done", "failed", "cancelled"):
                    del self.jobs[j.id]
        self.q.put(job)
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job or job.state in ("done", "failed", "cancelled"):
            return False
        job.ctl.cancel.set()
        if job.state == "queued":
            job.state = "cancelled"
        return True

    def _loop(self) -> None:
        while True:
            job = self.q.get()
            if job.state == "cancelled":
                continue
            job.state = "running"
            try:
                job.result = job.run(job.ctl)
                job.state = "done"
            except Cancelled:
                job.state = "cancelled"
            except Exception as e:  # noqa: BLE001 - reported to the client
                if job.ctl.cancel.is_set():
                    job.state = "cancelled"
                else:
                    job.state = "failed"
                    job.error = str(e)
