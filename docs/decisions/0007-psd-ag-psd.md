# 0007. PSD writer: ag-psd 34

**Context.** S1 asks for raster PSD with Notes / Raw (hidden) / Clean. Need to know ag-psd layer order and Node requirements.

**Decision.** Use `ag-psd` 34.2 `writePsdUint8Array` with per-layer `imageData` (no canvas needed for writing). Verified in `dist/psdWriter.js` (`addChildren`): `children` are written in file order, which is **bottom-first**, so the generator passes `[Clean, Raw, Notes]`. Options: `noBackground: true` (Clean stays a normal layer, not a locked Background), no thumbnail (needs canvas), RLE (default, no zip compression for compatibility). Composite image is computed by the generator from visible layers (source-over with layer opacity). Reading back in tests needs only `initializeCanvas(_, createImageData)`.

**Consequences.** Golden tests read the PSD back and check names, order, visibility, opacity, sizes, no text layers. Photoshop check remains manual (S1 checklist).
