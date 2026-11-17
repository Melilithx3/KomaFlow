# 0015. Clean editor in the desktop

**Context.** Leaving MVP (user, 2026-11-18): the cleaner wants to clean in komaflow — LaMa auto-clean, brush and eraser, mask brush for LaMa, fill and clone stamp.

**Decision.**
- Mode «Клин» in the desktop editor. The page clean is a full-resolution RGBA raster edited in the WebView (`core/raster.ts`, pure functions with tests); start = existing clean, else a copy of raw. Tools: brush (colour, Alt = eyedropper), eraser (restores raw), flood fill (tolerance), clone stamp (Alt = source), mask brush (Shift erases); size/hardness/opacity; pixel undo by rectangles, memory-capped.
- Auto-clean: text mask = pixels darker than a threshold inside each box (inset 4 % to skip the bubble outline), dilated by N px; LaMa (`mayocream/lama-manga`, revision from the benchmark) inpaints under the mask in the sidecar (`inpaint` job, own process, crop around the mask + 96 px context; ROCm or CPU). Scopes: selected box, page, chapter. Manual mask + «Стереть» for SFX over art.
- Saving encodes PNG, stores it content-addressed in the workspace and binds it as the page clean (`ImportFiles`, undoable in the markup history). Leaving the page/mode, publishing or closing saves automatically. Publishing uploads the clean like an imported one.
- Tauri: binary IPC (`ws_save_image`, `ws_write_temp`, `read_file`) instead of JSON byte arrays.

**Consequences.** The sidecar `inpaint` job is tested with a fake stage; the LaMa buttons in the UI could not be run here (no engine in the browser dev host) — check on the cleaner's PC with the real model. The mask heuristic misses white-on-black lettering: use the mask brush.
