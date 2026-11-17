# 0010. Desktop architecture details

**Context.** docs/05 §3 fixes state-outside-canvas, commands with undo/redo and Rust for files/network/token; the dev machine has no Rust toolchain.

**Decision.**
- `apps/desktop/src/core` is plain TS behind a `Host` interface (files, hashing, thumbnails, uploads, token, sidecar). Implementations: `tauriHost` (Rust commands), `browserHost` (dev in a browser through the Vite proxy), `MemoryHost` (tests against the real server app).
- Store = immutable workspace + command history (cap 200). Structural commands snapshot the page's object list; gesture steps share a merge key → one undo entry per drag / arrow-key run. Web data (flags, comments) and publish results are applied with `patch` (not undoable).
- Workspace on disk: `workspace.json` + `pages/<id>.json`, atomic writes, 1 s debounce, only changed pages written. Page digest (idx, file hashes, geometry) decides «изменена после публикации»; publish sends only new/changed pages.
- Canvas is a 2D `<canvas>` redrawn in one rAF; the current page image only (lazy). New boxes default to `bubble`.
- Import matching: file stem, then the last number in the name (unique only), else idx; size mismatch never applied.
- Token: Windows Credential Manager via `keyring` (service `komaflow`, account = server URL). HTTP plugin scope: any `https://` host plus localhost.
- The engine installer dialog is not in the UI yet: `komaflow-sidecar install` from a console (documented).

**Consequences.** Rust side compiles only on a machine with Rust (see `apps/desktop/src-tauri/README.md`).
