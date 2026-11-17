"""Каталог моделей, окружений и комбинаций «модель × backend × вариант».

Здесь собраны все решения из docs/research.md. Чтобы добавить модель,
опишите ModelSpec, адаптер в bench/worker/adapters/ и нужные Combo.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

# --------------------------------------------------------------------------- модели


@dataclass(frozen=True)
class ModelSpec:
    key: str
    repo: str
    revision: str  # точный commit hash HF — фиксирует воспроизводимость
    adapter: str  # модуль в bench/worker/adapters
    approx_size_gb: float
    description: str


MODELS: dict[str, ModelSpec] = {
    m.key: m
    for m in [
        ModelSpec(
            key="koharu-layout",
            repo="mayocream/koharu-layout-highres",
            revision="68077eb09401a46e548190ff2786bd405113ea8b",
            adapter="koharu_layout",
            approx_size_gb=0.19,
            description="RF-DETR Seg 2XL @1920: боксы и маски text / onomatopoeia / bubble / panel",
        ),
        ModelSpec(
            key="paddleocr-vl",
            repo="PaddlePaddle/PaddleOCR-VL-1.6",
            revision="132c45f52c0a26ed5a6b2f6bd8e3985794cc27dd",
            adapter="paddleocr_vl",
            approx_size_gb=1.95,
            description="VLM 0.9B (NaViT + ERNIE-4.5-0.3B), режим Spotting по всей странице",
        ),
        ModelSpec(
            key="lama-manga",
            repo="mayocream/lama-manga",
            revision="f91c85b26913b3e83f9877867b4c336da3675238",
            adapter="lama_manga",
            approx_size_gb=0.21,
            description="Big-LaMa FFCResNetGenerator, инпейнтинг по маске из koharu-layout",
        ),
    ]
}

# --------------------------------------------------------------------------- окружения

AMD_STABLE = "https://stable.repo.amd.com/rocm/whl-next/"
AMD_NIGHTLY = "https://nightly.repo.amd.com/rocm/whl-next/"
TORCH_CPU = "https://download.pytorch.org/whl/cpu"
PYPI = "https://pypi.org/simple"


@dataclass(frozen=True)
class InstallStep:
    packages: tuple[str, ...]
    prerelease: bool = False
    # пакеты, версии которых после предыдущих шагов фиксируются как constraints
    # (чтобы, например, PyPI не заменил ROCm-сборку torch на обычную)
    pin_installed: tuple[str, ...] = ()


@dataclass(frozen=True)
class EnvSpec:
    name: str
    python: str
    steps: tuple[InstallStep, ...]
    runtime: str  # человекочитаемое описание runtime
    # Доп. индекс пакетов. uv ищет сначала в нём, затем в PyPI (стратегия first-index):
    # так torch гарантированно берётся из нужного индекса, а прочие зависимости — из PyPI.
    approx_size_gb: float
    extra_index: str | None = None
    fallback_for: str | None = None  # создаётся только если основное окружение не прошло smoke-test
    smoke: str = "torch"  # какой smoke-test запускать: torch | paddle


_COMMON_TORCH_PKGS = (
    "rfdetr==1.7.0",
    "transformers==5.23.0",
    "safetensors>=0.8.0",
    "pillow",
    "numpy<2.4",
)

ENVS: dict[str, EnvSpec] = {
    e.name: e
    for e in [
        EnvSpec(
            name="torch-cpu",
            python="3.12",
            steps=(
                InstallStep(("torch==2.14.0+cpu", "torchvision==0.29.0+cpu")),
                InstallStep(_COMMON_TORCH_PKGS, pin_installed=("torch", "torchvision")),
            ),
            runtime="PyTorch 2.14.0 CPU",
            extra_index=TORCH_CPU,
            approx_size_gb=1.5,
        ),
        EnvSpec(
            name="torch-rocm",
            python="3.12",
            steps=(
                InstallStep(
                    ("torch[device-gfx1031]==2.14.0+rocm10.1.0", "torchvision[device-gfx1031]==0.29.0a0+rocm10.1.0"),
                    prerelease=True,
                ),
                InstallStep(_COMMON_TORCH_PKGS, pin_installed=("torch", "torchvision")),
            ),
            runtime="PyTorch 2.14.0 + ROCm 10.1.0 (AMD TheRock stable, device-gfx1031)",
            extra_index=AMD_STABLE,
            approx_size_gb=6.0,
        ),
        EnvSpec(
            name="torch-rocm-nightly",
            python="3.12",
            steps=(
                InstallStep(("torch[device-gfx1031]", "torchvision[device-gfx1031]"), prerelease=True),
                InstallStep(_COMMON_TORCH_PKGS, pin_installed=("torch", "torchvision")),
            ),
            runtime="PyTorch nightly + ROCm nightly (AMD TheRock, device-gfx1031)",
            extra_index=AMD_NIGHTLY,
            approx_size_gb=6.0,
            fallback_for="torch-rocm",
        ),
        EnvSpec(
            name="torch-dml",
            python="3.12",
            steps=(
                InstallStep(("torch==2.4.1", "torchvision==0.19.1", "torch-directml==0.2.5.dev240914"), prerelease=True),
                InstallStep(
                    # rfdetr 1.5.2 — последняя версия с transformers<5 (transformers 5 требует torch>=2.6,
                    # а torch-directml жёстко привязан к torch 2.4.1)
                    ("rfdetr==1.5.2", "transformers==4.57.6", "safetensors>=0.4.3", "pillow", "numpy==1.26.4",
                     "protobuf", "sentencepiece", "einops"),  # нужны custom code PaddleOCR-VL в transformers 4.x
                    pin_installed=("torch", "torchvision", "torch-directml"),
                ),
            ),
            runtime="PyTorch 2.4.1 + torch-directml 0.2.5.dev240914 (DirectML)",
            approx_size_gb=2.0,
        ),
        EnvSpec(
            name="paddle-cpu",
            python="3.12",
            steps=(InstallStep(("paddlepaddle==3.3.1", "paddleocr[doc-parser]==3.7.0", "pillow")),),
            runtime="PaddlePaddle 3.3.1 CPU + PaddleOCR 3.7.0",
            approx_size_gb=2.0,
            smoke="paddle",
        ),
    ]
}

# --------------------------------------------------------------------------- комбинации

OFFICIAL = "official"  # путь из документации модели + backend официально поддерживает устройство
UNOFFICIAL = "unofficial"  # рабочая, но не задокументированная авторами связка (иной backend, cast dtype)
EXPERIMENTAL = "experimental"  # даунгрейд библиотек против model card, nightly-сборки, обходные решения


@dataclass
class Combo:
    model: str
    backend: str  # cpu | rocm | dml
    variant: str  # короткое имя варианта, напр. fp32 / bf16 / paddle
    env: str
    framework: str  # torch | paddle
    support: str
    notes: str
    params: dict = field(default_factory=dict)
    warmup: int = 1
    repeats: int = 3
    per_image_timeout_s: int = 900
    load_timeout_s: int = 900

    @property
    def id(self) -> str:
        return f"{self.model}/{self.backend}-{self.variant}"

    @property
    def dir_name(self) -> str:
        return f"{self.backend}-{self.variant}"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["id"] = self.id
        return d


_ROCM_NOTE = (
    "AMD TheRock: gfx1031 на Windows отмечен Release Ready в SUPPORTED_GPUS.md; "
    "известен issue ROCm/TheRock#9718 (сбой на 6700 XT со старым torch 2.9.1)."
)
_DML_NOTE = "torch-directml 0.2.5 (последний релиз, 2024-09) жёстко требует torch 2.4.1."

_QCHUNK_NOTE = (
    "Обход: в ROCm-сборке для gfx1031 нет flash/mem-efficient SDPA, MATH-ядро строит полную матрицу "
    "внимания (~14.6 ГиБ при 1920 px). Внимание считается блоками по 2048 запросов — математически "
    "эквивалентно, веса не меняются (bench/worker/adapters/_attn.py)."
)
_OCR_TIMEOUT = 2400
# generation_config.json модели задаёт use_cache=false; на практике (замер 2026-11-16, ROCm, 1 страница)
# без KV-кэша прогрев одной страницы не завершился за 7–11 мин, с кэшем — 17 с. Поэтому во всех
# вариантах use_cache=True (параметр генерации, веса не меняются); это отмечено в отчёте.
_OCR_PARAMS = {"task": "spotting", "max_new_tokens": 2048, "use_cache": True}

COMBOS: list[Combo] = [
    # ---------------- koharu-layout
    Combo("koharu-layout", "cpu", "fp32", "torch-cpu", "torch", OFFICIAL, "rfdetr 1.7.0 (версия обучения модели), эталонный прогон."),
    Combo("koharu-layout", "rocm", "fp32", "torch-rocm", "torch", OFFICIAL, _ROCM_NOTE),
    Combo(
        "koharu-layout", "rocm", "fp16", "torch-rocm", "torch", UNOFFICIAL,
        "torch.autocast(fp16) во время инференса; веса на диске не меняются.",
        params={"autocast": "float16"},
    ),
    Combo(
        "koharu-layout", "rocm", "fp32-qchunk", "torch-rocm", "torch", EXPERIMENTAL,
        _QCHUNK_NOTE, params={"attn_query_chunk": 2048},
    ),
    Combo(
        "koharu-layout", "rocm", "fp16-qchunk", "torch-rocm", "torch", EXPERIMENTAL,
        _QCHUNK_NOTE + " Плюс torch.autocast(fp16).", params={"attn_query_chunk": 2048, "autocast": "float16"},
    ),
    Combo(
        "koharu-layout", "dml", "fp32", "torch-dml", "torch", EXPERIMENTAL,
        _DML_NOTE + " Поэтому rfdetr 1.5.2 вместо 1.7.0: модель грузится strict=True, "
        "несовпадение архитектуры будет зафиксировано как ошибка.",
    ),
    Combo(
        "koharu-layout", "dml", "fp32-qchunk", "torch-dml", "torch", EXPERIMENTAL,
        _DML_NOTE + " rfdetr 1.5.2. " + _QCHUNK_NOTE.replace("в ROCm-сборке для gfx1031 нет flash/mem-efficient SDPA, MATH-ядро",
                                                         "на DirectML SDPA"),
        params={"attn_query_chunk": 2048},
    ),
    # ---------------- PaddleOCR-VL
    Combo(
        "paddleocr-vl", "cpu", "paddle", "paddle-cpu", "paddle", OFFICIAL,
        "Официальный путь: PaddlePaddle + PaddleX, только VLM-модуль (без PP-DocLayout).",
        params=dict(_OCR_PARAMS), repeats=1, per_image_timeout_s=_OCR_TIMEOUT, load_timeout_s=1800,
    ),
    Combo(
        "paddleocr-vl", "cpu", "bf16", "torch-cpu", "torch", OFFICIAL,
        "transformers 5, родной dtype bf16 (у Zen 3 нет аппаратного bf16 — ожидается медленно).",
        params=dict(_OCR_PARAMS, dtype="bfloat16"), repeats=1, per_image_timeout_s=_OCR_TIMEOUT,
    ),
    Combo(
        "paddleocr-vl", "cpu", "fp32", "torch-cpu", "torch", UNOFFICIAL,
        "transformers 5, веса приведены к fp32 в памяти при загрузке.",
        params=dict(_OCR_PARAMS, dtype="float32"), repeats=1, per_image_timeout_s=_OCR_TIMEOUT,
    ),
    Combo(
        "paddleocr-vl", "rocm", "bf16", "torch-rocm", "torch", OFFICIAL,
        _ROCM_NOTE + " Родной bf16 (у RDNA2 нет bf16-матричных блоков).",
        params=dict(_OCR_PARAMS, dtype="bfloat16"), repeats=2, per_image_timeout_s=_OCR_TIMEOUT,
    ),
    Combo(
        "paddleocr-vl", "rocm", "fp16", "torch-rocm", "torch", UNOFFICIAL,
        _ROCM_NOTE + " Веса приведены к fp16 в памяти.",
        params=dict(_OCR_PARAMS, dtype="float16"), repeats=2, per_image_timeout_s=_OCR_TIMEOUT,
    ),
    Combo(
        "paddleocr-vl", "dml", "bf16", "torch-dml", "torch", EXPERIMENTAL,
        _DML_NOTE + " transformers 4.57.6 + custom code из репозитория (trust_remote_code), родной bf16.",
        params=dict(_OCR_PARAMS, dtype="bfloat16", remote_code=True), repeats=1, per_image_timeout_s=_OCR_TIMEOUT,
    ),
    Combo(
        "paddleocr-vl", "dml", "fp16", "torch-dml", "torch", EXPERIMENTAL,
        _DML_NOTE + " transformers 4.57.6 + custom code, веса приведены к fp16 в памяти.",
        params=dict(_OCR_PARAMS, dtype="float16", remote_code=True), repeats=1, per_image_timeout_s=_OCR_TIMEOUT,
    ),
    # ---------------- lama-manga
    Combo("lama-manga", "cpu", "fp32", "torch-cpu", "torch", OFFICIAL, "Оригинальный FFCResNetGenerator (advimman/lama), эталон."),
    Combo("lama-manga", "rocm", "fp32", "torch-rocm", "torch", OFFICIAL, _ROCM_NOTE + " FFT через rocFFT."),
    Combo(
        "lama-manga", "dml", "fp32", "torch-dml", "torch", UNOFFICIAL,
        _DML_NOTE + " Модель использует torch.fft — проверяется, исполняется ли FFT на DML или уходит на CPU.",
    ),
]

# Модели в порядке выполнения: lama-manga зависит от масок koharu-layout
MODEL_ORDER = ["koharu-layout", "paddleocr-vl", "lama-manga"]

# Комбинации, которые рассмотрены и сознательно не запускаются (попадают в отчёт)
EXCLUDED: list[dict] = [
    {"what": "ROCm gfx1030 + HSA_OVERRIDE_GFX_VERSION=10.3.0", "models": "все",
     "reason": "Существует нативный пакет device-gfx1031 в TheRock; override нужен только как обход, если нативный не работает."},
    {"what": "ZLUDA", "models": "все",
     "reason": "Нативный PyTorch+ROCm под Windows существует; ZLUDA — эмуляция CUDA поверх HIP, лишний слой без выигрыша."},
    {"what": "PaddlePaddle GPU", "models": "paddleocr-vl",
     "reason": "Сборок PaddlePaddle для AMD GPU под Windows нет (только CUDA/XPU, DCU — Linux)."},
    {"what": "vLLM / SGLang", "models": "paddleocr-vl",
     "reason": "Официально Linux/CUDA (docker); community-порты на Windows RDNA2 — не Python-библиотека для этого теста."},
    {"what": "ONNX Runtime (DirectML EP), OpenVINO, ncnn/Vulkan, TensorRT, GGUF", "models": "все",
     "reason": "Запрещено ТЗ: требуют экспорта/конвертации весов."},
    {"what": "candle (родной движок Koharu, Rust)", "models": "koharu-layout, lama-manga",
     "reason": "Не Python; candle не поддерживает ROCm/DirectML."},
    {"what": "flash-attention 2", "models": "paddleocr-vl",
     "reason": "Нет сборок для RDNA2 под Windows."},
]
