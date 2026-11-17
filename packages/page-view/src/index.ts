import type { Box, ObjectType, TranslationState } from '@komaflow/contract';
import { boxContainsPoint } from '@komaflow/contract';

/**
 * Object type palette shared by web and desktop (docs/05-desktop-sidecar.md §2).
 * Each type also has its own label shape so colour is never the only cue.
 */
export const TYPE_STYLE: Record<ObjectType, { color: string; label: string; short: string; shape: 'circle' | 'square' | 'diamond' | 'tag' }> = {
  bubble: { color: '#2563eb', label: 'Пузырь', short: 'П', shape: 'circle' },
  sfx: { color: '#dc2626', label: 'SFX', short: 'S', shape: 'square' },
  onomatopoeia: { color: '#d97706', label: 'Звукоподражание', short: 'З', shape: 'diamond' },
  text: { color: '#16a34a', label: 'Текст', short: 'Т', shape: 'tag' },
};

export const STATE_LABEL: Record<TranslationState, string> = {
  empty: 'Пусто',
  translated: 'Переведено',
  skipped: 'Пропустить (не переводим)',
  unreadable: 'Нечитаемо',
};

// ---------------------------------------------------------------- viewport

export interface Viewport {
  /** Screen px per image px. */
  scale: number;
  /** Screen position of the image origin. */
  x: number;
  y: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Fits an image into a view with a margin, centred. */
export function fitViewport(img: { width: number; height: number }, view: { width: number; height: number }, margin = 16): Viewport {
  const w = Math.max(1, view.width - margin * 2);
  const h = Math.max(1, view.height - margin * 2);
  const scale = clampScale(Math.min(w / img.width, h / img.height));
  return { scale, x: (view.width - img.width * scale) / 2, y: (view.height - img.height * scale) / 2 };
}

/** Zooms by `factor` keeping the screen point (px, py) fixed. */
export function zoomAt(v: Viewport, factor: number, px: number, py: number): Viewport {
  const scale = clampScale(v.scale * factor);
  const k = scale / v.scale;
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

export const screenToImage = (v: Viewport, sx: number, sy: number) => ({ x: (sx - v.x) / v.scale, y: (sy - v.y) / v.scale });
export const imageToScreen = (v: Viewport, ix: number, iy: number) => ({ x: ix * v.scale + v.x, y: iy * v.scale + v.y });

/** Pans so that the box centre is in the view centre (scale unchanged). */
export function centerOn(v: Viewport, b: Box, view: { width: number; height: number }): Viewport {
  return { ...v, x: view.width / 2 - (b.x + b.w / 2) * v.scale, y: view.height / 2 - (b.y + b.h / 2) * v.scale };
}

/** Image point → coordinates relative to the box centre in the box's own (unrotated) frame. */
export function toBoxFrame(b: Box, rotation: number, ix: number, iy: number): { x: number; y: number } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const a = (-rotation * Math.PI) / 180;
  const dx = ix - cx;
  const dy = iy - cy;
  return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
}

export function pointInBox(b: Box, rotation: number, ix: number, iy: number): boolean {
  if (!rotation) return boxContainsPoint(b, ix, iy);
  const p = toBoxFrame(b, rotation, ix, iy);
  return Math.abs(p.x) <= b.w / 2 && Math.abs(p.y) <= b.h / 2;
}

/** Corners of a (rotated) box in image coordinates: top-left, top-right, bottom-right, bottom-left. */
export function boxCorners(b: Box, rotation = 0): Array<{ x: number; y: number }> {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const a = (rotation * Math.PI) / 180;
  return [
    [-b.w / 2, -b.h / 2],
    [b.w / 2, -b.h / 2],
    [b.w / 2, b.h / 2],
    [-b.w / 2, b.h / 2],
  ].map(([x, y]) => ({ x: cx + x! * Math.cos(a) - y! * Math.sin(a), y: cy + x! * Math.sin(a) + y! * Math.cos(a) }));
}

/** Topmost (smallest) box under an image point; null when none. Rotation is respected. */
export function hitTest<T extends { id: string; box: Box; rotation?: number }>(items: readonly T[], ix: number, iy: number): T | null {
  let best: T | null = null;
  for (const it of items) {
    if (!pointInBox(it.box, it.rotation ?? 0, ix, iy)) continue;
    if (!best || it.box.w * it.box.h < best.box.w * best.box.h) best = it;
  }
  return best;
}

/**
 * Where the number badge goes: outside the box so it never covers the text — above its top-left
 * corner, or to the left when there is no room above, or inside as the last resort (page edge).
 * Returns the badge centre in image coordinates.
 */
export function labelAnchor(b: Box, rotation: number, size: number): { x: number; y: number } {
  const tl = boxCorners(b, rotation).reduce((m, c) => (c.y < m.y || (c.y === m.y && c.x < m.x) ? c : m));
  const r = size * 0.62;
  if (tl.y - 2 * r - 2 >= 0) return { x: Math.max(r, tl.x + r), y: tl.y - r - 2 };
  if (tl.x - 2 * r - 2 >= 0) return { x: tl.x - r - 2, y: Math.max(r, tl.y + r) };
  return { x: tl.x + r + 2, y: tl.y + r + 2 };
}

// ---------------------------------------------------------------- wheel & trackpad

export type WheelAction = { kind: 'pan'; dx: number; dy: number } | { kind: 'zoom'; factor: number };

/**
 * Wheel / trackpad mapping (the same in web and desktop):
 * wheel → vertical pan; Shift+wheel → horizontal pan; Ctrl+wheel (and trackpad pinch, which browsers
 * report as Ctrl+wheel) → zoom; two-finger trackpad scroll → free pan (deltaX + deltaY).
 */
export function wheelAction(e: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): WheelAction {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * k;
  const dy = e.deltaY * k;
  if (e.ctrlKey || e.metaKey) return { kind: 'zoom', factor: Math.exp(-Math.max(-50, Math.min(50, dy)) * 0.005) };
  if (e.shiftKey && dx === 0) return { kind: 'pan', dx: -dy, dy: 0 };
  return { kind: 'pan', dx: -dx, dy: -dy };
}

// ---------------------------------------------------------------- letter case of OCR text

export type CaseMode = 'sentence' | 'lower' | 'upper';

/**
 * OCR returns English lettering in CAPS; «как в предложении» lowers everything and capitalises the
 * first letter of each sentence and the pronoun "I" (I, I'm, I'll…). Other scripts are unaffected.
 */
export function changeCase(text: string, mode: CaseMode): string {
  if (mode === 'upper') return text.toLocaleUpperCase();
  const lower = text.toLocaleLowerCase();
  if (mode === 'lower') return lower;
  let start = true;
  let out = '';
  for (const ch of lower) {
    if (start && /\p{L}/u.test(ch)) {
      out += ch.toLocaleUpperCase();
      start = false;
    } else {
      out += ch;
      if (/[.!?…]/.test(ch)) start = true;
    }
  }
  return out.replace(/(^|[^\p{L}])i(?=$|[^\p{L}])/gu, '$1I');
}

// ---------------------------------------------------------------- copy for the typer

export interface CopyItem {
  order: number;
  translation: string;
  state: TranslationState;
}

/**
 * "Копировать всё" (docs/06-web.md §1.4): one paragraph per object in reading order, `1. текст`;
 * skipped / unreadable / empty are marked in parentheses.
 */
export function formatCopyAll(items: readonly CopyItem[]): string {
  return [...items]
    .sort((a, b) => a.order - b.order)
    .map((o) => {
      const t = o.translation.trim();
      if (o.state === 'skipped') return `${o.order}. (пропущено)${t ? ` ${t}` : ''}`;
      if (o.state === 'unreadable') return `${o.order}. (нечитаемо)${t ? ` ${t}` : ''}`;
      if (!t) return `${o.order}. (пусто)`;
      return `${o.order}. ${t}`;
    })
    .join('\n\n');
}
export * from './translation-json.js';
