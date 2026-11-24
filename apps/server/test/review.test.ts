import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodePng, seedFixtureChapter, type FixturePage } from '@komaflow/contract/fixtures';
import { sha256Hex } from '@komaflow/contract';
import { unreferencedBlobs } from '../src/services/blobs.js';
import { makeTestApp, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let desk: Client;
let web: Client;
let pages: FixturePage[];

beforeEach(async () => {
  t = await makeTestApp();
  desk = await t.login('alice', 'desktop');
  web = await t.login('bob', 'web');
  pages = (await seedFixtureChapter(desk.http)).pages;
});
afterEach(async () => t.close());

/** Fixture pages are 800x1200. */
const image = (w: number, h: number, v: number) => encodePng(w, h, new Uint8Array(w * h * 4).fill(v));
async function upload(c: Client, png: Uint8Array) {
  const h = sha256Hex(png);
  const r = await c.req('PUT', `/blobs/${h}`, png, { 'content-type': 'image/png' });
  expect([200, 201]).toContain(r.status);
  return h;
}

describe('editorial review (ADR 0021)', () => {
  it('web uploads marks and saves a clean review; versions guard concurrent edits; clean and PSD layers untouched', async () => {
    const pid = pages[0]!.id;
    const before = (await web.req('GET', `/pages/${pid}`)).json;
    expect(before.reviews).toEqual([
      { kind: 'clean', marks_hash: null, comment: '', ver: 0, updated_at: null, updated_by_name: null },
      { kind: 'type', marks_hash: null, comment: '', ver: 0, updated_at: null, updated_by_name: null },
    ]);
    const marks = await upload(web, image(800, 1200, 0));
    const r = await web.req('PUT', `/pages/${pid}/reviews/clean`, { base_ver: 0, marks_hash: marks, comment: 'пятно у второго пузыря' });
    expect(r.status).toBe(200);
    expect(r.json.review).toMatchObject({ kind: 'clean', marks_hash: marks, comment: 'пятно у второго пузыря', ver: 1 });
    const after = (await desk.req('GET', `/pages/${pid}`)).json;
    expect(after.page.clean_hash).toBe(before.page.clean_hash);
    expect(after.page.markup_rev).toBe(before.page.markup_rev);
    expect(after.reviews[0].ver).toBe(1);
    // stale base: conflict with the current review, nothing written
    const stale = await desk.req('PUT', `/pages/${pid}/reviews/clean`, { base_ver: 0, marks_hash: null, comment: 'другое' });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('REVISION_CONFLICT');
    expect(stale.json.error.details.review.comment).toBe('пятно у второго пузыря');
    // same data again is a no-op; wrong size and unknown kind are rejected
    expect((await web.req('PUT', `/pages/${pid}/reviews/clean`, { base_ver: 1, marks_hash: marks, comment: 'пятно у второго пузыря' })).json.review.ver).toBe(1);
    const small = await upload(web, image(10, 10, 0));
    expect((await web.req('PUT', `/pages/${pid}/reviews/clean`, { base_ver: 1, marks_hash: small, comment: '' })).json.error.code).toBe('SIZE_MISMATCH');
    expect((await web.req('PUT', `/pages/${pid}/reviews/psd`, { base_ver: 0, marks_hash: null, comment: '' })).status).toBe(404);
    // marks are referenced: blob GC keeps them
    expect(unreferencedBlobs(t.ctx).map((b) => b.hash)).not.toContain(marks);
  });

  it('typed page upload binds the image and sets «затайплена»; sync from the desktop keeps it', async () => {
    const pid = pages[1]!.id;
    const png = image(800, 1200, 120);
    const missing = await web.req('PUT', `/pages/${pid}/typed-image`, { hash: sha256Hex(png) });
    expect(missing.json.error.code).toBe('BLOBS_MISSING');
    expect((await web.req('GET', `/pages/${pid}`)).json.page.typed).toBe(false);
    const h = await upload(web, png);
    const r = await web.req('PUT', `/pages/${pid}/typed-image`, { hash: h });
    expect(r.json.page).toMatchObject({ typed: true, typed_hash: h });
    const ch = (await web.req('GET', `/chapters/${(await web.req('GET', `/pages/${pid}`)).json.page.chapter_id}`)).json;
    expect(ch.pages.find((p: { id: string }) => p.id === pid)).toMatchObject({ typed: true, typed_hash: h });
    // other pages untouched
    expect(ch.pages.filter((p: { typed: boolean }) => p.typed)).toHaveLength(1);
  });

  it('sync stays desktop-only', async () => {
    const r = await web.req('POST', `/chapters/${(await web.req('GET', `/pages/${pages[0]!.id}`)).json.page.chapter_id}/sync`, { pages: [] });
    expect(r.status).toBe(403);
  });
});
