/**
 * Publishes the synthetic fixture chapter through the real HTTP API, like the desktop does.
 *   pnpm seed -- --url http://127.0.0.1:8787 --login demo --password demo-password [--translate]
 * Env: KOMAFLOW_URL, KOMAFLOW_SEED_LOGIN, KOMAFLOW_SEED_PASSWORD.
 */
import { seedFixtureChapter, type SeedHttp } from '@komaflow/contract/fixtures';

const args = process.argv.slice(2);
const opt = (name: string, env: string, d: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]! : (process.env[env] ?? d);
};
const base = opt('--url', 'KOMAFLOW_URL', 'http://127.0.0.1:8787').replace(/\/$/, '');
const login = opt('--login', 'KOMAFLOW_SEED_LOGIN', 'demo');
const password = opt('--password', 'KOMAFLOW_SEED_PASSWORD', 'demo-password');

const res = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password, device_name: 'seed script', client: 'desktop' }),
});
if (!res.ok) throw new Error(`login failed: HTTP ${res.status} ${await res.text()}`);
const { token } = (await res.json()) as { token: string };

const http: SeedHttp = async (r) => {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body: BodyInit | undefined;
  if (r.bytes) {
    headers['content-type'] = r.contentType ?? 'application/octet-stream';
    body = r.bytes as unknown as BodyInit;
  } else if (r.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(r.json);
  }
  const x = await fetch(`${base}/api/v1${r.path}`, { method: r.method, headers, body });
  const text = await x.text();
  return { status: x.status, body: text ? (JSON.parse(text) as unknown) : null };
};

const out = await seedFixtureChapter(http, { translateFirstPage: args.includes('--translate'), log: (m) => console.log(m) });
console.log(`done: ${base}/chapters/${out.chapter.id}`);
