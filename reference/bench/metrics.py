"""Сэмплер ресурсов: работает в потоке оркестратора и наблюдает за деревом процессов воркера.

Источники (все пишутся в metrics.csv, сводка — в result.json):
  RAM/CPU процесса  — psutil (RSS и private bytes по всему дереву процессов воркера)
  VRAM процесса     — PDH «GPU Process Memory» Dedicated/Shared Usage по PID дерева (как Диспетчер задач)
  VRAM адаптера     — PDH «GPU Adapter Memory» (видит и чужие процессы → только как контекст, + дельта от baseline)
  Загрузка GPU      — PDH «GPU Engine» Utilization по PID дерева (макс. по типам движков, как Диспетчер задач)
  Сенсоры GPU       — ADL PMLog: температура edge/hotspot, частота GFX/MEM, мощность ASIC, общая активность GFX
  Частота CPU       — PDH «% Processor Performance» × базовая частота
Внутренняя статистика аллокатора PyTorch (ROCm) собирается воркером отдельно.
"""
from __future__ import annotations

import csv
import threading
import time
from pathlib import Path

import psutil

from . import winperf

FIELDS = [
    "t", "phase", "proc_rss_mb", "proc_private_mb", "proc_cpu_pct", "sys_cpu_pct", "sys_avail_ram_mb",
    "gpu_proc_dedicated_mb", "gpu_proc_shared_mb", "gpu_adapter_dedicated_mb", "gpu_util_pct",
    "gpu_util_3d_pct", "gpu_util_compute_pct", "gpu_util_copy_pct",
    "gpu_temp_edge_c", "gpu_temp_hotspot_c", "gpu_clock_mhz", "gpu_mem_clock_mhz", "gpu_power_w",
    "gpu_activity_pct", "cpu_freq_mhz",
]


class GpuSources:
    """Общие для всего прогона источники GPU-метрик (создаются один раз)."""

    def __init__(self, cpu_base_mhz: float | None):
        self.errors: dict[str, str] = {}
        self.cpu_base_mhz = cpu_base_mhz
        self.luid: str | None = None
        self.adapter_name: str | None = None
        try:
            ads = [a for a in winperf.dxgi_adapters() if a.vendor_id == 0x1002 and not a.software]
            if ads:
                self.luid = ads[0].luid
                self.adapter_name = ads[0].name
            else:
                self.errors["dxgi"] = "AMD-адаптер не найден через DXGI"
        except OSError as e:
            self.errors["dxgi"] = str(e)
        try:
            self.pdh = winperf.PdhQuery({
                "pm_ded": r"\GPU Process Memory(*)\Dedicated Usage",
                "pm_sh": r"\GPU Process Memory(*)\Shared Usage",
                "eng": r"\GPU Engine(*)\Utilization Percentage",
                "ad_ded": r"\GPU Adapter Memory(*)\Dedicated Usage",
                "cpu_perf": r"\Processor Information(_Total)\% Processor Performance",
            })
            self.errors.update({f"pdh.{k}": v for k, v in self.pdh.errors.items()})
        except OSError as e:
            self.pdh = None
            self.errors["pdh"] = str(e)
        try:
            self.adl = winperf.AdlSensors()
        except OSError as e:
            self.adl = None
            self.errors["adl"] = str(e)
        self.lock = threading.Lock()

    def _luid_ok(self, luid: str | None) -> bool:
        return self.luid is None or (luid is not None and luid == self.luid)

    def sample(self, pids: set[int]) -> dict:
        r: dict = {}
        with self.lock:
            if self.pdh:
                d = self.pdh.collect()
                ded = sh = 0.0
                for inst, v in d.get("pm_ded", {}).items():
                    pid, luid, _ = winperf.parse_instance(inst)
                    if pid in pids and self._luid_ok(luid):
                        ded += v
                for inst, v in d.get("pm_sh", {}).items():
                    pid, luid, _ = winperf.parse_instance(inst)
                    if pid in pids and self._luid_ok(luid):
                        sh += v
                r["gpu_proc_dedicated_mb"] = ded / 2**20
                r["gpu_proc_shared_mb"] = sh / 2**20
                ad = [v for inst, v in d.get("ad_ded", {}).items() if self._luid_ok(winperf.parse_instance(inst)[1])]
                r["gpu_adapter_dedicated_mb"] = (sum(ad) / 2**20) if ad else None
                per_type: dict[str, float] = {}
                for inst, v in d.get("eng", {}).items():
                    pid, luid, eng = winperf.parse_instance(inst)
                    if pid in pids and self._luid_ok(luid) and eng:
                        per_type[eng] = per_type.get(eng, 0.0) + v
                r["gpu_util_pct"] = min(100.0, max(per_type.values())) if per_type else 0.0
                r["gpu_util_3d_pct"] = per_type.get("3D", 0.0)
                r["gpu_util_compute_pct"] = max([v for k, v in per_type.items() if k.lower().startswith("compute")], default=0.0)
                r["gpu_util_copy_pct"] = per_type.get("Copy", 0.0)
                perf = d.get("cpu_perf", {}).get("_Total")
                r["cpu_freq_mhz"] = perf * self.cpu_base_mhz / 100 if (perf and self.cpu_base_mhz) else None
            if self.adl:
                s = self.adl.read()
                r["gpu_temp_edge_c"] = s.get("temp_edge_c")
                r["gpu_temp_hotspot_c"] = s.get("temp_hotspot_c")
                r["gpu_clock_mhz"] = s.get("gfx_clock_mhz")
                r["gpu_mem_clock_mhz"] = s.get("mem_clock_mhz")
                r["gpu_power_w"] = s.get("asic_power_w")
                r["gpu_activity_pct"] = s.get("gfx_activity_pct")
        return r

    def baseline(self) -> dict:
        s = self.sample(set())
        vm = psutil.virtual_memory()
        return {"gpu_adapter_dedicated_mb": s.get("gpu_adapter_dedicated_mb"),
                "sys_avail_ram_mb": vm.available / 2**20, "sys_total_ram_mb": vm.total / 2**20,
                "gpu_temp_edge_c": s.get("gpu_temp_edge_c"), "gpu_power_w": s.get("gpu_power_w")}


class Sampler(threading.Thread):
    def __init__(self, sources: GpuSources, root_pid: int, csv_path: Path, phase_getter, interval: float = 0.25):
        super().__init__(daemon=True)
        self.src = sources
        self.root_pid = root_pid
        self.csv_path = csv_path
        self.phase_getter = phase_getter
        self.interval = interval
        self._stop = threading.Event()
        self.rows: list[dict] = []
        self._cpu_procs: dict[int, psutil.Process] = {}

    def stop(self) -> None:
        self._stop.set()

    def _tree(self) -> list[psutil.Process]:
        try:
            root = psutil.Process(self.root_pid)
            return [root, *root.children(recursive=True)]
        except psutil.Error:
            return []

    def run(self) -> None:
        psutil.cpu_percent(None)
        with self.csv_path.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
            w.writeheader()
            while not self._stop.is_set():
                t = time.time()
                procs = self._tree()
                pids = {p.pid for p in procs}
                rss = priv = cpu = 0.0
                for p in procs:
                    try:
                        mi = p.memory_info()
                        rss += mi.rss
                        priv += getattr(mi, "private", 0) or 0
                        cp = self._cpu_procs.setdefault(p.pid, p)
                        cpu += cp.cpu_percent(None)
                    except psutil.Error:
                        pass
                row = {"t": round(t, 3), "phase": self.phase_getter(),
                       "proc_rss_mb": rss / 2**20, "proc_private_mb": priv / 2**20,
                       "proc_cpu_pct": cpu, "sys_cpu_pct": psutil.cpu_percent(None),
                       "sys_avail_ram_mb": psutil.virtual_memory().available / 2**20}
                row.update(self.src.sample(pids))
                self.rows.append(row)
                w.writerow({k: (round(v, 2) if isinstance(v, float) else v) for k, v in row.items()})
                f.flush()
                self._stop.wait(self.interval)


def summarize(rows: list[dict], baseline: dict, cpu_count: int) -> dict:
    """Сводка: пики и средние по всему запуску и отдельно по фазе инференса."""

    def agg(sel: list[dict]) -> dict:
        def vals(k):
            return [r[k] for r in sel if r.get(k) is not None]

        def mx(k):
            v = vals(k)
            return max(v) if v else None

        def avg(k):
            v = vals(k)
            return sum(v) / len(v) if v else None

        return {
            "samples": len(sel),
            "peak_proc_rss_mb": mx("proc_rss_mb"),
            "peak_proc_private_mb": mx("proc_private_mb"),
            "avg_proc_cpu_pct": avg("proc_cpu_pct"),
            "avg_proc_cpu_pct_of_total": (avg("proc_cpu_pct") / cpu_count) if avg("proc_cpu_pct") is not None else None,
            "peak_proc_cpu_pct": mx("proc_cpu_pct"),
            "min_sys_avail_ram_mb": min(vals("sys_avail_ram_mb")) if vals("sys_avail_ram_mb") else None,
            "peak_gpu_proc_dedicated_mb": mx("gpu_proc_dedicated_mb"),
            "peak_gpu_proc_shared_mb": mx("gpu_proc_shared_mb"),
            "peak_gpu_adapter_dedicated_mb": mx("gpu_adapter_dedicated_mb"),
            "avg_gpu_util_pct": avg("gpu_util_pct"),
            "peak_gpu_util_pct": mx("gpu_util_pct"),
            "avg_gpu_activity_pct": avg("gpu_activity_pct"),
            "peak_gpu_temp_edge_c": mx("gpu_temp_edge_c"),
            "peak_gpu_temp_hotspot_c": mx("gpu_temp_hotspot_c"),
            "avg_gpu_clock_mhz": avg("gpu_clock_mhz"),
            "peak_gpu_clock_mhz": mx("gpu_clock_mhz"),
            "avg_gpu_power_w": avg("gpu_power_w"),
            "peak_gpu_power_w": mx("gpu_power_w"),
            "avg_cpu_freq_mhz": avg("cpu_freq_mhz"),
        }

    infer = [r for r in rows if r.get("phase") in ("warmup", "measure")]
    whole = agg(rows)
    b = baseline.get("gpu_adapter_dedicated_mb")
    if b is not None and whole.get("peak_gpu_adapter_dedicated_mb") is not None:
        whole["peak_gpu_adapter_delta_mb"] = whole["peak_gpu_adapter_dedicated_mb"] - b
    last = rows[-1] if rows else {}
    return {"whole_run": whole, "inference": agg(infer), "baseline_before": baseline,
            "sys_avail_ram_mb_after": last.get("sys_avail_ram_mb")}
