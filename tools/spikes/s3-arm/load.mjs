// Builds and starts the server on a temp data dir, seeds the fixture chapter and runs 3 parallel clients
// (GET chapter + GET blob + GET page + PATCH + sync) for 60 s. Prints p95 latencies and server peak RSS.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');
const data = mkdtempSync(join(tmpdir(), 'komaflow-s3-'));
const env = { ...process.env, KOMAFLOW_DATA_DIR: data, KOMAFLOW_PORT: '8799', KOMAFLOW_DEV: '1', KOMAFLOW_LOG_LEVEL: 'warn' };
const seconds = Number(process.env.S3_SECONDS ?? 60);

execFileSync('pnpm', ['--filter', '@komaflow/server', 'build'], { cwd: root, stdio: 'inherit', shell: true });
execFileSync(process.execPath, ['apps/server/dist/admin.js', 'seed', '--fixtures'], { cwd: root, env, stdio: 'inherit' });
const srv = spawn(process.execPath, ['--max-old-space-size=512', 'apps/server/dist/server.js'], { cwd: root, env, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1500));

const base = 'http://127.0.0.1:8799/api/v1';
const t0 = performance.now();
const lr = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: 'demo', password: 'demo-password', device_name: 's3', client: 'desktop' }),
});
console.log(`login: ${(performance.now() - t0).toFixed(0)} ms`);
const { token } = await lr.json();
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const projects = await (await fetch(`${base}/projects`, { headers: H })).json();
const chapters = await (await fetch(`${base}/projects/${projects.projects[0].id}/chapters`, { headers: H })).json();
const chapterId = chapters.chapters[0].id;

const lat = { chapter: [], blob: [], page: [], patch: [], sync: [] };
const time = async (k, f) => {
  const t = performance.now();
  const r = await f();
  lat[k].push(performance.now() - t);
  return r;
};
let rss = 0;
const rssTimer = setInterval(() => {
  try {
    rss = Math.max(rss, Number(execFileSync('ps', ['-o', 'rss=', '-p', String(srv.pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) * 1024);
  } catch {
    // ps is not available on Windows
  }
}, 1000);

const end = Date.now() + seconds * 1000;
const client = async () => {
  while (Date.now() < end) {
    const ch = await time('chapter', async () => (await fetch(`${base}/chapters/${chapterId}`, { headers: H })).json());
    const page = ch.pages[Math.floor(Math.random() * ch.pages.length)];
    await time('blob', async () => (await fetch(`${base}/blobs/${page.raw_hash}`, { headers: H })).arrayBuffer());
    const d = await time('page', async () => (await fetch(`${base}/pages/${page.id}`, { headers: H })).json());
    const o = d.objects[0];
    await time('patch', () =>
      fetch(`${base}/objects/${o.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ base_text_ver: o.text_ver, changes: { comment: `c${Math.random()}` } }) }),
    );
    const p = d.page;
    const objects = d.objects.map((x) => ({ id: x.id, type: x.type, box: x.box, text_box: x.text_box }));
    const body = { pages: [{ id: p.id, idx: p.idx, width: p.width, height: p.height, raw_hash: p.raw_hash, clean_hash: p.clean_hash, notes_hash: p.notes_hash, thumb_hash: p.thumb_hash, base_markup_rev: p.markup_rev, objects }] };
    await time('sync', () => fetch(`${base}/chapters/${chapterId}/sync`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
  }
};
await Promise.all([client(), client(), client()]);
clearInterval(rssTimer);

const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)]?.toFixed(0);
for (const [k, v] of Object.entries(lat)) console.log(`${k.padEnd(8)} n=${v.length} p95=${p95(v)} ms`);
console.log(`server peak RSS: ${rss ? `${(rss / 1e6).toFixed(0)} MB` : 'n/a'} (target < 400 MB)`);
srv.kill('SIGTERM');
