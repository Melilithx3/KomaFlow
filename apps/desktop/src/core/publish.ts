import type { MarkupSummary, PageDetailResponse } from '@komaflow/contract';
import { ApiFailure, type ApiClient } from './api.js';
import type { Host } from './host.js';
import type { FileRef, LocalObject, LocalPage, Workspace } from './model.js';
import { fileRef, pageDigest, toSyncPage } from './workspace.js';

export interface PublishPlan {
  newPages: LocalPage[];
  changedPages: LocalPage[];
  files: FileRef[];
  objectCount: number;
}

/** What «Опубликовать» will send (docs/05 §4.3, step 3). Unchanged pages are not sent. */
export function planPublish(ws: Workspace): PublishPlan {
  const newPages = ws.pages.filter((p) => p.server_markup_rev === null);
  const changedPages = ws.pages.filter((p) => p.server_markup_rev !== null && p.published_digest !== pageDigest(p));
  const files = new Map<string, FileRef>();
  for (const p of [...newPages, ...changedPages]) for (const f of [p.raw, p.clean, p.notes, p.thumb]) if (f) files.set(f.hash, f);
  return { newPages, changedPages, files: [...files.values()], objectCount: [...newPages, ...changedPages].reduce((n, p) => n + p.objects.length, 0) };
}

export type PublishEvent =
  | { kind: 'stage'; stage: 'thumbs' | 'check' | 'upload' | 'sync' }
  | { kind: 'upload'; done: number; total: number; bytes: number; totalBytes: number }
  | { kind: 'retry'; hash: string; attempt: number; error: string };

export type PublishResult =
  | { kind: 'ok'; pages: Array<{ id: string; markup_rev: number; changed: boolean; summary: MarkupSummary }>; ws: Workspace }
  | { kind: 'conflict'; pages: Array<{ id: string; markup_rev: number | null }> }
  | { kind: 'nothing' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PublishOptions {
  /** «Перезаписать сервер»: use these server revisions as base for the listed pages. */
  overwriteRevs?: Map<string, number | null>;
  retryDelayMs?: number;
  concurrency?: number;
  onEvent?: (e: PublishEvent) => void;
}

/**
 * Publish (docs/05 §4.3): thumbnails → blobs/check → upload missing (2–3 in parallel, retries with
 * growing pause) → sync; on BLOBS_MISSING upload and repeat. Safe to repeat after an interruption:
 * uploads are idempotent and sync is one transaction.
 */
export async function publish(host: Host, api: ApiClient, ws0: Workspace, opts: PublishOptions = {}): Promise<PublishResult> {
  if (!ws0.server) throw new Error('workspace is not linked to a server chapter');
  const emit = opts.onEvent ?? (() => {});
  let ws = ws0;

  emit({ kind: 'stage', stage: 'thumbs' });
  const pages = await Promise.all(
    ws.pages.map(async (p) => (p.thumb ? p : { ...p, thumb: fileRef(await host.makeThumb(p.raw.path, ws.id)) })),
  );
  ws = { ...ws, pages };

  const plan = planPublish(ws);
  const toSend = [...plan.newPages, ...plan.changedPages].sort((a, b) => a.idx - b.idx);
  if (toSend.length === 0) return { kind: 'nothing' };

  const upload = async (files: FileRef[]) => {
    const total = files.length;
    const totalBytes = files.length;
    let done = 0;
    const queue = [...files];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        for (let attempt = 1; ; attempt++) {
          try {
            await host.uploadBlob(api.baseUrl, api.bearer ?? '', f, () => {});
            break;
          } catch (e) {
            if (attempt >= 5) throw e;
            emit({ kind: 'retry', hash: f.hash, attempt, error: e instanceof Error ? e.message : String(e) });
            await sleep((opts.retryDelayMs ?? 1000) * 2 ** (attempt - 1));
          }
        }
        done++;
        emit({ kind: 'upload', done, total, bytes: done, totalBytes });
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, files.length) }, worker));
  };

  emit({ kind: 'stage', stage: 'check' });
  const byHash = new Map(plan.files.map((f) => [f.hash, f]));
  const missing: string[] = [];
  const hashes = [...byHash.keys()];
  for (let i = 0; i < hashes.length; i += 500) missing.push(...(await api.checkBlobs(hashes.slice(i, i + 500))));
  emit({ kind: 'stage', stage: 'upload' });
  await upload(missing.map((h) => byHash.get(h)!));

  emit({ kind: 'stage', stage: 'sync' });
  const body = {
    pages: toSend.map((p) => {
      const sp = toSyncPage(p);
      if (opts.overwriteRevs?.has(p.id)) sp.base_markup_rev = opts.overwriteRevs.get(p.id)!;
      return sp;
    }),
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await api.sync(ws.server!.chapter_id, body);
      const revs = new Map(res.pages.map((p) => [p.id, p.markup_rev]));
      ws = {
        ...ws,
        pages: ws.pages.map((p) => (revs.has(p.id) ? { ...p, server_markup_rev: revs.get(p.id)!, published_digest: pageDigest(p) } : p)),
      };
      return { kind: 'ok', pages: res.pages, ws };
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'BLOBS_MISSING' && attempt < 3) {
        const more = ((e.details?.missing as string[] | undefined) ?? []).map((h) => byHash.get(h)).filter((f): f is FileRef => !!f);
        await upload(more);
        continue;
      }
      if (e instanceof ApiFailure && e.code === 'REVISION_CONFLICT') {
        return { kind: 'conflict', pages: (e.details?.pages as Array<{ id: string; markup_rev: number | null }>) ?? [] };
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- download (docs/05 §4.4)

const webOf = (o: PageDetailResponse['objects'][number]): LocalObject['web'] => ({
  flagged: o.flagged,
  comment: o.comment,
  translation: o.translation,
  state: o.state,
});

/** Builds a workspace from a server chapter; blobs missing locally are downloaded into the cache. */
export async function downloadChapter(
  host: Host,
  api: ApiClient,
  chapterId: string,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<Workspace> {
  const ch = await api.chapter(chapterId);
  const pages: LocalPage[] = [];
  let done = 0;
  for (const s of ch.pages) {
    const d = await api.page(s.id);
    const get = async (hash: string | null): Promise<FileRef | null> => {
      if (!hash) return null;
      const { bytes, mime } = await api.blob(hash);
      const path = await host.saveImage(ch.chapter.id, hash, bytes, mime);
      const w = hash === d.page.thumb_hash ? 0 : d.page.width;
      const h = hash === d.page.thumb_hash ? 0 : d.page.height;
      return { path, hash, width: w, height: h, mime };
    };
    const page: LocalPage = {
      id: d.page.id,
      idx: d.page.idx,
      width: d.page.width,
      height: d.page.height,
      raw: (await get(d.page.raw_hash))!,
      clean: await get(d.page.clean_hash),
      notes: await get(d.page.notes_hash),
      thumb: await get(d.page.thumb_hash),
      objects: d.objects.map((o) => ({
        id: o.id,
        type: o.type,
        box: o.box,
        text_box: o.text_box,
        rotation: o.rotation ?? 0,
        source_text: o.source_text,
        origin: 'manual',
        touched: false,
        web: webOf(o),
      })),
      analyzed: d.objects.length > 0,
      server_markup_rev: d.page.markup_rev,
      published_digest: null,
    };
    page.published_digest = pageDigest(page);
    pages.push(page);
    onProgress(++done, ch.pages.length);
  }
  return {
    format: 1,
    id: ch.chapter.id,
    title: `${ch.project.title} — ${ch.chapter.number}`,
    server: { url: api.baseUrl, project_id: ch.project.id, chapter_id: ch.chapter.id, chapter_number: ch.chapter.number },
    reading_direction: ch.project.reading_direction,
    pages,
  };
}

/** Flags and comments from the web (docs/05 §4.5) — the only data flowing back; never undoable. */
export async function refreshWebData(api: ApiClient, ws: Workspace): Promise<Workspace> {
  const pages = await Promise.all(
    ws.pages.map(async (p) => {
      if (p.server_markup_rev === null) return p;
      try {
        const d = await api.page(p.id);
        const web = new Map([...d.objects, ...d.deleted_objects].map((o) => [o.id, webOf(o)]));
        let changed = false;
        const objects = p.objects.map((o) => {
          const w = web.get(o.id);
          if (!w || JSON.stringify(w) === JSON.stringify(o.web)) return o;
          changed = true;
          return { ...o, web: w };
        });
        return changed ? { ...p, objects } : p;
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 404) return p;
        throw e;
      }
    }),
  );
  return pages.every((p, i) => p === ws.pages[i]) ? ws : { ...ws, pages };
}
