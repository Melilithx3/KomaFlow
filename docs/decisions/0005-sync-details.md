# 0005. Sync details not fixed by the spec

**Context.** docs/02 §5 leaves open: what an omitted `clean_hash`/`notes_hash`/`thumb_hash` means, how page `idx` changes, what ETag is built from.

**Decision.**
- In a sync page, an omitted file hash keeps the server value; `null` removes the file. The desktop always sends all three.
- `idx` may change (pages swap in two phases inside the transaction). An `idx` used by a page outside the request → 422. Changing `idx` bumps `rev` only, not `markup_rev` (it is not part of the markup summary).
- `base_markup_rev` must equal the server value; for unknown pages it must be `null`. All conflicting pages are listed in `details.pages: [{id, markup_rev|null}]`.
- An object id that already belongs to another page → 422 (objects never move between pages).
- ETag of `GET /chapters/{id}` and `GET /pages/{id}` is a weak hash of the response body: it contains page `rev` and is also correct for per-user fields (`markup_changed_for_me`, `seen_markup_rev`).

**Consequences.** Re-sync of identical data is a no-op; the 304 path still builds the response (cheap for our sizes).
