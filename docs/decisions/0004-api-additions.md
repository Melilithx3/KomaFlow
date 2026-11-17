# 0004. Small API additions beyond docs/02

**Context.** Some UI needs are not covered by the API text.

**Decision.**
- `MarkupSummary.thumb_changed` (thumb changes bump `markup_rev` per 01 §3.1).
- `GET /pages/{id}` also returns `seen_markup_rev` (banner), `GET /exports/{id}` returns `manifest` when done; chapter list item has `ready_count`.
- 409 FIELD_CONFLICT `details` = `{fields, server_values, object, updated_by: {id, login, display_name}}` so the dialog can name the other user.
- Extra error codes: `EXPORT_NOT_READY` (409), `GONE` (410 expired export), `HASH_MISMATCH` (422 blob body != path), `INTERNAL_ERROR` (500).
- PATCH: a field whose new value equals the current one is a no-op and never conflicts (01 §3.2 says such a field is not changed).

**Consequences.** All of it lives in `packages/contract` schemas; OpenAPI reflects it.
