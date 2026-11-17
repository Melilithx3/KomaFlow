#!/usr/bin/env python
"""Единственная точка входа бенчмарка.

Запуск:  py -3.13 run_all.py            (любой Python >= 3.10 под Windows)

Скрипт сам:
  1. создаёт служебное окружение .tools/venv (uv, psutil, huggingface_hub) —
     глобальный Python не меняется;
  2. перезапускается внутри него и передаёт управление bench.orchestrator.

Этот файл намеренно использует только стандартную библиотеку.
"""
from __future__ import annotations

import os
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TOOLS_VENV = ROOT / ".tools" / "venv"
TOOLS_PY = TOOLS_VENV / "Scripts" / "python.exe"
TOOLS_REQ = ["uv==0.13.8", "psutil==7.2.2", "huggingface_hub==2.4.0"]
MARKER = TOOLS_VENV / ".bench_tools_ok"


def _in_tools_venv() -> bool:
    try:
        return Path(sys.prefix).resolve() == TOOLS_VENV.resolve()
    except OSError:
        return False


def _bootstrap() -> None:
    want = "\n".join(TOOLS_REQ)
    if TOOLS_PY.exists() and MARKER.exists() and MARKER.read_text(encoding="utf-8") == want:
        return
    print(f"[bootstrap] создаю служебное окружение {TOOLS_VENV}")
    if not TOOLS_PY.exists():
        venv.EnvBuilder(with_pip=True, clear=False).create(TOOLS_VENV)
    env = dict(os.environ, PIP_DISABLE_PIP_VERSION_CHECK="1")
    subprocess.check_call([str(TOOLS_PY), "-m", "pip", "install", "--quiet", *TOOLS_REQ], env=env)
    MARKER.write_text(want, encoding="utf-8")


def main() -> int:
    if sys.platform != "win32":
        print("Этот бенчмарк рассчитан на Windows.")
        return 2
    if sys.version_info < (3, 10):
        print("Нужен Python >= 3.10 для запуска оркестратора.")
        return 2
    if not _in_tools_venv():
        _bootstrap()
        env = dict(os.environ, PYTHONUTF8="1")
        return subprocess.call([str(TOOLS_PY), str(Path(__file__).resolve()), *sys.argv[1:]], env=env)
    for s in (sys.stdout, sys.stderr):
        if not s.isatty():  # вывод в файл/пайп — всегда UTF-8 (консоль Windows печатает Unicode сама)
            s.reconfigure(encoding="utf-8", errors="replace")
    sys.path.insert(0, str(ROOT))
    from bench.orchestrator import main as orch_main

    return orch_main(sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
