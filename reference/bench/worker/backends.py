"""Инициализация вычислительного устройства внутри воркера.

Импортирует только то, что есть в конкретном окружении (torch / torch_directml / paddle).
"""
from __future__ import annotations

import importlib.metadata as md
import os
import platform
import sys


def pkg_versions(names: list[str]) -> dict[str, str | None]:
    out = {}
    for n in names:
        try:
            out[n] = md.version(n)
        except md.PackageNotFoundError:
            out[n] = None
    return out


class TorchBackend:
    framework = "torch"

    def __init__(self, kind: str, seed: int):
        import torch

        self.torch = torch
        self.kind = kind
        torch.manual_seed(seed)
        self.info: dict = {"framework": "torch", "torch": torch.__version__, "kind": kind,
                           "torch_num_threads": torch.get_num_threads()}
        if kind == "cpu":
            self.device = torch.device("cpu")
            self.info["device_name"] = platform.processor()
        elif kind == "rocm":
            hip = getattr(torch.version, "hip", None)
            self.info["hip"] = hip
            if not hip:
                raise RuntimeError(f"установлена не-ROCm сборка torch ({torch.__version__})")
            if not torch.cuda.is_available():
                raise RuntimeError("torch.cuda.is_available() == False — HIP-runtime не видит GPU")
            self.device = torch.device("cuda:0")
            props = torch.cuda.get_device_properties(0)
            self.info.update(device_name=props.name, gcn_arch=getattr(props, "gcnArchName", None),
                             total_memory_mb=props.total_memory / 2**20,
                             device_count=torch.cuda.device_count())
            torch.cuda.manual_seed_all(seed)
        elif kind == "dml":
            import torch_directml

            self.dml = torch_directml
            if torch_directml.device_count() < 1:
                raise RuntimeError("DirectML не видит ни одного устройства")
            idx = torch_directml.default_device()
            self.device = torch_directml.device(idx)
            self.info.update(device_name=torch_directml.device_name(idx).rstrip("\x00"), device_count=torch_directml.device_count(),
                             torch_directml=pkg_versions(["torch-directml"])["torch-directml"])
        else:
            raise ValueError(kind)

    # --- синхронизация: время инференса должно включать реальное завершение работы GPU
    def sync(self) -> None:
        if self.kind == "rocm":
            self.torch.cuda.synchronize()
        # DML: явного synchronize нет; адаптеры копируют результат на CPU (.cpu()),
        # что блокирует до завершения вычислений.

    def no_grad(self):
        """torch-directml несовместим с torch.inference_mode ("Cannot set version_counter for
        inference tensor") — для DML используется torch.no_grad (как в RFDETR.predict)."""
        return self.torch.no_grad() if self.kind == "dml" else self.torch.inference_mode()

    def reset_peak(self) -> None:
        if self.kind == "rocm":
            self.torch.cuda.reset_peak_memory_stats()

    def mem(self) -> dict:
        if self.kind != "rocm":
            return {}
        t = self.torch.cuda
        free, total = t.mem_get_info()
        return {"torch_allocated_mb": t.memory_allocated() / 2**20,
                "torch_reserved_mb": t.memory_reserved() / 2**20,
                "torch_peak_allocated_mb": t.max_memory_allocated() / 2**20,
                "torch_peak_reserved_mb": t.max_memory_reserved() / 2**20,
                "hip_mem_free_mb": free / 2**20, "hip_mem_total_mb": total / 2**20}

    def dtype(self, name: str | None):
        if not name:
            return self.torch.float32
        return getattr(self.torch, name)


class PaddleBackend:
    framework = "paddle"

    def __init__(self, kind: str, seed: int):
        import paddle

        if kind != "cpu":
            raise RuntimeError("PaddlePaddle под Windows не имеет сборок для AMD GPU")
        self.paddle = paddle
        self.kind = kind
        paddle.set_device("cpu")
        paddle.seed(seed)
        self.info = {"framework": "paddle", "paddle": paddle.__version__, "kind": kind,
                     "device_name": platform.processor(),
                     "compiled_with_cuda": paddle.device.is_compiled_with_cuda()}

    def sync(self) -> None:
        pass

    def reset_peak(self) -> None:
        pass

    def mem(self) -> dict:
        return {}


def make(framework: str, kind: str, seed: int):
    if framework == "torch":
        return TorchBackend(kind, seed)
    if framework == "paddle":
        return PaddleBackend(kind, seed)
    raise ValueError(framework)


def environment_info() -> dict:
    return {"python": sys.version, "executable": sys.executable, "platform": platform.platform(),
            "cpu_count": os.cpu_count()}
