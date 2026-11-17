"""Models, environments and settings verified on the target hardware.

Taken from the user's benchmark (reference/bench/bench/catalog.py): same repos, commit revisions,
package sets and index URLs. Only ROCm and CPU are kept (docs/05-desktop-sidecar.md, no DirectML/ONNX).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelSpec:
    key: str
    repo: str
    revision: str  # exact HF commit hash
    approx_size_gb: float
    required: bool


MODELS: dict[str, ModelSpec] = {
    "layout": ModelSpec("layout", "mayocream/koharu-layout-highres", "68077eb09401a46e548190ff2786bd405113ea8b", 0.19, True),
    "ocr": ModelSpec("ocr", "PaddlePaddle/PaddleOCR-VL-1.6", "132c45f52c0a26ed5a6b2f6bd8e3985794cc27dd", 1.95, True),
    # Not used in MVP (auto-clean is post-MVP); optional download only.
    "lama": ModelSpec("lama", "mayocream/lama-manga", "f91c85b26913b3e83f9877867b4c336da3675238", 0.21, False),
}

AMD_STABLE = "https://stable.repo.amd.com/rocm/whl-next/"
TORCH_CPU = "https://download.pytorch.org/whl/cpu"
PYPI = "https://pypi.org/simple"

COMMON_PKGS = ("rfdetr==1.7.0", "transformers==5.23.0", "safetensors>=0.8.0", "pillow", "numpy<2.4", "huggingface_hub")


@dataclass(frozen=True)
class EnvSpec:
    name: str  # also the lock file name in locks/
    backend: str  # rocm | cpu
    python: str
    torch_pkgs: tuple[str, ...]
    extra_index: str
    prerelease: bool
    approx_size_gb: float


ENVS: dict[str, EnvSpec] = {
    "rocm": EnvSpec(
        "torch-rocm",
        "rocm",
        "3.12",
        ("torch[device-gfx1031]==2.14.0+rocm10.1.0", "torchvision[device-gfx1031]==0.29.0a0+rocm10.1.0"),
        AMD_STABLE,
        True,
        6.0,
    ),
    "cpu": EnvSpec("torch-cpu", "cpu", "3.12", ("torch==2.14.0+cpu", "torchvision==0.29.0+cpu"), TORCH_CPU, False, 1.5),
}

# GPUs the ROCm wheels are known to work with (gfx1031 verified, siblings of the same family).
ROCM_ARCHS = ("gfx1030", "gfx1031", "gfx1032")

# Workarounds that are mandatory on gfx1031 (docs/05 §11).
LAYOUT_ATTN_QUERY_CHUNK = 2048  # chunked SDPA: full attention matrix does not fit into 12 GB
OCR_USE_CACHE = True  # generation_config.json has use_cache=false; without KV cache a page never finishes
OCR_MAX_NEW_TOKENS = 512  # per crop (a bubble has a few lines)
OCR_PROMPT = "OCR:"  # model card prompt for plain recognition

DEFAULTS = {
    "layout_threshold": None,  # None = model's recommended per-class thresholds
    "ocr_padding_px": 8,  # starting value, tuned in spike S2
}
