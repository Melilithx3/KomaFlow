"""Простой лог: консоль + файл текущего прогона."""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

_lock = threading.Lock()
_file: Path | None = None


def set_logfile(p: Path | None) -> None:
    global _file
    _file = p
    if p:
        p.parent.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    with _lock:
        try:
            print(line, flush=True)
        except UnicodeEncodeError:
            sys.stdout.buffer.write((line + "\n").encode("utf-8", "replace"))
            sys.stdout.flush()
        if _file:
            with _file.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
