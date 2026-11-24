import {
  ApiError,
  MarkupSummary,
  applyTextPatch,
  type ObjectDTO,
  type PageDetailResponse,
  type PageDTO,
  type PageReviewDTO,
  type PatchObjectRequest,
  type PutReviewRequest,
  type ReviewKind,
  type TextData,
  type TextField,
} from '@komaflow/contract';
import { iso, type Ctx } from '../context.js';
import { getBlob } from './blobs.js';
import { objectDTO, pageDTO, parseSettings, type ObjectRow, type PageRow } from './rows.js';
import { getChapterRow, getProjectRow } from './catalog.js';
import { userDTO, type UserRow } from './users.js';

export function getPageRow(ctx: Ctx, id: string): PageRow {
  const p = ctx.db.get<PageRow>('SELECT * FROM pages WHERE id = ?', id);
  if (!p) throw new ApiError('NOT_FOUND', 'page not found');
  return p;
}

export function pageDetail(ctx: Ctx, pageId: string, userId: string): PageDetailResponse {
  const page = getPageRow(ctx, pageId);
  const chapter = getChapterRow(ctx, page.chapter_id);
  const project = getProjectRow(ctx, chapter.project_id);
  const objs = ctx.db.all<ObjectRow>('SELECT * FROM objects WHERE page_id = ? ORDER BY deleted, ord, id', pageId);
  const revisions = ctx.db
    .all<{ rev: number; at: string; user_id: string | null; summary_json: string; display_name: string | null }>(
      `SELECT r.rev, r.at, r.user_id, r.summary_json, u.display_name
         FROM markup_revisions r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.page_id = ? ORDER BY r.rev DESC LIMIT 10`,
      pageId,
    )
    .map((r) => ({
      rev: r.rev,
      at: r.at,
      user_id: r.user_id,
      user_name: r.display_name,
      summary: MarkupSummary.parse(JSON.parse(r.summary_json)),
    }));
  const seen = ctx.db.get<{ markup_rev: number }>(
    'SELECT markup_rev FROM page_seen WHERE user_id = ? AND page_id = ?',
    userId,
    pageId,
  );
  return {
    reviews: pageReviews(ctx, pageId),
    page: pageDTO(page),
    objects: objs.filter((o) => o.deleted === 0).map(objectDTO),
    deleted_objects: objs.filter((o) => o.deleted === 1).map(objectDTO),
    revisions,
    project_settings: parseSettings(project.settings_json),
    seen_markup_rev: seen?.markup_rev ?? null,
  };
}

/** Records the markup revision the user has seen (never decreases). */
export function markSeen(ctx: Ctx, pageId: string, userId: string, markupRev: number): void {
  const page = getPageRow(ctx, pageId);
  const rev = Math.min(markupRev, page.markup_rev);
  ctx.db.run(
    `INSERT INTO page_seen (user_id, page_id, markup_rev) VALUES (?, ?, ?)
     ON CONFLICT (user_id, page_id) DO UPDATE SET markup_rev = MAX(markup_rev, excluded.markup_rev)`,
    userId,
    pageId,
    rev,
  );
}

/** Reviews of a page; both kinds are always listed (ver 0 = nothing saved yet). */
export function pageReviews(ctx: Ctx, pageId: string): PageReviewDTO[] {
  const rows = ctx.db.all<{ kind: ReviewKind; marks_hash: string | null; comment: string; ver: number; updated_at: string | null; display_name: string | null }>(
    `SELECT r.kind, r.marks_hash, r.comment, r.ver, r.updated_at, u.display_name
       FROM page_reviews r LEFT JOIN users u ON u.id = r.updated_by WHERE r.page_id = ?`,
    pageId,
  );
  return (['clean', 'type'] as const).map((kind) => {
    const r = rows.find((x) => x.kind === kind);
    return r
      ? { kind, marks_hash: r.marks_hash, comment: r.comment, ver: r.ver, updated_at: r.updated_at, updated_by_name: r.display_name }
      : { kind, marks_hash: null, comment: '', ver: 0, updated_at: null, updated_by_name: null };
  });
}

/**
 * Saves the editorial review of the clean or the typed page (ADR 0021). Marks are a separate image, they
 * never touch the clean / typed image. Stale `base_ver` → REVISION_CONFLICT with the current review.
 */
export function putReview(ctx: Ctx, pageId: string, kind: ReviewKind, userId: string, req: PutReviewRequest): PageReviewDTO {
  return ctx.db.tx(() => {
    const page = getPageRow(ctx, pageId);
    const cur = pageReviews(ctx, pageId).find((r) => r.kind === kind)!;
    if (req.base_ver !== cur.ver) throw new ApiError('REVISION_CONFLICT', 'the review was changed meanwhile', { review: cur });
    if (req.marks_hash) {
      const b = getBlob(ctx, req.marks_hash);
      if (!b) throw new ApiError('BLOBS_MISSING', 'upload the marks image first', { missing: [req.marks_hash] });
      if (b.width !== page.width || b.height !== page.height) {
        throw new ApiError('SIZE_MISMATCH', `marks are ${b.width}x${b.height}, page is ${page.width}x${page.height}`);
      }
    }
    if (req.marks_hash === cur.marks_hash && req.comment === cur.comment) return cur;
    ctx.db.run(
      `INSERT INTO page_reviews (page_id, kind, marks_hash, comment, ver, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (page_id, kind) DO UPDATE SET marks_hash = excluded.marks_hash, comment = excluded.comment, ver = ver + 1,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      pageId,
      kind,
      req.marks_hash,
      req.comment,
      iso(ctx.now()),
      userId,
    );
    ctx.db.run('UPDATE pages SET rev = rev + 1 WHERE id = ?', pageId);
    return pageReviews(ctx, pageId).find((r) => r.kind === kind)!;
  });
}

/** Binds an uploaded typed page image and sets «затайплена» (the image is the proof). */
export function setTypedImage(ctx: Ctx, pageId: string, userId: string, hash: string): PageDTO {
  return ctx.db.tx(() => {
    const page = getPageRow(ctx, pageId);
    if (!getBlob(ctx, hash)) throw new ApiError('BLOBS_MISSING', 'upload the typed page first', { missing: [hash] });
    if (page.typed_hash === hash && page.typed_at !== null) return pageDTO(page);
    ctx.db.run(
      'UPDATE pages SET typed_hash = ?, typed_at = COALESCE(typed_at, ?), typed_by = COALESCE(typed_by, ?), rev = rev + 1 WHERE id = ?',
      hash,
      iso(ctx.now()),
      userId,
      pageId,
    );
    return pageDTO(getPageRow(ctx, pageId));
  });
}

export function setTyped(ctx: Ctx, pageId: string, userId: string, typed: boolean): PageDTO {
  return ctx.db.tx(() => {
    const page = getPageRow(ctx, pageId);
    if (typed !== (page.typed_at !== null)) {
      ctx.db.run(
        'UPDATE pages SET typed_at = ?, typed_by = ?, rev = rev + 1 WHERE id = ?',
        typed ? iso(ctx.now()) : null,
        typed ? userId : null,
        pageId,
      );
    }
    return pageDTO(getPageRow(ctx, pageId));
  });
}

const toText = (r: ObjectRow): TextData => ({
  source_text: r.source_text,
  translation: r.translation,
  state: r.state,
  comment: r.comment,
  flagged: r.flagged === 1,
  text_ver: r.text_ver,
  field_vers: JSON.parse(r.field_vers) as Partial<Record<TextField, number>>,
});

const historyValue = (v: string | boolean) => (typeof v === 'boolean' ? (v ? '1' : '0') : v);

/** PATCH /objects/{id} (docs/01-data-model.md §3.2). Never touches geometry. */
export function patchObject(ctx: Ctx, objectId: string, userId: string, req: PatchObjectRequest): ObjectDTO {
  return ctx.db.tx(() => {
    const row = ctx.db.get<ObjectRow>('SELECT * FROM objects WHERE id = ?', objectId);
    if (!row) throw new ApiError('NOT_FOUND', 'object not found');
    if (req.base_text_ver > row.text_ver) {
      throw new ApiError('VALIDATION_ERROR', 'base_text_ver is ahead of the server');
    }
    const cur = toText(row);
    const r = applyTextPatch(cur, req.base_text_ver, req.changes);
    if (r.kind === 'invalid') throw new ApiError('VALIDATION_ERROR', r.message);
    if (r.kind === 'conflict') {
      const by = row.updated_by ? ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', row.updated_by) : undefined;
      throw new ApiError('FIELD_CONFLICT', 'field was changed by someone else', {
        fields: r.fields,
        server_values: Object.fromEntries(r.fields.map((f) => [f, cur[f]])),
        object: objectDTO(row),
        updated_by: by ? userDTO(by) : null,
      });
    }
    if (r.changed.length === 0) return objectDTO(row);
    const at = iso(ctx.now());
    const n = r.next;
    ctx.db.run(
      `UPDATE objects SET source_text = ?, translation = ?, state = ?, comment = ?, flagged = ?,
              text_ver = ?, field_vers = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      n.source_text,
      n.translation,
      n.state,
      n.comment,
      n.flagged ? 1 : 0,
      n.text_ver,
      JSON.stringify(n.field_vers),
      at,
      userId,
      objectId,
    );
    for (const f of r.changed) {
      ctx.db.run(
        'INSERT INTO text_history (object_id, field, old_value, new_value, user_id, at, text_ver) VALUES (?, ?, ?, ?, ?, ?, ?)',
        objectId,
        f,
        historyValue(cur[f]),
        historyValue(n[f]),
        userId,
        at,
        n.text_ver,
      );
    }
    ctx.db.run('UPDATE pages SET rev = rev + 1 WHERE id = ?', row.page_id);
    return objectDTO(ctx.db.get<ObjectRow>('SELECT * FROM objects WHERE id = ?', objectId)!);
  });
}
