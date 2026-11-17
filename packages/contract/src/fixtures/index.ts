import type { Box, ObjectType } from '../common.js';
import { sha256Hex } from '../sha256.js';
import type { SyncPage } from '../api.js';
import { Raster } from './png.js';

export { encodePng, Raster } from './png.js';

/** Deterministic UUID v7-shaped id for fixtures (timestamp 2026-01-01, counter in the tail). */
export function fixtureId(n: number): string {
  const ts = (1767225600000).toString(16).padStart(12, '0');
  const tail = n.toString(16).padStart(12, '0');
  return `${ts.slice(0, 8)}-${ts.slice(8)}-7000-8000-${tail}`;
}

export interface FixtureObject {
  id: string;
  type: ObjectType;
  box: Box;
  text_box: Box | null;
  source_text: string;
  /** Suggested translation (used by e2e/demo, never sent by sync). */
  translation: string;
}

export interface FixturePage {
  id: string;
  idx: number;
  width: number;
  height: number;
  raw: Uint8Array;
  clean: Uint8Array | null;
  notes: Uint8Array | null;
  objects: FixtureObject[];
}

const BLACK: [number, number, number, number] = [20, 20, 20, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const PAPER: [number, number, number, number] = [236, 233, 226, 255];
const RED: [number, number, number, number] = [220, 38, 38, 255];

interface Spec {
  type: ObjectType;
  box: Box;
  ja: string;
  ru: string;
}

const PAGE_SPECS: Spec[][] = [
  [
    { type: 'bubble', box: { x: 520, y: 60, w: 220, h: 260 }, ja: 'ここが噂の店か…', ru: 'Так это и есть тот самый магазин…' },
    { type: 'bubble', box: { x: 120, y: 90, w: 240, h: 200 }, ja: 'いらっしゃいませ！', ru: 'Добро пожаловать!' },
    { type: 'sfx', box: { x: 300, y: 420, w: 260, h: 140 }, ja: 'ドン', ru: 'БАМ' },
    { type: 'text', box: { x: 80, y: 980, w: 300, h: 120 }, ja: '翌日', ru: 'На следующий день' },
  ],
  [
    { type: 'bubble', box: { x: 480, y: 80, w: 260, h: 300 }, ja: 'レビューを書くぞ！\n今日も頑張ろう', ru: 'Пишем рецензию!\nСегодня тоже постараемся' },
    { type: 'onomatopoeia', box: { x: 100, y: 500, w: 180, h: 220 }, ja: 'ざわざわ', ru: 'шу-шу' },
    { type: 'bubble', box: { x: 420, y: 760, w: 300, h: 260 }, ja: '星いくつ？', ru: 'Сколько звёзд?' },
  ],
  [{ type: 'bubble', box: { x: 260, y: 300, w: 300, h: 300 }, ja: '続く', ru: 'Продолжение следует' }],
];

/**
 * Synthetic chapter: 3 pages of 800x1200 with "bubbles" (white boxes with dark text stripes on raw,
 * empty on clean). Page 3 has no clean; page 1 has notes.
 */
export function makeFixtureChapter(): FixturePage[] {
  const W = 800;
  const H = 1200;
  let n = 1;
  return PAGE_SPECS.map((specs, pi) => {
    const pageId = fixtureId(1000 + pi);
    const raw = new Raster(W, H, PAPER);
    const clean = new Raster(W, H, PAPER);
    for (const r of [raw, clean]) {
      r.frame(20, 20, W - 40, H / 2 - 30, 6, BLACK);
      r.frame(20, H / 2 + 10, W - 40, H / 2 - 30, 6, BLACK);
    }
    for (const s of specs) {
      for (const r of [raw, clean]) {
        r.rect(s.box.x, s.box.y, s.box.w, s.box.h, WHITE);
        r.frame(s.box.x, s.box.y, s.box.w, s.box.h, 4, BLACK);
      }
      const lines = Math.max(1, Math.floor((s.box.h - 40) / 36));
      for (let l = 0; l < Math.min(lines, 4); l++) {
        raw.rect(s.box.x + 30, s.box.y + 30 + l * 36, s.box.w - 60, 14, BLACK);
      }
    }
    let notes: Uint8Array | null = null;
    if (pi === 0) {
      const nr = new Raster(W, H, [0, 0, 0, 0]);
      const b = specs[2]!.box;
      nr.frame(b.x - 10, b.y - 10, b.w + 20, b.h + 20, 5, RED);
      notes = nr.png();
    }
    return {
      id: pageId,
      idx: pi + 1,
      width: W,
      height: H,
      raw: raw.png(),
      clean: pi === 2 ? null : clean.png(),
      notes,
      objects: specs.map((s) => ({
        id: fixtureId(n++),
        type: s.type,
        box: s.box,
        text_box: null,
        source_text: s.ja,
        translation: s.ru,
      })),
    };
  });
}

/** Builds a sync payload page for a fixture page (as the desktop would). */
export function fixtureSyncPage(p: FixturePage, base_markup_rev: number | null = null): SyncPage {
  return {
    id: p.id,
    idx: p.idx,
    width: p.width,
    height: p.height,
    raw_hash: sha256Hex(p.raw),
    clean_hash: p.clean ? sha256Hex(p.clean) : null,
    notes_hash: p.notes ? sha256Hex(p.notes) : null,
    thumb_hash: null,
    base_markup_rev,
    objects: p.objects.map((o) => ({ id: o.id, type: o.type, box: o.box, text_box: o.text_box, source_text: o.source_text })),
  };
}
