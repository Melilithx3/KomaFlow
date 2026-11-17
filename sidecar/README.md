# komaflow sidecar

Local model service for the komaflow desktop: page layout (`mayocream/koharu-layout-highres`) →
crops → OCR (`PaddlePaddle/PaddleOCR-VL-1.6`), PyTorch with ROCm (gfx1030/1031/1032) or CPU.
No ONNX, no DirectML. Versions and workarounds come from the user's benchmark (`reference/bench/`).

- Each heavy stage runs in its own child process (`python -m komaflow_sidecar.stage`) that exits
  afterwards, so VRAM is always returned; cancel kills the process.
- OCR is disabled on CPU (too slow); layout works on CPU.
- MIOpen kernel cache is persistent: `%LOCALAPPDATA%/komaflow/sidecar/cache/miopen`.

```bash
# dev / tests (no GPU needed: stages are faked)
python -m venv .venv && .venv/Scripts/python -m pip install -e .[dev]
.venv/Scripts/python -m pytest

# engine install on the cleaner's PC (uv, Python 3.12, exact versions from locks/, models by revision)
komaflow-sidecar install --backends rocm,cpu --models layout,ocr

# spike S2: analyze a folder of pages with overlays
komaflow-sidecar analyze --pages test_data --out out/s2 --overlay [--backend rocm|cpu] [--padding 8]

# service used by the desktop
komaflow-sidecar serve --token <random>
```

Env: `KOMAFLOW_SIDECAR_HOME`, `KOMAFLOW_MODELS_DIR`, `KOMAFLOW_SIDECAR_FAKE=1` (test stand-ins).
