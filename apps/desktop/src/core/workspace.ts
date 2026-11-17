import { canonicalJson, sha256Hex, toCanonical, uuidv7, type ReadingDirection, type SyncPage } from '@komaflow/contract';
import type { Host, ImageInfo } from './host.js';
import { naturalSort } from './importMatch.js';
import type { FileRef, LocalPage, Workspace } from './model.js';

export const fileRef = (f: ImageInfo): FileRef => ({ path: f.path, hash: f.hash, width: f.width, height: f.height, mime: f.mime });

/** New chapter from a folder of raw pages (docs/05 §1.1). Page order = natural file name order. */
export function workspaceFromImages(title: string, images: ImageInfo[], dir: ReadingDirection = 'rtl'): Workspace {
  return {
    format: 1,
    id: uuidv7(),
    title,
    server: null,
    reading_direction: dir,
    pages: naturalSort(images).map((img, i) => ({
      id: uuidv7(),
      idx: i + 1,
      width: img.width,
      height: img.height,
      raw: fileRef(img),
      clean: null,
      notes: null,
      thumb: null,
      objects: [],
      analyzed: false,
      server_markup_rev: null,
      published_digest: null,
    })),
  };
}

/** All local files of a workspace (raw, clean, notes, thumbnails) — to allow them for the WebView. */
export const workspaceFiles = (ws: Workspace): string[] =>
  ws.pages.flatMap((p) => [p.raw, p.clean, p.notes, p.thumb].filter((f): f is FileRef => !!f).map((f) => f.path));

/** Markup that the server stores for a page; equal digests mean «не изменена после публикации». */
export function pageDigest(p: LocalPage): string {
  return sha256Hex(
    canonicalJson(
      toCanonical({
        idx: p.idx,
        raw: p.raw.hash,
        clean: p.clean?.hash ?? null,
        notes: p.notes?.hash ?? null,
        objects: p.objects.map((o) => ({ id: o.id, type: o.type, box: o.box, text_box: o.text_box, rotation: o.rotation ?? 0, source_text: o.source_text })),
      }),
    ),
  );
}

export type PageLocalStatus = { analyzed: boolean; hasClean: boolean; published: boolean; changedSincePublish: boolean };

export function pageStatus(p: LocalPage): PageLocalStatus {
  const published = p.server_markup_rev !== null;
  return { analyzed: p.analyzed, hasClean: !!p.clean, published, changedSincePublish: published && p.published_digest !== pageDigest(p) };
}

/** Payload page for POST /chapters/{id}/sync. Originals of existing objects are applied by the server per ADR 0013. */
export function toSyncPage(p: LocalPage, forceSource?: ReadonlySet<string>): SyncPage {
  return {
    id: p.id,
    idx: p.idx,
    width: p.width,
    height: p.height,
    raw_hash: p.raw.hash,
    clean_hash: p.clean?.hash ?? null,
    notes_hash: p.notes?.hash ?? null,
    thumb_hash: p.thumb?.hash ?? null,
    base_markup_rev: p.server_markup_rev,
    objects: p.objects.map((o) => ({
      id: o.id,
      type: o.type,
      box: o.box,
      text_box: o.text_box,
      rotation: Math.round(o.rotation ?? 0),
      source_text: o.source_text,
      ...(o.server_source !== undefined ? { source_text_base: o.server_source } : {}),
      ...(forceSource?.has(o.id) ? { source_text_force: true } : {}),
    })),
  };
}

// ---------------------------------------------------------------- persistence (docs/05 §3)

/**
 * Layout: workspace.json (chapter, server link, format) + pages/<page_id>.json. Written atomically by
 * the host (tmp + rename), debounced by the caller (~1 s).
 */
export async function saveWorkspace(host: Host, ws: Workspace, previous?: Workspace): Promise<void> {
  const { pages, ...meta } = ws;
  await host.writeTextAtomic(`${ws.id}/workspace.json`, JSON.stringify({ ...meta, page_ids: pages.map((p) => p.id) }, null, 1));
  const prev = new Map(previous?.pages.map((p) => [p.id, p]));
  for (const p of pages) {
    if (prev.get(p.id) === p) continue; // unchanged object identity → unchanged page
    await host.writeTextAtomic(`${ws.id}/pages/${p.id}.json`, JSON.stringify(p, null, 1));
  }
}

export async function loadWorkspace(host: Host, id: string): Promise<Workspace | null> {
  const metaText = await host.readText(`${id}/workspace.json`);
  if (!metaText) return null;
  const meta = JSON.parse(metaText) as Omit<Workspace, 'pages'> & { page_ids: string[] };
  const pages: LocalPage[] = [];
  for (const pid of meta.page_ids) {
    const t = await host.readText(`${id}/pages/${pid}.json`);
    if (t) pages.push(JSON.parse(t) as LocalPage);
  }
  const { page_ids: _ids, ...rest } = meta;
  return { ...rest, pages };
}

/** Debounced autosave that only writes changed pages. */
export function autosaver(host: Host, delayMs = 1000, onError: (e: unknown) => void = () => {}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saved: Workspace | undefined;
  let pending: Workspace | null = null;
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const ws = pending;
    pending = null;
    if (!ws) return;
    try {
      await saveWorkspace(host, ws, saved?.id === ws.id ? saved : undefined);
      saved = ws;
    } catch (e) {
      onError(e);
    }
  };
  return {
    schedule(ws: Workspace) {
      pending = ws;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
  };
}
