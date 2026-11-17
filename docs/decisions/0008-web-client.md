# 0008. Web client details

**Context.** docs/06 leaves the client mechanics open: ETag handling, per-field conflict bases, layout of the table.

**Decision.**
- ETag/304 is left to the browser HTTP cache: the server sends `Cache-Control: no-cache` + `ETag`, so `fetch` revalidates with `If-None-Match` automatically; TanStack Query polls (page 15 s, chapter 30 s, only while visible).
- Drafts live in `localStorage` per object: `{field: {value, base}}`, where `base` is the object's `text_ver` when editing of that field began. A PATCH sends `base_text_ver = min(base)` of the dirty fields, so a concurrent change of the same field always yields `FIELD_CONFLICT` even if polling already showed the newer object. State and flag are sent at once, texts after 800 ms or on blur. One request in flight per object; network errors retry with backoff up to 30 s.
- «Объединить вручную» starts with «их текст\nмой текст».
- First visit of a page silently records `seen_markup_rev`; the banner appears only for later markup changes.
- One responsive row markup: a 5-column grid on wide panels, a card below 680 px of panel width (container query) and on phones (< 768 px, plus separate mobile page layout with bottom bar).
- Copy all: `N. текст`, paragraphs separated by a blank line; `(пропущено)`, `(нечитаемо)`, `(пусто)` marks.

**Consequences.** No custom ETag code; Playwright e2e is not set up yet (verified manually in a browser, see STATUS).
