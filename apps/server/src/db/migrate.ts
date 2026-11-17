import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './driver.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.slice(0, 4)), name: f.replace(/\.sql$/, ''), sql: readFileSync(join(dir, f), 'utf8') }));
}

/**
 * Applies pending migrations in order. Before applying to a non-empty database,
 * copies it to `<backupDir>/db-pre-NNNN.sqlite` (docs/03-server-ops.md §6).
 */
export async function migrate(db: Db, migrations: Migration[], backupDir: string): Promise<number[]> {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
  const pending = migrations.filter((m) => !applied.has(m.version));
  const done: number[] = [];
  for (const m of pending) {
    if (applied.size > 0 || done.length > 0) {
      if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
      await db.backup(join(backupDir, `db-pre-${String(m.version).padStart(4, '0')}.sqlite`));
    }
    db.tx(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, new Date().toISOString());
    });
    done.push(m.version);
  }
  return done;
}
