/**
 * Pixel operations of the clean editor (ADR 0015). Pure functions on RGBA buffers (same layout as
 * ImageData), so they run in the WebView and in tests. Every operation returns the touched rectangle,
 * which the editor uses for partial redraws and undo snapshots.
 */
import type { Box } from '@komaflow/contract';

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 8 bit, not premultiplied. */
  data: Uint8ClampedArray;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RGBA = [number, number, number, number];

export const createRaster = (width: number, height: number, fill: RGBA = [0, 0, 0, 0]): Raster => {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill.some((v) => v !== 0)) for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width, height, data };
};

export const cloneRaster = (r: Raster): Raster => ({ width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) });

export function clipRect(r: Rect, width: number, height: number): Rect | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.w));
  const y1 = Math.min(height, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Copy of a rectangle (for undo). */
export function readRegion(r: Raster, rect: Rect): Raster {
  const out = createRaster(rect.w, rect.h);
  for (let y = 0; y < rect.h; y++) {
    const s = ((rect.y + y) * r.width + rect.x) * 4;
    out.data.set(r.data.subarray(s, s + rect.w * 4), y * rect.w * 4);
  }
  return out;
}

export function writeRegion(r: Raster, rect: Rect, patch: Raster): void {
  for (let y = 0; y < rect.h; y++) {
    const d = ((rect.y + y) * r.width + rect.x) * 4;
    r.data.set(patch.data.subarray(y * rect.w * 4, (y + 1) * rect.w * 4), d);
  }
}

/** Brush coverage 0..1 at distance `d` from the centre: solid core, smooth falloff (hardness 0..1). */
export function brushAlpha(d: number, radius: number, hardness: number): number {
  if (d >= radius) return 0;
  const core = radius * Math.min(0.999, Math.max(0, hardness));
  if (d <= core) return 1;
  const t = (d - core) / (radius - core);
  return 1 - t * t * (3 - 2 * t);
}

export interface Brush {
  radius: number;
  hardness: number;
  /** 0..1 */
  opacity: number;
}

/** Paints a round dab of `color`. */
export function paintDab(r: Raster, cx: number, cy: number, b: Brush, color: RGBA): Rect | null {
  return dabOp(r, cx, cy, b, (i, a) => blendPixel(r.data, i, color[0], color[1], color[2], (color[3] / 255) * a));
}

/** Eraser: brings back pixels of `source` (the raw page). */
export function restoreDab(r: Raster, source: Raster, cx: number, cy: number, b: Brush): Rect | null {
  return dabOp(r, cx, cy, b, (i, a) => blendPixel(r.data, i, source.data[i]!, source.data[i + 1]!, source.data[i + 2]!, a));
}

/**
 * Brush on a transparent layer (notes for the typer): source-over with the brush alpha, so strokes keep
 * soft edges and the layer stays transparent elsewhere.
 */
export function paintDabOver(r: Raster, cx: number, cy: number, b: Brush, color: RGBA): Rect | null {
  const ca = color[3] / 255;
  return dabOp(r, cx, cy, b, (i, a) => {
    const d = r.data;
    const sa = a * ca;
    const da = d[i + 3]! / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    for (let c = 0; c < 3; c++) d[i + c] = (color[c]! * sa + d[i + c]! * da * (1 - sa)) / oa;
    d[i + 3] = oa * 255;
  });
}

/** Eraser on a transparent layer: lowers alpha under the brush. */
export function eraseDabAlpha(r: Raster, cx: number, cy: number, b: Brush): Rect | null {
  return dabOp(r, cx, cy, b, (i, a) => {
    r.data[i + 3] = r.data[i + 3]! * (1 - a);
  });
}

/** True when any pixel of the layer is not fully transparent. */
export function hasVisiblePixels(r: Raster): boolean {
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i]! > 0) return true;
  return false;
}

/** Clone stamp: copies from `source` (a snapshot taken at stroke start) at offset (dx, dy). */
export function cloneDab(r: Raster, source: Raster, cx: number, cy: number, dx: number, dy: number, b: Brush): Rect | null {
  return dabOp(r, cx, cy, b, (i, a, x, y) => {
    const sx = x + dx;
    const sy = y + dy;
    if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) return;
    const j = (sy * source.width + sx) * 4;
    blendPixel(r.data, i, source.data[j]!, source.data[j + 1]!, source.data[j + 2]!, a);
  });
}

/** Mask dab: 255 inside (or 0 when erasing the mask). Mask is one byte per pixel. */
export function maskDab(mask: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number, erase: boolean): Rect | null {
  const rect = clipRect({ x: cx - radius, y: cy - radius, w: radius * 2 + 1, h: radius * 2 + 1 }, width, height);
  if (!rect) return null;
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius) mask[y * width + x] = erase ? 0 : 255;
    }
  return rect;
}

function dabOp(r: Raster, cx: number, cy: number, b: Brush, fn: (i: number, a: number, x: number, y: number) => void): Rect | null {
  const rect = clipRect({ x: cx - b.radius, y: cy - b.radius, w: b.radius * 2 + 1, h: b.radius * 2 + 1 }, r.width, r.height);
  if (!rect) return null;
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const a = brushAlpha(Math.hypot(x + 0.5 - cx, y + 0.5 - cy), b.radius, b.hardness) * b.opacity;
      if (a > 0) fn((y * r.width + x) * 4, a, x, y);
    }
  return rect;
}

function blendPixel(d: Uint8ClampedArray, i: number, r: number, g: number, b: number, a: number) {
  d[i] = d[i]! + (r - d[i]!) * a;
  d[i + 1] = d[i + 1]! + (g - d[i + 1]!) * a;
  d[i + 2] = d[i + 2]! + (b - d[i + 2]!) * a;
  d[i + 3] = 255;
}

/** Points along a stroke segment, spaced by a fraction of the radius (continuous lines). */
export function strokePoints(x0: number, y0: number, x1: number, y1: number, radius: number): Array<[number, number]> {
  const step = Math.max(1, radius * 0.25);
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
  const out: Array<[number, number]> = [];
  for (let i = 1; i <= n; i++) out.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  return out;
}

export function pixelAt(r: Raster, x: number, y: number): RGBA {
  const i = (Math.floor(y) * r.width + Math.floor(x)) * 4;
  return [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!, r.data[i + 3]!];
}

/** Flood fill of the area connected to (x, y) whose colour is within `tolerance` (0..255, per channel max). */
export function floodFill(r: Raster, x: number, y: number, color: RGBA, tolerance: number): Rect | null {
  const { width, height, data } = r;
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  const seed = pixelAt(r, sx, sy);
  const near = (i: number) =>
    Math.abs(data[i]! - seed[0]) <= tolerance && Math.abs(data[i + 1]! - seed[1]) <= tolerance && Math.abs(data[i + 2]! - seed[2]) <= tolerance;
  const seen = new Uint8Array(width * height);
  const stack = [sy * width + sx];
  let minX = sx;
  let minY = sy;
  let maxX = sx;
  let maxY = sy;
  const hits: number[] = [];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen[p]) continue;
    seen[p] = 1;
    if (!near(p * 4)) continue;
    hits.push(p);
    const px = p % width;
    const py = (p - px) / width;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    if (px > 0) stack.push(p - 1);
    if (px < width - 1) stack.push(p + 1);
    if (py > 0) stack.push(p - width);
    if (py < height - 1) stack.push(p + width);
  }
  // paint after the search so the tolerance compares against the original colours
  for (const p of hits) data.set(color, p * 4);
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const lum = (d: Uint8ClampedArray, i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;

/**
 * Text mask for auto-clean: inside the box (slightly inset to skip the bubble outline) pixels darker than
 * `threshold` are text; the mask grows by `dilate` px so anti-aliased edges are erased too.
 * Writes 255 into `mask` (one byte per pixel); returns the touched rectangle.
 */
export function textMask(r: Raster, box: Box, mask: Uint8Array, opts: { threshold: number; dilate: number; inset: number }): Rect | null {
  const ix = Math.round(box.w * opts.inset);
  const iy = Math.round(box.h * opts.inset);
  const area = clipRect({ x: box.x + ix, y: box.y + iy, w: box.w - 2 * ix, h: box.h - 2 * iy }, r.width, r.height);
  if (!area) return null;
  const core = new Uint8Array(area.w * area.h);
  let any = false;
  for (let y = 0; y < area.h; y++)
    for (let x = 0; x < area.w; x++) {
      if (lum(r.data, ((area.y + y) * r.width + area.x + x) * 4) < opts.threshold) {
        core[y * area.w + x] = 1;
        any = true;
      }
    }
  if (!any) return null;
  const d = Math.max(0, Math.round(opts.dilate));
  const out = clipRect({ x: area.x - d, y: area.y - d, w: area.w + 2 * d, h: area.h + 2 * d }, r.width, r.height)!;
  for (let y = 0; y < area.h; y++)
    for (let x = 0; x < area.w; x++) {
      if (!core[y * area.w + x]) continue;
      for (let yy = -d; yy <= d; yy++)
        for (let xx = -d; xx <= d; xx++) {
          if (xx * xx + yy * yy > d * d) continue;
          const gx = area.x + x + xx;
          const gy = area.y + y + yy;
          if (gx >= 0 && gy >= 0 && gx < r.width && gy < r.height) mask[gy * r.width + gx] = 255;
        }
    }
  return out;
}

export function maskBounds(mask: Uint8Array, width: number, height: number): Rect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (mask[y * width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Copies pixels of `result` into `r` where the mask is set (LaMa output pasted only under the mask). */
export function applyMasked(r: Raster, result: Raster, mask: Uint8Array): Rect | null {
  if (result.width !== r.width || result.height !== r.height) throw new Error('result size differs from the page');
  const rect = maskBounds(mask, r.width, r.height);
  if (!rect) return null;
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const p = y * r.width + x;
      if (mask[p]) r.data.set(result.data.subarray(p * 4, p * 4 + 4), p * 4);
    }
  return rect;
}

/** Mask as an RGBA raster (white = erase) for PNG encoding. */
export function maskToRaster(mask: Uint8Array, width: number, height: number): Raster {
  const r = createRaster(width, height);
  for (let p = 0; p < mask.length; p++) {
    const v = mask[p] ? 255 : 0;
    r.data[p * 4] = v;
    r.data[p * 4 + 1] = v;
    r.data[p * 4 + 2] = v;
    r.data[p * 4 + 3] = 255;
  }
  return r;
}

// ---------------------------------------------------------------- undo history of pixel edits

interface Step {
  rect: Rect;
  before: Raster;
  after: Raster | null;
}

/** Undo/redo by rectangles: memory-bounded (oldest steps are dropped). */
export class PixelHistory {
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes = 400 * 1024 * 1024) {}

  /** Call before changing `rect` of `r` (single operations: fill, LaMa result). */
  begin(r: Raster, rect: Rect): void {
    this.push(rect, readRegion(r, rect));
  }

  /** Records a finished stroke: `before` holds the pixels of `rect` from before the stroke. */
  push(rect: Rect, before: Raster): void {
    this.undoStack.push({ rect, before, after: null });
    this.bytes += before.data.length;
    this.redoStack = [];
    while (this.bytes > this.maxBytes && this.undoStack.length > 1) {
      const s = this.undoStack.shift()!;
      this.bytes -= s.before.data.length;
    }
  }

  undo(r: Raster): Rect | null {
    const s = this.undoStack.pop();
    if (!s) return null;
    s.after = readRegion(r, s.rect);
    writeRegion(r, s.rect, s.before);
    this.redoStack.push(s);
    return s.rect;
  }

  redo(r: Raster): Rect | null {
    const s = this.redoStack.pop();
    if (!s || !s.after) return null;
    writeRegion(r, s.rect, s.after);
    this.undoStack.push(s);
    return s.rect;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.bytes = 0;
  }
}
