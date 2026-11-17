"""Главный координатор: окружения → модели → комбинации → отчёт."""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

from . import envs, hardware, models, paths, report
from .catalog import COMBOS, ENVS, EXCLUDED, MODEL_ORDER, MODELS, Combo
from .logutil import log, set_logfile
from .metrics import GpuSources
from .runner import kill_tree, run_worker
from .storage import RunStore

EMPTY_TEST_DATA_HELP = f"""
Каталог с тестовыми изображениями пуст: {paths.TEST_DATA}

Положите туда страницы манги (PNG, JPG или WebP) и запустите снова:
    start.bat          (или: py run_all.py)

Необязательно: собственные маски для lama-manga — test_data/masks/<имя_страницы>.png
(белое = закрасить). Без них маска строится из результата koharu-layout.
"""


def env_kind(env_name: str) -> str:
    return "rocm" if "rocm" in env_name else "dml" if "dml" in env_name else "cpu"


def parse_args(argv):
    ap = argparse.ArgumentParser(prog="run_all.py", description="Бенчмарк моделей на AMD gfx1031 / Windows")
    ap.add_argument("--resume", metavar="RUN", help="продолжить прерванный прогон: 'last' или имя каталога в runs/")
    ap.add_argument("--only", action="append", metavar="GLOB",
                    help="запускать только комбинации, подходящие под маску (напр. 'lama-manga/*', '*/rocm-*')")
    ap.add_argument("--gpu-only", action="store_true", help="только GPU-комбинации (ROCm и DirectML)")
    ap.add_argument("--cpu-only", action="store_true", help="только CPU-комбинации")
    ap.add_argument("--repeats", type=int, help="переопределить число измерений на изображение")
    ap.add_argument("--warmup", type=int, help="переопределить число прогревочных запусков")
    ap.add_argument("--timeout-scale", type=float, default=1.0, help="множитель всех таймаутов")
    ap.add_argument("--max-images", type=int, help="ограничить число изображений (для быстрой проверки)")
    ap.add_argument("--retry-failed", action="store_true",
                    help="при --resume повторить также неуспешные комбинации (прошлая попытка сохраняется как _attemptN)")
    ap.add_argument("--list", action="store_true", help="показать комбинации и выйти")
    a = ap.parse_args(argv)
    if a.gpu_only and a.cpu_only:
        ap.error("--gpu-only и --cpu-only взаимоисключающие")
    a.backends = {"rocm", "dml"} if a.gpu_only else {"cpu"} if a.cpu_only else None
    return a


def list_images() -> list[Path]:
    if not paths.TEST_DATA.exists():
        return []
    return sorted(p for p in paths.TEST_DATA.iterdir() if p.is_file() and p.suffix.lower() in paths.IMAGE_EXTS)


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def select_combos(only: list[str] | None, backends: set[str] | None = None) -> list[Combo]:
    combos = sorted(COMBOS, key=lambda c: MODEL_ORDER.index(c.model))
    if backends:
        combos = [c for c in combos if c.backend in backends]
    if only:
        combos = [c for c in combos if any(fnmatch.fnmatch(c.id, g) for g in only)]
    return combos


def smoke_test(env_name: str, logdir: Path) -> dict:
    spec = ENVS[env_name]
    py = envs.env_python(env_name)
    env = dict(os.environ, PYTHONUTF8="1", PYTHONNOUSERSITE="1")
    env.pop("PYTHONPATH", None)
    env.update(_runtime_env(env_name))
    t = time.perf_counter()
    try:
        r = subprocess.run([str(py), str(paths.WORKER_DIR / "smoke.py"), env_kind(env_name), spec.smoke],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=600)
        out = r.stdout + "\n" + r.stderr
        rc = r.returncode
    except subprocess.TimeoutExpired as e:
        out, rc = f"timeout: {e}", None
    (logdir / f"smoke_{env_name}.log").write_text(out, encoding="utf-8")
    m = re.search(r"^SMOKE_JSON (.*)$", out, re.M)
    res = json.loads(m.group(1)) if m else {"ok": False, "error": f"smoke-test не вернул результат (код {rc})"}
    if rc is not None and (rc & 0xFFFFFFFF) == 0xC0000005:
        res["error"] = (res.get("error") or "") + " ACCESS_VIOLATION (0xC0000005) в нативном коде"
    res["returncode"] = rc
    res["time_s"] = round(time.perf_counter() - t, 1)
    return res


def _runtime_env(env_name: str) -> dict[str, str]:
    """Переменные окружения только для дочерних процессов (системные не меняются)."""
    e: dict[str, str] = {}
    if env_name.startswith("paddle"):
        # Paddle (динамический граф) на Windows по умолчанию считал в 1 поток (замер: ~100% CPU = 1 ядро).
        # Даём столько же потоков, сколько PyTorch берёт сам — по числу физических ядер.
        import psutil

        n = str(psutil.cpu_count(logical=False) or 1)
        e.update(OMP_NUM_THREADS=n, MKL_NUM_THREADS=n, PADDLE_PDX_CPU_NUM_THREADS=n)
    if env_kind(env_name) == "rocm":
        cache = paths.ROOT / ".cache" / "miopen"
        cache.mkdir(parents=True, exist_ok=True)
        e.update(MIOPEN_USER_DB_PATH=str(cache), MIOPEN_CUSTOM_CACHE_DIR=str(cache))
    return e


def prepare_envs(store: RunStore, combos: list[Combo], stop: threading.Event,
                 retry_failed: bool = False) -> dict[str, str]:
    """Готовит окружения. Возвращает отображение env → фактически используемое env (с учётом fallback)."""
    logdir = store.dir / "logs"
    logdir.mkdir(exist_ok=True)
    needed = []
    for c in combos:
        if c.env not in needed:
            needed.append(c.env)
    mapping: dict[str, str] = {}
    for name in needed:
        if stop.is_set():
            break
        rec = store.state["envs"].get(name)
        stale = bool(rec and rec.get("ok") and not envs.is_ready(ENVS[rec.get("use", name)]))
        if stale:
            log(f"[env] {name}: спецификация изменилась с прошлой попытки — окружение будет обновлено")
        if rec and rec.get("final") and not stale and not (retry_failed and not (rec.get("ok") or rec.get("use"))):
            mapping[name] = rec.get("use", name) if rec.get("ok") else None
            continue
        rec = _prepare_one(name, logdir)
        if not rec["ok"]:
            fb = next((e for e in ENVS.values() if e.fallback_for == name), None)
            if fb:
                log(f"[env] {name} не прошло проверку — пробую запасное окружение {fb.name}")
                fbrec = _prepare_one(fb.name, logdir)
                rec["fallback"] = fbrec
                if fbrec["ok"]:
                    rec["use"] = fb.name
        rec["final"] = True
        store.state["envs"][name] = rec
        store.save()
        mapping[name] = rec.get("use", name) if (rec["ok"] or rec.get("use")) else None
    return mapping


def _prepare_one(name: str, logdir: Path) -> dict:
    spec = ENVS[name]
    rec: dict = {"env": name, "runtime": spec.runtime, "python_requested": spec.python}
    try:
        info = envs.ensure_env(spec, logdir / f"install_{name}.log")
        rec.update(info)
        (logdir / f"freeze_{name}.txt").write_text(info.get("freeze", ""), encoding="utf-8")
        rec.pop("freeze", None)
    except Exception as e:
        rec.update(ok=False, stage="install", error=f"{type(e).__name__}: {e}")
        log(f"[env] {name}: установка не удалась: {e}")
        return rec
    log(f"[env] {name}: smoke-test устройства")
    sm = smoke_test(name, logdir)
    rec["smoke"] = sm
    rec["ok"] = bool(sm.get("ok"))
    if not rec["ok"]:
        rec["stage"] = "smoke"
        rec["error"] = sm.get("error")
        log(f"[env] {name}: smoke-test не пройден: {sm.get('error')}")
    else:
        log(f"[env] {name}: OK ({sm.get('device') or sm.get('torch') or sm.get('paddle')})")
    return rec


def build_masks(store: RunStore, images: list[dict]) -> dict[str, dict]:
    """Маски для lama-manga: пользовательские приоритетнее, иначе из эталонного прогона layout.

    Маска страницы строится ОДИН раз за прогон и дальше не меняется (в т.ч. при --resume),
    чтобы все backend lama-manga получали одинаковый вход.
    """
    out: dict[str, dict] = dict(store.state.get("masks") or {})
    mdir = store.dir / "masks"
    order = ["koharu-layout/cpu-fp32"] + [c.id for c in COMBOS if c.model == "koharu-layout" and c.id != "koharu-layout/cpu-fp32"]
    for img in images:
        stem = Path(img["name"]).stem
        if img["name"] in out and Path(out[img["name"]]["path"]).exists():
            continue
        user = paths.USER_MASKS / f"{stem}.png"
        if user.exists():
            mdir.mkdir(exist_ok=True)
            dst = mdir / f"{stem}.png"
            shutil.copy2(user, dst)
            out[img["name"]] = {"path": str(dst), "source": f"пользовательская: {user}"}
            continue
        for cid in order:
            rec = store.state["combos"].get(cid)
            if not rec or rec.get("status") != "ok":
                continue
            src = store.dir / rec["dir"] / "outputs" / stem / "lama_mask.png"
            if src.exists():
                mdir.mkdir(exist_ok=True)
                dst = mdir / f"{stem}.png"
                shutil.copy2(src, dst)
                out[img["name"]] = {"path": str(dst), "source": f"koharu-layout: {cid}"}
                break
    return out


def run_combo(store: RunStore, c: Combo, env_used: str, images: list[dict], model_info: dict, args,
              sources: GpuSources, cpu_count: int, stop: threading.Event, masks: dict) -> dict:
    out_dir = store.prepare_combo_dir(c.model, c.dir_name)
    rel = out_dir.relative_to(store.dir).as_posix()
    spec = MODELS[c.model]
    warmup = args.warmup if args.warmup is not None else c.warmup
    repeats = args.repeats if args.repeats is not None else c.repeats
    job = {"combo": c.to_dict(), "adapter": spec.adapter, "framework": c.framework, "backend": c.backend,
           "model_dir": model_info["local_dir"], "model_repo": spec.repo, "model_revision": spec.revision,
           "out_dir": str(out_dir), "images": images, "warmup": warmup, "repeats": repeats,
           "params": c.params, "seed": 0, "masks": {k: v["path"] for k, v in masks.items()}}
    (out_dir / "job.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    n = len(images)
    # per_image_timeout_s — бюджет на один вызов инференса
    hard = (c.load_timeout_s + c.per_image_timeout_s * (warmup + n * repeats)) * args.timeout_scale
    stall = (max(c.load_timeout_s, c.per_image_timeout_s) + 300) * args.timeout_scale
    log(f"[run] {c.id}  — пропустить досрочно: создайте файл {store.dir / 'STOP_CURRENT'}")
    log(f"[run] {c.id}  (env={env_used}, изображений={n}, warmup={warmup}, repeats={repeats}, "
        f"таймаут={hard / 60:.0f} мин)")
    outcome = run_worker(envs.env_python(env_used), out_dir / "job.json", out_dir, sources, cpu_count,
                         hard_timeout_s=hard, stall_timeout_s=stall, extra_env=_runtime_env(env_used), stop_flag=stop,
                         skip_file=store.dir / "STOP_CURRENT")
    res_path = out_dir / "result.json"
    worker_res = json.loads(res_path.read_text(encoding="utf-8")) if res_path.exists() else {}
    status = outcome.status
    reason = outcome.reason
    if status == "ok":
        status = worker_res.get("status", "failed")
        if status != "ok":
            reason = worker_res.get("reason") or reason
    elif worker_res.get("reason") and status == "failed":
        reason = worker_res["reason"]
    rec = {"id": c.id, "model": c.model, "backend": c.backend, "variant": c.variant, "support": c.support,
           "env": c.env, "env_used": env_used, "framework": c.framework, "notes": c.notes,
           "status": status, "reason": reason, "failed_phase": worker_res.get("failed_phase"),
           "dir": rel, "wall_time_s": outcome.wall_time_s, "returncode": outcome.returncode,
           "metrics": outcome.metrics, "final": status != "interrupted",
           "finished": time.strftime("%Y-%m-%d %H:%M:%S")}
    store.write_json(f"{rel}/combo_summary.json", {**rec, "worker_result": worker_res})
    log(f"[run] {c.id}: {status}" + (f" — {reason}" if reason else ""))
    return rec


def main(argv) -> int:
    args = parse_args(argv)
    if args.list:
        for c in select_combos(args.only, args.backends):
            print(f"{c.id:32s} env={c.env:12s} support={c.support:12s} {c.notes[:80]}")
        return 0

    images_p = list_images()
    if not images_p:
        print(EMPTY_TEST_DATA_HELP)
        return 0
    if args.max_images:
        images_p = images_p[: args.max_images]

    store = RunStore.open(args.resume) if args.resume else RunStore.new()
    set_logfile(store.dir / "logs" / "orchestrator.log")
    log(f"Прогон: {store.dir}" + ("" if store.created else " (возобновление)"))

    stop = threading.Event()

    def on_sigint(signum, frame):
        if stop.is_set():
            log("Повторный Ctrl+C — немедленный выход")
            os._exit(130)
        log("Ctrl+C: останавливаю текущий тест, сохраняю результаты (ещё раз Ctrl+C — выход без сохранения)")
        stop.set()

    signal.signal(signal.SIGINT, on_sigint)

    images = [{"name": p.name, "path": str(p), "bytes": p.stat().st_size, "sha256": sha256(p)} for p in images_p]
    combos = select_combos(args.only, args.backends)

    if store.created or "hardware" not in store.state:
        log("Проверка оборудования и ПО")
        hw = hardware.probe()
        store.state["hardware"] = hw
        store.state["args"] = vars(args)
        store.state["images"] = images
        store.state["excluded"] = EXCLUDED
        store.save()
    hw = store.state["hardware"]
    gpu = hardware.amd_gpu_summary(hw)
    log(f"GPU: {gpu}  CPU: {hw['cpu']['name']}")
    # Бенчмарк и lock-версии проверены на Navi 22 (gfx1031). На другом железе всё равно запускаемся,
    # но честно предупреждаем, что результаты несопоставимы, а ROCm-пакет device-gfx1031 может не подойти.
    if not any(k in (gpu.get("name") or "") for k in ("6700", "6750")):
        warn = (f"ВНИМАНИЕ: GPU «{gpu.get('name')}» — не RX 6700/6750 XT (gfx1031), для которой собраны и "
                "проверены окружения. ROCm-комбинации могут не работать, результаты несопоставимы.")
        log(warn)
        store.state.setdefault("warnings", [])
        if warn not in store.state["warnings"]:
            store.state["warnings"].append(warn)
            store.save()

    # --- модели
    store.state.setdefault("models", {})
    for key in dict.fromkeys(c.model for c in combos):
        if key in store.state["models"] and "local_dir" in store.state["models"][key]:
            continue
        try:
            store.state["models"][key] = models.download(MODELS[key])
        except Exception as e:
            store.state["models"][key] = {"error": f"{type(e).__name__}: {e}"}
            log(f"[model] {key}: ошибка загрузки: {e}")
        store.save()

    # --- окружения
    t_env = time.perf_counter()
    mapping = prepare_envs(store, combos, stop, retry_failed=args.retry_failed)
    store.state.setdefault("env_prepare_total_s", round(time.perf_counter() - t_env, 1))
    store.save()

    sources = GpuSources(hw["cpu"].get("base_clock_mhz"))
    store.state["metric_sources_errors"] = sources.errors
    cpu_count = hw["cpu"].get("threads") or os.cpu_count() or 1

    masks: dict = {}
    try:
        for c in combos:
            if stop.is_set():
                break
            prev = store.state["combos"].get(c.id) or {}
            if store.is_done(c.id) and not (args.retry_failed and prev.get("status") != "ok"):
                log(f"[skip] {c.id}: уже выполнено в этом прогоне")
                continue
            minfo = store.state["models"].get(c.model, {})
            env_used = mapping.get(c.env)
            base = {"id": c.id, "model": c.model, "backend": c.backend, "variant": c.variant, "support": c.support,
                    "env": c.env, "framework": c.framework, "notes": c.notes, "final": True,
                    "dir": f"{c.model}/{c.dir_name}"}
            if "local_dir" not in minfo:
                store.set_combo(c.id, {**base, "status": "not_tested", "reason": f"модель не скачана: {minfo.get('error')}"})
                continue
            if not env_used:
                er = store.state["envs"].get(c.env, {})
                store.set_combo(c.id, {**base, "status": "not_tested",
                                       "reason": f"окружение {c.env} недоступно ({er.get('stage')}): {er.get('error')}"})
                log(f"[skip] {c.id}: окружение {c.env} недоступно")
                continue
            if c.model == "lama-manga":
                masks = build_masks(store, images)
                store.state["masks"] = masks
                if not masks:
                    store.set_combo(c.id, {**base, "status": "not_tested",
                                           "reason": "нет масок: koharu-layout не дал результата, а test_data/masks/ пуст"})
                    continue
            rec = run_combo(store, c, env_used, images, minfo, args, sources, cpu_count, stop, masks)
            if env_used != c.env:
                rec["notes"] += f" [запущено в запасном окружении {env_used}]"
                rec["support"] = "experimental"
            store.set_combo(c.id, rec)
            report.generate(store)
            if stop.is_set():
                break
    finally:
        report.generate(store)
        log(f"Отчёт: {store.dir / 'summary.html'}")
    if stop.is_set():
        log(f"Прогон прерван. Продолжить: py run_all.py --resume {store.dir.name}")
        return 130
    return 0


__all__ = ["main", "kill_tree"]
