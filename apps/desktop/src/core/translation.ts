import type { FieldConflictDetails, ObjectDTO, TextChanges } from '@komaflow/contract';
import { buildTranslationJson, parseTranslationJson, type ExportPage, type ImportResult } from '@komaflow/page-view';
import { ApiFailure, type ApiClient } from './api.js';
import type { LocalObject, Workspace } from './model.js';

/**
 * Translation data in the desktop (review 2026-11-24, ADR 0019): the desktop edits translation and
 * comments the same way the web does — PATCH /objects/:id with base_text_ver, field conflicts reported,
 * never overwritten silently. Flags stay the translator's signal for the typer: shown, not set here.
 */

export const webOf = (o: ObjectDTO): NonNullable<LocalObject['web']> => ({
  flagged: o.flagged,
  comment: o.comment,
  translation: o.translation,
  state: o.state,
  text_ver: o.text_ver,
});

export type PatchResult = { kind: 'ok'; object: ObjectDTO } | { kind: 'conflict'; details: FieldConflictDetails } | { kind: 'gone' };

export async function patchText(api: ApiClient, objectId: string, baseTextVer: number, changes: TextChanges): Promise<PatchResult> {
  try {
    return { kind: 'ok', object: await api.req<ObjectDTO>('PATCH', `/objects/${objectId}`, { base_text_ver: baseTextVer, changes }) };
  } catch (e) {
    if (e instanceof ApiFailure && e.code === 'FIELD_CONFLICT' && e.details) return { kind: 'conflict', details: e.details as unknown as FieldConflictDetails };
    if (e instanceof ApiFailure && e.status === 404) return { kind: 'gone' };
    throw e;
  }
}

/** Puts server text data of objects into the workspace (not an undo entry: it is the web's data). */
export function applyServerObjects(ws: Workspace, objects: ObjectDTO[]): Workspace {
  const byId = new Map(objects.map((o) => [o.id, o]));
  let changed = false;
  const pages = ws.pages.map((p) => {
    if (!p.objects.some((o) => byId.has(o.id))) return p;
    const objs = p.objects.map((o) => {
      const so = byId.get(o.id);
      if (!so) return o;
      changed = true;
      return { ...o, web: webOf(so) };
    });
    return { ...p, objects: objs };
  });
  return changed ? { ...ws, pages } : ws;
}

export interface ServerText {
  pages: ExportPage[];
  objects: Map<string, ObjectDTO>;
}

/** Current text data of the published pages, straight from the server (fresh text_ver for imports). */
export async function loadServerText(api: ApiClient, ws: Workspace, pageIds?: string[]): Promise<ServerText> {
  const objects = new Map<string, ObjectDTO>();
  const pages: ExportPage[] = [];
  for (const p of ws.pages) {
    if (p.server_markup_rev === null || (pageIds && !pageIds.includes(p.id))) continue;
    const d = await api.page(p.id);
    for (const o of d.objects) objects.set(o.id, o);
    pages.push({ idx: d.page.idx, objects: d.objects.map((o) => ({ id: o.id, order: o.order, type: o.type, source_text: o.source_text, translation: o.translation, state: o.state })) });
  }
  return { pages, objects };
}

export const exportJson = (st: ServerText, ws: Workspace, onlyUntranslated: boolean) =>
  buildTranslationJson(st.pages, { chapter: ws.server?.chapter_number ?? ws.title, sourceLang: 'ja', targetLang: 'ru', onlyUntranslated });

export const checkImport = (text: string, st: ServerText): ImportResult => parseTranslationJson(text, st.pages);

/** Matches the import would write (same rule as the web: empty translations only unless overwriting). */
export const importTodo = (r: ImportResult, overwrite: boolean) => r.matches.filter((m) => m.translation !== m.current && (overwrite || !m.current.trim()));

/** Writes translations one by one; a conflicting object is skipped and counted (someone edited it meanwhile). */
export async function applyImport(
  api: ApiClient,
  st: ServerText,
  todo: ImportResult['matches'],
  onProgress: (done: number, failed: number) => void,
): Promise<ObjectDTO[]> {
  const saved: ObjectDTO[] = [];
  let failed = 0;
  for (const [i, m] of todo.entries()) {
    const o = st.objects.get(m.objectId)!;
    const r = await patchText(api, o.id, o.text_ver, { translation: m.translation });
    if (r.kind === 'ok') saved.push(r.object);
    else failed++;
    onProgress(i + 1, failed);
  }
  return saved;
}
