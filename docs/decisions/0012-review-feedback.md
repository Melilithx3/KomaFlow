# 0012. Changes after the first team review

**Context.** First real use (docs: user feedback, 2026-11) — controls, ordering, OCR flow, AI translation, readability.

**Decision.**
- **Viewer controls** (web and desktop, one function `wheelAction`): wheel = vertical pan, Shift+wheel = horizontal pan, Ctrl+wheel and trackpad pinch (browsers send Ctrl+wheel) = zoom, two-finger trackpad scroll = free pan.
- **Badges** with the object number sit outside the box (above-left, else left, else inside at the page edge); non-selected boxes are dimmed while one is selected.
- **Web page screen** fills the window (no page scroll on desktop, so zoom centres are right); on phones the viewer is pinned under the header and can be collapsed.
- **Layout and OCR are separate steps** in the desktop: «Разметка» (layout only) → manual fixes → «OCR» over existing boxes (`ocr_batch` job, optionally only empty originals). Per-class layout parameters (bubble / text / onomatopoeia / panel): on/off, target type, score threshold.
- **Order editing**: drag with a drop marker, or type the number into the badge.
- **Enter** in an original moves to the next object's original (web table and desktop inspector).
- **JSON for AI**: `komaflow-translation` v1 with `instructions`, `pages[].objects[]{n,id,type,source,translation:""}`; import matches by `id`, then page+`n`, tolerates ```json fences, previews, does not overwrite existing translations unless asked; saves through normal PATCH (conflicts are counted, not forced).
- **Letter case** of originals: «как в предложении / строчные / ЗАГЛАВНЫЕ» per object and per page; it rewrites `source_text` (owned by the web).
- **Visual refresh**: design tokens, light/dark, cards, state pills, icons.

**Consequences.** Spec docs 05/06 point here for the changed behaviour.
