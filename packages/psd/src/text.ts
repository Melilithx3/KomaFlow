import type { Box, ObjectType, PsdSettings, TranslationState } from '@komaflow/contract';
import { insetBox } from '@komaflow/contract';
import type { Layer } from 'ag-psd';

export interface TextObject {
  id: string;
  order: number;
  type: ObjectType;
  box: Box;
  textBox?: Box | null;
  rotation?: number;
  translation: string;
  state: TranslationState;
}

/** Only translated objects with text get a layer (docs/04-psd.md §3). */
export const wantsTextLayer = (o: TextObject) => o.state === 'translated' && o.translation.trim() !== '';

/** `07_bubble` */
export const textLayerName = (o: TextObject) => `${String(o.order).padStart(2, '0')}_${o.type}`;

/** Text area: `text_box`, else the box shrunk by `text_padding[type]`, clipped to the page (in the box frame for rotation). */
export function textRect(o: TextObject, s: PsdSettings, page: { width: number; height: number }): Box {
  if (o.textBox) return o.textBox;
  const inset = insetBox(o.box, s.text_padding[o.type]);
  if (o.rotation) return inset; // a rotated box is positioned by its transform, not clipped
  const x0 = Math.max(0, inset.x);
  const y0 = Math.max(0, inset.y);
  const x1 = Math.min(page.width, inset.x + inset.w);
  const y1 = Math.min(page.height, inset.y + inset.h);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** Paragraphs from the translation: trimmed, `\n` separates paragraphs. */
export const cleanText = (t: string) =>
  t
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();

/** Word wrap with a fixed average glyph width; returns the number of lines. */
export function countLines(text: string, maxWidth: number, size: number): number {
  const avg = 0.55 * size;
  let lines = 0;
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines++;
      continue;
    }
    let cur = 0;
    lines++;
    for (const w of words) {
      const ww = w.length * avg;
      const add = cur === 0 ? ww : avg + ww;
      if (cur > 0 && cur + add > maxWidth) {
        lines++;
        cur = ww;
      } else cur += add;
      // a single word longer than the line wraps by characters
      while (cur > maxWidth && ww > maxWidth) {
        lines++;
        cur -= maxWidth;
      }
    }
  }
  return lines;
}

/** Font size heuristic (docs/04-psd.md §3): start at base size, shrink until it fits, not below the minimum. */
export function fitFontSize(text: string, rect: Box, base: number, min: number, lineHeight: number): number {
  let size = base;
  while (size > min && countLines(text, rect.w, size) * size * lineHeight > rect.h) size--;
  return Math.max(min, size);
}

const hex = (c: string) => ({ r: parseInt(c.slice(1, 3), 16), g: parseInt(c.slice(3, 5), 16), b: parseInt(c.slice(5, 7), 16) });

/**
 * Editable paragraph (box) text layer. Coordinates: the text frame starts at the rect's top-left corner,
 * rotated with the object around the box centre; `boxBounds` is the rect size in the text frame.
 */
export function buildTextLayer(o: TextObject, s: PsdSettings, page: { width: number; height: number }): Layer {
  const rect = textRect(o, s, page);
  const text = cleanText(o.translation);
  const px = fitFontSize(text, rect, s.base_font_size[o.type], s.min_font_size, s.line_height);
  const toPt = 72 / s.dpi;
  const rot = ((o.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  // rect top-left rotated around the object's box centre
  const cx = o.box.x + o.box.w / 2;
  const cy = o.box.y + o.box.h / 2;
  const dx = rect.x - cx;
  const dy = rect.y - cy;
  const tx = cx + dx * cos - dy * sin;
  const ty = cy + dx * sin + dy * cos;
  // axis-aligned bounds of the (rotated) rect for the layer record
  const xs = [0, rect.w, rect.w, 0].map((x, i) => tx + x * cos - [0, 0, rect.h, rect.h][i]! * sin);
  const ys = [0, rect.w, rect.w, 0].map((x, i) => ty + x * sin + [0, 0, rect.h, rect.h][i]! * cos);
  const units = (v: number) => ({ units: 'Pixels' as const, value: v });
  return {
    name: textLayerName(o),
    top: Math.floor(Math.min(...ys)),
    left: Math.floor(Math.min(...xs)),
    bottom: Math.ceil(Math.max(...ys)),
    right: Math.ceil(Math.max(...xs)),
    text: {
      text,
      transform: [cos, sin, -sin, cos, tx, ty],
      shapeType: 'box',
      boxBounds: [0, 0, rect.w, rect.h],
      bounds: { left: units(0), top: units(0), right: units(rect.w), bottom: units(rect.h) },
      boundingBox: { left: units(0), top: units(0), right: units(rect.w), bottom: units(rect.h) },
      antiAlias: 'smooth',
      orientation: 'horizontal',
      style: {
        font: { name: s.default_font },
        fontSize: px * toPt,
        autoLeading: false,
        leading: px * s.line_height * toPt,
        fillColor: hex(s.text_color),
      },
      paragraphStyle: { justification: s.justification },
    },
  };
}
