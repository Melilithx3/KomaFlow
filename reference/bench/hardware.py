"""Обнаружение аппаратной и программной конфигурации (только чтение)."""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys

import psutil

from . import paths, winperf


def _ps_json(cmd: str):
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                            f"{cmd} | ConvertTo-Json -Depth 3"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        if r.returncode != 0 or not r.stdout.strip():
            return None
        d = json.loads(r.stdout)
        return d if isinstance(d, list) else [d]
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return None


def probe() -> dict:
    info: dict = {"errors": {}}
    os_ = _ps_json("Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture")
    info["os"] = {"platform": platform.platform(), "release": platform.release(), "version": platform.version(),
                  "wmi": os_[0] if os_ else None}
    cpu = _ps_json("Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed")
    info["cpu"] = {"name": (cpu[0]["Name"].strip() if cpu else platform.processor()),
                   "cores": psutil.cpu_count(logical=False), "threads": psutil.cpu_count(logical=True),
                   "base_clock_mhz": (cpu[0]["MaxClockSpeed"] if cpu else None)}
    vm = psutil.virtual_memory()
    info["ram"] = {"total_mb": vm.total / 2**20, "available_mb": vm.available / 2**20}
    mem = _ps_json("Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity,Speed,ConfiguredClockSpeed,Manufacturer,PartNumber")
    info["ram"]["modules"] = mem
    gpus = _ps_json("Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,DriverDate,PNPDeviceID,VideoProcessor")
    info["gpu_wmi"] = gpus
    try:
        info["gpu_dxgi"] = [a.__dict__ for a in winperf.dxgi_adapters()]
    except OSError as e:
        info["errors"]["dxgi"] = str(e)
    try:
        s = winperf.AdlSensors()
        info["adl"] = {"available": True, "adapter": s.adapter_name, "sample": s.read()}
        s.close()
    except OSError as e:
        info["adl"] = {"available": False, "error": str(e)}
    # AMD runtime/драйверы: только наличие, ничего не меняем
    sysroot = os.environ.get("SystemRoot", r"C:\Windows")
    info["runtimes"] = {
        "amdhip64_in_system32": [f for f in os.listdir(os.path.join(sysroot, "System32"))
                                 if f.lower().startswith("amdhip64")] if os.path.isdir(os.path.join(sysroot, "System32")) else [],
        "atiadlxx.dll": os.path.exists(os.path.join(sysroot, "System32", "atiadlxx.dll")),
        "DirectML.dll(system)": os.path.exists(os.path.join(sysroot, "System32", "DirectML.dll")),
        "HIP_PATH": os.environ.get("HIP_PATH"),
        "HSA_OVERRIDE_GFX_VERSION": os.environ.get("HSA_OVERRIDE_GFX_VERSION"),
    }
    du = shutil.disk_usage(paths.ROOT)
    info["disk"] = {"project_drive_free_gb": du.free / 2**30, "project_drive_total_gb": du.total / 2**30}
    info["orchestrator_python"] = sys.version
    try:
        r = subprocess.run(["py", "-0p"], capture_output=True, text=True, timeout=20)
        info["system_pythons"] = r.stdout.strip().splitlines()
    except OSError:
        info["system_pythons"] = None
    return info


def _wmi_date(v):
    """WMI-дата из ConvertTo-Json приходит как '/Date(1792108800000)/' — переводим в YYYY-MM-DD."""
    import datetime
    import re

    m = re.match(r"/Date\((\d+)\)/", str(v or ""))
    if not m:
        return v
    return datetime.datetime.fromtimestamp(int(m.group(1)) / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")


def amd_gpu_summary(hw: dict) -> dict:
    d = next((a for a in hw.get("gpu_dxgi", []) if a["vendor_id"] == 0x1002), None)
    w = next((g for g in (hw.get("gpu_wmi") or []) if "AMD" in (g.get("Name") or "") or "Radeon" in (g.get("Name") or "")), None)
    return {"name": (d or {}).get("name") or (w or {}).get("Name"),
            "vram_gb": round(d["dedicated_vram_bytes"] / 2**30, 2) if d else None,
            "driver_version": (w or {}).get("DriverVersion"), "driver_date": _wmi_date((w or {}).get("DriverDate")),
            "device_id": hex(d["device_id"]) if d else None}
