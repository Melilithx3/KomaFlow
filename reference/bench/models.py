"""Скачивание моделей с HF в собственный кэш проекта по точному revision."""
from __future__ import annotations

import shutil
from pathlib import Path

from . import paths
from .catalog import ModelSpec
from .logutil import log


def download(spec: ModelSpec) -> dict:
    from huggingface_hub import HfApi, snapshot_download

    need = spec.approx_size_gb * 1.2 + 1
    free = shutil.disk_usage(paths.ROOT).free / 2**30
    if free < need:
        raise RuntimeError(f"недостаточно места для {spec.repo}: нужно ~{need:.1f} ГБ, свободно {free:.1f} ГБ")
    log(f"[model] {spec.repo}@{spec.revision[:10]}: проверка/скачивание")
    d = snapshot_download(spec.repo, revision=spec.revision, cache_dir=str(paths.MODELS / "hub"))
    files = sorted(str(p.relative_to(d)) for p in Path(d).rglob("*") if p.is_file())
    info = {"repo": spec.repo, "revision": spec.revision, "local_dir": d, "files": files}
    try:
        mi = HfApi().model_info(spec.repo, revision=spec.revision)
        info["resolved_sha"] = mi.sha
        info["last_modified"] = str(mi.last_modified)
    except Exception as e:  # офлайн — не критично, revision зафиксирован
        info["resolved_sha_error"] = str(e)
    return info
