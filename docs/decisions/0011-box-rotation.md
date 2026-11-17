# 0011. Rotated boxes

**Context.** Cleaner feedback: lettering is often tilted; axis-aligned boxes catch neighbouring text and OCR reads tilted crops badly.

**Decision.**
- Object gets `rotation`: whole degrees −180…180, clockwise on screen, around the box centre. `box` stays the unrotated rectangle (same `x,y,w,h` meaning), so validation "box inside page", reading order and old clients keep working; a rotated box may stick out of the page by its corners.
- DB: `objects.rot INTEGER NOT NULL DEFAULT 0` (migration 0002). Sync accepts optional `rotation` (missing = 0); a change counts as `moved` and bumps `geometry_ver` / `markup_rev`. `ObjectDTO.rotation` is always present.
- Desktop: rotation handle above the box, Q/E (Shift = 15°), numeric field; resize works in the box frame. Web draws and hit-tests rotated boxes.
- Sidecar OCR straightens a rotated crop (rotate the page around the box centre, then crop).
- `psd_input_hash` is unchanged (objects are not part of the MVP PSD); text layers will need rotation later.

**Consequences.** Old desktops send no rotation and would reset it to 0 on publish — update all desktops together (docs/UPDATE.md).
