import { canonicalJson, sha256Hex, toCanonical, type ChapterDetailResponse, type PageDetailResponse } from '@komaflow/contract';
import type { ApiClient } from './api.js';
import type { Host } from './host.js';
import type { FileRef, LocalObject, LocalPage, Workspace } from './model.js';
import { webOf } from './translation.js';
import { pageDigest } from './workspace.js';

/**
 * «Синхронизировать»: server → local chapter (review 2026-11-24, ADR 0020). Two categories are chosen by
 * the user — clean (clean + notes images) and markup (objects: boxes, rotation, type, order). Translation
 * data (originals, translations, flags, comments) comes automatically as in the web. Each category is
 * compared three-way against the state of the last publish/download/sync (`LocalPage.base`), so local
 * edits are recognised and never overwritten without an explicit choice. Publishing is unchanged.
 */

export type CatState = 'same' | 'server' | 'local' | 'conflict';

export const cleanKey = (clean: string | null, notes: string | null) => `${clean ?? '-'}|${notes ?? '-'}`;

/** Digest of the desktop-owned markup (originals are not part of it: they travel with translation data). */
export function markupKey(objects: ReadonlyArray<Pick<LocalObject, 'id' | 'type' | 'box' | 'text_box' | 'rotation'>>): string {
  return sha256Hex(canonicalJson(toCanonical(objects.map((o) => ({ id: o.id, type: o.type, box: o.box, text_box: o.text_box, rotation: o.rotation ?? 0 })))));
}

export const pageBase = (p: LocalPage): { clean: string; markup: string } => ({ clean: cleanKey(p.clean?.hash ?? null, p.notes?.hash ?? null), markup: markupKey(p.objects) });

/** Three-way state of one category: local value, server value, value at the last contact (if known). */
export function catState(local: string, server: string, base: string | undefined, fallback: 'local' | 'server' | 'conflict'): CatState {
  if (local === server) return 'same';
  if (base === undefined) return fallback;
  const l = local !== base;
  const s = server !== base;
  return l && s ? 'conflict' : s ? 'server' : l ? 'local' : 'same';
}

export interface PullPage {
  local: LocalPage;
  server: PageDetailResponse;
  clean: CatState;
  markup: CatState;
}

export interface PullPlan {
  detail: ChapterDetailResponse;
  pages: PullPage[];
  /** Pages on the server that this chapter does not have (not pulled: the local chapter keeps its pages). */
  serverOnly: number[];
  /** Local pages with no server counterpart (new pages: publishing adds them). */
  localOnly: number[];
  /** The local chapter was not linked yet: linking adopts the server ids. */
  relink: boolean;
}

export type ChapterMatch = { ok: true; chapterId: string } | { ok: false; message: string };

/**
 * Finds the server chapter of a local one: its link when it was published or downloaded here, else the
 * chapter whose pages have the same raw images (content hashes) — the raw is immutable on the server. No
 * match or several matches → no guess.
 */
export async function findServerChapter(api: ApiClient, ws: Workspace): Promise<ChapterMatch> {
  if (ws.server) return { ok: true, chapterId: ws.server.chapter_id };
  const raws = new Set(ws.pages.map((p) => p.raw.hash));
  const hits: Array<{ id: string; label: string; overlap: number }> = [];
  for (const pr of await api.projects()) {
    for (const ch of await api.chapters(pr.id)) {
      const d = await api.chapter(ch.id);
      const overlap = d.pages.filter((p) => raws.has(p.raw_hash)).length;
      if (overlap > 0) hits.push({ id: ch.id, label: `«${pr.title}», глава ${ch.number} (общих страниц: ${overlap})`, overlap });
    }
  }
  if (hits.length === 0) return { ok: false, message: 'На сервере нет главы с такими же страницами (raw). Синхронизировать не с чем.' };
  if (hits.length > 1) return { ok: false, message: `Подходят несколько глав на сервере, выбрать наугад нельзя: ${hits.map((h) => h.label).join('; ')}.` };
  return { ok: true, chapterId: hits[0]!.id };
}

export async function planPull(api: ApiClient, ws: Workspace, chapterId: string): Promise<PullPlan> {
  const detail = await api.chapter(chapterId);
  const byId = new Map(detail.pages.map((p) => [p.id, p]));
  const byRaw = new Map(detail.pages.map((p) => [p.raw_hash, p]));
  const used = new Set<string>();
  const pages: PullPage[] = [];
  const localOnly: number[] = [];
  for (const lp of ws.pages) {
    const sp = byId.get(lp.id) ?? byRaw.get(lp.raw.hash);
    if (!sp || used.has(sp.id)) {
      localOnly.push(lp.idx);
      continue;
    }
    used.add(sp.id);
    const server = await api.page(sp.id);
    const linked = lp.id === sp.id && lp.server_markup_rev !== null;
    // without a recorded base: unchanged server revision → the difference is local; never-linked empty page → server
    const sameRev = linked && lp.server_markup_rev === server.page.markup_rev;
    const empty = !lp.clean && !lp.notes && lp.objects.length === 0;
    const fallback = sameRev ? 'local' : empty ? 'server' : 'conflict';
    const localClean = cleanKey(lp.clean?.hash ?? null, lp.notes?.hash ?? null);
    const serverClean = cleanKey(server.page.clean_hash, server.page.notes_hash);
    pages.push({
      local: lp,
      server,
      clean: catState(localClean, serverClean, linked ? lp.base?.clean : undefined, !lp.clean && !lp.notes ? 'server' : fallback),
      markup: catState(markupKey(lp.objects), markupKey(server.objects), linked ? lp.base?.markup : undefined, lp.objects.length === 0 ? 'server' : fallback),
    });
  }
  const serverOnly = detail.pages.filter((p) => !used.has(p.id)).map((p) => p.idx);
  return { detail, pages, serverOnly, localOnly, relink: !ws.server };
}

export interface PullChoice {
  clean: boolean;
  markup: boolean;
  /** Also take the server version where both sides changed (local edits of those pages are replaced). */
  conflicts: boolean;
}

export const takes = (st: CatState, on: boolean, conflicts: boolean) => on && (st === 'server' || (st === 'conflict' && conflicts));

/** Objects of the server page as local objects; a locally edited original is kept (it is published by ADR 0013). */
function serverObjects(lp: LocalPage, server: PageDetailResponse): LocalObject[] {
  const mine = new Map(lp.objects.map((o) => [o.id, o]));
  return server.objects.map((so) => {
    const o = mine.get(so.id);
    const localEdit = o && o.server_source !== undefined && o.source_text !== o.server_source;
    return {
      id: so.id,
      type: so.type,
      box: so.box,
      text_box: so.text_box,
      rotation: so.rotation ?? 0,
      source_text: localEdit ? o.source_text : so.source_text,
      server_source: so.source_text,
      origin: o?.origin ?? 'manual',
      touched: o?.touched ?? false,
      web: webOf(so),
      ...(o?.score !== undefined ? { score: o.score } : {}),
    };
  });
}

/** Downloads what was chosen and returns the updated workspace (the caller stores it; not an undo entry). */
export async function applyPull(
  host: Host,
  api: ApiClient,
  ws: Workspace,
  plan: PullPlan,
  choice: PullChoice,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<{ ws: Workspace; pulled: { clean: number; markup: number } }> {
  const pulled = { clean: 0, markup: 0 };
  const file = async (hash: string | null, w: number, h: number): Promise<FileRef | null> => {
    if (!hash) return null;
    const { bytes, mime } = await api.blob(hash);
    return { path: await host.saveImage(ws.id, hash, bytes, mime), hash, width: w, height: h, mime };
  };
  const next = new Map<string, LocalPage>();
  let done = 0;
  for (const pp of plan.pages) {
    const { local: lp, server } = pp;
    const sp = server.page;
    const takeClean = takes(pp.clean, choice.clean, choice.conflicts);
    const takeMarkup = takes(pp.markup, choice.markup, choice.conflicts);
    let page: LocalPage = { ...lp, id: sp.id };
    if (takeClean) {
      page = { ...page, clean: await file(sp.clean_hash, sp.width, sp.height), notes: await file(sp.notes_hash, sp.width, sp.height) };
      pulled.clean++;
    }
    const srvObjects = serverObjects(lp, server);
    if (takeMarkup) {
      page = { ...page, objects: srvObjects, analyzed: page.analyzed || srvObjects.length > 0 };
      pulled.markup++;
    }
    // the server version of this page, as if just downloaded: base and «published» digest
    const serverView: LocalPage = {
      ...page,
      clean: sp.clean_hash ? (page.clean?.hash === sp.clean_hash ? page.clean : { path: '', hash: sp.clean_hash, width: sp.width, height: sp.height, mime: 'image/png' }) : null,
      notes: sp.notes_hash ? (page.notes?.hash === sp.notes_hash ? page.notes : { path: '', hash: sp.notes_hash, width: sp.width, height: sp.height, mime: 'image/png' }) : null,
      objects: srvObjects.map((o) => ({ ...o, source_text: o.server_source ?? o.source_text })),
    };
    const sb = pageBase(serverView);
    const stillServer = (st: CatState, took: boolean) => !took && (st === 'server' || st === 'conflict');
    const pending = stillServer(pp.clean, takeClean) || stillServer(pp.markup, takeMarkup);
    const oldBase = lp.id === sp.id ? lp.base : undefined;
    // the server value becomes the base where the two sides now agree on it; an untaken conflict keeps the old base
    const baseOf = (st: CatState, took: boolean, server: string, old: string | undefined) =>
      took || st === 'same' || st === 'server' || (st === 'local' && old === undefined) ? (st === 'server' && !took ? old : server) : old;
    page.base = { clean: baseOf(pp.clean, takeClean, sb.clean, oldBase?.clean), markup: baseOf(pp.markup, takeMarkup, sb.markup, oldBase?.markup) };
    if (!pending) {
      // nothing on the server is left untaken: this desktop is now based on the server revision
      page.server_markup_rev = sp.markup_rev;
      page.published_digest = pageDigest(serverView);
    } else if (lp.id !== sp.id) {
      page.server_markup_rev = null; // publish will report the revision conflict instead of overwriting
    }
    next.set(lp.id, page);
    onProgress(++done, plan.pages.length);
  }
  const d = plan.detail;
  return {
    ws: {
      ...ws,
      server: ws.server ?? { url: api.baseUrl, project_id: d.project.id, chapter_id: d.chapter.id, chapter_number: d.chapter.number },
      pages: ws.pages.map((p) => next.get(p.id) ?? p),
    },
    pulled,
  };
}
