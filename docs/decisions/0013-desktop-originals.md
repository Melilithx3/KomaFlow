# 0013. Desktop may update originals of existing objects

**Context.** With layout and OCR as separate steps (ADR 0012) the cleaner OCRs boxes that are already published; sync ignored `source_text` of existing objects (docs/01 §3.4), so new OCR never reached the web. Approved by the user (2026-11-18): the desktop writes the original unless the web has changed it.

**Decision.**
- `SyncObject.source_text` is applied to an existing object when the server value equals `source_text_base` (the server value the desktop last saw), or, without a base, when the web never edited the field. `source_text_force: true` overwrites.
- Otherwise the page still syncs and the response lists `source_conflicts` (server vs desktop value); `source_updated` lists applied ones. Applying works like a web edit: `text_ver` + `field_vers.source_text` + history, page `rev` grows, `markup_rev` does not.
- Desktop keeps `server_source` per object; the page digest includes the original. Publish shows the conflicts: «Оставить версию из веба» or «Перезаписать мой вариант». The 60-second web refresh takes web edits of originals the desktop did not change locally.
- `translation`, `state`, `comment`, `flagged` stay web-only.

**Consequences.** Invariant 4 in CLAUDE.md is amended accordingly.
