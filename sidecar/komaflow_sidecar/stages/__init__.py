"""Stage implementations. Torch is imported only inside `Real` classes (in the model env)."""
from __future__ import annotations


class TorchDevice:
    """Device helper shared by real stages (adapted from reference/bench worker/backends.py)."""

    def __init__(self, backend: str):
        import torch

        self.torch = torch
        self.kind = backend
        if backend == "rocm":
            if not getattr(torch.version, "hip", None):
                raise RuntimeError(f"torch build without ROCm ({torch.__version__})")
            if not torch.cuda.is_available():
                raise RuntimeError("HIP runtime does not see a GPU")
            self.device = torch.device("cuda:0")
            torch.cuda.reset_peak_memory_stats()
        else:
            self.device = torch.device("cpu")

    def info(self) -> dict:
        d = {"torch": self.torch.__version__, "backend": self.kind}
        if self.kind == "rocm":
            p = self.torch.cuda.get_device_properties(0)
            d.update(device=p.name, arch=getattr(p, "gcnArchName", None), hip=self.torch.version.hip)
        return d

    def peak_vram_mb(self) -> float | None:
        if self.kind != "rocm":
            return None
        return round(self.torch.cuda.max_memory_allocated() / 2**20, 1)

    def inference(self):
        return self.torch.inference_mode()
