"""Backend selection (docs/05 §10): gfx1030/1031/1032 -> rocm, otherwise cpu. Probe runs in the env python."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from . import paths
from .catalog import ENVS, ROCM_ARCHS

PROBE = (
    "import json,torch\n"
    "d={'torch':torch.__version__,'hip':getattr(torch.version,'hip',None),'available':False}\n"
    "try:\n"
    "  d['available']=bool(d['hip']) and torch.cuda.is_available()\n"
    "  if d['available']:\n"
    "    p=torch.cuda.get_device_properties(0); d['device']=p.name; d['arch']=getattr(p,'gcnArchName','')\n"
    "except Exception as e: d['error']=str(e)\n"
    "print(json.dumps(d))\n"
)


def fake() -> bool:
    return os.environ.get("KOMAFLOW_SIDECAR_FAKE") == "1"


def stage_python(backend: str) -> Path:
    """Interpreter for a stage process: the env built from locks, or this one in fake/dev mode."""
    if fake():
        return Path(sys.executable)
    return paths.env_python(ENVS[backend].name)


def probe_rocm(python: Path | None = None) -> dict:
    py = python or paths.env_python(ENVS["rocm"].name)
    if fake():
        return {"available": os.environ.get("KOMAFLOW_SIDECAR_FAKE_ROCM") == "1", "device": "Fake GPU", "arch": "gfx1031"}
    if not py.exists():
        return {"available": False, "error": "rocm environment is not installed"}
    try:
        r = subprocess.run([str(py), "-c", PROBE], capture_output=True, text=True, timeout=180, env=paths.stage_env())
        return json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 else {"available": False, "error": r.stderr[-500:]}
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, IndexError) as e:
        return {"available": False, "error": str(e)}


def arch_supported(arch: str | None) -> bool:
    base = (arch or "").split(":")[0]
    return base in ROCM_ARCHS


def choose(requested: str, rocm_info: dict, cpu_installed: bool) -> str:
    """auto -> rocm if a supported GPU answers, else cpu. Explicit choice is validated."""
    rocm_ok = bool(rocm_info.get("available")) and arch_supported(rocm_info.get("arch"))
    if requested == "rocm":
        if not rocm_ok:
            raise RuntimeError(f"ROCm backend is not available: {rocm_info.get('error') or rocm_info.get('arch')}")
        return "rocm"
    if requested == "cpu":
        if not cpu_installed:
            raise RuntimeError("CPU environment is not installed")
        return "cpu"
    if rocm_ok:
        return "rocm"
    if cpu_installed:
        return "cpu"
    raise RuntimeError("no backend installed: run `komaflow-sidecar install`")


_caps_cache: dict[tuple, dict] = {}


def capabilities(refresh: bool = False) -> dict:
    """Backends and models. Importing torch to probe the GPU takes seconds, so the answer is cached per
    process (and per relevant environment); `refresh=True` probes again (after installing)."""
    key = tuple(os.environ.get(k) for k in ("KOMAFLOW_SIDECAR_FAKE", "KOMAFLOW_SIDECAR_FAKE_ROCM", "KOMAFLOW_SIDECAR_HOME", "KOMAFLOW_MODELS_DIR"))
    if refresh or key not in _caps_cache:
        _caps_cache[key] = _capabilities()
    return _caps_cache[key]


def _capabilities() -> dict:
    rocm = probe_rocm()
    cpu_installed = fake() or paths.env_python(ENVS["cpu"].name).exists()
    from .catalog import MODELS

    def model_state(key: str) -> dict:
        d = paths.model_dir(key)
        marker = d / ".komaflow_model.json"
        if fake():
            return {"installed": True, "revision": "fake"}
        if marker.exists():
            try:
                return {"installed": True, "revision": json.loads(marker.read_text(encoding="utf-8")).get("revision")}
            except (OSError, json.JSONDecodeError):
                pass
        return {"installed": False, "revision": MODELS[key].revision}

    return {
        "backends": [
            {"id": "rocm", "available": bool(rocm.get("available")) and arch_supported(rocm.get("arch")),
             "device": rocm.get("device"), "arch": rocm.get("arch"), **({"error": rocm["error"]} if rocm.get("error") else {})},
            {"id": "cpu", "available": cpu_installed},
        ],
        "models": {k: model_state(k) for k in ("layout", "ocr", "lama")},
    }
