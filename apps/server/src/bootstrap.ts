import { mkdirSync } from 'node:fs';
import type { Config } from './config.js';
import type { Ctx } from './context.js';
import { openDb } from './db/driver.js';
import { loadMigrations, migrate } from './db/migrate.js';

/** Opens the database, creates data directories and applies migrations. */
export async function openContext(cfg: Config, now: () => Date = () => new Date()): Promise<Ctx> {
  for (const d of [cfg.dataDir, cfg.blobDir, cfg.tmpDir, cfg.exportDir, cfg.backupDir]) mkdirSync(d, { recursive: true });
  const db = openDb(cfg.dbPath);
  await migrate(db, loadMigrations(cfg.migrationsDir), cfg.backupDir);
  return { db, cfg, now };
}
