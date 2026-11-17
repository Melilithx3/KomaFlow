import {
  ApiError,
  boxInsidePage,
  diffMarkup,
  type SourceConflict,
  type SyncPage,
  type SyncRequest,
  type SyncResponse,
} from '@komaflow/contract';
import { iso, type Ctx } from '../context.js';
import { getChapterRow } from './catalog.js';
import { getBlob, missingBlobs } from './blobs.js';
import type { ObjectRow, PageRow } from './rows.js';

interface Issue {
  path: string;
  message: string;
}

/**
 * POST /chapters/{id}/sync (docs/02-api.md §5, docs/01-data-model.md §3.1, §3.4).
 * One transaction: any error leaves the database untouched.
 */
export function syncChapter(ctx: Ctx, chapterId: string, userId: string, req: SyncRequest): SyncResponse {
  return ctx.db.tx(() => {
    getChapterRow(ctx, chapterId);
    validateShape(req);

    // Files first: a missing blob is the normal "upload and retry" path.
    const hashes = req.pages.flatMap((p) => [p.raw_hash, p.clean_hash, p.notes_hash, p.thumb_hash]).filter(
      (h): h is string => typeof h === 'string',
    );
    const missing = missingBlobs(ctx, hashes);
    if (missing.length > 0) throw new ApiError('BLOBS_MISSING', `${missing.length} file(s) are missing`, { missing });

    const existing = new Map<string, PageRow>();
    const conflicts: Array<{ id: string; markup_rev: number | null }> = [];
    for (const p of req.pages) {
      const row = ctx.db.get<PageRow>('SELECT * FROM pages WHERE id = ?', p.id);
      if (row) {
        if (row.chapter_id !== chapterId) {
          throw new ApiError('VALIDATION_ERROR', `page ${p.id} belongs to another chapter`);
        }
        existing.set(p.id, row);
        if (p.base_markup_rev !== row.markup_rev) conflicts.push({ id: p.id, markup_rev: row.markup_rev });
      } else if (p.base_markup_rev !== null) {
        conflicts.push({ id: p.id, markup_rev: null });
      }
    }
    if (conflicts.length > 0) {
      throw new ApiError('REVISION_CONFLICT', 'markup was changed on the server', { pages: conflicts });
    }

    for (const p of req.pages) checkFiles(ctx, p, existing.get(p.id));
    checkObjectOwnership(ctx, req);
    applyIdx(ctx, chapterId, req, existing);

    const at = iso(ctx.now());
    const out: SyncResponse['pages'] = [];
    for (const p of req.pages) {
      const before = new Set(ctx.db.all<{ id: string }>('SELECT id FROM objects WHERE page_id = ?', p.id).map((r) => r.id));
      const markup = applyPage(ctx, chapterId, userId, p, existing.get(p.id), at);
      out.push({ ...markup, ...applySourceTexts(ctx, userId, p, before, at) });
    }
    return { pages: out };
  });
}

function validateShape(req: SyncRequest): void {
  const issues: Issue[] = [];
  const pageIds = new Set<string>();
  const idxs = new Set<number>();
  const objIds = new Set<string>();
  req.pages.forEach((p, pi) => {
    if (pageIds.has(p.id)) issues.push({ path: `pages.${pi}.id`, message: 'duplicate page id' });
    pageIds.add(p.id);
    if (idxs.has(p.idx)) issues.push({ path: `pages.${pi}.idx`, message: 'duplicate idx' });
    idxs.add(p.idx);
    const size = { width: p.width, height: p.height };
    p.objects.forEach((o, oi) => {
      const path = `pages.${pi}.objects.${oi}`;
      if (objIds.has(o.id)) issues.push({ path: `${path}.id`, message: 'duplicate object id' });
      objIds.add(o.id);
      if (!boxInsidePage(o.box, size)) issues.push({ path: `${path}.box`, message: 'box must lie inside the page' });
      if (o.text_box && !boxInsidePage(o.text_box, size)) {
        issues.push({ path: `${path}.text_box`, message: 'text_box must lie inside the page' });
      }
    });
  });
  if (issues.length > 0) throw new ApiError('VALIDATION_ERROR', 'invalid sync request', { issues });
}

function checkFiles(ctx: Ctx, p: SyncPage, row: PageRow | undefined): void {
  if (row && (row.raw_hash !== p.raw_hash || row.width !== p.width || row.height !== p.height)) {
    throw new ApiError('RAW_IMMUTABLE', `raw of page ${p.id} cannot be replaced`, { page_id: p.id });
  }
  const raw = getBlob(ctx, p.raw_hash)!;
  if (raw.width !== p.width || raw.height !== p.height) {
    throw new ApiError('SIZE_MISMATCH', `raw is ${raw.width}x${raw.height}, page says ${p.width}x${p.height}`, {
      page_id: p.id,
      layer: 'raw',
    });
  }
  for (const layer of ['clean', 'notes'] as const) {
    const h = p[`${layer}_hash`];
    if (!h) continue;
    const b = getBlob(ctx, h)!;
    if (b.width !== p.width || b.height !== p.height) {
      throw new ApiError('SIZE_MISMATCH', `${layer} is ${b.width}x${b.height}, raw is ${p.width}x${p.height}`, {
        page_id: p.id,
        layer,
      });
    }
  }
}

/** Objects never move between pages. */
function checkObjectOwnership(ctx: Ctx, req: SyncRequest): void {
  for (const p of req.pages) {
    for (const o of p.objects) {
      const r = ctx.db.get<{ page_id: string }>('SELECT page_id FROM objects WHERE id = ?', o.id);
      if (r && r.page_id !== p.id) {
        throw new ApiError('VALIDATION_ERROR', `object ${o.id} belongs to another page`);
      }
    }
  }
}

/** Moves page indexes in two phases so pages can swap places; collisions with other pages are rejected. */
function applyIdx(ctx: Ctx, chapterId: string, req: SyncRequest, existing: Map<string, PageRow>): void {
  const requestIds = new Set(req.pages.map((p) => p.id));
  const others = ctx.db
    .all<{ id: string; idx: number }>('SELECT id, idx FROM pages WHERE chapter_id = ?', chapterId)
    .filter((r) => !requestIds.has(r.id));
  const taken = new Set(others.map((r) => r.idx));
  for (const p of req.pages) {
    if (taken.has(p.idx)) {
      throw new ApiError('VALIDATION_ERROR', `idx ${p.idx} is used by another page of the chapter`);
    }
  }
  const moving = req.pages.filter((p) => existing.has(p.id) && existing.get(p.id)!.idx !== p.idx);
  for (const p of moving) ctx.db.run('UPDATE pages SET idx = ? WHERE id = ?', -existing.get(p.id)!.idx, p.id);
  for (const p of moving) ctx.db.run('UPDATE pages SET idx = ?, rev = rev + 1 WHERE id = ?', p.idx, p.id);
}

function applyPage(
  ctx: Ctx,
  chapterId: string,
  userId: string,
  p: SyncPage,
  row: PageRow | undefined,
  at: string,
): Omit<SyncResponse['pages'][number], 'source_updated' | 'source_conflicts'> {
  // `undefined` keeps the server value, `null` removes the file (ADR 0005).
  const files = {
    clean_hash: p.clean_hash === undefined ? (row?.clean_hash ?? null) : p.clean_hash,
    notes_hash: p.notes_hash === undefined ? (row?.notes_hash ?? null) : p.notes_hash,
    thumb_hash: p.thumb_hash === undefined ? (row?.thumb_hash ?? null) : p.thumb_hash,
  };
  const stored = row ? ctx.db.all<ObjectRow>('SELECT * FROM objects WHERE page_id = ?', p.id) : [];
  const next = p.objects.map((o) => ({ id: o.id, type: o.type, box: o.box, text_box: o.text_box ?? null, rotation: o.rotation ?? 0 }));
  const diff = diffMarkup(
    row
      ? {
          objects: stored.map((o) => ({
            id: o.id,
            type: o.type,
            box: { x: o.x, y: o.y, w: o.w, h: o.h },
            text_box: o.tx === null ? null : { x: o.tx, y: o.ty!, w: o.tw!, h: o.th! },
            rotation: o.rot,
            ord: o.ord,
            deleted: o.deleted === 1,
          })),
          files: { clean_hash: row.clean_hash, notes_hash: row.notes_hash, thumb_hash: row.thumb_hash },
        }
      : null,
    { objects: next, files },
  );

  if (!diff.changed && row) return { id: p.id, markup_rev: row.markup_rev, changed: false, summary: diff.summary };

  const markupRev = (row?.markup_rev ?? 0) + 1;
  if (row) {
    ctx.db.run(
      'UPDATE pages SET clean_hash = ?, notes_hash = ?, thumb_hash = ?, markup_rev = ?, rev = rev + 1 WHERE id = ?',
      files.clean_hash,
      files.notes_hash,
      files.thumb_hash,
      markupRev,
      p.id,
    );
  } else {
    ctx.db.run(
      `INSERT INTO pages (id, chapter_id, idx, width, height, raw_hash, clean_hash, notes_hash, thumb_hash, markup_rev, rev, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      p.id,
      chapterId,
      p.idx,
      p.width,
      p.height,
      p.raw_hash,
      files.clean_hash,
      files.notes_hash,
      files.thumb_hash,
      markupRev,
      at,
    );
  }

  const storedById = new Map(stored.map((o) => [o.id, o]));
  const geometry = new Set(diff.geometryChanged);
  p.objects.forEach((o, i) => {
    const tb = o.text_box ?? null;
    const s = storedById.get(o.id);
    if (!s) {
      ctx.db.run(
        `INSERT INTO objects (id, page_id, type, x, y, w, h, tx, ty, tw, th, ord, rot, source_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        o.id,
        p.id,
        o.type,
        o.box.x,
        o.box.y,
        o.box.w,
        o.box.h,
        tb?.x ?? null,
        tb?.y ?? null,
        tb?.w ?? null,
        tb?.h ?? null,
        i + 1,
        o.rotation ?? 0,
        o.source_text ?? '',
        at,
        at,
      );
    } else if (geometry.has(o.id)) {
      // source_text of existing objects goes through applySourceTexts (ADR 0013).
      ctx.db.run(
        `UPDATE objects SET type = ?, x = ?, y = ?, w = ?, h = ?, tx = ?, ty = ?, tw = ?, th = ?, ord = ?, rot = ?, deleted = 0,
                geometry_ver = geometry_ver + 1 WHERE id = ?`,
        o.type,
        o.box.x,
        o.box.y,
        o.box.w,
        o.box.h,
        tb?.x ?? null,
        tb?.y ?? null,
        tb?.w ?? null,
        tb?.h ?? null,
        i + 1,
        o.rotation ?? 0,
        o.id,
      );
    }
  });
  for (const id of diff.summary.deleted) {
    ctx.db.run('UPDATE objects SET deleted = 1, geometry_ver = geometry_ver + 1 WHERE id = ?', id);
  }
  ctx.db.run(
    'INSERT INTO markup_revisions (page_id, rev, user_id, at, summary_json) VALUES (?, ?, ?, ?, ?)',
    p.id,
    markupRev,
    userId,
    at,
    JSON.stringify(diff.summary),
  );
  return { id: p.id, markup_rev: markupRev, changed: true, summary: diff.summary };
}

/**
 * Originals of existing objects from the desktop (ADR 0013): taken when the server value still equals
 * the desktop's base (or the web never edited it), or when forced; otherwise reported as a conflict.
 * Written like a web edit (text_ver, field_vers, history) so web clients see it and keep their conflicts.
 */
function applySourceTexts(ctx: Ctx, userId: string, p: SyncPage, existedBefore: Set<string>, at: string) {
  const updated: string[] = [];
  const conflicts: SourceConflict[] = [];
  for (const o of p.objects) {
    if (o.source_text === undefined || !existedBefore.has(o.id)) continue;
    const row = ctx.db.get<ObjectRow>('SELECT * FROM objects WHERE id = ?', o.id);
    if (!row || row.source_text === o.source_text) continue;
    const fv = JSON.parse(row.field_vers) as Record<string, number>;
    const ok =
      o.source_text_force === true ||
      (o.source_text_base !== undefined && o.source_text_base !== null ? row.source_text === o.source_text_base : fv.source_text === undefined);
    if (!ok) {
      conflicts.push({ id: o.id, server_source_text: row.source_text, desktop_source_text: o.source_text });
      continue;
    }
    const textVer = row.text_ver + 1;
    fv.source_text = textVer;
    ctx.db.run(
      'UPDATE objects SET source_text = ?, text_ver = ?, field_vers = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      o.source_text,
      textVer,
      JSON.stringify(fv),
      at,
      userId,
      o.id,
    );
    ctx.db.run(
      'INSERT INTO text_history (object_id, field, old_value, new_value, user_id, at, text_ver) VALUES (?, ?, ?, ?, ?, ?, ?)',
      o.id,
      'source_text',
      row.source_text,
      o.source_text,
      userId,
      at,
      textVer,
    );
    updated.push(o.id);
  }
  if (updated.length) ctx.db.run('UPDATE pages SET rev = rev + 1 WHERE id = ?', p.id);
  return { source_updated: updated, source_conflicts: conflicts };
}
