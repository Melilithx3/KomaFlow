import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { initializeCanvas, readPsd } from 'ag-psd';
import { encodePng, fixtureSyncPage, seedFixtureChapter, type FixturePage } from '@komaflow/contract/fixtures';
import { sha256Hex } from '@komaflow/contract';
import { expireExports } from '../src/services/exports.js';
import { makeTestApp, type Client, type TestApp } from './helpers.js';

initializeCanvas(
  () => {
    throw new Error('no canvas');
  },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as never,
);

let t: TestApp;
let desk: Client;
let web: Client;
let chapterId: string;
let projectId: string;
let pages: FixturePage[];

beforeEach(async () => {
  t = await makeTestApp();
  desk = await t.login('alice', 'desktop');
  web = await t.login('bob', 'web');
  const s = await seedFixtureChapter(desk.http, { translateFirstPage: true });
  chapterId = s.chapter.id;
  projectId = s.project.id;
  pages = s.pages;
});
afterEach(async () => t.close());

async function runExport(body: unknown = {}) {
  const r = await web.req('POST', `/chapters/${chapterId}/exports`, body);
  if (r.status !== 202) return r;
  await t.worker.idle();
  return web.req('GET', `/exports/${r.json.export.id}`);
}

const status = async () => (await web.req('GET', `/chapters/${chapterId}/export-status`)).json;

describe('exports', () => {
  it('default: only ready pages, zip with PSD + manifest, layer order', async () => {
    const r = await runExport();
    expect(r.json.export).toMatchObject({ status: 'done', progress: { done: 1, total: 1 }, errors: [] });
    expect(r.json.export.params).toEqual({ only_ready: true, page_ids: null, layers: { raw: true, clean: true, notes: true, text: false } });
    const m = r.json.manifest;
    expect(m.pages.map((p: { idx: number; file: string }) => [p.idx, p.file])).toEqual([[1, '001.psd']]);
    expect(m.skipped_pages.map((s: { idx: number; reason: string }) => [s.idx, s.reason])).toEqual([
      [2, 'not_ready'],
      [3, 'not_ready'],
    ]);
    expect(m.generator.name).toBe('komaflow-psd');
    expect(m.created_by.login).toBe('bob');

    const dl = await web.req('GET', `/exports/${r.json.export.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    const files = unzipSync(new Uint8Array(dl.raw));
    expect(Object.keys(files).sort()).toEqual(['1/001.psd', 'manifest.json']);
    expect(JSON.parse(strFromU8(files['manifest.json']!)).export_id).toBe(r.json.export.id);
    const psd = readPsd(files['1/001.psd']!, { useImageData: true, skipThumbnail: true });
    const names = [...psd.children!].reverse().map((l) => [l.name, !!l.hidden]);
    expect(names).toEqual([
      ['Notes', false],
      ['Raw', true],
      ['Clean', false],
    ]);
  });

  it('layer flags: text → 422, none → 422, only notes skips pages without notes', async () => {
    expect((await web.req('POST', `/chapters/${chapterId}/exports`, { layers: { text: true } })).status).toBe(422);
    expect((await web.req('POST', `/chapters/${chapterId}/exports`, { layers: { raw: false, clean: false, notes: false } })).status).toBe(422);
    const r = await runExport({ only_ready: false, layers: { raw: false, clean: false, notes: true } });
    expect(r.json.manifest.pages.map((p: { idx: number }) => p.idx)).toEqual([1]);
    expect(r.json.manifest.skipped_pages.map((s: { reason: string }) => s.reason)).toEqual(['no_layers', 'no_layers']);
  });

  it('include unready: page without clean is skipped with no_clean unless clean is off', async () => {
    const r = await runExport({ only_ready: false });
    expect(r.json.manifest.pages.map((p: { idx: number }) => p.idx)).toEqual([1, 2]);
    expect(r.json.manifest.skipped_pages).toEqual([{ page_id: pages[2]!.id, idx: 3, reason: 'no_clean' }]);
    const r2 = await runExport({ only_ready: false, layers: { clean: false } });
    expect(r2.json.manifest.pages.map((p: { idx: number }) => p.idx)).toEqual([1, 2, 3]);
  });

  it('single page via page_ids; nothing to export → 409', async () => {
    const r = await runExport({ only_ready: false, page_ids: [pages[1]!.id] });
    expect(r.json.manifest.pages.map((p: { idx: number }) => p.idx)).toEqual([2]);
    const none = await web.req('POST', `/chapters/${chapterId}/exports`, { page_ids: [pages[2]!.id] });
    expect(none.status).toBe(409);
    expect(none.json.error.code).toBe('EXPORT_NOT_READY');
  });

  it('freshness: translation edits keep it fresh; clean/notes/settings make it stale', async () => {
    expect((await status()).latest_export_id).toBeNull();
    await runExport();
    let s = await status();
    expect(s.pages.map((p: { state: string }) => p.state)).toEqual(['fresh', 'not_exported', 'not_exported']);

    const o = (await web.req('GET', `/pages/${pages[0]!.id}`)).json.objects[0];
    await web.req('PATCH', `/objects/${o.id}`, { base_text_ver: o.text_ver, changes: { translation: 'Новый перевод' } });
    const moved = fixtureSyncPage(pages[0]!, 1);
    moved.objects[0]!.box = { x: 10, y: 10, w: 50, h: 50 };
    await desk.req('POST', `/chapters/${chapterId}/sync`, { pages: [moved] });
    expect((await status()).pages[0].state).toBe('fresh');

    const clean2 = encodePng(800, 1200, new Uint8Array(800 * 1200 * 4).fill(250));
    await desk.req('PUT', `/blobs/${sha256Hex(clean2)}`, clean2, { 'content-type': 'image/png' });
    const withClean = { ...moved, base_markup_rev: 2, clean_hash: sha256Hex(clean2) };
    expect((await desk.req('POST', `/chapters/${chapterId}/sync`, { pages: [withClean] })).status).toBe(200);
    s = await status();
    expect(s.pages[0]).toMatchObject({ state: 'stale', stale_reasons: ['clean'] });

    await runExport();
    expect((await status()).pages[0].state).toBe('fresh');
    const project = (await web.req('GET', '/projects')).json.projects.find((p: { id: string }) => p.id === projectId);
    await web.req('PATCH', `/projects/${projectId}`, { settings: { psd: { ...project.settings.psd, notes_opacity: 50 } } });
    expect((await status()).pages[0]).toMatchObject({ state: 'stale', stale_reasons: ['settings'] });

    const noNotes = { ...withClean, base_markup_rev: 3, notes_hash: null };
    await desk.req('POST', `/chapters/${chapterId}/sync`, { pages: [noNotes] });
    expect((await status()).pages[0].stale_reasons).toEqual(['notes', 'settings']);
  });

  it('expiry removes the file and download answers 410', async () => {
    const r = await runExport();
    const id = r.json.export.id;
    t.advance(8 * 86_400_000);
    expect(expireExports(t.ctx)).toBe(1);
    expect((await web.req('GET', `/exports/${id}`)).json.export.status).toBe('expired');
    const dl = await web.req('GET', `/exports/${id}/download`);
    expect(dl.status).toBe(410);
    // freshness still uses the expired export's manifest
    expect((await status()).latest_export_id).toBe(id);
    expect((await web.req('GET', `/chapters/${chapterId}/exports`)).json.exports).toHaveLength(1);
  });

  it('a page whose blob vanished goes to errors.json, export still done', async () => {
    await web.req('PATCH', `/objects/${pages[1]!.objects[0]!.id}`, { base_text_ver: 0, changes: { state: 'skipped' } });
    for (const o of pages[1]!.objects.slice(1)) await web.req('PATCH', `/objects/${o.id}`, { base_text_ver: 0, changes: { state: 'skipped' } });
    const { rmSync } = await import('node:fs');
    const { blobPath } = await import('../src/services/blobs.js');
    rmSync(blobPath(t.ctx, sha256Hex(pages[1]!.raw)));
    const r = await runExport();
    expect(r.json.export.status).toBe('done');
    expect(r.json.export.errors).toEqual([expect.objectContaining({ page_id: pages[1]!.id, code: 'BLOB_MISSING' })]);
    const dl = await web.req('GET', `/exports/${r.json.export.id}/download`);
    expect(Object.keys(unzipSync(new Uint8Array(dl.raw))).sort()).toEqual(['1/001.psd', 'errors.json', 'manifest.json']);
  });
});
