import { DatabaseSync, backup as sqliteBackup, type SQLInputValue } from 'node:sqlite';

export type SqlValue = SQLInputValue;
export type Row = Record<string, SqlValue>;

/**
 * Thin database layer (docs/03-server-ops.md §6). Everything above uses only this interface,
 * so the driver (node:sqlite today) can be swapped.
 */
export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): { changes: number };
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  /** Runs `fn` inside BEGIN IMMEDIATE … COMMIT; rolls back on any throw. Nested calls join the outer one. */
  tx<T>(fn: () => T): T;
  backup(destPath: string): Promise<void>;
  checkpoint(): void;
  close(): void;
  readonly path: string;
}

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  let depth = 0;
  return {
    path,
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => {
      const r = stmt(sql).run(...params);
      return { changes: Number(r.changes) };
    },
    get: <T>(sql: string, ...params: SqlValue[]) => stmt(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: SqlValue[]) => stmt(sql).all(...params) as T[],
    tx<T>(fn: () => T): T {
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
    backup: async (dest) => {
      await sqliteBackup(db, dest);
    },
    checkpoint: () => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'),
    close: () => db.close(),
  };
}
