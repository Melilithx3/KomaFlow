# 0009. Sidecar implementation

**Context.** docs/05 §9–13 and the benchmark fix models, versions and workarounds; the desktop needs a stable local API.

**Decision.**
- Control process: stdlib `http.server` + Pillow only (no torch). Heavy stages (`layout`, `ocr`) run as `python -m komaflow_sidecar.stage` in the model env built from `sidecar/locks/` (copied from the bench); one process per stage per batch, killed on cancel.
- OCR on crops with the model-card prompt `OCR:`, `use_cache=True`, greedy, `max_new_tokens=512`; crops smaller than 64 px are upscaled. Whole-page Spotting is not wired (fallback per spec, keep in mind for S2).
- Layout: model's per-class recommended thresholds unless `layout_threshold` is given; chunked SDPA (2048) on ROCm.
- OCR is disabled on CPU; `ocr_boxes` requires ROCm.
- One job at a time; job results stay in memory (last 50).
- `KOMAFLOW_SIDECAR_FAKE=1` swaps stages for deterministic stand-ins (tests, desktop development without GPU).

**Consequences.** S2 confirms timings, VRAM, padding and class map on the real GPU.
