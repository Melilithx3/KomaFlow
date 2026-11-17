# komaflow desktop — Tauri shell

Not built on the development machine (no Rust toolchain there). To build on the cleaner's PC:

1. Install Rust (https://rustup.rs, MSVC toolchain) and WebView2 (preinstalled on Windows 10/11).
2. Icons: `pnpm --filter @komaflow/desktop tauri icon src-tauri/icons/icon.svg` (generates icon.ico / icon.png).
3. Dev: `pnpm --filter @komaflow/desktop tauri dev`. Installer: `pnpm --filter @komaflow/desktop tauri build`
   → `src-tauri/target/release/bundle/nsis/*.exe` (per-user install, no admin rights).

The same UI runs in a plain browser for development: `pnpm --filter @komaflow/desktop dev` → http://localhost:1420
(browser host: files in memory, token in localStorage; the API is proxied to http://127.0.0.1:8787).

Commands live in `src/lib.rs` and must match `src/hosts/tauriHost.ts`. The token is stored in the Windows
Credential Manager (`keyring`, service `komaflow`, account = server URL). The Python engine is not bundled:
`komaflow-sidecar install` creates it under `%LOCALAPPDATA%\komaflow\sidecar`; its sources are bundled as resources.
