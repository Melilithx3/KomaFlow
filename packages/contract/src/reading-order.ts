import type { Box, ReadingDirection } from './common.js';

export interface OrderItem {
  id: string;
  box: Box;
}

/**
 * Automatic reading order (docs/05-desktop-sidecar.md §2): boxes are grouped into rows when they
 * overlap vertically by more than 50% of the smaller height; rows go top to bottom, inside a row
 * right-to-left for `rtl` and left-to-right for `ltr`. Returns ids in reading order.
 */
export function autoReadingOrder(items: readonly OrderItem[], direction: ReadingDirection): string[] {
  const sorted = [...items].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x || cmp(a.id, b.id));
  const rows: OrderItem[][] = [];
  for (const it of sorted) {
    const row = rows.find((r) => r.some((m) => verticalOverlapRatio(m.box, it.box) > 0.5));
    if (row) row.push(it);
    else rows.push([it]);
  }
  const top = (r: OrderItem[]) => Math.min(...r.map((m) => m.box.y));
  rows.sort((a, b) => top(a) - top(b));
  const sign = direction === 'rtl' ? -1 : 1;
  return rows.flatMap((r) =>
    [...r]
      .sort((a, b) => sign * (cx(a.box) - cx(b.box)) || a.box.y - b.box.y || cmp(a.id, b.id))
      .map((m) => m.id),
  );
}

function cx(b: Box): number {
  return b.x + b.w / 2;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Vertical overlap divided by the height of the smaller box. */
export function verticalOverlapRatio(a: Box, b: Box): number {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (overlap <= 0) return 0;
  return overlap / Math.min(a.h, b.h);
}
