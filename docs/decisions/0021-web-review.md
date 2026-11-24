# 0021. «Редакция» in the web; web uploads typed pages and review marks

**Context.** Review 2026-11-24: a chapter tab «Редакция» with exactly three sub-tabs (Клин, Перевод, Тайп); brush marks + page comments on the clean and on typed pages; uploading a typed chapter from the web.

**Decision.** Migration 0003: `pages.typed_hash` and `page_reviews (page_id, kind clean|type, marks_hash, comment, ver)`. Marks are a separate transparent PNG of the page size (content-addressed blob) — never part of the clean, the typed image or the PSD. `PUT /pages/{id}/reviews/{kind}` is optimistic by `base_ver` (409 `REVISION_CONFLICT` carries the current review). `PUT /pages/{id}/typed-image` binds an uploaded image and sets «затайплена». «Перевод» reuses the translator's object rows (same flags and comments). Upload preview matches files by the last number in the name; replacing an uploaded page is opt-in; unmatched files are skipped.

**Invariant 6 amended (user request):** blob upload (`/blobs/check`, `PUT /blobs`) is open to the web too; binding raw / clean / notes and markup stays in desktop sync.

**Consequences.** Blob GC keeps typed pages and marks. Typed images of another size are allowed but flagged in the preview.
