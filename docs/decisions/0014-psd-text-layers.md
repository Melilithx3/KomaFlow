# 0014. Editable text layers in PSD

**Context.** Leaving MVP (user, 2026-11-18): the typer wants the translation already placed in the PSD. User choice: native text layers only (no `apply-text.jsx` fallback); font unknown yet → `ArialMT` default, configurable per project.

**Decision.**
- `@komaflow/psd/src/text.ts`: one paragraph (box) text layer per translated object, name `07_bubble`, inside group `Text` between `Raw` and `Clean`. Rect = `text_box`, else box inset by `text_padding[type]`; rotation from the object (transform matrix around the box centre). Font, colour, alignment, line height, base/min size from project `PsdSettings`; size shrinks by the word-wrap heuristic of docs/04 §3. PSD carries `resolutionInfo` = `dpi`; font size in pt = px·72/dpi.
- ag-psd does not render text pixels: the file is written with `invalidateTextLayers`, Photoshop asks to update text layers on open («Обновить»).
- `DEFAULT_EXPORT_LAYERS.text = true`; text-only export allowed; pages without translated objects and no other layer are skipped (`no_layers`). `psd_input_hash` includes objects (with rotation) and full settings when text is on, so translation/markup/font edits make an export stale.
- Web: «Текст» checkbox active; project settings expose font, DPI, colour, alignment, sizes, spacing, padding.

**Consequences.** Real check in Photoshop: docs/spikes/S1b-checklist.md. If Photoshop rejects these layers, the fallback must be agreed with the user.
