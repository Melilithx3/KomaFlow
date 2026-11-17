import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodePng, fixtureSyncPage, makeFixtureChapter, seedFixtureChapter, type FixturePage } from '@komaflow/contract/fixtures';
import { sha256Hex, uuidv7, type SyncPage } from '@komaflow/contract';
import { makeTestApp, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let desk: Client;
let web: Client;
let chapterId: string;
let pages: FixturePage[];

beforeEach(async () => {
  t = await makeTestApp();
  desk = await t.login('alice', 'desktop');
  web = await t.login('bob', 'web');
  const seeded = await seedFixtureChapter(desk.http);
  chapterId = seeded.chapter.id;
  pages = seeded.pages;
});
afterEach(async () => t.close());

const rowsOf = (pageId: string) =>
  t.ctx.db.all<{ id: string; ord: number; deleted: number; geometry_ver: number; translation: string; source_text: string }>(
    'SELECT id, ord, deleted, geometry_ver, translation, source_text FROM objects WHERE page_id = ? ORDER BY deleted, ord',
    pageId,
  );

async function rev(pageId: string): Promise<number> {
  return (await web.req('GET', `/pages/${pageId}`)).json.page.markup_rev;
}

async function sync(p: SyncPage[]) {
  return desk.req('POST', `/chapters/${chapterId}/sync`, { pages: p });
}

describe('blobs', () => {
  it('check, put (201 then 200), get with immutable cache + ETag', async () => {
    const png = encodePng(4, 3, new Uint8Array(48).fill(255));
    const h = sha256Hex(png);
    expect((await desk.req('POST', '/blobs/check', { hashes: [h] })).json.missing).toEqual([h]);
    const put = await desk.req('PUT', `/blobs/${h}`, png, { 'content-type': 'image/png' });
    expect(put.status).toBe(201);
    expect(put.json).toMatchObject({ hash: h, width: 4, height: 3, mime: 'image/png', created: true });
    expect((await desk.req('PUT', `/blobs/${h}`, png, { 'content-type': 'image/png' })).status).toBe(200);
    expect((await desk.req('POST', '/blobs/check', { hashes: [h] })).json.missing).toEqual([]);
    const get = await web.req('GET', `/blobs/${h}`);
    expect(get.status).toBe(200);
    expect(get.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(get.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(get.raw, Buffer.from(png))).toBe(0);
    expect((await web.req('GET', `/blobs/${h}`, undefined, { 'if-none-match': `"${h}"` })).status).toBe(304);
  });

  it('rejects hash mismatch, wrong type, bad signature, too large', async () => {
    const png = encodePng(2, 2, new Uint8Array(16));
    const wrong = 'b'.repeat(64);
    expect((await desk.req('PUT', `/blobs/${wrong}`, png, { 'content-type': 'image/png' })).json.error.code).toBe('HASH_MISMATCH');
    const txt = new TextEncoder().encode('hello');
    expect((await desk.req('PUT', `/blobs/${sha256Hex(txt)}`, txt, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await desk.req('PUT', `/blobs/${sha256Hex(txt)}`, txt, { 'content-type': 'image/png' })).status).toBe(415);
    t.ctx.cfg.maxBlobBytes = 10;
    const big = await desk.req('PUT', `/blobs/${sha256Hex(png)}`, png, { 'content-type': 'image/png' });
    expect(big.status).toBe(413);
    // nothing left behind
    expect((await desk.req('POST', '/blobs/check', { hashes: [sha256Hex(png)] })).json.missing).toHaveLength(1);
  });

  it('pixel bomb limits', async () => {
    t.ctx.cfg.maxPixels = 10;
    const png = encodePng(4, 4, new Uint8Array(64));
    expect((await desk.req('PUT', `/blobs/${sha256Hex(png)}`, png, { 'content-type': 'image/png' })).status).toBe(413);
  });
});

describe('sync', () => {
  it('seed created pages with ord 1..n, rev 1 and source text', async () => {
    const r = await web.req('GET', `/chapters/${chapterId}`);
    expect(r.json.pages).toHaveLength(3);
    expect(r.json.pages.map((p: { markup_rev: number }) => p.markup_rev)).toEqual([1, 1, 1]);
    const rows = rowsOf(pages[0]!.id);
    expect(rows.map((o) => o.ord)).toEqual([1, 2, 3, 4]);
    expect(rows[0]!.source_text).toBe('ここが噂の店か…');
  });

  it('is idempotent: same data does not bump markup_rev', async () => {
    const r = await sync(pages.map((p) => fixtureSyncPage(p, 1)));
    expect(r.status).toBe(200);
    expect(r.json.pages.every((p: { changed: boolean; markup_rev: number }) => !p.changed && p.markup_rev === 1)).toBe(true);
    expect(await rev(pages[0]!.id)).toBe(1);
  });

  it('REVISION_CONFLICT on stale base, nothing applied', async () => {
    const p = fixtureSyncPage(pages[0]!, 0);
    p.objects = p.objects.slice(1);
    const r = await sync([p]);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('REVISION_CONFLICT');
    expect(r.json.error.details.pages).toEqual([{ id: pages[0]!.id, markup_rev: 1 }]);
    expect(rowsOf(pages[0]!.id).filter((o) => !o.deleted)).toHaveLength(4);
  });

  it('BLOBS_MISSING lists missing hashes and changes nothing', async () => {
    const extra = encodePng(800, 1200, new Uint8Array(800 * 1200 * 4).fill(7));
    const p = { ...fixtureSyncPage(pages[0]!, 1), clean_hash: sha256Hex(extra) };
    const r = await sync([p]);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'BLOBS_MISSING', details: { missing: [sha256Hex(extra)] } });
    await desk.req('PUT', `/blobs/${sha256Hex(extra)}`, extra, { 'content-type': 'image/png' });
    const ok = await sync([p]);
    expect(ok.status).toBe(200);
    expect(ok.json.pages[0]).toMatchObject({ changed: true, markup_rev: 2, summary: { clean_changed: true } });
  });

  it('SIZE_MISMATCH for clean of another size, RAW_IMMUTABLE for new raw', async () => {
    const small = encodePng(10, 10, new Uint8Array(400));
    await desk.req('PUT', `/blobs/${sha256Hex(small)}`, small, { 'content-type': 'image/png' });
    const r = await sync([{ ...fixtureSyncPage(pages[0]!, 1), clean_hash: sha256Hex(small) }]);
    expect(r.json.error.code).toBe('SIZE_MISMATCH');
    const raw2 = await sync([{ ...fixtureSyncPage(pages[0]!, 1), raw_hash: sha256Hex(pages[1]!.raw) }]);
    expect(raw2.json.error.code).toBe('RAW_IMMUTABLE');
    // new page whose raw does not match declared size
    const np = { ...fixtureSyncPage(pages[0]!, null), id: uuidv7(), idx: 9, width: 10, height: 10, clean_hash: null, notes_hash: null, objects: [] };
    expect((await sync([np])).json.error.code).toBe('SIZE_MISMATCH');
  });

  it('validates boxes inside page and duplicate ids', async () => {
    const p = fixtureSyncPage(pages[0]!, 1);
    p.objects[0]!.box = { x: 700, y: 0, w: 200, h: 10 };
    const r = await sync([p]);
    expect(r.status).toBe(422);
    expect(r.json.error.details.issues[0].path).toBe('pages.0.objects.0.box');
    const d = fixtureSyncPage(pages[0]!, 1);
    d.objects[1]!.id = d.objects[0]!.id;
    expect((await sync([d])).status).toBe(422);
    const tb = fixtureSyncPage(pages[0]!, 1);
    tb.objects[0]!.text_box = { x: 0, y: 1190, w: 10, h: 20 };
    expect((await sync([tb])).status).toBe(422);
  });

  it('soft delete keeps text, restore brings it back; ord stays 1..n', async () => {
    const pid = pages[0]!.id;
    const victim = pages[0]!.objects[1]!.id;
    const o = (await web.req('GET', `/pages/${pid}`)).json.objects.find((x: { id: string }) => x.id === victim);
    await web.req('PATCH', `/objects/${victim}`, { base_text_ver: o.text_ver, changes: { translation: 'Добро пожаловать!' } });

    const p = fixtureSyncPage(pages[0]!, 1);
    p.objects = p.objects.filter((x) => x.id !== victim);
    const r = await sync([p]);
    expect(r.json.pages[0]).toMatchObject({ markup_rev: 2, summary: { deleted: [victim] } });
    let rows = rowsOf(pid);
    expect(rows.filter((x) => !x.deleted).map((x) => x.ord)).toEqual([1, 2, 3]);
    expect(rows.find((x) => x.id === victim)).toMatchObject({ deleted: 1, translation: 'Добро пожаловать!' });
    const detail = (await web.req('GET', `/pages/${pid}`)).json;
    expect(detail.deleted_objects.map((x: { id: string }) => x.id)).toEqual([victim]);

    const back = fixtureSyncPage(pages[0]!, 2);
    const r2 = await sync([back]);
    expect(r2.json.pages[0].summary.restored).toEqual([victim]);
    rows = rowsOf(pid);
    expect(rows.every((x) => !x.deleted)).toBe(true);
    expect(rows.map((x) => x.ord)).toEqual([1, 2, 3, 4]);
    expect(rows.find((x) => x.id === victim)!.translation).toBe('Добро пожаловать!');
  });

  it('never touches text; source_text of existing objects is ignored', async () => {
    const pid = pages[0]!.id;
    const oid = pages[0]!.objects[0]!.id;
    await web.req('PATCH', `/objects/${oid}`, { base_text_ver: 0, changes: { translation: 'перевод', comment: 'к', flagged: true, source_text: 'правка' } });
    const p = fixtureSyncPage(pages[0]!, 1);
    p.objects[0]!.source_text = 'OCR again';
    p.objects[0]!.box = { x: 500, y: 60, w: 220, h: 260 };
    p.objects.reverse();
    const r = await sync([p]);
    expect(r.json.pages[0].summary).toMatchObject({ moved: [oid], reordered: true });
    const obj = (await web.req('GET', `/pages/${pid}`)).json.objects.find((x: { id: string }) => x.id === oid);
    expect(obj).toMatchObject({ translation: 'перевод', comment: 'к', flagged: true, source_text: 'правка', state: 'translated', order: 4 });
    expect(obj.geometry_ver).toBe(2);
  });

  it('rotation is stored, bumps markup, is idempotent and validated', async () => {
    const p = fixtureSyncPage(pages[0]!, 1);
    p.objects[0]!.rotation = -12;
    const r = await sync([p]);
    expect(r.json.pages[0]).toMatchObject({ markup_rev: 2, summary: { moved: [p.objects[0]!.id] } });
    const obj = (await web.req('GET', `/pages/${pages[0]!.id}`)).json.objects[0];
    expect(obj.rotation).toBe(-12);
    expect((await sync([{ ...p, base_markup_rev: 2 }])).json.pages[0].changed).toBe(false);
    p.objects[0]!.rotation = 200;
    expect((await sync([{ ...p, base_markup_rev: 2 }])).status).toBe(422);
  });

  it('pages can swap idx', async () => {
    const a = fixtureSyncPage(pages[0]!, 1);
    const b = fixtureSyncPage(pages[1]!, 1);
    const r = await sync([{ ...a, idx: 2 }, { ...b, idx: 1 }]);
    expect(r.status).toBe(200);
    const ch = (await web.req('GET', `/chapters/${chapterId}`)).json;
    expect(ch.pages.map((p: { id: string }) => p.id)).toEqual([pages[1]!.id, pages[0]!.id, pages[2]!.id]);
    const clash = await sync([{ ...fixtureSyncPage(pages[0]!, 1), idx: 3 }]);
    expect(clash.status).toBe(422);
  });

  it('atomic: an error on the second page leaves the first untouched', async () => {
    const a = fixtureSyncPage(pages[0]!, 1);
    a.objects = [];
    const b = { ...fixtureSyncPage(pages[1]!, 1), raw_hash: sha256Hex(pages[0]!.raw) };
    expect((await sync([a, b])).status).toBe(422);
    expect(rowsOf(pages[0]!.id).filter((o) => !o.deleted)).toHaveLength(4);
    expect(await rev(pages[0]!.id)).toBe(1);
  });

  it('revisions and the "markup changed" badge', async () => {
    const pid = pages[0]!.id;
    let d = (await web.req('GET', `/pages/${pid}`)).json;
    expect(d.seen_markup_rev).toBeNull();
    await web.req('PUT', `/pages/${pid}/seen`, { markup_rev: d.page.markup_rev });
    let ch = (await web.req('GET', `/chapters/${chapterId}`)).json;
    expect(ch.pages[0].markup_changed_for_me).toBe(false);
    const p = fixtureSyncPage(pages[0]!, 1);
    p.objects.pop();
    await sync([p]);
    ch = (await web.req('GET', `/chapters/${chapterId}`)).json;
    expect(ch.pages[0].markup_changed_for_me).toBe(true);
    d = (await web.req('GET', `/pages/${pid}`)).json;
    expect(d.revisions[0]).toMatchObject({ rev: 2, user_name: 'Алиса' });
    expect(d.revisions[0].summary.deleted).toHaveLength(1);
  });

  it('chapters: create is idempotent by number and desktop-only', async () => {
    const projectId = (await web.req('GET', '/projects')).json.projects[0].id;
    const again = await desk.req('POST', `/projects/${projectId}/chapters`, { number: '1' });
    expect(again.status).toBe(200);
    expect(again.json.chapter.id).toBe(chapterId);
    const n = await desk.req('POST', `/projects/${projectId}/chapters`, { number: '12.5' });
    expect(n.status).toBe(201);
    const list = (await web.req('GET', `/projects/${projectId}/chapters`)).json.chapters;
    expect(list.map((c: { number: string }) => c.number)).toEqual(['1', '12.5']);
    expect(list[0]).toMatchObject({ page_count: 3, clean_count: 2 });
  });

  it('ETag / 304 on chapter and page', async () => {
    const r = await web.req('GET', `/chapters/${chapterId}`);
    const etag = String(r.headers.etag);
    expect((await web.req('GET', `/chapters/${chapterId}`, undefined, { 'if-none-match': etag })).status).toBe(304);
    const pr = await web.req('GET', `/pages/${pages[0]!.id}`);
    const pe = String(pr.headers.etag);
    expect((await web.req('GET', `/pages/${pages[0]!.id}`, undefined, { 'if-none-match': pe })).status).toBe(304);
    await web.req('PATCH', `/objects/${pages[0]!.objects[0]!.id}`, { base_text_ver: 0, changes: { comment: 'x' } });
    expect((await web.req('GET', `/pages/${pages[0]!.id}`, undefined, { 'if-none-match': pe })).status).toBe(200);
    expect((await web.req('GET', `/chapters/${chapterId}`, undefined, { 'if-none-match': etag })).status).toBe(200);
  });
});

describe('seed is re-runnable', () => {
  it('second seed changes nothing', async () => {
    const again = await seedFixtureChapter(desk.http);
    expect(again.chapter.id).toBe(chapterId);
    expect(makeFixtureChapter()).toHaveLength(3);
    expect(await rev(pages[0]!.id)).toBe(1);
  });
});
