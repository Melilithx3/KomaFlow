"""Engine installation (docs/05 §10): isolated Python 3.12 env via uv with exact versions from locks/,
then model download by pinned revision. No admin rights, the global Python is untouched.
Adapted from reference/bench/bench/envs.py."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

from . import paths
from .catalog import COMMON_PKGS, ENVS, MODELS, PYPI, EnvSpec

LOCKS = Path(__file__).resolve().parent.parent / "locks"
Log = Callable[[str], None]


def read_lock(env_name: str) -> tuple[str | None, list[str]]:
    p = LOCKS / f"{env_name}.txt"
    if not p.exists():
        return None, []
    py = None
    pins = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("# python=="):
            py = line.split("==", 1)[1].strip()
        elif line and not line.startswith("#") and "==" in line:
            pins.append(line)
    return py, pins


def uv_bin() -> str:
    found = shutil.which("uv")
    if found:
        return found
    try:
        from uv import find_uv_bin  # type: ignore[import-not-found]

        return find_uv_bin()
    except ImportError as e:
        raise RuntimeError("uv is not installed: `pip install uv` or https://docs.astral.sh/uv/") from e


def uv_env() -> dict[str, str]:
    env = dict(os.environ)
    env.update(UV_PYTHON_INSTALL_DIR=str(paths.home() / "python"), UV_CACHE_DIR=str(paths.home() / "uv-cache"),
               UV_NO_PROGRESS="1", UV_LINK_MODE="copy", PYTHONUTF8="1")
    for k in ("UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "VIRTUAL_ENV", "PYTHONPATH"):
        env.pop(k, None)
    return env


def env_commands(spec: EnvSpec, uv: str, constraints: Path | None) -> list[list[str]]:
    """The exact uv command lines that build the environment (tested without running them)."""
    py_lock, _ = read_lock(spec.name)
    d = paths.envs_dir() / spec.name
    py = str(paths.env_python(spec.name))
    cons = ["--constraint", str(constraints)] if constraints else []
    torch_step = [uv, "pip", "install", "--python", py, "--index-url", PYPI, "--extra-index-url", spec.extra_index, *cons]
    if spec.prerelease:
        torch_step += ["--prerelease", "allow"]
    return [
        [uv, "venv", "--python", py_lock or spec.python, "--python-preference", "only-managed", "--seed", str(d)],
        torch_step + list(spec.torch_pkgs),
        [uv, "pip", "install", "--python", py, "--index-url", PYPI, "--extra-index-url", spec.extra_index, *cons, *COMMON_PKGS],
    ]


def free_gb(path: Path) -> float:
    path.mkdir(parents=True, exist_ok=True)
    return shutil.disk_usage(path).free / 2**30


def install_env(backend: str, log: Log = print) -> None:
    spec = ENVS[backend]
    need = spec.approx_size_gb * 1.5 + 2
    if (free := free_gb(paths.envs_dir())) < need:
        raise RuntimeError(f"not enough disk space: need ~{need:.1f} GB, free {free:.1f} GB")
    d = paths.envs_dir() / spec.name
    if d.exists():
        log(f"[env] {spec.name}: removing an incomplete or outdated environment")
        shutil.rmtree(d)
    _, pins = read_lock(spec.name)
    cfile = None
    if pins:
        paths.envs_dir().mkdir(parents=True, exist_ok=True)
        cfile = paths.envs_dir() / f"{spec.name}.constraints.txt"
        cfile.write_text("\n".join(pins) + "\n", encoding="utf-8")
    uv = uv_bin()
    logfile = paths.logs_dir() / f"install-{spec.name}.log"
    logfile.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    for i, cmd in enumerate(env_commands(spec, uv, cfile)):
        log(f"[env] {spec.name}: step {i + 1}/3")
        with logfile.open("a", encoding="utf-8") as f:
            f.write("\n$ " + " ".join(cmd) + "\n")
            f.flush()
            r = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT, env=uv_env())
        if r.returncode != 0:
            tail = logfile.read_text(encoding="utf-8", errors="replace").splitlines()[-25:]
            raise RuntimeError(f"step {i + 1} failed (exit {r.returncode}), log {logfile}:\n" + "\n".join(tail))
    (d / ".komaflow_env.json").write_text(json.dumps({"spec": spec.name, "installed": time.strftime("%Y-%m-%d %H:%M:%S"),
                                                      "seconds": round(time.perf_counter() - t0)}), encoding="utf-8")
    log(f"[env] {spec.name}: ready in {time.perf_counter() - t0:.0f} s")


DOWNLOAD = (
    "import sys\n"
    "from huggingface_hub import snapshot_download\n"
    "snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3])\n"
)


def install_model(key: str, backend: str, log: Log = print) -> None:
    m = MODELS[key]
    dest = paths.model_dir(key)
    if (free := free_gb(paths.models_dir())) < m.approx_size_gb * 1.2 + 0.5:
        raise RuntimeError(f"not enough disk space for {key}: free {free:.1f} GB")
    log(f"[model] {key}: {m.repo}@{m.revision[:10]}")
    env = uv_env()
    env.pop("HF_HUB_OFFLINE", None)
    r = subprocess.run([str(paths.env_python(ENVS[backend].name)), "-c", DOWNLOAD, m.repo, m.revision, str(dest)], env=env)
    if r.returncode != 0:
        raise RuntimeError(f"download of {key} failed (exit {r.returncode})")
    (dest / ".komaflow_model.json").write_text(json.dumps({"repo": m.repo, "revision": m.revision}), encoding="utf-8")


def installed_backend() -> str | None:
    """An already built environment to download models with (ROCm preferred)."""
    for b in ("rocm", "cpu"):
        if paths.env_python(ENVS[b].name).exists():
            return b
    return None


def install(backends: list[str], models: list[str], log: Log = print, models_only: bool = False) -> None:
    """Builds environments (unless `models_only`) and downloads models by pinned revision."""
    if not models_only:
        for b in backends:
            install_env(b, log)
    via = installed_backend() if models_only else (backends[0] if backends else installed_backend())
    if models and via is None:
        raise RuntimeError("no engine environment yet: run install without --models-only first")
    for k in models:
        install_model(k, via, log)  # type: ignore[arg-type]
    log("done")


if __name__ == "__main__":  # pragma: no cover
    install(sys.argv[1:] or ["rocm", "cpu"], ["layout", "ocr", "lama"])
