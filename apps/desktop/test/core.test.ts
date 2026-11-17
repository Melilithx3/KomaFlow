import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodePng, makeFixtureChapter } from '@komaflow/contract/fixtures';
import { makeTestApp, type TestApp } from '../../server/test/helpers.js';
import { ApiClient } from '../src/core/api.js';
import {
  AddObject,
  ApplyAnalysis,
  AutoOrder,
  DeleteObject,
  ImportFiles,
  MoveInOrder,
  newObject,
  replacedByAnalysis,
  SetBox,
  SetSourceText,
  SetType,
} from '../src/core/commands.js';
import { applicable, matchImport, numericSuffix } from '../src/core/importMatch.js';
import type { Workspace } from '../src/core/model.js';
import { downloadChapter, planPublish, publish, refreshWebData } from '../src/core/publish.js';
import { Store } from '../src/core/store.js';
import { fileRef, loadWorkspace, pageStatus, saveWorkspace, workspaceFromImages } from '../src/core/workspace.js';
import { MemoryHost } from './memory-host.js';

const png = (w: number, h: number, v = 200) => encodePng(w, h, new Uint8Array(w * h * 4).fill(v));

function makeWs(host: MemoryHost): Promise<Workspace> {
  host.addFolder('raw', { '10.png': png(100, 200, 10), '2.png': png(100, 200, 2), '1.png': png(100, 200, 1) });
  return host.scanImages('raw').then((imgs) => workspaceFromImages('Глава', imgs));
}

describe('workspace and store', () => {
  let host: MemoryHost;
  let ws: Workspace;
  beforeEach(async () => {
    host = new MemoryHost(() => Promise.reject(new Error('offline')));
    ws = await makeWs(host);
  });

  it('pages follow natural file order', () => {
    expect(ws.pages.map((p) => p.raw.path)).toEqual(['raw/1.png', 'raw/2.png', 'raw/10.png']);
    expect(ws.pages.map((p) => p.idx)).toEqual([1, 2, 3]);
  });

  it('commands undo/redo; a drag gesture is one entry', () => {
    const s = new Store(ws);
    const pid = ws.pages[0]!.id;
    const o = newObject('bubble', { x: 10, y: 10, w: 20, h: 20 });
    s.exec(AddObject(pid, o));
    for (let i = 1; i <= 5; i++) s.exec(SetBox(pid, o.id, { x: 10 + i, y: 10, w: 20, h: 20 }, 'g1'));
    s.endGesture();
    s.exec(SetType(pid, o.id, 'sfx'));
    expect(s.historyLabels()).toEqual(['Добавить бокс', 'Изменить бокс', 'Тип объекта']);
    const page = () => s.get().ws.pages[0]!;
    expect(page().objects[0]).toMatchObject({ type: 'sfx', box: { x: 15 } });
    s.undo();
    expect(page().objects[0]!.type).toBe('bubble');
    s.undo();
    expect(page().objects[0]!.box.x).toBe(10);
    s.redo();
    expect(page().objects[0]!.box.x).toBe(15);
    s.undo();
    s.undo();
    expect(page().objects).toHaveLength(0);
    expect(s.canUndo()).toBe(false);
  });

  it('boxes are clamped into the page; no-op commands leave no history', () => {
    const s = new Store(ws);
    const pid = ws.pages[0]!.id;
    const o = newObject('text', { x: 90, y: 190, w: 50, h: 50 });
    s.exec(AddObject(pid, o));
    expect(s.get().ws.pages[0]!.objects[0]!.box).toEqual({ x: 90, y: 190, w: 10, h: 10 });
    s.exec(SetType(pid, o.id, 'text'));
    s.exec(SetSourceText(pid, o.id, ''));
    expect(s.historyLabels()).toHaveLength(1);
    s.exec(DeleteObject(pid, o.id));
    s.undo();
    expect(s.get().ws.pages[0]!.objects).toHaveLength(1);
  });

  it('auto order and manual move', () => {
    const s = new Store(ws);
    const pid = ws.pages[0]!.id;
    const left = newObject('bubble', { x: 0, y: 0, w: 20, h: 20 });
    const right = newObject('bubble', { x: 60, y: 0, w: 20, h: 20 });
    const below = newObject('bubble', { x: 0, y: 100, w: 20, h: 20 });
    for (const o of [below, left, right]) s.exec(AddObject(pid, o));
    s.exec(AutoOrder(s.get().ws.pages[0]!, 'rtl'));
    expect(s.get().ws.pages[0]!.objects.map((o) => o.id)).toEqual([right.id, left.id, below.id]);
    s.exec(MoveInOrder(s.get().ws.pages[0]!, below.id, 0));
    expect(s.get().ws.pages[0]!.objects[0]!.id).toBe(below.id);
  });

  it('ApplyAnalysis replaces only auto untouched objects and is one undo step', () => {
    const s = new Store(ws);
    const pid = ws.pages[0]!.id;
    const manual = newObject('sfx', { x: 0, y: 150, w: 10, h: 10 });
    s.exec(AddObject(pid, manual));
    s.exec(ApplyAnalysis(pid, [{ type: 'bubble', box: { x: 50, y: 0, w: 40, h: 40 }, score: 0.9, source_text: 'あ' }, { type: 'text', box: { x: 0, y: 0, w: 40, h: 40 }, score: 0.8, source_text: 'い' }], 'rtl'));
    let objs = s.get().ws.pages[0]!.objects;
    expect(objs.map((o) => o.source_text)).toEqual(['あ', 'い', '']);
    const touched = objs[0]!;
    s.exec(SetBox(pid, touched.id, { x: 51, y: 0, w: 40, h: 40 }));
    expect(replacedByAnalysis(s.get().ws.pages[0]!)).toBe(1);
    s.exec(ApplyAnalysis(pid, [{ type: 'bubble', box: { x: 5, y: 100, w: 10, h: 10 }, score: 0.7, source_text: 'う' }], 'rtl'));
    objs = s.get().ws.pages[0]!.objects;
    expect(objs.map((o) => o.source_text).sort()).toEqual(['', 'あ', 'う']);
    s.undo();
    expect(s.get().ws.pages[0]!.objects.map((o) => o.source_text)).toEqual(['あ', 'い', '']);
  });

  it('saves and restores pages/<id>.json + workspace.json', async () => {
    const s = new Store(ws);
    s.exec(AddObject(ws.pages[1]!.id, newObject('bubble', { x: 1, y: 1, w: 5, h: 5 }, 'テスト')));
    await saveWorkspace(host, s.get().ws);
    expect([...host.texts.keys()].filter((k) => k.includes('/pages/'))).toHaveLength(3);
    const back = await loadWorkspace(host, ws.id);
    expect(back).toEqual(s.get().ws);
  });
});

describe('import matching', () => {
  it('by name, then numeric suffix; size mismatch is not applied; extras listed', async () => {
    const host = new MemoryHost(() => Promise.reject(new Error('x')));
    const ws = await makeWs(host);
    host.addFolder('clean', { '1.png': png(100, 200), 'clean_002.png': png(100, 200), 'p10.png': png(50, 50), 'other.png': png(100, 200) });
    const plan = matchImport(ws.pages, await host.scanImages('clean'));
    expect(plan.rows.map((r) => [r.pageIdx, r.status, r.rule])).toEqual([
      [1, 'matched', 'name'],
      [2, 'matched', 'number'],
      [3, 'size_mismatch', 'number'],
    ]);
    expect(plan.extra.map((f) => f.name)).toEqual(['other.png']);
    expect(applicable(plan).map((r) => r.pageIdx)).toEqual([1, 2]);
    expect(numericSuffix('ch3-007.png')).toBe(7);
    const s = new Store(ws);
    s.exec(ImportFiles('clean', applicable(plan).map((r) => ({ pageId: r.pageId, file: fileRef(r.file!) }))));
    expect(s.get().ws.pages.map((p) => !!p.clean)).toEqual([true, true, false]);
    s.undo();
    expect(s.get().ws.pages.every((p) => !p.clean)).toBe(true);
  });
});

describe('publish / download against the real server', () => {
  let t: TestApp;
  let host: MemoryHost;
  let api: ApiClient;

  beforeEach(async () => {
    t = await makeTestApp();
    host = new MemoryHost(async (url, init) => {
      const r = await t.app.inject({
        method: (init.method ?? 'GET') as 'GET',
        url: url.replace('http://srv', ''),
        headers: init.headers as Record<string, string>,
        payload: init.body instanceof Uint8Array ? Buffer.from(init.body) : (init.body as string | undefined),
      });
      return new Response(r.rawPayload.length ? new Uint8Array(r.rawPayload) : null, { status: r.statusCode, headers: { 'content-type': String(r.headers['content-type'] ?? '') } });
    });
    api = new ApiClient(host, 'http://srv', null);
    await api.login('alice', 'correct-horse', 'test-pc');
  });
  afterEach(async () => t.close());

  async function linkedWorkspace() {
    const fx = makeFixtureChapter();
    host.addFolder('raw', Object.fromEntries(fx.map((p) => [`${p.idx}.png`, p.raw])));
    host.addFolder('clean', Object.fromEntries(fx.filter((p) => p.clean).map((p) => [`${p.idx}.png`, p.clean!])));
    let ws = workspaceFromImages('Глава 7', await host.scanImages('raw'));
    const project = await api.createProject('Проект');
    const chapter = await api.createChapter(project.id, '7');
    ws = { ...ws, server: { url: 'http://srv', project_id: project.id, chapter_id: chapter.id, chapter_number: '7' } };
    const s = new Store(ws);
    for (const [i, p] of fx.entries()) {
      for (const o of p.objects) s.exec(AddObject(ws.pages[i]!.id, { ...newObject(o.type, o.box, o.source_text) }));
    }
    const plan = matchImport(s.get().ws.pages, await host.scanImages('clean'));
    s.exec(ImportFiles('clean', applicable(plan).map((r) => ({ pageId: r.pageId, file: fileRef(r.file!) }))));
    return s;
  }

  it('publishes, survives upload failures, is idempotent, then shows changed pages only', async () => {
    const s = await linkedWorkspace();
    expect(planPublish(s.get().ws).newPages).toHaveLength(3);
    host.failUploads = 2;
    const events: string[] = [];
    const r = await publish(host, api, s.get().ws, { retryDelayMs: 1, onEvent: (e) => events.push(e.kind === 'stage' ? e.stage : e.kind) });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(events.filter((e) => e === 'retry')).toHaveLength(2);
    expect(r.pages.every((p) => p.markup_rev === 1)).toBe(true);
    s.reset(r.ws);
    expect(s.get().ws.pages.every((p) => pageStatus(p).published && !pageStatus(p).changedSincePublish)).toBe(true);
    expect(await publish(host, api, s.get().ws)).toEqual({ kind: 'nothing' });

    const page = s.get().ws.pages[0]!;
    s.exec(SetBox(page.id, page.objects[0]!.id, { x: 1, y: 1, w: 30, h: 30 }));
    expect(pageStatus(s.get().ws.pages[0]!).changedSincePublish).toBe(true);
    expect(planPublish(s.get().ws).changedPages).toHaveLength(1);
    const r2 = await publish(host, api, s.get().ws);
    expect(r2.kind === 'ok' && r2.pages).toEqual([expect.objectContaining({ id: page.id, markup_rev: 2, changed: true })]);
  });

  it('BLOBS_MISSING after check (file removed on server) is uploaded and retried', async () => {
    const s = await linkedWorkspace();
    const r = await publish(host, api, s.get().ws);
    if (r.kind !== 'ok') throw new Error('first publish failed');
    // new clean for page 1 uploaded, then deleted on the server between check and sync
    const fresh = png(800, 1200, 77);
    host.addFolder('clean2', { '1.png': fresh });
    s.reset(r.ws);
    const plan = matchImport(s.get().ws.pages.slice(0, 1), await host.scanImages('clean2'));
    s.exec(ImportFiles('clean', applicable(plan).map((x) => ({ pageId: x.pageId, file: fileRef(x.file!) }))));
    const realCheck = api.checkBlobs.bind(api);
    let first = true;
    api.checkBlobs = async (h) => (first ? ((first = false), []) : realCheck(h));
    const r2 = await publish(host, api, s.get().ws);
    expect(r2.kind).toBe('ok');
  });

  it('REVISION_CONFLICT is reported; overwrite with server revisions works', async () => {
    const s = await linkedWorkspace();
    const r = await publish(host, api, s.get().ws);
    if (r.kind !== 'ok') throw new Error('x');
    const stale = r.ws;
    // someone else publishes page 1
    const other = new Store(r.ws);
    other.exec(DeleteObject(r.ws.pages[0]!.id, r.ws.pages[0]!.objects[0]!.id));
    await publish(host, api, other.get().ws);
    // our stale copy changes page 1 too
    const mine = new Store(stale);
    mine.exec(SetType(stale.pages[0]!.id, stale.pages[0]!.objects[1]!.id, 'sfx'));
    const c = await publish(host, api, mine.get().ws);
    expect(c).toEqual({ kind: 'conflict', pages: [{ id: stale.pages[0]!.id, markup_rev: 2 }] });
    const ok = await publish(host, api, mine.get().ws, { overwriteRevs: new Map([[stale.pages[0]!.id, 2]]) });
    expect(ok.kind === 'ok' && ok.pages[0]!.markup_rev).toBe(3);
  });

  it('download from server rebuilds the workspace; web flags flow back', async () => {
    const s = await linkedWorkspace();
    const r = await publish(host, api, s.get().ws);
    if (r.kind !== 'ok') throw new Error('x');
    const ws = await downloadChapter(host, api, r.ws.server!.chapter_id);
    expect(ws.pages.map((p) => p.objects.length)).toEqual([4, 3, 1]);
    expect(ws.pages[0]!.objects[0]!.source_text).toBe('ここが噂の店か…');
    expect(ws.pages[0]!.clean).not.toBeNull();
    expect(ws.pages[2]!.clean).toBeNull();
    expect(planPublish(ws).changedPages).toHaveLength(0);

    const web = await t.login('bob', 'web');
    const oid = ws.pages[0]!.objects[0]!.id;
    await web.req('PATCH', `/objects/${oid}`, { base_text_ver: 0, changes: { flagged: true, comment: 'проверь бокс' } });
    const ws2 = await refreshWebData(api, ws);
    expect(ws2.pages[0]!.objects[0]!.web).toMatchObject({ flagged: true, comment: 'проверь бокс' });
    expect(ws2.pages[1]).toBe(ws.pages[1]);
  });
});
