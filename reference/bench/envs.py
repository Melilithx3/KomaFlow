"""Изолированные Python-окружения через uv.

* Интерпретаторы скачивает uv в .tools/python (глобальный Python не трогается).
* Каждое окружение — .envs/<name>; после установки пишется .bench_env.json
  (хэш спецификации, время установки, pip freeze). Повторный запуск с той же
  спецификацией переиспользует окружение.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
from dataclasses import asdict
from pathlib import Path

from . import paths
from .catalog import PYPI, EnvSpec
from .logutil import log

MARKER_NAME = ".bench_env.json"


def uv_bin() -> str:
    from uv import find_uv_bin  # пакет uv установлен в .tools/venv

    return find_uv_bin()


def uv_env() -> dict[str, str]:
    env = dict(os.environ)
    env.update(
        UV_CACHE_DIR=str(paths.UV_CACHE),
        UV_PYTHON_INSTALL_DIR=str(paths.UV_PYTHON),
        UV_NO_PROGRESS="1",
        UV_LINK_MODE="copy",
        PYTHONUTF8="1",
    )
    # не даём внешним настройкам pip/uv пользователя влиять на воспроизводимость
    for k in ("UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "VIRTUAL_ENV", "PYTHONPATH"):
        env.pop(k, None)
    return env


def env_dir(name: str) -> Path:
    return paths.ENVS / name


def env_python(name: str) -> Path:
    return env_dir(name) / "Scripts" / "python.exe"


def spec_hash(spec: EnvSpec) -> str:
    return hashlib.sha256(json.dumps(asdict(spec), sort_keys=True).encode()).hexdigest()[:16]


LOCKS = paths.ROOT / "bench" / "locks"


def read_lock(name: str) -> tuple[str | None, dict[str, str]]:
    """bench/locks/<env>.txt — точные версии Python и всех пакетов проверенного окружения.
    Возвращает (версия Python, {нормализованное имя пакета: «имя==версия»})."""
    p = LOCKS / f"{name}.txt"
    if not p.exists():
        return None, {}
    py = None
    pins: dict[str, str] = {}
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("# python=="):
            py = line.split("==", 1)[1].strip()
        elif line and not line.startswith("#") and "==" in line:
            pins[_norm(line.split("==", 1)[0])] = line
    return py, pins


def _norm(pkg: str) -> str:
    return pkg.strip().lower().replace("_", "-")


def _freeze_map(text: str) -> dict[str, str]:
    return {_norm(ln.split("==", 1)[0]): ln.strip() for ln in text.splitlines() if "==" in ln}


def lock_matches(spec: EnvSpec, marker: dict) -> bool:
    """Окружение соответствует lock-файлу (если lock есть)."""
    _, pins = read_lock(spec.name)
    if not pins:
        return True
    have = _freeze_map(marker.get("freeze", ""))
    return all(have.get(k, "").lower() == v.lower() for k, v in pins.items())


def read_marker(name: str) -> dict | None:
    p = env_dir(name) / MARKER_NAME
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def is_ready(spec: EnvSpec) -> bool:
    m = read_marker(spec.name)
    return bool(m and m.get("spec_hash") == spec_hash(spec) and env_python(spec.name).exists()
                and lock_matches(spec, m))


def freeze(name: str) -> str:
    r = subprocess.run(
        [uv_bin(), "pip", "freeze", "--python", str(env_python(name))],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=uv_env(),
    )
    return r.stdout


def _run(cmd: list[str], logfile: Path, timeout: int) -> None:
    with logfile.open("a", encoding="utf-8") as f:
        f.write(f"\n$ {' '.join(cmd)}\n")
        f.flush()
        p = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT, env=uv_env(), timeout=timeout)
    if p.returncode != 0:
        tail = logfile.read_text(encoding="utf-8", errors="replace").splitlines()[-25:]
        raise RuntimeError(f"команда завершилась с кодом {p.returncode}:\n" + "\n".join(tail))


def ensure_env(spec: EnvSpec, logfile: Path, timeout: int = 4 * 3600) -> dict:
    """Создаёт (или переиспользует) окружение. Межпроцессная блокировка на время установки."""
    import psutil

    paths.ENVS.mkdir(parents=True, exist_ok=True)
    lock = paths.ENVS / f".{spec.name}.lock"
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            break
        except FileExistsError:
            try:
                holder = int(lock.read_text().strip() or 0)
            except (OSError, ValueError):
                holder = 0
            if holder and psutil.pid_exists(holder):
                log(f"[env] {spec.name}: устанавливается другим процессом (pid {holder}), жду")
                time.sleep(15)
            else:
                lock.unlink(missing_ok=True)  # осиротевшая блокировка после аварии
    try:
        return _ensure_env_locked(spec, logfile, timeout)
    finally:
        lock.unlink(missing_ok=True)


def _ensure_env_locked(spec: EnvSpec, logfile: Path, timeout: int) -> dict:
    if is_ready(spec):
        m = read_marker(spec.name) or {}
        return {"env": spec.name, "reused": True, "prepare_time_s": 0.0,
                "original_install_time_s": m.get("install_time_s"), "python": m.get("python"),
                "freeze": m.get("freeze", "")}

    need = spec.approx_size_gb * 1.5 + 2
    free = shutil.disk_usage(paths.ROOT).free / 2**30
    if free < need:
        raise RuntimeError(f"недостаточно места: нужно ~{need:.1f} ГБ, свободно {free:.1f} ГБ")

    d = env_dir(spec.name)
    if d.exists():
        # незавершённая/устаревшая установка нашего же окружения — пересоздаём
        log(f"[env] {spec.name}: окружение устарело или не достроено, пересоздаю")
        shutil.rmtree(d)
    paths.ENVS.mkdir(parents=True, exist_ok=True)
    logfile.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    lock_py, lock_pins = read_lock(spec.name)
    python = lock_py or spec.python
    log(f"[env] {spec.name}: создаю venv (Python {python})"
        + (f"; точные версии пакетов из bench/locks/{spec.name}.txt ({len(lock_pins)} шт.)" if lock_pins else ""))
    _run([uv_bin(), "venv", "--python", python, "--python-preference", "only-managed", "--seed", str(d)],
         logfile, timeout=900)
    py = str(env_python(spec.name))
    for i, step in enumerate(spec.steps):
        log(f"[env] {spec.name}: шаг {i + 1}/{len(spec.steps)}: {' '.join(step.packages)}")
        cmd = [uv_bin(), "pip", "install", "--python", py, "--index-url", PYPI]
        if spec.extra_index:
            cmd += ["--extra-index-url", spec.extra_index]
        if step.prerelease:
            cmd += ["--prerelease", "allow"]
        cons = dict(lock_pins)  # lock — точные версии всего окружения
        if step.pin_installed:
            inst = _installed_versions(spec.name)
            for p in step.pin_installed:
                if p in inst and p not in cons:
                    cons[p] = f"{p}=={inst[p]}"
        if cons:
            cfile = d / f".constraints_step{i}.txt"
            cfile.write_text("\n".join(cons.values()) + "\n", encoding="utf-8")
            cmd += ["--constraint", str(cfile)]
        _run(cmd + list(step.packages), logfile, timeout=timeout)
    elapsed = time.perf_counter() - t0
    pyver = subprocess.run([py, "-c", "import sys;print(sys.version)"], capture_output=True, text=True).stdout.strip()
    frz = freeze(spec.name)
    marker = {"spec_hash": spec_hash(spec), "spec": asdict(spec), "install_time_s": round(elapsed, 1),
              "created": time.strftime("%Y-%m-%d %H:%M:%S"), "python": pyver, "freeze": frz}
    (d / MARKER_NAME).write_text(json.dumps(marker, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"[env] {spec.name}: готово за {elapsed:.0f} с")
    return {"env": spec.name, "reused": False, "prepare_time_s": round(elapsed, 1),
            "original_install_time_s": round(elapsed, 1), "python": pyver, "freeze": frz}


def _installed_versions(name: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in freeze(name).splitlines():
        if "==" in line:
            k, v = line.split("==", 1)
            out[k.strip().lower().replace("_", "-")] = v.strip()
    return out
