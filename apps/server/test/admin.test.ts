import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/driver.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';

const tsx = join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const admin = join(import.meta.dirname, '..', 'src', 'admin.ts');
let dir: string;

function run(args: string[], input = '', env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [tsx, admin, ...args], {
    input,
    env: { ...process.env, KOMAFLOW_DATA_DIR: dir, KOMAFLOW_ARGON2_MEMORY_KIB: '1024', KOMAFLOW_ARGON2_PASSES: '1', ...env },
    encoding: 'utf8',
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'komaflow-admin-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('komaflow-admin', () => {
  it('create-user, list, set-password, disable', () => {
    expect(run(['create-user', 'typer', '--name', 'Тайпер'], 'secret-pass\n')).toMatch(/created typer/);
    expect(run(['list-users'])).toMatch(/typer\tТайпер\tactive/);
    expect(run(['set-password', 'typer'], 'other-pass-1\n')).toMatch(/changed/);
    expect(run(['disable-user', 'typer'])).toMatch(/disabled/);
    expect(run(['list-users'])).toMatch(/disabled/);
  });

  it('seed (dev), dump-text, backup, gc-blobs', () => {
    expect(() => run(['seed', '--fixtures'])).toThrow();
    expect(run(['seed', '--fixtures'], '', { KOMAFLOW_DEV: '1' })).toMatch(/synced 3 page/);
    const out = join(dir, 'dump.json');
    run(['dump-text', '--out', out]);
    const dump = JSON.parse(readFileSync(out, 'utf8'));
    const objs = dump.projects[0].chapters[0].pages[0].objects;
    expect(objs[0]).toMatchObject({ order: 1, source_text: 'ここが噂の店か…', state: 'translated' });
    expect(run(['backup'])).toMatch(/backup written/);
    expect(readdirSync(join(dir, 'backups')).some((f) => /^db-\d{8}\.sqlite$/.test(f))).toBe(true);
    expect(run(['gc-blobs', '--dry-run'])).toMatch(/would delete 0 blob/);
  });
});

describe('migrations', () => {
  it('apply once, back up before a new migration on a non-empty db', async () => {
    const d = mkdtempSync(join(tmpdir(), 'komaflow-mig-'));
    const migDir = join(d, 'migrations');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(migDir);
    writeFileSync(join(migDir, '0001_a.sql'), 'CREATE TABLE a (x INTEGER);');
    const db = openDb(join(d, 'db.sqlite'));
    expect(await migrate(db, loadMigrations(migDir), join(d, 'backups'))).toEqual([1]);
    expect(await migrate(db, loadMigrations(migDir), join(d, 'backups'))).toEqual([]);
    writeFileSync(join(migDir, '0002_b.sql'), 'CREATE TABLE b (y INTEGER);');
    expect(await migrate(db, loadMigrations(migDir), join(d, 'backups'))).toEqual([2]);
    expect(existsSync(join(d, 'backups', 'db-pre-0002.sqlite'))).toBe(true);
    // failing migration rolls back
    writeFileSync(join(migDir, '0003_c.sql'), 'CREATE TABLE c (z INTEGER); SELECT * FROM nope;');
    await expect(migrate(db, loadMigrations(migDir), join(d, 'backups'))).rejects.toThrow();
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'c'")).toBeUndefined();
    db.close();
    rmSync(d, { recursive: true, force: true });
  });
});
