import type { TranslationState } from './common.js';
import type { StateCounts } from './dto.js';

export function emptyCounts(): StateCounts {
  return { total: 0, empty: 0, translated: 0, skipped: 0, unreadable: 0 };
}

export function countStates(states: Iterable<TranslationState>): StateCounts {
  const c = emptyCounts();
  for (const s of states) {
    c.total++;
    c[s]++;
  }
  return c;
}

export interface PageStatusInput {
  clean_hash: string | null;
  counts: StateCounts;
  typed_at: string | null;
  markup_rev: number;
  /** markup_rev the current user has seen, or null when the user never opened the page. */
  seen_markup_rev: number | null;
}

/** Computed page statuses (docs/01-data-model.md §4). */
export function pageStatus(p: PageStatusInput) {
  const has_clean = p.clean_hash !== null;
  const translation_done = p.counts.empty === 0;
  return {
    has_clean,
    translation_done,
    ready_for_typing: has_clean && translation_done,
    typed: p.typed_at !== null,
    markup_changed_for_me: p.seen_markup_rev !== null && p.markup_rev > p.seen_markup_rev,
  };
}
