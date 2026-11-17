# 0016. Warm models in the sidecar

**Context.** User requirement (2026-11-18): models that already ran must stay loaded, so repeated layout/OCR and especially LaMa clean do not wait for loading and MIOpen warm-up. docs/05 §11 ran each stage in a process that exited after the stage; VRAM (12 GB) still fits only one heavy model at a time.

**Decision.**
- One long-lived worker process per model and backend (`python -m komaflow_sidecar.worker <stage>`), JSON lines over stdin/stdout. It loads its model once; later jobs reuse it.
- Before a model runs on ROCm the other GPU workers are *parked*: weights move to CPU RAM and `torch.cuda.empty_cache()` frees VRAM, the process and kernels stay alive. Unparking is a memory copy (seconds), not a reload.
- Workers exit after `KOMAFLOW_SIDECAR_IDLE_MIN` minutes without work (default 60, 0 = never) and when the sidecar stops.
- Cancel asks the worker to stop after the current item; if it does not within `KOMAFLOW_SIDECAR_CANCEL_GRACE` s (3) it is killed (the only case a model is lost).
- GPU capabilities are probed once per sidecar run (torch import is slow); `/capabilities?refresh=1` probes again. `/workers` shows worker states. Progress reports `<stage>:loading` only for a cold model.

**Consequences.** RAM use grows by the parked models (~2–3 GB for OCR fp16 + layout + LaMa); a 16 GB PC is fine. Supersedes the "process per stage" rule of docs/05 §11 (VRAM rule kept).
