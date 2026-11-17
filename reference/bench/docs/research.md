# Исследование: модели, backend, комбинации

Дата исследования: 2026-11-16. Все утверждения ниже — из исходников/документации по ссылкам;
то, что не проверено на железе, помечено как **ожидание**.

## 0. Фактическая машина (собрано автоматически)

| Параметр | ТЗ | Фактически |
|---|---|---|
| GPU | RX 6700 XT (gfx1031, 12 GB) | **AMD Radeon RX 6750 XT** (тот же Navi 22 / gfx1031, 12 GB), драйвер 32.0.21045.16010 (16.10.2026) |
| CPU | Ryzen 5 5600X | **Ryzen 5 5600** (6C/12T) |
| RAM | 32 GB | 32 GB |
| ОС | Win 10/11 | Windows 10 Pro 19045 |
| Python | 3.12.9 | **3.13, 3.14** (py launcher), 3.12 не установлен |
| ComfyUI | есть | **не найден** на C:/D: |
| HIP SDK | — | не установлен (`HIP_PATH` пуст) — и не нужен, см. ниже |
| Диск | — | D: 357 GB свободно, C: 51 GB |

## 1. Модели

### 1.1 `mayocream/koharu-layout-highres` — rev `68077eb09401a46e548190ff2786bd405113ea8b`
- Архитектура: **RF-DETR Seg 2XL** (DINOv2-ViT backbone + deformable DETR decoder + segmentation head), библиотека `rfdetr` (PyTorch, Roboflow, Apache-2.0).
- `config.json`: `architecture=RFDETRSeg2XLarge`, `rfdetr_version=1.7.0`, `resolution=1920`, `num_select=160`, 4 класса (text, onomatopoeia, bubble, panel), рекомендованные пороги по классам.
- Веса: `model.safetensors` 186 MB, 600 тензоров FP32, SHA-256 `03de2f77…cda255`. Имена ключей — родной `state_dict` модуля `LWDETR` из `rfdetr` (`backbone.0.encoder…`, `transformer.*`), `position_embeddings [1, 25601, 384]` = (1920/12)²+1 → `positional_encoding_size=160`.
- Загрузка: создать `RFDETRSeg2XLarge(pretrain_weights=None, num_classes=4, resolution=1920, …)` и `load_state_dict(safetensors.load_file(...), strict=True)` — веса на диске не меняются.
- Выход: боксы + instance-маски + классы + score. Сохраняем JSON (сырые боксы/score/класс), PNG-маски, визуализацию.

### 1.2 `PaddlePaddle/PaddleOCR-VL-1.6` — rev `132c45f52c0a26ed5a6b2f6bd8e3985794cc27dd`
- Архитектура: VLM 0.9B — NaViT-подобный vision encoder (27 слоёв, patch 14) + ERNIE-4.5-0.3B LM (18 слоёв), M-RoPE. `torch_dtype=bfloat16`.
- Веса: `model.safetensors` 1.9 GB + custom code (`modeling_paddleocr_vl.py`, `processing_…`, `image_processing_…`) для `transformers` (`trust_remote_code`), плюс `inference.yml` для PaddleX.
- Официальные способы:
  1. **PaddlePaddle + PaddleOCR/PaddleX** (`paddlepaddle>=3.2.1`, `paddleocr[doc-parser]>=3.6`) — рекомендован авторами. Полный пайплайн `PaddleOCRVL` дополнительно использует **другую** модель разметки (PP-DocLayout) → по ТЗ («только эти три модели») используем только VLM-модуль без доп. моделей.
  2. **transformers >= 5.0** (`AutoModelForImageTextToText`), промпты `OCR:` / `Spotting:` / `Table Recognition:` … Element-level распознавание и text spotting.
- Вход: RGB, min_pixels 112896, max_pixels ~1M (spotting — 1.6M, рекомендуется апскейл ×2 для страниц < 1500px).
- Выход: текст (для spotting — текст с координатами). Сохраняем сырой вывод как есть.

### 1.3 `mayocream/lama-manga` — rev `f91c85b26913b3e83f9877867b4c336da3675238`
- Архитектура: **Big-LaMa `FFCResNetGenerator`** (advimman/lama), вход 4 канала (RGB + маска), выход RGB, 18 FFC-блоков, `pad_multiple=8`.
- Веса: `lama-manga.safetensors` 204 MB, 989 тензоров (FP32 + I64 `num_batches_tracked`). Ключи `model.N.*` = `state_dict` оригинального `FFCResNetGenerator`. Это родной формат репозитория (автор репо сам снял TorchScript-обёртку); мы используем файл как есть.
- Готовой pip-библиотеки, которая грузит именно этот safetensors, нет → в проект вендорится оригинальный код `FFCResNetGenerator` из advimman/lama (Apache-2.0) с атрибуцией. `strict=True` гарантирует, что архитектура совпадает с весами.
- Использует `torch.fft.rfftn/irfftn` — критично для DirectML.
- **Требует маску** — в ТЗ источник маски не задан (вопрос пользователю).

## 2. Backend

| Backend | Что есть на 2026-11 | Статус для gfx1031 |
|---|---|---|
| **ROCm (TheRock)** | `stable.repo.amd.com/rocm/whl-next/`: `torch 2.14.0+rocm10.1.0`, cp310–cp314, win_amd64; пакет `amd-torch-device-gfx1031`. ROCm ставится pip-колёсами внутрь venv, HIP SDK не нужен. | `SUPPORTED_GPUS.md` → Windows / RDNA2 / gfx1031: Build ✅ Sanity ✅ **Release Ready ✅**. Но есть свежий issue ROCm/TheRock#9718 (access violation на 6700 XT, torch 2.9.1). → «официально в TheRock, не подтверждено на этой машине». |
| ROCm nightly | `nightly.repo.amd.com`: `torch 2.16.0a0+rocm10.3.0a…` | запасной вариант, если stable упадёт |
| **DirectML** | `torch-directml 0.2.5.dev240914` (последний), жёстко `torch==2.4.1`, cp38–cp312 | Не развивается с 2024. `transformers 5` требует `torch>=2.6` → DML несовместим с transformers 5 и с `rfdetr>=1.6`. |
| **CPU** | torch 2.14 CPU; paddlepaddle 3.3.1 (cp39–cp313, win) | контрольный |
| PaddlePaddle GPU | только CUDA/XPU/DCU(Linux) | AMD+Windows сборок нет |

## 3. Таблица комбинаций

| # | Модель | Backend | Библиотека | Способ загрузки | Ожидаемая совместимость | Решение / примечания |
|---|---|---|---|---|---|---|
| L1 | layout | CPU | torch 2.14 CPU, rfdetr 1.7.0 | RFDETRSeg2XLarge + load_state_dict(strict) | высокая (официальный путь) | **включено**, эталон. Медленно: 2XL @1920. |
| L2 | layout | ROCm | torch 2.14+rocm10.1 (gfx1031), rfdetr 1.7.0 | то же | средняя: TheRock Release Ready, не проверено на HW | **включено** |
| L3 | layout | DirectML | torch 2.4.1 + torch-directml, rfdetr **1.5.2** (последний с transformers<5), transformers 4.x | то же | низкая: другая версия rfdetr (ключи могут не совпасть → strict провалится честно), grid_sample/bicubic на DML | **включено как experimental** |
| P1 | PaddleOCR-VL | CPU | paddlepaddle 3.3.1 + paddlex/paddleocr | VLM-модуль из snapshot HF-репо | высокая (официальный путь) | **включено** |
| P2 | PaddleOCR-VL | CPU | torch 2.14 CPU + transformers 5 | AutoModelForImageTextToText | высокая | **включено** |
| P3 | PaddleOCR-VL | ROCm | torch 2.14+rocm + transformers 5 | то же | средняя; bf16 на RDNA2 без аппаратного bf16-матмула — может быть медленно | **включено** |
| P4 | PaddleOCR-VL | DirectML | torch 2.4.1 + torch-directml + transformers 4.55 (версия из config.json) + `trust_remote_code` | custom code из репо | низкая: bf16 и SDPA/rope на DML | **включено как experimental** |
| M1 | lama-manga | CPU | torch 2.14 CPU | вендорный FFCResNetGenerator + load_state_dict(strict) | высокая | **включено**, эталон |
| M2 | lama-manga | ROCm | torch 2.14+rocm | то же (FFT через rocFFT) | средняя | **включено** |
| M3 | lama-manga | DirectML | torch 2.4.1 + torch-directml | то же | низкая: FFT на DML не поддерживается/fallback на CPU — фиксируем, если был fallback | **включено как experimental** |
| X1 | все | ROCm nightly (2.16a) | — | — | — | **запасной**: запускается автоматически, только если stable-ROCm не прошёл smoke-test |
| X2 | все | ROCm gfx1030 + `HSA_OVERRIDE_GFX_VERSION=10.3.0` | — | — | — | **исключено по умолчанию**: нативный gfx1031-пакет существует; включается флагом, env только у дочернего процесса |
| X3 | все | ZLUDA | — | — | — | **исключено**: нативный ROCm-torch под Windows существует, ZLUDA = CUDA-эмуляция поверх HIP, лишний слой без выигрыша |
| X4 | PaddleOCR-VL | Paddle GPU | — | — | — | **исключено**: нет сборок Paddle для AMD под Windows |
| X5 | PaddleOCR-VL | vLLM/SGLang | — | — | — | **исключено**: Linux/CUDA; есть community-порт vLLM на Windows RDNA2 — экзотика, не Python-библиотека |
| X6 | все | ONNX Runtime/DirectML EP, OpenVINO, ncnn/Vulkan, TensorRT | — | — | — | **исключено ТЗ**: требуют экспорта/конвертации |
| X7 | layout, lama | candle (Rust, родной Koharu) | — | — | — | **исключено**: не Python; candle без ROCm/DirectML |
| X8 | PaddleOCR-VL | flash-attn 2 | — | — | — | **исключено**: нет сборок для RDNA2/Windows |

## Источники
- HF API / model cards / config.json / заголовки safetensors трёх репозиториев (ревизии выше)
- https://github.com/ROCm/TheRock/blob/main/RELEASES.md , SUPPORTED_GPUS.md
- https://github.com/ROCm/TheRock/issues/9718
- https://pypi.org/project/torch-directml/ , https://pypi.org/project/rfdetr/ , https://pypi.org/project/transformers/ , https://pypi.org/project/paddlepaddle/
- https://github.com/advimman/lama (FFCResNetGenerator)

## 4. Проверено на железе (RX 6750 XT, 2026-11-16, 1 страница 900×1350)

Это результаты отладочного прогона `runs/20261116_222136` (1 изображение, 1–3 повтора) — для
выбора и починки комбинаций. Итоговые цифры — в полном прогоне по всем страницам.

| Комбинация | Итог | Медиана на страницу | Примечание |
|---|---|---|---|
| layout / cpu-fp32 | ✅ | 25.6 с | эталон, 20 детекций |
| layout / rocm-fp32 | ❌ OOM | — | MATH-SDPA строит матрицу 14.65 ГиБ (`flash`/`mem-efficient` для gfx1031: «No available kernel») |
| layout / rocm-fp16 (autocast) | ❌ OOM | — | та же матрица 14.65 ГиБ — autocast её не уменьшает |
| layout / rocm-fp32-qchunk | ✅ | 3.4 с | 20/20 детекций, IoU с CPU ≥ 0.997; VRAM процесса 7.6 ГБ |
| layout / rocm-fp16-qchunk | ✅ | 3.3 с | 20/20, IoU ≥ 0.958 |
| layout / dml-fp32 | ❌ | — | веса загрузились (rfdetr 1.5.2, strict) → нехватка видеопамяти на тензоре 3.9 ГБ |
| layout / dml-fp32-qchunk | ❌ | — | после бэкбона: `torch.concat` в декодере → DirectML «Параметр задан неверно» |
| PaddleOCR-VL / rocm-bf16 | ✅ | 40.3 с | 463 токена, 11.5 ток/с (с KV-кэшем) |
| PaddleOCR-VL / rocm-fp16 | ✅ | 17.7 с | тот же текст, что bf16; 26 ток/с; VRAM ~10 ГБ |
| PaddleOCR-VL / dml-fp16 | ✅ | 26.8 с | без отката на CPU; текст ≈ ROCm (порядок строк, «チ») |
| PaddleOCR-VL / dml-bf16 | ❌ | — | DirectML: `Invalid or unsupported data type BFloat16` (нативный abort) |
| PaddleOCR-VL / любой без KV-кэша | ⏹ | > 7–11 мин | `use_cache=false` из generation_config; остановлено вручную |
| PaddleOCR-VL / cpu-paddle | ⏹ | > 15 мин | Paddle на Windows считал в 1 поток; исправлено (OMP/MKL = числу физ. ядер), перепроверить |
| lama-manga / cpu-fp32 | ✅ | 10.2 с | |
| lama-manga / rocm-fp32 | ✅ | см. отчёт | FFT через rocFFT работает |
| lama-manga / dml-fp32 | ❌ | — | DirectML: `Invalid or unsupported data type ComplexFloat` (FFT) — нативный abort |

Факты по backend, выявленные проверкой:
* **ROCm (TheRock stable, torch 2.14.0+rocm10.1.0, device-gfx1031)** — работает на gfx1031 без
  `HSA_OVERRIDE_GFX_VERSION` и без HIP SDK. Но нет flash/mem-efficient attention → нужен блочный обход
  для моделей с длинными последовательностями.
* **DirectML (torch-directml 0.2.5)** — fp32/fp16 matmul/conv работают; FFT (complex) и bf16 — нет,
  причём падение нативное (процесс завершается с 0xC0000409, Python не может перехватить).
  Несовместим с `torch.inference_mode`. Ошибки Windows приходят в cp1251 и ломают декодирование в torch.
