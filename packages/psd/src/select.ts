import type { ExportLayers } from '@komaflow/contract';

export type SkipReason = 'not_ready' | 'no_clean' | 'no_layers';

export interface SelectablePage {
  id: string;
  idx: number;
  clean_hash: string | null;
  notes_hash: string | null;
  ready_for_typing: boolean;
  /** Objects that would get a text layer (translated, non-empty). */
  text_objects?: number;
}

export interface Selection<P> {
  pages: P[];
  skipped: Array<{ page: P; reason: SkipReason }>;
}

/** Page selection for an export (docs/04-psd.md §4). Raw always exists. */
export function selectPages<P extends SelectablePage>(
  pages: readonly P[],
  params: { only_ready: boolean; page_ids: string[] | null; layers: ExportLayers },
): Selection<P> {
  const ids = params.page_ids ? new Set(params.page_ids) : null;
  const out: Selection<P> = { pages: [], skipped: [] };
  for (const p of [...pages].sort((a, b) => a.idx - b.idx)) {
    if (ids && !ids.has(p.id)) continue;
    if (params.only_ready && !p.ready_for_typing) {
      out.skipped.push({ page: p, reason: 'not_ready' });
      continue;
    }
    if (params.layers.clean && !p.clean_hash) {
      out.skipped.push({ page: p, reason: 'no_clean' });
      continue;
    }
    const any =
      params.layers.raw ||
      (params.layers.notes && p.notes_hash !== null) ||
      (params.layers.clean && p.clean_hash !== null) ||
      (params.layers.text && (p.text_objects ?? 0) > 0);
    if (!any) {
      out.skipped.push({ page: p, reason: 'no_layers' });
      continue;
    }
    out.pages.push(p);
  }
  return out;
}

/** `001.psd` etc. */
export const psdFileName = (idx: number) => `${String(idx).padStart(3, '0')}.psd`;
