import { z } from 'zod';

/**
 * JSON for translating with an AI assistant (ADR 0012): export the objects, let the AI fill
 * `translation`, import it back. Matching is by `id` first, then by page number + `n`.
 */
export const TRANSLATION_FORMAT = 'komaflow-translation';

export interface ExportObject {
  id: string;
  order: number;
  type: string;
  source_text: string;
  translation: string;
  state: string;
}

export interface ExportPage {
  idx: number;
  objects: ExportObject[];
}

const Item = z.object({
  n: z.number().int().optional(),
  id: z.string().optional(),
  source: z.string().optional(),
  translation: z.string().nullable().optional(),
});
const PageItem = z.object({ page: z.number().int().optional(), objects: z.array(Item) });
const FileSchema = z.object({
  format: z.string().optional(),
  pages: z.array(PageItem).optional(),
  objects: z.array(Item).optional(),
  page: z.number().int().optional(),
});

export function buildTranslationJson(
  pages: ExportPage[],
  opts: { chapter?: string; sourceLang: string; targetLang: string; onlyUntranslated?: boolean },
): string {
  const doc = {
    format: TRANSLATION_FORMAT,
    version: 1,
    instructions:
      `Translate every "source" from ${opts.sourceLang} to ${opts.targetLang} (manga lettering). ` +
      'Write the result into "translation" of the same item. Do not change "n", "id", "page" or "source", ' +
      'do not add or remove items. Keep line breaks as \\n. Return the whole JSON.',
    source_lang: opts.sourceLang,
    target_lang: opts.targetLang,
    ...(opts.chapter ? { chapter: opts.chapter } : {}),
    pages: pages.map((p) => ({
      page: p.idx,
      objects: p.objects
        .filter((o) => !opts.onlyUntranslated || o.state === 'empty')
        .sort((a, b) => a.order - b.order)
        .map((o) => ({ n: o.order, id: o.id, type: o.type, source: o.source_text, translation: '' })),
    })),
  };
  return JSON.stringify(doc, null, 2);
}

export interface ImportMatch {
  objectId: string;
  page: number;
  n: number;
  source: string;
  current: string;
  translation: string;
}

export interface ImportResult {
  matches: ImportMatch[];
  /** Items that matched nothing (shown to the user). */
  unmatched: Array<{ page: number | null; n: number | null; id: string | null }>;
  /** Items with an empty translation (skipped). */
  empty: number;
}

/** Strips ```json fences the AI may add around the answer. */
function unwrap(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1]! : t;
}

export function parseTranslationJson(text: string, pages: ExportPage[]): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(unwrap(text));
  } catch (e) {
    throw new Error(`Это не JSON: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) throw new Error('JSON не похож на файл перевода komaflow (нет списка pages/objects)');
  const doc = parsed.data;
  // A single-page file may be {objects: [...]} at the top level.
  const filePages = doc.pages ?? [{ page: doc.page ?? (pages.length === 1 ? pages[0]!.idx : undefined), objects: doc.objects ?? [] }];

  const byId = new Map<string, { page: ExportPage; obj: ExportObject }>();
  for (const p of pages) for (const o of p.objects) byId.set(o.id, { page: p, obj: o });

  const res: ImportResult = { matches: [], unmatched: [], empty: 0 };
  const seen = new Set<string>();
  for (const fp of filePages) {
    for (const it of fp.objects) {
      const tr = (it.translation ?? '').replace(/\r\n/g, '\n');
      if (!tr.trim()) {
        res.empty++;
        continue;
      }
      let hit = it.id ? byId.get(it.id) : undefined;
      if (!hit && it.n !== undefined) {
        const page = pages.find((p) => p.idx === fp.page) ?? (pages.length === 1 ? pages[0] : undefined);
        const obj = page?.objects.find((o) => o.order === it.n);
        if (page && obj) hit = { page, obj };
      }
      if (!hit || seen.has(hit.obj.id)) {
        res.unmatched.push({ page: fp.page ?? null, n: it.n ?? null, id: it.id ?? null });
        continue;
      }
      seen.add(hit.obj.id);
      res.matches.push({ objectId: hit.obj.id, page: hit.page.idx, n: hit.obj.order, source: hit.obj.source_text, current: hit.obj.translation, translation: tr });
    }
  }
  return res;
}
