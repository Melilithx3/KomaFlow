"""Все пути проекта. Ничего не пишется за пределы каталога проекта."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_DATA = ROOT / "test_data"
USER_MASKS = TEST_DATA / "masks"
RUNS = ROOT / "runs"
ENVS = ROOT / ".envs"
TOOLS = ROOT / ".tools"
UV_CACHE = ROOT / ".cache" / "uv"
UV_PYTHON = TOOLS / "python"  # интерпретаторы, скачанные uv (не глобальные)
MODELS = ROOT / "models"  # собственный HF-кэш проекта; пользовательский ~/.cache не трогаем
WORKER_DIR = ROOT / "bench" / "worker"

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
