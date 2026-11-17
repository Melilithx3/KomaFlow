#!/usr/bin/env node
/**
 * komaflow-admin (docs/03-server-ops.md §7).
 * Passwords are read interactively; for scripts, pipe the password to stdin.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { seedFixtureChapter } from '@komaflow/contract/fixtures';
import { sharpCodec } from '@komaflow/psd/sharp';
import { buildApp } from './app.js';
import { openContext } from './bootstrap.js';
import { loadConfig } from './config.js';
import type { Ctx } from './context.js';
import { deleteBlob, unreferencedBlobs } from './services/blobs.js';
import { createSession, createUser, findUser, setPassword, type SessionRow, type UserRow } from './services/users.js';
import { dumpText } from './services/dump.js';

const USAGE = `komaflow-admin <command>

  create-user <login> [--name "Display name"]
  set-password <login>
  disable-user <login> | enable-user <login>
  list-users
  list-sessions [<login>]
  revoke-session <session-id>
  backup [--out <file>]           online SQLite copy, keeps the 7 newest in data/backups
  dump-text [--out <file>]        JSON with all text data
  gc-blobs [--dry-run]            delete blobs no page references
  seed --fixtures                 (dev) demo user + fixture chapter through the API
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function askPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
  }
  let muted = false;
  const out = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  const ask = (q: string) =>
    new Promise<string>((res) => {
      process.stdout.write(q);
      muted = true;
      rl.question('', (a) => {
        muted = false;
        process.stdout.write('\n');
        res(a);
      });
    });
  const a = await ask(prompt);
  const b = await ask('Repeat: ');
  rl.close();
  if (a !== b) throw new Error('passwords do not match');
  return a;
}

function needUser(ctx: Ctx, login: string | undefined): UserRow {
  if (!login) throw new Error('login is required');
  const u = findUser(ctx, login);
  if (!u) throw new Error(`no user ${login}`);
  return u;
}

async function backup(ctx: Ctx, out?: string): Promise<string> {
  const day = ctx.now().toISOString().slice(0, 10).replace(/-/g, '');
  const dest = resolve(out ?? join(ctx.cfg.backupDir, `db-${day}.sqlite`));
  mkdirSync(resolve(dest, '..'), { recursive: true });
  rmSync(dest, { force: true });
  await ctx.db.backup(dest);
  if (!out) {
    const old = readdirSync(ctx.cfg.backupDir)
      .filter((f) => /^db-\d{8}\.sqlite$/.test(f))
      .sort()
      .reverse()
      .slice(7);
    for (const f of old) rmSync(join(ctx.cfg.backupDir, f), { force: true });
  }
  return dest;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === '--help' || cmd === 'help') {
    process.stdout.write(USAGE);
    return cmd ? 0 : 1;
  }
  const cfg = loadConfig();
  const ctx = await openContext(cfg);
  try {
    switch (cmd) {
      case 'create-user': {
        const login = args[0];
        if (!login) throw new Error('usage: create-user <login> [--name …]');
        const pw = await askPassword(`Password for ${login}: `);
        const u = await createUser(ctx, login, flag(args, '--name') ?? login, pw);
        console.log(`created ${u.login} (${u.id})`);
        return 0;
      }
      case 'set-password': {
        const u = needUser(ctx, args[0]);
        await setPassword(ctx, u.id, await askPassword(`New password for ${u.login}: `));
        console.log('password changed');
        return 0;
      }
      case 'disable-user':
      case 'enable-user': {
        const u = needUser(ctx, args[0]);
        const disabled = cmd === 'disable-user';
        ctx.db.run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, u.id);
        if (disabled) ctx.db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', ctx.now().toISOString(), u.id);
        console.log(`${u.login} ${disabled ? 'disabled, sessions revoked' : 'enabled'}`);
        return 0;
      }
      case 'list-users': {
        for (const u of ctx.db.all<UserRow>('SELECT * FROM users ORDER BY login')) {
          console.log(`${u.login}\t${u.display_name}\t${u.disabled ? 'disabled' : 'active'}\t${u.id}`);
        }
        return 0;
      }
      case 'list-sessions': {
        const u = args[0] ? needUser(ctx, args[0]) : null;
        const rows = ctx.db.all<SessionRow & { login: string }>(
          `SELECT s.*, u.login FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.revoked_at IS NULL ${u ? 'AND s.user_id = ?' : ''} ORDER BY s.last_used_at DESC`,
          ...(u ? [u.id] : []),
        );
        for (const s of rows) console.log(`${s.id}\t${s.login}\t${s.client}\t${s.device_name}\tlast ${s.last_used_at}\texpires ${s.expires_at}`);
        return 0;
      }
      case 'revoke-session': {
        const n = ctx.db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', ctx.now().toISOString(), args[0] ?? '').changes;
        console.log(n ? 'revoked' : 'no such active session');
        return n ? 0 : 1;
      }
      case 'backup':
        console.log(`backup written to ${await backup(ctx, flag(args, '--out'))}`);
        return 0;
      case 'dump-text': {
        const json = JSON.stringify(dumpText(ctx), null, 2);
        const out = flag(args, '--out');
        if (out) {
          writeFileSync(out, json);
          console.log(`text dump written to ${out}`);
        } else process.stdout.write(json + '\n');
        return 0;
      }
      case 'gc-blobs': {
        const dry = args.includes('--dry-run');
        const rows = unreferencedBlobs(ctx);
        let bytes = 0;
        for (const b of rows) {
          bytes += b.size;
          if (!dry) deleteBlob(ctx, b.hash);
        }
        console.log(`${dry ? 'would delete' : 'deleted'} ${rows.length} blob(s), ${(bytes / 1024 / 1024).toFixed(1)} MB`);
        return 0;
      }
      case 'seed': {
        if (!args.includes('--fixtures')) throw new Error('usage: seed --fixtures');
        if (!cfg.dev) throw new Error('seed is only available with KOMAFLOW_DEV=1');
        const login = process.env.KOMAFLOW_SEED_LOGIN ?? 'demo';
        const password = process.env.KOMAFLOW_SEED_PASSWORD ?? 'demo-password';
        const user = findUser(ctx, login) ?? (await createUser(ctx, login, 'Демо', password));
        const { token } = createSession(ctx, user.id, 'desktop', 'komaflow-admin seed');
        const { app } = buildApp(ctx, { codec: sharpCodec, logger: false });
        await app.ready();
        await seedFixtureChapter(
          async (r) => {
            const res = await app.inject({
              method: r.method,
              url: `/api/v1${r.path}`,
              headers: {
                authorization: `Bearer ${token}`,
                ...(r.json !== undefined ? { 'content-type': 'application/json' } : {}),
                ...(r.contentType ? { 'content-type': r.contentType } : {}),
              },
              payload: r.bytes ? Buffer.from(r.bytes) : r.json !== undefined ? JSON.stringify(r.json) : undefined,
            });
            return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as unknown) : null };
          },
          { translateFirstPage: true, log: (m) => console.log(m) },
        );
        await app.close();
        console.log(`demo user: ${login} / ${password}`);
        return 0;
      }
      default:
        process.stderr.write(`unknown command ${cmd}\n\n${USAGE}`);
        return 1;
    }
  } finally {
    ctx.db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
