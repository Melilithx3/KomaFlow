import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFixtureChapter } from '@komaflow/contract/fixtures';
import { makeTestApp, type TestApp } from '../../server/test/helpers.js';
import { ApiClient } from '../src/core/api.js';
import { AddObject, ImportFiles, newObject, SetBox, SetType } from '../src/core/commands.js';
import { applicable, matchImport } from '../src/core/importMatch.js';
import { planPublish, publish } from '../src/core/publish.js';
import { applyPull, findServerChapter, planPull } from '../src/core/pull.js';
import { Store } from '../src/core/store.js';
import { fileRef, workspaceFromImages } from '../src/core/workspace.js';
import { MemoryHost } from './memory-host.js';

/** «Синхронизировать» (server → local chapter) against the real server, two «devices». */
describe('chapter sync from the server', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await makeTestApp();
  });
  afterEach(async () => t.close());

  async function device() {
    const host = new MemoryHost(async (url, init) => {
      const r = await t.app.inject({
        method: (init.method ?? 'GET') as 'GET',
        url: url.replace('http://srv', ''),
        headers: init.headers as Record<string, string>,
        payload: init.body instanceof Uint8Array ? Buffer.from(init.body) : (init.body as string | undefined),
      });
      return new Response(r.rawPayload.length ? new Uint8Array(r.rawPayload) : null, { status: r.statusCode, headers: { 'content-type': String(r.headers['content-type'] ?? '') } });
    });
    const api = new ApiClient(host, 'http://srv', null);
    await api.login('alice', 'correct-horse', 'pc');
    const fx = makeFixtureChapter();
    host.addFolder('raw', Object.fromEntries(fx.map((p) => [`${p.idx}.png`, p.raw])));
    host.addFolder('clean', Object.fromEntries(fx.filter((p) => p.clean).map((p) => [`${p.idx}.png`, p.clean!])));
    const store = new Store(workspaceFromImages('Глава 7', await host.scanImages('raw')));
    return { host, api, fx, store };
  }

  /** Device A marks up, cleans and publishes. */
  async function publishedA() {
    const a = await device();
    const project = await a.api.createProject('Проект');
    const chapter = await a.api.createChapter(project.id, '7');
    a.store.patch((ws) => ({ ...ws, server: { url: 'http://srv', project_id: project.id, chapter_id: chapter.id, chapter_number: '7' } }));
    for (const [i, p] of a.fx.entries()) for (const o of p.objects) a.store.exec(AddObject(a.store.get().ws.pages[i]!.id, newObject(o.type, o.box, o.source_text)));
    const plan = matchImport(a.store.get().ws.pages, await a.host.scanImages('clean'));
    a.store.exec(ImportFiles('clean', applicable(plan).map((r) => ({ pageId: r.pageId, file: fileRef(r.file!) }))));
    const r = await publish(a.host, a.api, a.store.get().ws);
    if (r.kind !== 'ok') throw new Error(r.kind);
    a.store.patch(() => r.ws);
    return a;
  }

  it('an unlinked local chapter with the same raw pages pulls clean and markup; repeat is a no-op', async () => {
    const a = await publishedA();
    const b = await device(); // same raw images, nothing else, never published
    const m = await findServerChapter(b.api, b.store.get().ws);
    expect(m).toEqual({ ok: true, chapterId: a.store.get().ws.server!.chapter_id });
    if (!m.ok) return;
    const plan = await planPull(b.api, b.store.get().ws, m.chapterId);
    expect(plan.relink).toBe(true);
    expect(plan.pages.map((p) => p.markup)).toEqual(['server', 'server', 'server']);
    expect(plan.pages.filter((p) => p.clean === 'server').length).toBe(a.fx.filter((p) => p.clean).length);
    const { ws, pulled } = await applyPull(b.host, b.api, b.store.get().ws, plan, { clean: true, markup: true, conflicts: false });
    b.store.patch(() => ws);
    expect(pulled.markup).toBe(3);
    const pa = a.store.get().ws.pages;
    expect(ws.pages.map((p) => p.id)).toEqual(pa.map((p) => p.id)); // server ids adopted
    expect(ws.pages.map((p) => p.objects.map((o) => o.id))).toEqual(pa.map((p) => p.objects.map((o) => o.id)));
    expect(ws.pages.map((p) => p.clean?.hash ?? null)).toEqual(pa.map((p) => p.clean?.hash ?? null));
    // B now publishes nothing, and a second sync finds nothing to take
    expect(planPublish(ws).changedPages).toHaveLength(0);
    expect(await publish(b.host, b.api, ws)).toEqual({ kind: 'nothing' });
    const again = await planPull(b.api, ws, m.chapterId);
    expect(again.pages.every((p) => p.clean === 'same' && p.markup === 'same')).toBe(true);
    const twice = await applyPull(b.host, b.api, ws, again, { clean: true, markup: true, conflicts: true });
    expect(twice.pulled).toEqual({ clean: 0, markup: 0 });
    expect(twice.ws.pages.map((p) => p.objects.length)).toEqual(ws.pages.map((p) => p.objects.length));
  });

  it('local changes are kept, server changes pulled, conflicts only on explicit choice; categories stay apart', async () => {
    const a = await publishedA();
    const b = await device();
    const m = await findServerChapter(b.api, b.store.get().ws);
    if (!m.ok) throw new Error(m.message);
    // B takes the chapter by syncing into its own (unlinked) workspace
    const bws0 = b.store.get().ws;
    const bws = (await applyPull(b.host, b.api, bws0, await planPull(b.api, bws0, m.chapterId), { clean: true, markup: true, conflicts: false })).ws;
    const sb = new Store(bws);

    const [p1, p2, p3] = a.store.get().ws.pages;
    // A (local only): moves a box on page 1
    a.store.exec(SetBox(p1!.id, p1!.objects[0]!.id, { ...p1!.objects[0]!.box, x: p1!.objects[0]!.box.x + 5 }));
    // B publishes: page 2 type change (server change for A), page 3 type change (A changes page 3 too → conflict)
    sb.exec(SetType(p2!.id, p2!.objects[0]!.id, 'sfx'));
    sb.exec(SetType(p3!.id, p3!.objects[0]!.id, 'sfx'));
    const rb = await publish(b.host, b.api, sb.get().ws);
    expect(rb.kind).toBe('ok');
    a.store.exec(SetType(p3!.id, p3!.objects[0]!.id, 'text'));

    const plan = await planPull(a.api, a.store.get().ws, m.chapterId);
    expect(plan.relink).toBe(false);
    expect(plan.pages.map((p) => p.markup)).toEqual(['local', 'server', 'conflict']);
    expect(plan.pages.map((p) => p.clean)).toEqual(['same', 'same', 'same']);

    // clean only: markup untouched everywhere
    const onlyClean = await applyPull(a.host, a.api, a.store.get().ws, plan, { clean: true, markup: false, conflicts: false });
    expect(onlyClean.ws.pages.map((p) => p.objects[0]!.type)).toEqual(a.store.get().ws.pages.map((p) => p.objects[0]!.type));

    const r = await applyPull(a.host, a.api, a.store.get().ws, plan, { clean: false, markup: true, conflicts: false });
    const w = r.ws.pages;
    expect(w[0]!.objects[0]!.box.x).toBe(p1!.objects[0]!.box.x + 5); // local edit kept
    expect(w[1]!.objects[0]!.type).toBe('sfx'); // server change taken
    expect(w[2]!.objects[0]!.type).toBe('text'); // conflict not overwritten
    // publishing the conflicted page reports the revision conflict (existing mechanism), nothing silent
    const pub = await publish(a.host, a.api, r.ws);
    expect(pub.kind).toBe('conflict');

    const r2 = await applyPull(a.host, a.api, r.ws, await planPull(a.api, r.ws, m.chapterId), { clean: false, markup: true, conflicts: true });
    expect(r2.ws.pages[2]!.objects[0]!.type).toBe('sfx');
    expect(r2.ws.pages[0]!.objects[0]!.box.x).toBe(p1!.objects[0]!.box.x + 5); // a «local» page is never replaced
    const pub2 = await publish(a.host, a.api, r2.ws);
    expect(pub2.kind).toBe('ok');
  });

  it('no guess when several server chapters share the pages', async () => {
    const a = await publishedA();
    const project = a.store.get().ws.server!.project_id;
    const ch2 = await a.api.createChapter(project, '7.5');
    const copy = { ...a.store.get().ws, server: { ...a.store.get().ws.server!, chapter_id: ch2.id, chapter_number: '7.5' } };
    // same raw pages published as another chapter (new ids)
    const fresh = (await device()).store.get().ws;
    const r = await publish(a.host, a.api, { ...fresh, server: copy.server });
    expect(r.kind).toBe('ok');
    const b = await device();
    const m = await findServerChapter(b.api, b.store.get().ws);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.message).toMatch(/несколько/);
  });
});
