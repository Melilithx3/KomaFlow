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

/** Topmost (smallest) box under an image point; null when none. */
export function hitTest<T extends { id: string; box: Box }>(items: readonly T[], ix: number, iy: number): T | null {
  let best: T | null = null;
  for (const it of items) {
    if (!boxContainsPoint(it.box, ix, iy)) continue;
    if (!best || it.box.w * it.box.h < best.box.w * best.box.h) best = it;
  }
  return best;
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
