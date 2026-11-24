# 0019. Translation data in the desktop markup editor

**Context.** Review 2026-11-24: the cleaner wants to see and edit originals, translations and comments next to the objects and to exchange objects as JSON for AI tools, like the web.

**Decision.** Originals stay desktop data (published with sync, ADR 0013). Translation and comment of a published object are edited in the inspector exactly like in the web: `PATCH /objects/{id}` with `base_text_ver`, debounced, a `FIELD_CONFLICT` is shown with «Взять с сервера» / «Оставить моё». The JSON dialog reuses the web format and rules (`@komaflow/page-view` translation-json, data read fresh from the server). Flags are the translator's signal for the typer: the desktop shows the object's existing flag, it has no flag control of its own.

**Consequences.** Invariant 4 holds: the desktop writes web-owned fields only through the web's own endpoint and versioning, never through sync. Unpublished objects have no translation fields yet.
