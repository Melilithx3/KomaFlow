import {
  ApiError,
  countStates,
  defaultProjectSettings,
  pageStatus,
  uuidv7,
  type ChapterDetailResponse,
  type ChapterListItem,
  type CreateChapterRequest,
  type CreateProjectRequest,
  type PageSummary,
  type ProjectDTO,
  type TranslationState,
  type UpdateProjectRequest,
} from '@komaflow/contract';
import { iso, type Ctx } from '../context.js';
import { chapterDTO, projectDTO, type ChapterRow, type PageRow, type ProjectRow } from './rows.js';

export function listProjects(ctx: Ctx): ProjectDTO[] {
  return ctx.db.all<ProjectRow>('SELECT * FROM projects ORDER BY created_at').map(projectDTO);
}

export function getProjectRow(ctx: Ctx, id: string): ProjectRow {
  const p = ctx.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
  if (!p) throw new ApiError('NOT_FOUND', 'project not found');
  return p;
}

export function createProject(ctx: Ctx, req: CreateProjectRequest): ProjectDTO {
  const row: ProjectRow = {
    id: uuidv7(),
    title: req.title,
    source_lang: req.source_lang,
    target_lang: req.target_lang,
    reading_direction: req.reading_direction ?? 'rtl',
    settings_json: JSON.stringify(defaultProjectSettings()),
    created_at: iso(ctx.now()),
  };
  ctx.db.run(
    'INSERT INTO projects (id, title, source_lang, target_lang, reading_direction, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    row.id,
    row.title,
    row.source_lang,
    row.target_lang,
    row.reading_direction,
    row.settings_json,
    row.created_at,
  );
  return projectDTO(row);
}

export function updateProject(ctx: Ctx, id: string, req: UpdateProjectRequest): ProjectDTO {
  return ctx.db.tx(() => {
    const p = getProjectRow(ctx, id);
    const next: ProjectRow = {
      ...p,
      title: req.title ?? p.title,
      source_lang: req.source_lang ?? p.source_lang,
      target_lang: req.target_lang ?? p.target_lang,
      reading_direction: req.reading_direction ?? p.reading_direction,
      settings_json: req.settings ? JSON.stringify(req.settings) : p.settings_json,
    };
    ctx.db.run(
      'UPDATE projects SET title = ?, source_lang = ?, target_lang = ?, reading_direction = ?, settings_json = ? WHERE id = ?',
      next.title,
      next.source_lang,
      next.target_lang,
      next.reading_direction,
      next.settings_json,
      id,
    );
    return projectDTO(next);
  });
}

export function getChapterRow(ctx: Ctx, id: string): ChapterRow {
  const c = ctx.db.get<ChapterRow>('SELECT * FROM chapters WHERE id = ?', id);
  if (!c) throw new ApiError('NOT_FOUND', 'chapter not found');
  return c;
}

export function createChapter(ctx: Ctx, projectId: string, req: CreateChapterRequest) {
  return ctx.db.tx(() => {
    getProjectRow(ctx, projectId);
    const existing = ctx.db.get<ChapterRow>(
      'SELECT * FROM chapters WHERE project_id = ? AND number = ?',
      projectId,
      req.number,
    );
    if (existing) return { chapter: chapterDTO(existing), created: false };
    const row: ChapterRow = {
      id: uuidv7(),
      project_id: projectId,
      number: req.number,
      title: req.title ?? null,
      created_at: iso(ctx.now()),
    };
    ctx.db.run(
      'INSERT INTO chapters (id, project_id, number, title, created_at) VALUES (?, ?, ?, ?, ?)',
      row.id,
      row.project_id,
      row.number,
      row.title,
      row.created_at,
    );
    return { chapter: chapterDTO(row), created: true };
  });
}

interface CountRow {
  page_id: string;
  state: TranslationState;
  n: number;
  flagged: number;
}

/** Page summaries for a chapter, computed for `userId` (docs/01-data-model.md §4). */
export function pageSummaries(ctx: Ctx, chapterId: string, userId: string): PageSummary[] {
  const pages = ctx.db.all<PageRow>('SELECT * FROM pages WHERE chapter_id = ? ORDER BY idx', chapterId);
  const counts = ctx.db.all<CountRow>(
    `SELECT o.page_id, o.state, COUNT(*) AS n, SUM(o.flagged) AS flagged
       FROM objects o JOIN pages p ON p.id = o.page_id
      WHERE p.chapter_id = ? AND o.deleted = 0
      GROUP BY o.page_id, o.state`,
    chapterId,
  );
  const seen = new Map(
    ctx.db
      .all<{ page_id: string; markup_rev: number }>(
        `SELECT s.page_id, s.markup_rev FROM page_seen s JOIN pages p ON p.id = s.page_id
          WHERE s.user_id = ? AND p.chapter_id = ?`,
        userId,
        chapterId,
      )
      .map((r) => [r.page_id, r.markup_rev]),
  );
  return pages.map((p) => {
    const rows = counts.filter((c) => c.page_id === p.id);
    const states: TranslationState[] = rows.flatMap((r) => Array<TranslationState>(r.n).fill(r.state));
    const c = countStates(states);
    const st = pageStatus({
      clean_hash: p.clean_hash,
      counts: c,
      typed_at: p.typed_at,
      markup_rev: p.markup_rev,
      seen_markup_rev: seen.get(p.id) ?? null,
    });
    return {
      id: p.id,
      idx: p.idx,
      width: p.width,
      height: p.height,
      raw_hash: p.raw_hash,
      thumb_hash: p.thumb_hash,
      markup_rev: p.markup_rev,
      rev: p.rev,
      typed: st.typed,
      typed_hash: p.typed_hash ?? null,
      has_clean: st.has_clean,
      counts: c,
      flagged: rows.reduce((n, r) => n + Number(r.flagged ?? 0), 0),
      translation_done: st.translation_done,
      ready_for_typing: st.ready_for_typing,
      markup_changed_for_me: st.markup_changed_for_me,
    };
  });
}

export function listChapters(ctx: Ctx, projectId: string, userId: string): ChapterListItem[] {
  getProjectRow(ctx, projectId);
  const chapters = ctx.db.all<ChapterRow>('SELECT * FROM chapters WHERE project_id = ?', projectId);
  chapters.sort((a, b) => Number(a.number) - Number(b.number) || a.number.localeCompare(b.number));
  return chapters.map((c) => {
    const pages = pageSummaries(ctx, c.id, userId);
    return {
      ...chapterDTO(c),
      page_count: pages.length,
      clean_count: pages.filter((p) => p.has_clean).length,
      translated_count: pages.filter((p) => p.translation_done).length,
      ready_count: pages.filter((p) => p.ready_for_typing).length,
      typed_count: pages.filter((p) => p.typed).length,
    };
  });
}

export function chapterDetail(ctx: Ctx, chapterId: string, userId: string): ChapterDetailResponse {
  const c = getChapterRow(ctx, chapterId);
  return {
    chapter: chapterDTO(c),
    project: projectDTO(getProjectRow(ctx, c.project_id)),
    pages: pageSummaries(ctx, chapterId, userId),
  };
}
