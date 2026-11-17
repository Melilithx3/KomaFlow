import type { ImageInfo } from './host.js';
import type { LocalPage } from './model.js';

export type MatchStatus = 'matched' | 'size_mismatch';

export interface ImportRow {
  pageId: string;
  pageIdx: number;
  pageName: string;
  file: ImageInfo | null;
  status: MatchStatus | 'missing';
  rule?: 'name' | 'number';
}

export interface ImportPlan {
  rows: ImportRow[];
  /** Files that did not match any page. */
  extra: ImageInfo[];
}

const stem = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase();

/** Last number in a name: "p012_clean" → 12, "ch3-007" → 7. */
export function numericSuffix(name: string): number | null {
  const m = /(\d+)(?!.*\d)/.exec(stem(name));
  return m ? Number(m[1]) : null;
}

/**
 * Matches clean / notes files to pages (docs/05 §4.2): by file name without extension, falling back to
 * the numeric suffix; a file whose size differs from raw is reported and never applied.
 */
export function matchImport(pages: readonly LocalPage[], files: readonly ImageInfo[]): ImportPlan {
  const used = new Set<string>();
  const byStem = new Map<string, ImageInfo>();
  for (const f of files) if (!byStem.has(stem(f.name))) byStem.set(stem(f.name), f);
  const rows: ImportRow[] = [];
  const pending: LocalPage[] = [];
  for (const p of pages) {
    const f = byStem.get(stem(p.raw.path.split(/[\\/]/).pop() ?? ''));
    if (f && !used.has(f.path)) {
      used.add(f.path);
      rows.push(row(p, f, 'name'));
    } else pending.push(p);
  }
  // Numeric suffix: page "012.png" ↔ "clean_12.png"; ambiguous numbers are not matched.
  const byNum = new Map<number, ImageInfo[]>();
  for (const f of files) {
    if (used.has(f.path)) continue;
    const n = numericSuffix(f.name);
    if (n !== null) byNum.set(n, [...(byNum.get(n) ?? []), f]);
  }
  for (const p of pending) {
    const n = numericSuffix(p.raw.path.split(/[\\/]/).pop() ?? '') ?? p.idx;
    const cands = (byNum.get(n) ?? []).filter((f) => !used.has(f.path));
    if (cands.length === 1) {
      used.add(cands[0]!.path);
      rows.push(row(p, cands[0]!, 'number'));
    } else rows.push({ pageId: p.id, pageIdx: p.idx, pageName: baseName(p.raw.path), file: null, status: 'missing' });
  }
  rows.sort((a, b) => a.pageIdx - b.pageIdx);
  return { rows, extra: files.filter((f) => !used.has(f.path)) };
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function row(p: LocalPage, f: ImageInfo, rule: 'name' | 'number'): ImportRow {
  const ok = f.width === p.width && f.height === p.height;
  return { pageId: p.id, pageIdx: p.idx, pageName: baseName(p.raw.path), file: f, status: ok ? 'matched' : 'size_mismatch', rule };
}

/** Rows that «Применить» binds. */
export const applicable = (plan: ImportPlan) => plan.rows.filter((r) => r.status === 'matched' && r.file);

/** Natural order of page files: "2.png" before "10.png". */
export function naturalSort<T extends { name: string }>(items: readonly T[]): T[] {
  const coll = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return [...items].sort((a, b) => coll.compare(a.name, b.name));
}
