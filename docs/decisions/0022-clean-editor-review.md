# 0022. Clean editor: brushes, object mask, residuals, autosave

**Context.** Review 2026-11-24 of the clean tab.

**Decision.**
- Brushes: a stroke keeps the max coverage per pixel (no airbrush build-up while holding or moving slowly; a new stroke may build up). Hardness: the soft edge widens non-linearly, low hardness also gets a higher falloff power, 0…100 % in the UI. Size: logarithmic slider 0.5…400 px with 0.1 px steps below 10, a number field showing the applied diameter, `[ ]` and Alt+wheel (no scroll / zoom). Range inputs lost the text-field padding that kept the thumb off the ends.
- Object mask (Alt+M = selected object, Alt+click in the mask tool = object under the cursor; rotation respected): hysteresis instead of one threshold — dark pixels count only when connected to «strong» ones (much darker than the box background, its 90th percentile). JPEG specks near letters no longer grow into stray blobs; faint letter edges stay. Manual mask editing is unchanged.
- Residual inspection (I): pixels of the clean darker than their 9×9 mean by more than the sensitivity, only where the raw had text; magenta overlay + rings for single pixels; an aid, not a guarantee; never written into the clean.
- R toggles RAW view (painting disabled while shown). No clean yet → a copy of raw is saved at once; edits autosave 1.5 s after the last change, not as markup undo entries; a failed write is shown and keeps the edit pending; page/mode switches wait for a successful save.
