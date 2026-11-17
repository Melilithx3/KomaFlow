"""Directories (docs/05 §10): %LOCALAPPDATA%/komaflow/sidecar/{envs,models,cache/miopen,logs}."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def home() -> Path:
    if os.environ.get("KOMAFLOW_SIDECAR_HOME"):
        return Path(os.environ["KOMAFLOW_SIDECAR_HOME"])
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    return Path(base) / "komaflow" / "sidecar"


def envs_dir() -> Path:
    return home() / "envs"


def models_dir() -> Path:
    return Path(os.environ.get("KOMAFLOW_MODELS_DIR") or home() / "models")


def model_dir(key: str) -> Path:
    return models_dir() / key


def miopen_cache() -> Path:
    return home() / "cache" / "miopen"


def logs_dir() -> Path:
    return home() / "logs"


def env_python(env_name: str) -> Path:
    d = envs_dir() / env_name
    return d / "Scripts" / "python.exe" if sys.platform == "win32" else d / "bin" / "python"


def stage_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Environment for stage processes: persistent MIOpen cache, UTF-8, no user Python leaks."""
    env = dict(os.environ)
    cache = miopen_cache()
    cache.mkdir(parents=True, exist_ok=True)
    env.update(
        MIOPEN_USER_DB_PATH=str(cache),
        MIOPEN_CUSTOM_CACHE_DIR=str(cache),
        PYTHONUTF8="1",
        PYTHONIOENCODING="utf-8",
        HF_HUB_OFFLINE="1",  # models are downloaded at install time by revision
    )
    env.pop("PYTHONPATH", None)
    # the stage imports komaflow_sidecar from this source tree
    env["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)
    if extra:
        env.update(extra)
    return env
