import type { Box } from './common.js';

export interface Size {
  width: number;
  height: number;
}

export function isValidBox(b: Box): boolean {
  return [b.x, b.y, b.w, b.h].every(Number.isInteger) && b.w >= 1 && b.h >= 1;
}

/** Box lies entirely within the page. */
export function boxInsidePage(b: Box, page: Size): boolean {
  return isValidBox(b) && b.x >= 0 && b.y >= 0 && b.x + b.w <= page.width && b.y + b.h <= page.height;
}

/**
 * Sanity limit for stored geometry (ADR 0018): a box may stick out of the page or lie outside it, e.g. a
 * rotated box at the page edge, but stays within two page sizes around the page.
 */
export function boxWithinReach(b: Box, page: Size): boolean {
  return isValidBox(b) && b.x >= -2 * page.width && b.y >= -2 * page.height && b.x + b.w <= 3 * page.width && b.y + b.h <= 3 * page.height;
}

/** Integer pixels, at least 1x1, no clamping into the page (manual geometry, ADR 0018). */
export function roundBox(b: Box): Box {
  const x0 = Math.round(b.x);
  const y0 = Math.round(b.y);
  return { x: x0, y: y0, w: Math.max(1, Math.round(b.x + b.w) - x0), h: Math.max(1, Math.round(b.y + b.h) - y0) };
}

/** Rounds to integer pixels and clamps into the page; keeps at least 1x1. */
export function clampBox(b: Box, page: Size): Box {
  const x0 = Math.min(Math.max(Math.round(b.x), 0), page.width - 1);
  const y0 = Math.min(Math.max(Math.round(b.y), 0), page.height - 1);
  const x1 = Math.min(Math.max(Math.round(b.x + b.w), x0 + 1), page.width);
  const y1 = Math.min(Math.max(Math.round(b.y + b.h), y0 + 1), page.height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Normalises a box given by two arbitrary corners (e.g. while drawing). */
export function boxFromPoints(ax: number, ay: number, bx: number, by: number): Box {
  const x = Math.min(ax, bx);
  const y = Math.min(ay, by);
  return { x, y, w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

export function boxesEqual(a: Box | null | undefined, b: Box | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export function boxContainsPoint(b: Box, px: number, py: number): boolean {
  return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
}

export function boxCenter(b: Box): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Shrinks a box by a fraction of each side on every edge (text padding). */
export function insetBox(b: Box, fraction: number): Box {
  const dx = Math.floor(b.w * fraction);
  const dy = Math.floor(b.h * fraction);
  return { x: b.x + dx, y: b.y + dy, w: Math.max(1, b.w - 2 * dx), h: Math.max(1, b.h - 2 * dy) };
}
