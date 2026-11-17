#!/usr/bin/env python
"""Собирает переносимый архив бенчмарка для запуска на другом ПК.

    py make_portable.py                     # только код (~100 КБ); модели и окружения скачаются там
    py make_portable.py --with-models       # + оригинальные веса моделей (~2.2 ГБ), без повторного скачивания
    py make_portable.py --with-test-data    # + страницы из test_data/

В архив НЕ попадают: .envs/ (окружения привязаны к путям этого ПК), .tools/, .cache/, runs/, dist/.
Точные версии пакетов переносятся через bench/locks/*.txt — на другом ПК ставится ровно то же самое.
Только стандартная библиотека.
"""
from __future__ import annotations

import argparse
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INCLUDE = ["run_all.py", "start.bat", "make_portable.py", "README.md", "docs", "bench", "tests"]
SKIP_DIRS = {"__pycache__", ".pytest_cache"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
# уже сжатые/бинарные данные — без повторного сжатия (быстрее, размер тот же)
STORED_EXTS = {".safetensors", ".png", ".jpg", ".jpeg", ".webp", ".model", ".npz"}


def iter_files(base: Path):
    if base.is_file():
        yield base
        return
    for p in sorted(base.rglob("*")):
        if p.is_file() and not (SKIP_DIRS & set(p.relative_to(ROOT).parts)):
            yield p


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--with-models", action="store_true", help="включить models/ (веса HF, ~2.2 ГБ)")
    ap.add_argument("--with-test-data", action="store_true", help="включить изображения из test_data/")
    ap.add_argument("--out", type=Path, default=ROOT / "dist", help="каталог для архива (по умолчанию dist/)")
    a = ap.parse_args()

    files: list[Path] = []
    for name in INCLUDE:
        p = ROOT / name
        if not p.exists():
            print(f"[!] нет {name} — пропускаю")
            continue
        files += list(iter_files(p))
    if a.with_models:
        m = ROOT / "models" / "hub"
        if not m.exists():
            print("[!] models/hub не найден — модели не скачаны, архив будет без них")
        else:
            files += [p for p in iter_files(m) if ".locks" not in p.parts]
    td = ROOT / "test_data"
    if a.with_test_data and td.exists():
        files += [p for p in iter_files(td) if p.suffix.lower() in IMAGE_EXTS]

    a.out.mkdir(parents=True, exist_ok=True)
    suffix = ("_models" if a.with_models else "") + ("_data" if a.with_test_data else "")
    zpath = a.out / f"gfx1031-bench_{time.strftime('%Y%m%d_%H%M%S')}{suffix}.zip"
    total = 0
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in files:
            arc = Path("gfx1031-bench") / p.relative_to(ROOT)
            ctype = zipfile.ZIP_STORED if p.suffix.lower() in STORED_EXTS else zipfile.ZIP_DEFLATED
            z.write(p, arc.as_posix(), compress_type=ctype)
            total += p.stat().st_size
        # пустой test_data/ с подсказкой, если изображения не включены
        if not a.with_test_data:
            z.writestr("gfx1031-bench/test_data/ПОЛОЖИТЕ_СЮДА_СТРАНИЦЫ.txt",
                       "Положите сюда страницы манги (PNG/JPG/WebP) и запустите start.bat\n")
    print(f"Готово: {zpath}")
    print(f"  файлов: {len(files)}, исходный объём {total / 2**20:.1f} МБ, архив {zpath.stat().st_size / 2**20:.1f} МБ")
    print("На другом ПК: распаковать в любую папку (лучше не в Program Files), положить страницы в test_data\\,")
    print("запустить start.bat (нужен Python >= 3.10 — только для запуска; модели считаются в своих окружениях).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
