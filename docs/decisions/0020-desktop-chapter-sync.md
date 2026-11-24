# 0020. «Синхронизировать»: server → local chapter

**Context.** Review 2026-11-24: a chapter published from another PC must be pullable into a local chapter that has the same raw pages; publishing stays as it is.

**Decision.** Matching: the workspace's server link if it has one, else the only server chapter with the same raw hashes (raw is immutable); none or several → a message, no guess. Pages match by id, then by raw hash; a relinked page takes the server id. Each page keeps `base` = clean and markup keys at the last publish / download / sync; categories are compared three-way: «без изменений», «обновление на сервере», «локальные изменения», «конфликт» (pages from old workspaces without `base`: same server revision → local, else conflict). The dialog pre-selects only categories with server updates; local pages are never replaced, conflicts only with an extra explicit checkbox. Clean = clean + notes images; markup = objects (box, rotation, type, order); a locally edited original survives a markup pull. Translation, web originals, flags and comments come automatically (`refreshWebData`). `server_markup_rev` moves to the server revision only when nothing from the server is left untaken, so a later publish over untaken server changes still hits `REVISION_CONFLICT`.

**Consequences.** Not an undo entry (like a download). Server pages missing locally are listed, not added.
