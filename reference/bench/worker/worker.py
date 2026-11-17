"""Воркер: исполняется ВНУТРИ окружения конкретной комбинации.

Протокол с оркестратором:
  вход   — job.json (путь аргументом)
  выход  — progress.jsonl (события фаз, по строке), result.json (обновляется после
           каждого изображения → частичные результаты не теряются), outputs/<изображение>/...
Код возврата 0 — успех хотя бы на одном изображении; иначе 1.
"""
from __future__ import annotations

import importlib
import json
import sys
import time
import traceback
import warnings
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent))  # корень проекта: для bench.stats (stdlib)

from bench.stats import describe  # noqa: E402

import backends  # noqa: E402


class Events:
    def __init__(self, path: Path):
        self.f = path.open("a", encoding="utf-8")

    def emit(self, **kw) -> None:
        kw["t"] = time.time()
        self.f.write(json.dumps(kw, ensure_ascii=False) + "\n")
        self.f.flush()


def main(job_path: str) -> int:
    job = json.loads(Path(job_path).read_text(encoding="utf-8"))
    out_dir = Path(job["out_dir"])
    ev = Events(out_dir / "progress.jsonl")
    result: dict = {"status": "running", "combo": job["combo"], "images": [], "warnings": [],
                    "environment": backends.environment_info(), "timings": {}}
    res_path = out_dir / "result.json"

    def save():
        tmp = res_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        tmp.replace(res_path)

    caught: list[warnings.WarningMessage] = []

    def flush_warnings():
        for w in caught:
            msg = f"{w.category.__name__}: {w.message}"
            if msg not in result["warnings"]:
                result["warnings"].append(msg)
        caught.clear()

    old_showwarning = warnings.showwarning

    def showwarning(message, category, filename, lineno, file=None, line=None):
        caught.append(warnings.WarningMessage(message, category, filename, lineno, file, line))
        old_showwarning(message, category, filename, lineno, file, line)

    warnings.showwarning = showwarning
    warnings.simplefilter("always")
    phase = "imports"
    try:
        ev.emit(phase=phase)
        t = time.perf_counter()
        be = backends.make(job["framework"], job["backend"], job.get("seed", 0))
        adapter_mod = importlib.import_module(f"adapters.{job['adapter']}")
        adapter = adapter_mod.Adapter(be, job)
        result["timings"]["import_and_device_init_s"] = time.perf_counter() - t
        result["backend_info"] = be.info
        result["packages"] = backends.pkg_versions(adapter_mod.PACKAGES)
        save()

        phase = "load"
        ev.emit(phase=phase)
        be.reset_peak()
        t = time.perf_counter()
        adapter.load(Path(job["model_dir"]))
        be.sync()
        result["timings"]["model_load_s"] = time.perf_counter() - t
        result["memory_after_load"] = be.mem()
        result["model_info"] = adapter.model_info()
        flush_warnings()
        save()

        # --- подготовка входов (не входит во время инференса)
        phase = "prepare"
        ev.emit(phase=phase)
        prepared = []
        for img in job["images"]:
            rec = {"name": img["name"], "source": img["path"]}
            try:
                t = time.perf_counter()
                raw = adapter.read_image(Path(img["path"]))
                rec["image_load_s"] = time.perf_counter() - t
                t = time.perf_counter()
                inp, meta = adapter.prepare(raw, img)
                rec["prepare_s"] = time.perf_counter() - t
                rec["input"] = meta
                prepared.append((rec, inp))
            except adapter_mod.SkipImage as e:
                rec["status"] = "skipped"
                rec["reason"] = str(e)
                result["images"].append(rec)
        save()
        if not prepared:
            raise RuntimeError("нет изображений, пригодных для этой модели: "
                               + "; ".join(r.get("reason", "") for r in result["images"]))

        # --- прогрев на первом изображении
        phase = "warmup"
        ev.emit(phase=phase, n=job["warmup"])
        warm = []
        first_rec, first_inp = prepared[0]
        for i in range(max(1, job["warmup"])):
            be.reset_peak()
            t = time.perf_counter()
            adapter.infer(first_inp)
            be.sync()
            dt = time.perf_counter() - t
            if i == 0:
                result["timings"]["first_inference_s"] = dt
                result["timings"]["first_inference_image"] = first_rec["name"]
            else:
                warm.append(dt)
            ev.emit(phase=phase, i=i, dt=dt)
        result["timings"]["warmup_extra_s"] = warm
        result["memory_after_warmup"] = be.mem()
        flush_warnings()
        save()

        # --- измерения
        phase = "measure"
        ev.emit(phase=phase)
        all_times: list[float] = []
        ok_images = 0
        for rec, inp in prepared:
            times: list[float] = []
            try:
                be.reset_peak()
                out = None
                for r in range(job["repeats"]):
                    t = time.perf_counter()
                    out = adapter.infer(inp)
                    be.sync()
                    dt = time.perf_counter() - t
                    times.append(dt)
                    ev.emit(phase=phase, image=rec["name"], rep=r, dt=dt)
                rec["memory"] = be.mem()
                rec["times_s"] = times
                img_dir = out_dir / "outputs" / Path(rec["name"]).stem
                img_dir.mkdir(parents=True, exist_ok=True)
                t = time.perf_counter()
                rec["outputs"] = adapter.save(out, img_dir, rec)
                rec["save_s"] = time.perf_counter() - t
                rec["status"] = "ok"
                ok_images += 1
            except Exception as e:  # ошибка на одном изображении не роняет остальные
                rec["status"] = "failed"
                rec["reason"] = f"{type(e).__name__}: {e}"
                rec["traceback"] = traceback.format_exc()
                ev.emit(phase=phase, image=rec["name"], error=rec["reason"])
                if hasattr(be, "torch") and be.kind == "rocm":
                    be.torch.cuda.empty_cache()
            rec["times_s"] = times
            rec["stats"] = describe(times)
            all_times.extend(times)
            result["images"].append(rec)
            flush_warnings()
            save()

        result["timings"]["inference_all"] = describe(all_times)
        result["status"] = "ok" if ok_images else "failed"
        if not ok_images:
            result["reason"] = "ни одно изображение не обработано успешно"
        result["fallback_to_cpu_detected"] = any("fall back" in w.lower() or "fallback" in w.lower()
                                                 for w in result["warnings"])
        ev.emit(phase="done")
        save()
        return 0 if ok_images else 1
    except BaseException as e:
        flush_warnings()
        result["status"] = "failed"
        result["failed_phase"] = phase
        result["reason"] = f"{type(e).__name__}: {e}"
        if isinstance(e, UnicodeDecodeError) and isinstance(e.object, (bytes, bytearray)):
            # torch-directml пытается декодировать локализованное (cp1251) сообщение Windows как UTF-8
            try:
                native = bytes(e.object).decode("cp1251", errors="replace").strip()
                result["reason"] = f"Ошибка runtime (сообщение Windows, cp1251): {native}"
            except Exception:
                pass
        result["traceback"] = traceback.format_exc()
        ev.emit(phase="error", failed_phase=phase, error=result["reason"])
        save()
        traceback.print_exc()
        return 1
    finally:
        ev.f.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
