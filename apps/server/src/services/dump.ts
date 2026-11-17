import type { Ctx } from '../context.js';
import type { ChapterRow, ObjectRow, PageRow, ProjectRow } from './rows.js';

/** `komaflow-admin dump-text`: every text field, grouped by project / chapter / page (docs/03-server-ops.md §8). */
export function dumpText(ctx: Ctx) {
  const projects = ctx.db.all<ProjectRow>('SELECT * FROM projects ORDER BY created_at');
  return {
    format: 1,
    created_at: ctx.now().toISOString(),
    projects: projects.map((p) => ({
      id: p.id,
      title: p.title,
      chapters: ctx.db.all<ChapterRow>('SELECT * FROM chapters WHERE project_id = ? ORDER BY created_at', p.id).map((c) => ({
        id: c.id,
        number: c.number,
        title: c.title,
        pages: ctx.db.all<PageRow>('SELECT * FROM pages WHERE chapter_id = ? ORDER BY idx', c.id).map((pg) => ({
          id: pg.id,
          idx: pg.idx,
          objects: ctx.db
            .all<ObjectRow>('SELECT * FROM objects WHERE page_id = ? ORDER BY deleted, ord', pg.id)
            .map((o) => ({
              id: o.id,
              order: o.ord,
              type: o.type,
              deleted: o.deleted === 1,
              source_text: o.source_text,
              translation: o.translation,
              state: o.state,
              comment: o.comment,
              flagged: o.flagged === 1,
            })),
        })),
      })),
    })),
  };
}
