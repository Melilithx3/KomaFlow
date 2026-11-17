import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedFixtureChapter, type FixturePage } from '@komaflow/contract/fixtures';
import { makeTestApp, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let alice: Client;
let bob: Client;
let pages: FixturePage[];
let oid: string;

beforeEach(async () => {
  t = await makeTestApp();
  const desk = await t.login('alice', 'desktop');
  pages = (await seedFixtureChapter(desk.http)).pages;
  alice = await t.login('alice', 'web');
  bob = await t.login('bob', 'web');
  oid = pages[0]!.objects[0]!.id;
});
afterEach(async () => t.close());

const patch = (c: Client, base: number, changes: Record<string, unknown>, id = oid) =>
  c.req('PATCH', `/objects/${id}`, { base_text_ver: base, changes });
const history = () => t.ctx.db.all<{ field: string }>('SELECT field FROM text_history WHERE object_id = ? ORDER BY id', oid);
const geometry = () => t.ctx.db.get<Record<string, number>>('SELECT x, y, w, h, ord, geometry_ver, deleted FROM objects WHERE id = ?', oid);

describe('PATCH /objects', () => {
  it('translation sets state translated; empty translation resets it', async () => {
    const r = await patch(alice, 0, { translation: 'Привет' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ translation: 'Привет', state: 'translated', text_ver: 1, field_vers: { translation: 1, state: 1 }, updated_by: t.users.alice.id });
    const r2 = await patch(alice, 1, { translation: '' });
    expect(r2.json).toMatchObject({ state: 'empty', text_ver: 2 });
  });

  it('explicit translated needs text; skipped/unreadable allowed with any text', async () => {
    expect((await patch(alice, 0, { state: 'translated' })).status).toBe(422);
    expect((await patch(alice, 0, { state: 'skipped' })).json.state).toBe('skipped');
    expect((await patch(alice, 1, { translation: 'текст', state: 'unreadable' })).json).toMatchObject({ state: 'unreadable', translation: 'текст' });
  });

  it('different fields merge without conflict', async () => {
    await patch(alice, 0, { translation: 'A' });
    const r = await patch(bob, 0, { comment: 'проверь' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ translation: 'A', comment: 'проверь', text_ver: 2 });
  });

  it('same field from a stale base gives FIELD_CONFLICT with server value and author', async () => {
    await patch(alice, 0, { translation: 'A' });
    const r = await patch(bob, 0, { translation: 'B', comment: 'c' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('FIELD_CONFLICT');
    expect(r.json.error.details).toMatchObject({
      fields: ['translation'],
      server_values: { translation: 'A' },
      updated_by: { login: 'alice', display_name: 'Алиса' },
    });
    expect(r.json.error.details.object.text_ver).toBe(1);
    // no partial apply: comment stayed empty
    const d = (await bob.req('GET', `/pages/${pages[0]!.id}`)).json.objects.find((o: { id: string }) => o.id === oid);
    expect(d.comment).toBe('');
    // "keep mine": resend on the fresh base
    expect((await patch(bob, 1, { translation: 'B', comment: 'c' })).status).toBe(200);
  });

  it('unchanged value creates no version and no history', async () => {
    await patch(alice, 0, { translation: 'A' });
    const before = history().length;
    const r = await patch(alice, 1, { translation: 'A', flagged: false });
    expect(r.json.text_ver).toBe(1);
    expect(history()).toHaveLength(before);
    // equal value never conflicts even from an old base
    expect((await patch(bob, 0, { translation: 'A' })).status).toBe(200);
  });

  it('history records each changed field', async () => {
    await patch(alice, 0, { translation: 'A', comment: 'c', flagged: true });
    expect(history().map((h) => h.field).sort()).toEqual(['comment', 'flagged', 'state', 'translation']);
  });

  it('never changes geometry; unknown fields are rejected', async () => {
    const g = geometry();
    expect((await patch(alice, 0, { box: { x: 0, y: 0, w: 1, h: 1 } })).status).toBe(422);
    await patch(alice, 0, { translation: 'A', source_text: 'B' });
    expect(geometry()).toEqual(g);
  });

  it('limits and validation', async () => {
    expect((await patch(alice, 0, { translation: 'x'.repeat(5001) })).status).toBe(422);
    expect((await patch(alice, 0, { comment: 'x'.repeat(2001) })).status).toBe(422);
    expect((await patch(alice, 0, {})).status).toBe(422);
    expect((await patch(alice, 5, { comment: 'x' })).status).toBe(422);
    expect((await patch(alice, 0, { comment: 'x' }, '0190a000-0000-7000-8000-000000000000')).status).toBe(404);
  });

  it('deleted objects can be edited', async () => {
    t.ctx.db.run('UPDATE objects SET deleted = 1 WHERE id = ?', oid);
    expect((await patch(alice, 0, { translation: 'A' })).status).toBe(200);
  });
});

describe('typed and statuses', () => {
  it('typed toggles; ready_for_typing is computed', async () => {
    const chapterId = (await alice.req('GET', `/pages/${pages[0]!.id}`)).json.page.chapter_id;
    let ch = (await alice.req('GET', `/chapters/${chapterId}`)).json;
    expect(ch.pages[0]).toMatchObject({ has_clean: true, translation_done: false, ready_for_typing: false, counts: { total: 4, empty: 4 } });
    for (const o of pages[0]!.objects) await patch(alice, 0, { translation: o.translation }, o.id);
    ch = (await alice.req('GET', `/chapters/${chapterId}`)).json;
    expect(ch.pages[0]).toMatchObject({ translation_done: true, ready_for_typing: true, counts: { translated: 4 } });
    // page 3 has no clean: translation done but not ready
    for (const o of pages[2]!.objects) await patch(alice, 0, { state: 'skipped' }, o.id);
    ch = (await alice.req('GET', `/chapters/${chapterId}`)).json;
    expect(ch.pages[2]).toMatchObject({ translation_done: true, ready_for_typing: false });

    const r = await bob.req('PUT', `/pages/${pages[0]!.id}/typed`, { typed: true });
    expect(r.json.page).toMatchObject({ typed: true, typed_by: t.users.bob.id });
    expect((await bob.req('PUT', `/pages/${pages[0]!.id}/typed`, { typed: false })).json.page.typed).toBe(false);
  });
});
