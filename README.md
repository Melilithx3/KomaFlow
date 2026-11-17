# komaflow

Personal service for a three-person manga translation team (cleaner → translator → typesetter).
The cleaner marks up pages in the desktop app and publishes them; the translator translates in the web UI
(also on a phone); anyone downloads layered PSDs (notes, hidden raw, clean) for typesetting in Photoshop; the translation text is copied from the web.

The specification lives in [`docs/`](docs/) (Russian). Progress: [`docs/STATUS.md`](docs/STATUS.md).

## Layout

| Path | What |
|---|---|
| `packages/contract` | zod schemas, types, OpenAPI, pure helpers, fixtures |
| `packages/psd` | PSD generator (isomorphic core) |
| `packages/page-view` | shared type palette, viewport math, copy formatting |
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

Quick demo:

```bash
cp apps/server/.env.example apps/server/.env
KOMAFLOW_DEV=1 pnpm --filter @komaflow/server admin -- seed --fixtures   # user demo / demo-password
pnpm dev:server      # terminal 1
pnpm dev:web         # terminal 2, open http://localhost:5173
```

Build instructions (Russian): [`docs/BUILD.md`](docs/BUILD.md). All commands: `CLAUDE.md` → «Команды». Operator guide: [`deploy/README.md`](deploy/README.md).
