"""Smoke-test окружения: устройство доступно и реально считает (matmul, conv, fft).

Печатает одну строку JSON. Код возврата 0 — устройство работает.
Тест не заменяет инференс модели: «окружение установилось» ≠ «backend работает».
"""
from __future__ import annotations

import json
import sys
import time
import traceback


def torch_smoke(kind: str) -> dict:
    import torch

    r: dict = {"torch": torch.__version__, "hip": getattr(torch.version, "hip", None)}
    if kind == "cpu":
        dev = torch.device("cpu")
    elif kind == "rocm":
        r["cuda_available"] = torch.cuda.is_available()
        if not r["cuda_available"]:
            raise RuntimeError("torch.cuda.is_available() == False")
        dev = torch.device("cuda:0")
        p = torch.cuda.get_device_properties(0)
        r.update(device=p.name, gcn_arch=getattr(p, "gcnArchName", None), total_mb=p.total_memory / 2**20)
    elif kind == "dml":
        import torch_directml as dml

        dev = dml.device(dml.default_device())
        r.update(device=dml.device_name(dml.default_device()).rstrip("\x00"), device_count=dml.device_count())
    else:
        raise ValueError(kind)
    checks = {}
    a = torch.randn(1024, 1024)
    t = time.perf_counter()
    c = (a.to(dev) @ a.to(dev)).cpu()
    checks["matmul_ok"] = bool(torch.allclose(c, a @ a, atol=1e-2, rtol=1e-3))
    checks["matmul_s"] = time.perf_counter() - t
    x = torch.randn(1, 8, 64, 64)
    w = torch.randn(16, 8, 3, 3)
    y = torch.nn.functional.conv2d(x.to(dev), w.to(dev), padding=1).cpu()
    checks["conv_ok"] = bool(torch.allclose(y, torch.nn.functional.conv2d(x, w, padding=1), atol=1e-3, rtol=1e-3))
    # Необязательные проверки (FFT, fp16, bf16) — каждая в отдельном процессе: на DirectML
    # неподдерживаемый dtype вызывает нативный abort, а не Python-исключение. Результат фиксируется,
    # но smoke не валится: эти возможности нужны не всем моделям.
    import subprocess

    for name in ("fft", "float16", "bfloat16"):
        try:
            fr = subprocess.run([sys.executable, __file__, kind, "check:" + name], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=300)
            out = fr.stdout + fr.stderr
            ok = fr.returncode == 0 and "CHECK_OK" in fr.stdout
            checks[f"{name}_ok"] = ok
            if not ok:
                tail = [ln for ln in out.strip().splitlines() if ln.strip()][-1:] or [""]
                checks[f"{name}_error"] = f"код {fr.returncode & 0xFFFFFFFF:#x}: {tail[0][:300]}"
        except subprocess.TimeoutExpired:
            checks[f"{name}_ok"] = False
            checks[f"{name}_error"] = "таймаут 300 с"
    r["checks"] = checks
    if not (checks["matmul_ok"] and checks["conv_ok"]):
        raise RuntimeError(f"неверные результаты вычислений на устройстве: {checks}")
    return r


def paddle_smoke() -> dict:
    import numpy as np
    import paddle

    paddle.set_device("cpu")
    a = np.random.randn(256, 256).astype("float32")
    c = (paddle.to_tensor(a) @ paddle.to_tensor(a)).numpy()
    ok = bool(np.allclose(c, a @ a, atol=1e-2))
    if not ok:
        raise RuntimeError("paddle matmul даёт неверный результат")
    return {"paddle": paddle.__version__, "checks": {"matmul_ok": ok}}


def single_check(kind: str, name: str) -> int:
    import torch

    if kind == "dml":
        import torch_directml as dml

        dev = dml.device(dml.default_device())
    else:
        dev = torch.device("cuda:0" if kind == "rocm" else "cpu")
    if name == "fft":
        x = torch.randn(1, 8, 64, 64)
        ok = bool(torch.allclose(torch.fft.rfftn(x.to(dev), dim=(-2, -1)).cpu(), torch.fft.rfftn(x, dim=(-2, -1)),
                                 atol=1e-2, rtol=1e-3))
    else:
        dt = getattr(torch, name)
        a = torch.randn(512, 512)
        z = (a.to(dev, dt) @ a.to(dev, dt)).float().cpu()
        ok = bool(torch.allclose(z, a @ a, atol=2.0, rtol=5e-2))
    print("CHECK_OK" if ok else "CHECK_WRONG_RESULT", flush=True)
    return 0 if ok else 1


def main() -> int:
    kind, framework = sys.argv[1], sys.argv[2]
    if framework.startswith("check:"):
        return single_check(kind, framework.split(":", 1)[1])
    try:
        r = paddle_smoke() if framework == "paddle" else torch_smoke(kind)
        r["ok"] = True
        code = 0
    except BaseException as e:
        r = {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()}
        code = 1
    print("SMOKE_JSON " + json.dumps(r, ensure_ascii=False, default=str), flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
