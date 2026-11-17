"""Низкоуровневые источники метрик Windows через ctypes (без сторонних пакетов).

* PDH (Performance Data Helper): счётчики «GPU Process Memory», «GPU Engine»,
  «GPU Adapter Memory» — тот же источник, что у Диспетчера задач. Это основной
  источник VRAM процесса: он видит выделения любого runtime (ROCm/HIP, DirectML,
  D3D), а не только аллокатора PyTorch.
* DXGI: список адаптеров, LUID и настоящий объём выделенной VRAM (WMI AdapterRAM
  обрезается до 4 ГБ).
* ADL (atiadlxx.dll, драйвер AMD): температура, частоты, мощность GPU.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import re
from dataclasses import dataclass

# ============================================================================ PDH

PDH_FMT_DOUBLE = 0x00000200
PDH_FMT_NOCAP100 = 0x00008000
PDH_MORE_DATA = 0x800007D2
PDH_CSTATUS_VALID_DATA = 0x0
PDH_CSTATUS_NEW_DATA = 0x1


class _FmtValue(ctypes.Structure):
    _fields_ = [("CStatus", wt.DWORD), ("doubleValue", ctypes.c_double)]  # union выровнен на 8


class _FmtItem(ctypes.Structure):
    _fields_ = [("szName", wt.LPWSTR), ("FmtValue", _FmtValue)]


class PdhQuery:
    """Набор PDH-счётчиков с wildcard-инстансами."""

    def __init__(self, paths: dict[str, str]):
        self._pdh = ctypes.WinDLL("pdh.dll")
        self._q = wt.HANDLE()
        st = self._pdh.PdhOpenQueryW(None, 0, ctypes.byref(self._q))
        if st != 0:
            raise OSError(f"PdhOpenQueryW: 0x{st & 0xFFFFFFFF:08X}")
        self._counters: dict[str, wt.HANDLE] = {}
        self.errors: dict[str, str] = {}
        for key, path in paths.items():
            h = wt.HANDLE()
            st = self._pdh.PdhAddEnglishCounterW(self._q, path, 0, ctypes.byref(h))
            if st == 0:
                self._counters[key] = h
            else:
                self.errors[key] = f"PdhAddEnglishCounterW({path}): 0x{st & 0xFFFFFFFF:08X}"
        self._pdh.PdhCollectQueryData(self._q)

    def collect(self) -> dict[str, dict[str, float]]:
        """Возвращает {ключ: {инстанс: значение}}."""
        self._pdh.PdhCollectQueryData(self._q)
        out: dict[str, dict[str, float]] = {}
        for key, h in self._counters.items():
            size = wt.DWORD(0)
            count = wt.DWORD(0)
            st = self._pdh.PdhGetFormattedCounterArrayW(h, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100,
                                                        ctypes.byref(size), ctypes.byref(count), None)
            if (st & 0xFFFFFFFF) != PDH_MORE_DATA or size.value == 0:
                out[key] = {}
                continue
            buf = (ctypes.c_byte * size.value)()
            st = self._pdh.PdhGetFormattedCounterArrayW(h, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100,
                                                        ctypes.byref(size), ctypes.byref(count), buf)
            if st != 0:
                out[key] = {}
                continue
            items = ctypes.cast(buf, ctypes.POINTER(_FmtItem))
            vals: dict[str, float] = {}
            for i in range(count.value):
                it = items[i]
                if it.FmtValue.CStatus in (PDH_CSTATUS_VALID_DATA, PDH_CSTATUS_NEW_DATA):
                    vals[it.szName] = vals.get(it.szName, 0.0) + it.FmtValue.doubleValue
            out[key] = vals
        return out

    def close(self) -> None:
        if self._q:
            self._pdh.PdhCloseQuery(self._q)
            self._q = wt.HANDLE()


_PID_RE = re.compile(r"pid_(\d+)_")
_LUID_RE = re.compile(r"luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)")
_ENG_RE = re.compile(r"engtype_(.+)$")


def parse_instance(name: str) -> tuple[int | None, str | None, str | None]:
    pid = _PID_RE.search(name)
    luid = _LUID_RE.search(name)
    eng = _ENG_RE.search(name)
    return (int(pid.group(1)) if pid else None,
            luid.group(1).lower() if luid else None,
            eng.group(1) if eng else None)


# ============================================================================ DXGI


class _LUID(ctypes.Structure):
    _fields_ = [("LowPart", wt.DWORD), ("HighPart", wt.LONG)]


class _DXGI_ADAPTER_DESC1(ctypes.Structure):
    _fields_ = [
        ("Description", ctypes.c_wchar * 128),
        ("VendorId", ctypes.c_uint), ("DeviceId", ctypes.c_uint),
        ("SubSysId", ctypes.c_uint), ("Revision", ctypes.c_uint),
        ("DedicatedVideoMemory", ctypes.c_size_t), ("DedicatedSystemMemory", ctypes.c_size_t),
        ("SharedSystemMemory", ctypes.c_size_t), ("AdapterLuid", _LUID), ("Flags", ctypes.c_uint),
    ]


class _GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort), ("Data3", ctypes.c_ushort),
                ("Data4", ctypes.c_ubyte * 8)]


def _guid(s: str) -> _GUID:
    import uuid

    u = uuid.UUID(s)
    g = _GUID()
    g.Data1, g.Data2, g.Data3 = u.fields[0], u.fields[1], u.fields[2]
    for i, b in enumerate(u.bytes[8:]):
        g.Data4[i] = b
    return g


@dataclass
class DxgiAdapter:
    index: int
    name: str
    vendor_id: int
    device_id: int
    dedicated_vram_bytes: int
    shared_system_bytes: int
    luid: str  # в формате PDH: 0xHHHHHHHH_0xLLLLLLLL
    software: bool


def _vcall(obj: ctypes.c_void_p, index: int, restype, *argtypes):
    vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    proto = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
    return proto(vtbl[index])


def dxgi_adapters() -> list[DxgiAdapter]:
    dxgi = ctypes.WinDLL("dxgi.dll")
    factory = ctypes.c_void_p()
    iid = _guid("770aae78-f26f-4dba-a829-253c83d1b387")  # IDXGIFactory1
    hr = dxgi.CreateDXGIFactory1(ctypes.byref(iid), ctypes.byref(factory))
    if hr != 0:
        raise OSError(f"CreateDXGIFactory1 hr=0x{hr & 0xFFFFFFFF:08X}")
    res: list[DxgiAdapter] = []
    try:
        enum1 = _vcall(factory, 12, ctypes.c_long, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p))
        i = 0
        while True:
            ad = ctypes.c_void_p()
            if enum1(factory, i, ctypes.byref(ad)) != 0:
                break
            desc = _DXGI_ADAPTER_DESC1()
            getdesc1 = _vcall(ad, 10, ctypes.c_long, ctypes.POINTER(_DXGI_ADAPTER_DESC1))
            if getdesc1(ad, ctypes.byref(desc)) == 0:
                luid = f"0x{desc.AdapterLuid.HighPart & 0xFFFFFFFF:08x}_0x{desc.AdapterLuid.LowPart:08x}"
                res.append(DxgiAdapter(i, desc.Description, desc.VendorId, desc.DeviceId,
                                       int(desc.DedicatedVideoMemory), int(desc.SharedSystemMemory),
                                       luid, bool(desc.Flags & 2)))
            _vcall(ad, 2, ctypes.c_ulong)(ad)  # Release
            i += 1
    finally:
        _vcall(factory, 2, ctypes.c_ulong)(factory)
    return res


# ============================================================================ ADL (AMD)

# Индексы ADL_PMLOG_SENSORS из ADL SDK (adl_defines.h)
ADL_SENSORS = {
    "gfx_clock_mhz": 1,
    "mem_clock_mhz": 2,
    "temp_edge_c": 8,
    "temp_mem_c": 9,
    "fan_rpm": 14,
    "gfx_activity_pct": 19,
    "asic_power_w": 23,
    "temp_hotspot_c": 27,
}


class _ADLSingleSensorData(ctypes.Structure):
    _fields_ = [("supported", ctypes.c_int), ("value", ctypes.c_int)]


class _ADLPMLogDataOutput(ctypes.Structure):
    _fields_ = [("size", ctypes.c_int), ("sensors", _ADLSingleSensorData * 256)]


class _AdapterInfo(ctypes.Structure):
    _fields_ = [
        ("iSize", ctypes.c_int), ("iAdapterIndex", ctypes.c_int), ("strUDID", ctypes.c_char * 256),
        ("iBusNumber", ctypes.c_int), ("iDeviceNumber", ctypes.c_int), ("iFunctionNumber", ctypes.c_int),
        ("iVendorID", ctypes.c_int), ("strAdapterName", ctypes.c_char * 256),
        ("strDisplayName", ctypes.c_char * 256), ("iPresent", ctypes.c_int), ("iExist", ctypes.c_int),
        ("strDriverPath", ctypes.c_char * 256), ("strDriverPathExt", ctypes.c_char * 256),
        ("strPNPString", ctypes.c_char * 256), ("iOSDisplayIndex", ctypes.c_int),
    ]


_ALLOC = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_int)


class AdlSensors:
    """Чтение PMLog-сенсоров AMD через ADL2_New_QueryPMLogData_Get."""

    def __init__(self) -> None:
        self._dll = ctypes.WinDLL("atiadlxx.dll")
        self._alloc = _ALLOC(lambda n: ctypes.cast(ctypes.create_string_buffer(n), ctypes.c_void_p).value)
        self._bufs: list = []
        self._ctx = ctypes.c_void_p()

        def alloc(n):
            b = ctypes.create_string_buffer(n)
            self._bufs.append(b)  # держим ссылку, иначе GC освободит память
            return ctypes.addressof(b)

        self._alloc = _ALLOC(alloc)
        if self._dll.ADL2_Main_Control_Create(self._alloc, 1, ctypes.byref(self._ctx)) != 0:
            raise OSError("ADL2_Main_Control_Create failed")
        n = ctypes.c_int()
        self._dll.ADL2_Adapter_NumberOfAdapters_Get(self._ctx, ctypes.byref(n))
        infos = (_AdapterInfo * max(n.value, 1))()
        self._dll.ADL2_Adapter_AdapterInfo_Get(self._ctx, infos, ctypes.sizeof(infos))
        self.adapter_index = None
        self.adapter_name = None
        seen_bus = set()
        for a in infos[: n.value]:
            if a.iVendorID != 1002 or a.iBusNumber in seen_bus:
                continue
            seen_bus.add(a.iBusNumber)
            out = _ADLPMLogDataOutput()
            if self._dll.ADL2_New_QueryPMLogData_Get(self._ctx, a.iAdapterIndex, ctypes.byref(out)) == 0:
                self.adapter_index = a.iAdapterIndex
                self.adapter_name = a.strAdapterName.decode(errors="replace")
                break
        if self.adapter_index is None:
            raise OSError("ADL: ни один адаптер AMD не отдал PMLog-данные")

    def read(self) -> dict[str, float | None]:
        out = _ADLPMLogDataOutput()
        if self._dll.ADL2_New_QueryPMLogData_Get(self._ctx, self.adapter_index, ctypes.byref(out)) != 0:
            return {}
        r: dict[str, float | None] = {}
        for k, idx in ADL_SENSORS.items():
            s = out.sensors[idx]
            r[k] = float(s.value) if s.supported else None
        return r

    def close(self) -> None:
        if self._ctx:
            try:
                self._dll.ADL2_Main_Control_Destroy(self._ctx)
            except OSError:
                pass
            self._ctx = ctypes.c_void_p()
