import { rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sharpCodec } from '@komaflow/psd/sharp';
import { buildApp } from './app.js';
import { openContext } from './bootstrap.js';
import { loadConfig } from './config.js';
import { expireExports } from './services/exports.js';

const cfg = loadConfig();
const ctx = await openContext(cfg);

// Unfinished uploads from a previous run.
for (const f of readdirSync(cfg.tmpDir)) rmSync(join(cfg.tmpDir, f), { force: true });

const { app, worker } = buildApp(ctx, { codec: sharpCodec });

const housekeeping = () => {
  try {
    const n = expireExports(ctx);
    if (n) app.log.info({ expired: n }, 'expired exports removed');
    ctx.db.checkpoint();
  } catch (err) {
    app.log.error({ err }, 'housekeeping failed');
  }
};
housekeeping();
const timer = setInterval(housekeeping, 60 * 60_000);
timer.unref();

await app.listen({ host: cfg.host, port: cfg.port });
void worker.kick();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  worker.stop();
  await app.close();
  ctx.db.checkpoint();
  ctx.db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
