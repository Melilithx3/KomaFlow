# 0017. Notes tool in the clean editor

**Context.** User, 2026-11-18: the cleaner wants to leave marks for the typer while cleaning, on a separate layer that goes to the server as the page notes — only if they actually drew on it.

**Decision.**
- Tool «Пометка» (key N) in the «Клин» mode: a transparent RGBA layer of the page size over the clean, painted with a normal brush (own colour, default red; size/hardness/opacity shared); Shift erases (alpha). Toggle «пометки» hides the layer on screen only.
- Start = existing page notes (imported or drawn earlier) if the size matches raw, else empty. Undo/redo is shared with the clean (one order stack across both layers).
- Saving (button, Ctrl+S, auto-save on leaving/publishing) stores the layer only when it was edited: visible pixels → PNG bound as page notes (`ImportFiles('notes')`); erased to nothing → notes removed (`file: null`); untouched → nothing. Publishing sends `notes_hash` as for imported notes, so the PSD gets the `Notes` layer.

**Consequences.** Imported notes and drawn notes are the same file: drawing over imported notes edits them. Non-PNG imported notes are re-encoded to PNG on save.
