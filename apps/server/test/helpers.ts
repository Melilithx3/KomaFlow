import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SeedHttp } from '@komaflow/contract/fixtures';
import { sharpCodec } from '@komaflow/psd/sharp';
import { buildApp } from '../src/app.js';
import { openContext } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import type { Ctx } from '../src/context.js';
import { createUser } from '../src/services/users.js';

export const PASSWORD = 'correct-horse';

export interface Client {
  token: string;
  kind: 'web' | 'desktop';
  /** Cookie header for web clients. */
  cookie?: string;
  req(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Res>;
  http: SeedHttp;
}

export interface Res {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test convenience
  headers: Record<string, string | string[] | number | undefined>;
  raw: Buffer;
}

export async function makeTestApp() {
  const dir = mkdtempSync(join(tmpdir(), 'komaflow-test-'));
  let now = new Date('2026-03-01T10:00:00Z');
  const cfg = loadConfig({ KOMAFLOW_DATA_DIR: dir }, { argon2: { memoryKiB: 1024, passes: 1, parallelism: 1 }, secureCookies: false });
  const ctx: Ctx = await openContext(cfg, () => now);
  const { app, worker } = buildApp(ctx, { codec: sharpCodec, logger: false, loginDelay: false });
  await app.ready();
  const alice = await createUser(ctx, 'alice', 'Алиса', PASSWORD);
  const bob = await createUser(ctx, 'bob', 'Боб', PASSWORD);

  const inject = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const isBytes = body instanceof Uint8Array;
    const r = await app.inject({
      method: method as 'GET',
      url: url.startsWith('/') && !url.startsWith('/api') && url !== '/healthz' ? `/api/v1${url}` : url,
      headers: {
        ...(body !== undefined && !isBytes ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      payload: isBytes ? Buffer.from(body) : body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json: unknown;
    try {
      json = r.body ? JSON.parse(r.body) : null;
    } catch {
      json = null;
    }
    return { status: r.statusCode, json, headers: r.headers, raw: r.rawPayload };
  };

  const login = async (user: 'alice' | 'bob', kind: 'web' | 'desktop'): Promise<Client> => {
    const r = await inject('POST', '/auth/login', { login: user, password: PASSWORD, device_name: `${user}-${kind}`, client: kind });
    if (r.status !== 200) throw new Error(`login failed ${r.status}`);
    let token: string;
    let cookie: string | undefined;
    if (kind === 'desktop') token = r.json.token;
    else {
      const set = String(([] as string[]).concat(r.headers['set-cookie'] as string)[0]);
      cookie = set.split(';')[0]!;
      token = cookie.split('=')[1]!;
    }
    const authHeaders = (): Record<string, string> =>
      kind === 'desktop' ? { authorization: `Bearer ${token}` } : { cookie: cookie!, 'x-komaflow-client': 'web' };
    const c: Client = {
      token,
      kind,
      cookie,
      req: (method, path, body, headers = {}) => inject(method, path, body, { ...authHeaders(), ...headers }),
      http: async (r) => {
        const res = await inject(r.method, r.path, r.bytes ?? r.json, {
          ...authHeaders(),
          ...(r.contentType ? { 'content-type': r.contentType } : {}),
        });
        return { status: res.status, body: res.json };
      },
    };
    return c;
  };

  return {
    ctx,
    app,
    worker,
    dir,
    users: { alice, bob },
    inject,
    login,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    async close() {
      worker.stop();
      await worker.idle();
      await app.close();
      ctx.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof makeTestApp>>;
