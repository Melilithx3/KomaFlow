# komaflow

Personal service for a three-person manga translation team (cleaner → translator → typesetter).
The cleaner marks up pages in the desktop app and publishes them; the translator translates in the web UI
(also on a phone); anyone downloads PSDs with editable text layers for typesetting in Photoshop.

The specification lives in [`docs/`](docs/) (Russian). Progress: [`docs/STATUS.md`](docs/STATUS.md).

## Layout

| Path | What |
|---|---|
| `packages/contract` | zod schemas, types, OpenAPI, pure helpers, fixtures |
| `packages/psd` | PSD generator (isomorphic core) |
| `apps/server` | Fastify + SQLite API, export worker, admin CLI |
| `apps/web` | React + Vite web UI |
| `apps/desktop` | Tauri 2 desktop app |
| `sidecar` | Python model service (layout + OCR) |
| `tools` | seed script, spike harnesses |
| `deploy` | nginx, systemd, Windows service configs |

## Commands

Requires Node >= 24.7 and pnpm 10 (`npm i -g pnpm@10`).

```bash
pnpm install
pnpm test          # all vitest projects
pnpm lint
pnpm typecheck
pnpm build
```

More commands are listed in `CLAUDE.md` → «Команды» as they appear.
