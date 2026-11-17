"""summary.html / summary.json / summary.csv. Генерируется после каждой комбинации (crash-safe)."""
from __future__ import annotations

import csv
import html
import json
from pathlib import Path

from .catalog import ENVS, EXCLUDED, MODEL_ORDER, MODELS
from .hardware import amd_gpu_summary

STATUS_RU = {"ok": "успех", "failed": "ошибка", "timeout": "таймаут", "stalled": "зависание",
             "interrupted": "прервано", "not_tested": "не проверено",
             "skipped": "остановлено досрочно"}
SUPPORT_RU = {"official": "официально", "unofficial": "неофициально", "experimental": "экспериментально"}

CSV_COLS = [
    "id", "model", "backend", "variant", "support", "status", "reason", "env_used", "runtime",
    "images_ok", "images_total", "import_s", "model_load_s", "first_inference_s",
    "mean_s", "median_s", "min_s", "max_s", "p95_s", "n_measurements",
    "peak_proc_rss_mb", "peak_proc_private_mb", "peak_gpu_proc_dedicated_mb", "peak_gpu_proc_shared_mb",
    "peak_gpu_adapter_delta_mb", "torch_peak_reserved_mb", "torch_peak_allocated_mb",
    "avg_proc_cpu_pct_of_total", "avg_gpu_util_pct", "avg_gpu_activity_pct", "peak_gpu_temp_hotspot_c",
    "avg_gpu_power_w", "avg_gpu_clock_mhz", "avg_cpu_freq_mhz", "cpu_fallback_detected", "wall_time_s", "dir",
]


def _load_detail(run_dir: Path, rec: dict) -> dict:
    p = run_dir / rec.get("dir", "") / "combo_summary.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8")).get("worker_result", {})
        except (OSError, json.JSONDecodeError):
            pass
    return {}


def _row(rec: dict, det: dict, env_rec: dict) -> dict:
    t = det.get("timings", {})
    inf = t.get("inference_all", {}) or {}
    m = (rec.get("metrics") or {}).get("whole_run", {})
    mi = (rec.get("metrics") or {}).get("inference", {})
    peaks_r = [i.get("memory", {}).get("torch_peak_reserved_mb") for i in det.get("images", [])]
    peaks_a = [i.get("memory", {}).get("torch_peak_allocated_mb") for i in det.get("images", [])]
    peaks_r += [(det.get("memory_after_warmup") or {}).get("torch_peak_reserved_mb")]
    peaks_a += [(det.get("memory_after_warmup") or {}).get("torch_peak_allocated_mb")]
    imgs = det.get("images", [])
    return {
        "id": rec["id"], "model": rec["model"], "backend": rec["backend"], "variant": rec["variant"],
        "support": rec.get("support"), "status": rec.get("status"), "reason": rec.get("reason"),
        "env_used": rec.get("env_used") or rec.get("env"),
        "runtime": ENVS.get(rec.get("env_used") or rec.get("env"), None).runtime if ENVS.get(rec.get("env_used") or rec.get("env")) else None,
        "images_ok": sum(1 for i in imgs if i.get("status") == "ok"), "images_total": len(imgs),
        "import_s": t.get("import_and_device_init_s"), "model_load_s": t.get("model_load_s"),
        "first_inference_s": t.get("first_inference_s"),
        "mean_s": inf.get("mean"), "median_s": inf.get("median"), "min_s": inf.get("min"), "max_s": inf.get("max"),
        "p95_s": inf.get("p95"), "n_measurements": inf.get("n"),
        "peak_proc_rss_mb": m.get("peak_proc_rss_mb"), "peak_proc_private_mb": m.get("peak_proc_private_mb"),
        "peak_gpu_proc_dedicated_mb": m.get("peak_gpu_proc_dedicated_mb"),
        "peak_gpu_proc_shared_mb": m.get("peak_gpu_proc_shared_mb"),
        "peak_gpu_adapter_delta_mb": m.get("peak_gpu_adapter_delta_mb"),
        "torch_peak_reserved_mb": max([x for x in peaks_r if x is not None], default=None),
        "torch_peak_allocated_mb": max([x for x in peaks_a if x is not None], default=None),
        "avg_proc_cpu_pct_of_total": mi.get("avg_proc_cpu_pct_of_total"),
        "avg_gpu_util_pct": mi.get("avg_gpu_util_pct"), "avg_gpu_activity_pct": mi.get("avg_gpu_activity_pct"),
        "peak_gpu_temp_hotspot_c": mi.get("peak_gpu_temp_hotspot_c"), "avg_gpu_power_w": mi.get("avg_gpu_power_w"),
        "avg_gpu_clock_mhz": mi.get("avg_gpu_clock_mhz"), "avg_cpu_freq_mhz": mi.get("avg_cpu_freq_mhz"),
        "cpu_fallback_detected": det.get("fallback_to_cpu_detected"), "wall_time_s": rec.get("wall_time_s"),
        "dir": rec.get("dir"),
    }


def generate(store) -> None:
    st = store.state
    run_dir: Path = store.dir
    order = {k: i for i, k in enumerate(MODEL_ORDER)}
    recs = sorted(st.get("combos", {}).values(), key=lambda r: (order.get(r["model"], 99), r["id"]))
    details = {r["id"]: _load_detail(run_dir, r) for r in recs}
    rows = [_row(r, details[r["id"]], st.get("envs", {}).get(r.get("env"), {})) for r in recs]

    full = {"run_dir": str(run_dir), "created": st.get("created"), "resumed": st.get("resumed"),
            "args": st.get("args"), "hardware": st.get("hardware"), "images": st.get("images"),
            "models": st.get("models"), "envs": st.get("envs"), "env_prepare_total_s": st.get("env_prepare_total_s"),
            "metric_sources_errors": st.get("metric_sources_errors"), "masks": st.get("masks"),
            "excluded": EXCLUDED, "combos": [{**r, "worker_result": details[r["id"]]} for r in recs]}
    (run_dir / "summary.json").write_text(json.dumps(full, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    with (run_dir / "summary.csv").open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLS, delimiter=";")
        w.writeheader()
        for r in rows:
            w.writerow({k: (f"{v:.4f}".replace(".", ",") if isinstance(v, float) else v) for k, v in r.items()})
    (run_dir / "summary.html").write_text(_html(st, recs, rows, details), encoding="utf-8")


# ----------------------------------------------------------------------------- HTML

def _f(v, nd=2, suf=""):
    if v is None or v == "":
        return '<span class="na">н/д</span>'
    if isinstance(v, float):
        return f"{v:.{nd}f}{suf}"
    return f"{html.escape(str(v))}{suf}"


def _mb(v):
    return _f(v / 1024, 2, " ГБ") if isinstance(v, (int, float)) else _f(None)


def _badge(status):
    return f'<span class="b b-{html.escape(status or "")}">{STATUS_RU.get(status, status)}</span>'


def _sup(s):
    return f'<span class="s s-{html.escape(s or "")}">{SUPPORT_RU.get(s, s)}</span>'


CSS = """
:root{--bg:#fafaf9;--fg:#1c1917;--mut:#78716c;--card:#fff;--line:#e7e5e4;--ok:#15803d;--bad:#b91c1c;--warn:#b45309;--acc:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--mut:#a8a29e;--card:#292524;--line:#44403c;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--acc:#93c5fd}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,Segoe UI,sans-serif;margin:0;padding:16px 24px 60px}
h1{font-size:22px;margin:4px 0 2px}h2{font-size:18px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:15px;margin:18px 0 6px}.mut,.na{color:var(--mut)}a{color:var(--acc)}
table{border-collapse:collapse;width:100%;background:var(--card);margin:6px 0 14px;font-size:13px}
th,td{border:1px solid var(--line);padding:4px 7px;text-align:left;vertical-align:top}th{position:sticky;top:0;background:var(--card)}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.wrap{overflow-x:auto}
.b,.s{display:inline-block;padding:1px 7px;border-radius:9px;font-size:12px;border:1px solid currentColor;white-space:nowrap}
.b-ok{color:var(--ok)}.b-failed,.b-timeout,.b-stalled{color:var(--bad)}.b-not_tested,.b-interrupted,.b-skipped{color:var(--warn)}
.s-official{color:var(--ok)}.s-unofficial{color:var(--warn)}.s-experimental{color:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.cell{background:var(--card);border:1px solid var(--line);padding:6px}.cell img{width:100%;height:auto;display:block}
pre{white-space:pre-wrap;max-height:220px;overflow:auto;background:var(--bg);border:1px solid var(--line);padding:6px;font-size:12px}
details{margin:4px 0}.kv td:first-child{width:260px;color:var(--mut)}
"""


def _section_table(title, rows, note=""):
    if not rows:
        return f"<h3>{title}</h3><p class='mut'>нет</p>"
    h = [f"<h3>{title}</h3>", f"<p class='mut'>{note}</p>" if note else "", "<div class='wrap'><table><tr>",
         "<th>Комбинация</th><th>Поддержка</th><th>Загрузка, с</th><th>1-й инференс, с</th><th>Медиана, с</th>"
         "<th>Среднее, с</th><th>Мин/Макс, с</th><th>Пик VRAM процесса</th><th>Пик RAM (RSS)</th>"
         "<th>GPU, %</th><th>CPU, % от всех ядер</th><th>Результаты</th></tr>"]
    for r in rows:
        h.append(
            f"<tr><td>{html.escape(r['id'])}</td><td>{_sup(r['support'])}</td><td class=n>{_f(r['model_load_s'])}</td>"
            f"<td class=n>{_f(r['first_inference_s'])}</td><td class=n>{_f(r['median_s'], 3)}</td>"
            f"<td class=n>{_f(r['mean_s'], 3)}</td><td class=n>{_f(r['min_s'], 3)} / {_f(r['max_s'], 3)}</td>"
            f"<td class=n>{_mb(r['peak_gpu_proc_dedicated_mb'])}</td><td class=n>{_mb(r['peak_proc_rss_mb'])}</td>"
            f"<td class=n>{_f(r['avg_gpu_util_pct'], 0)}</td><td class=n>{_f(r['avg_proc_cpu_pct_of_total'], 0)}</td>"
            f"<td><a href='{html.escape(r['dir'])}/'>каталог</a></td></tr>")
    h.append("</table></div>")
    return "".join(h)


def _html(st, recs, rows, details) -> str:
    hw = st.get("hardware", {})
    gpu = amd_gpu_summary(hw) if hw else {}
    by_id = {r["id"]: r for r in rows}
    ok = [r for r in rows if r["status"] == "ok"]
    gpu_ok = [r for r in ok if r["backend"] != "cpu"]
    cpu_ok = [r for r in ok if r["backend"] == "cpu"]
    workaround_ok = [r for r in ok if r["support"] in ("unofficial", "experimental")]
    failed = [r for r in rows if r["status"] in ("failed", "timeout", "stalled")]
    untested = [r for r in rows if r["status"] in ("not_tested", "interrupted", "skipped")]

    h = [f"<!doctype html><html lang=ru><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
         f"<title>Бенчмарк gfx1031</title><style>{CSS}</style></head><body>"]
    h.append("<h1>Бенчмарк моделей на AMD gfx1031 / Windows</h1>")
    h.append(f"<p class=mut>Прогон создан {html.escape(str(st.get('created')))}"
             + (f", возобновлялся: {html.escape(', '.join(st.get('resumed') or []))}" if st.get("resumed") else "")
             + f". Успешным считается только реальный инференс на тестовом изображении.</p>")

    for w in st.get("warnings") or []:
        h.append(f"<p style='border:1px solid var(--warn);color:var(--warn);padding:8px'>{html.escape(w)}</p>")

    # --- система
    cpu = hw.get("cpu", {})
    osw = (hw.get("os") or {}).get("wmi") or {}
    h.append("<h2>Система</h2><table class=kv>")
    for k, v in [("ОС", f"{osw.get('Caption', '')} {osw.get('Version', '')}"),
                 ("GPU", f"{gpu.get('name')} · {gpu.get('vram_gb')} ГБ · драйвер {gpu.get('driver_version')} ({gpu.get('driver_date')})"),
                 ("CPU", f"{cpu.get('name')} · {cpu.get('cores')}C/{cpu.get('threads')}T · база {cpu.get('base_clock_mhz')} МГц"),
                 ("RAM", f"{(hw.get('ram') or {}).get('total_mb', 0) / 1024:.1f} ГБ"),
                 ("Сенсоры AMD (ADL)", "доступны" if (hw.get("adl") or {}).get("available") else f"недоступны: {(hw.get('adl') or {}).get('error')}"),
                 ("Ошибки источников метрик", json.dumps(st.get("metric_sources_errors") or {}, ensure_ascii=False)),
                 ("Изображения", ", ".join(i["name"] for i in st.get("images", []))),
                 ("Подготовка окружений (этот прогон)", f"{st.get('env_prepare_total_s')} с")]:
        h.append(f"<tr><td>{k}</td><td>{html.escape(str(v))}</td></tr>")
    h.append("</table>")

    # --- окружения
    h.append("<h2>Окружения</h2><div class=wrap><table><tr><th>Окружение</th><th>Runtime</th><th>Python</th>"
             "<th>Статус</th><th>Установка, с</th><th>Smoke-test</th></tr>")
    for name, e in (st.get("envs") or {}).items():
        sm = e.get("smoke") or {}
        smt = ("OK: " + html.escape(str(sm.get("device") or sm.get("torch") or sm.get("paddle")))
               + f" · {html.escape(json.dumps(sm.get('checks', {}), ensure_ascii=False))}") if sm.get("ok") else html.escape(str(e.get("error")))
        if e.get("fallback"):
            smt += f"<br>запасное {html.escape(e['fallback'].get('env', ''))}: {'OK' if e['fallback'].get('ok') else html.escape(str(e['fallback'].get('error')))}"
        h.append(f"<tr><td>{html.escape(name)}</td><td>{html.escape(e.get('runtime', ''))}</td>"
                 f"<td>{html.escape(str(e.get('python', ''))[:40])}</td>"
                 f"<td>{_badge('ok' if e.get('ok') else 'failed')}{' (переиспользовано)' if e.get('reused') else ''}</td>"
                 f"<td class=n>{_f(e.get('original_install_time_s'), 0)}</td><td>{smt}</td></tr>")
    h.append("</table></div><p class=mut>Полные списки пакетов: logs/freeze_&lt;окружение&gt;.txt</p>")

    # --- итоговые группы
    h.append("<h2>Итоги</h2>")
    h.append(_section_table("Успешные запуски на GPU", gpu_ok))
    h.append(_section_table("Успешные запуски на CPU", cpu_ok))
    h.append(_section_table("Успешные запуски с неофициальными/экспериментальными решениями", workaround_ok))
    h.append("<h3>Неудачные попытки</h3>")
    if failed:
        h.append("<div class=wrap><table><tr><th>Комбинация</th><th>Поддержка</th><th>Статус</th><th>Фаза</th><th>Причина</th><th>Лог</th></tr>")
        for r in failed:
            rec = next(x for x in recs if x["id"] == r["id"])
            h.append(f"<tr><td>{html.escape(r['id'])}</td><td>{_sup(r['support'])}</td><td>{_badge(r['status'])}</td>"
                     f"<td>{html.escape(str(rec.get('failed_phase') or ''))}</td><td><pre>{html.escape(str(r['reason']))}</pre></td>"
                     f"<td><a href='{html.escape(r['dir'])}/worker.log'>worker.log</a></td></tr>")
        h.append("</table></div>")
    else:
        h.append("<p class=mut>нет</p>")
    h.append("<h3>Варианты, которые не удалось проверить</h3>")
    if untested:
        h.append("<table><tr><th>Комбинация</th><th>Причина</th></tr>")
        for r in untested:
            h.append(f"<tr><td>{html.escape(r['id'])}</td><td>{html.escape(str(r['reason']))}</td></tr>")
        h.append("</table>")
    else:
        h.append("<p class=mut>нет</p>")
    h.append("<h3>Сознательно исключённые варианты</h3><table><tr><th>Вариант</th><th>Модели</th><th>Причина</th></tr>")
    for e in EXCLUDED:
        h.append(f"<tr><td>{html.escape(e['what'])}</td><td>{html.escape(e['models'])}</td><td>{html.escape(e['reason'])}</td></tr>")
    h.append("</table>")

    # --- по моделям: полное сравнение + галерея
    for mk in MODEL_ORDER:
        mrows = [r for r in rows if r["model"] == mk]
        if not mrows:
            continue
        spec = MODELS[mk]
        minfo = (st.get("models") or {}).get(mk, {})
        h.append(f"<h2>{html.escape(spec.repo)}</h2><p class=mut>{html.escape(spec.description)} · revision "
                 f"<code>{html.escape(spec.revision)}</code></p>")
        h.append("<div class=wrap><table><tr><th>Вариант</th><th>Поддержка</th><th>Статус</th><th>Runtime</th>"
                 "<th>Загрузка, с</th><th>1-й, с</th><th>Медиана, с</th><th>P95, с</th><th>n</th>"
                 "<th>VRAM процесса (PDH)</th><th>VRAM shared</th><th>torch reserved</th><th>Δ VRAM адаптера</th>"
                 "<th>RAM RSS</th><th>CPU %</th><th>GPU %</th><th>T hotspot</th><th>P, Вт</th><th>F GPU, МГц</th>"
                 "<th>Fallback на CPU</th><th>Примечание</th></tr>")
        for r in mrows:
            rec = next(x for x in recs if x["id"] == r["id"])
            h.append(
                f"<tr><td><a href='{html.escape(r['dir'])}/'>{html.escape(r['backend'])}-{html.escape(r['variant'])}</a></td>"
                f"<td>{_sup(r['support'])}</td><td>{_badge(r['status'])}</td><td>{html.escape(str(r['runtime'] or ''))}</td>"
                f"<td class=n>{_f(r['model_load_s'])}</td><td class=n>{_f(r['first_inference_s'])}</td>"
                f"<td class=n>{_f(r['median_s'], 3)}</td><td class=n>{_f(r['p95_s'], 3)}</td><td class=n>{_f(r['n_measurements'])}</td>"
                f"<td class=n>{_mb(r['peak_gpu_proc_dedicated_mb'])}</td><td class=n>{_mb(r['peak_gpu_proc_shared_mb'])}</td>"
                f"<td class=n>{_mb(r['torch_peak_reserved_mb'])}</td><td class=n>{_mb(r['peak_gpu_adapter_delta_mb'])}</td>"
                f"<td class=n>{_mb(r['peak_proc_rss_mb'])}</td><td class=n>{_f(r['avg_proc_cpu_pct_of_total'], 0)}</td>"
                f"<td class=n>{_f(r['avg_gpu_util_pct'], 0)}</td><td class=n>{_f(r['peak_gpu_temp_hotspot_c'], 0)}</td>"
                f"<td class=n>{_f(r['avg_gpu_power_w'], 0)}</td><td class=n>{_f(r['avg_gpu_clock_mhz'], 0)}</td>"
                f"<td>{'да' if r['cpu_fallback_detected'] else ('нет' if r['status'] == 'ok' else '')}</td>"
                f"<td class=mut>{html.escape(rec.get('notes', ''))}</td></tr>")
        h.append("</table></div>")
        h.append("<p class=mut>Время — только вызов модели (вход уже подготовлен, результат скопирован на CPU). "
                 "VRAM процесса — счётчик Windows «GPU Process Memory» по дереву процессов воркера (видит любой runtime); "
                 "torch reserved — внутренний аллокатор PyTorch (только ROCm); Δ VRAM адаптера — пик минус фон до запуска "
                 "(включает чужие процессы).</p>")

        # галерея: изображение × вариант
        images = st.get("images", [])
        h.append("<h3>Результаты по изображениям</h3>")
        for img in images:
            stem = Path(img["name"]).stem
            h.append(f"<details open><summary><b>{html.escape(img['name'])}</b> <span class=mut>sha256 {img['sha256'][:12]}…</span>"
                     f"</summary><div class=grid>")
            for r in mrows:
                det = details.get(r["id"], {})
                irec = next((i for i in det.get("images", []) if i.get("name") == img["name"]), None)
                body = ""
                if irec and irec.get("status") == "ok":
                    base = f"{r['dir']}/outputs/{stem}"
                    outs = irec.get("outputs", [])
                    pics = [o for o in outs if o.lower().endswith((".png", ".jpg", ".webp"))]
                    show = next((o for o in pics if o.startswith(("overlay", "inpainted"))), pics[0] if pics else None)
                    if show:
                        body += f"<a href='{html.escape(base)}/{html.escape(show)}'><img loading=lazy src='{html.escape(base)}/{html.escape(show)}'></a>"
                    txt = next((o for o in outs if o.endswith(".txt")), None)
                    if txt:
                        body += f"<pre data-src='{html.escape(base)}/{html.escape(txt)}'>{html.escape(irec.get('preview', ''))}</pre>"
                    body += "<div class=mut>" + " · ".join(f"<a href='{html.escape(base)}/{html.escape(o)}'>{html.escape(o)}</a>" for o in outs) + "</div>"
                    s = irec.get("stats", {})
                    body += f"<div class=mut>медиана {_f(s.get('median'), 3)} с · вход {html.escape(json.dumps(irec.get('input', {}).get('model_input_wh') or irec.get('input', {}).get('orig_size_wh')))}</div>"
                elif irec:
                    body = f"{_badge(irec.get('status'))} <span class=mut>{html.escape(str(irec.get('reason', '')))}</span>"
                else:
                    body = f"{_badge(r['status'])}"
                h.append(f"<div class=cell><b>{html.escape(r['backend'])}-{html.escape(r['variant'])}</b><br>{body}</div>")
            h.append("</div></details>")
    h.append("<p class=mut>Полные данные: <a href='summary.json'>summary.json</a> · <a href='summary.csv'>summary.csv</a> · "
             "<a href='logs/orchestrator.log'>orchestrator.log</a></p></body></html>")
    return "".join(h)
