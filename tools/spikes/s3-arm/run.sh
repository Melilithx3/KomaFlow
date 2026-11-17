#!/usr/bin/env bash
# Spike S3 (docs/07-spikes.md): checks that the server installs and runs on Orange Pi Zero 3 (linux-arm64)
# without a compiler, and measures argon2 login time, RSS, SQLite latency and PSD generation.
# Usage on the Pi, from the repo root:  bash tools/spikes/s3-arm/run.sh 2>&1 | tee s3-results.txt
set -euo pipefail
cd "$(dirname "$0")/../../.."

echo "== system"; uname -a; node --version; pnpm --version || corepack enable
echo "== compiler present? (must not be needed)"; command -v cc gcc g++ make || true

echo "== install (frozen lockfile)"; pnpm install --frozen-lockfile
echo "== built-in / native modules"
node -e "const s=require('node:sqlite');console.log('node:sqlite ok', typeof s.DatabaseSync)"
node tools/spikes/s3-arm/argon2-bench.mjs
(cd apps/server && node -e "import('sharp').then(s=>console.log('sharp ok', JSON.stringify(s.default.versions)))")

echo "== tests"; pnpm test

echo "== PSD generation (S1 harness)"
pnpm --filter @komaflow/tools s1 -- --only V1-2000
pnpm --filter @komaflow/tools s1 -- --only V3
/usr/bin/time -v pnpm --filter @komaflow/tools s1 -- --only V1-2000 2>&1 | grep -E "Maximum resident|Elapsed" || true

echo "== load: server + 3 clients for 60 s"
node tools/spikes/s3-arm/load.mjs
