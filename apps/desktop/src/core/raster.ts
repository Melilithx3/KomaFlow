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

/**
 * Brush coverage 0..1 at distance `d` from the centre (hardness 0..1). The soft edge widens
 * non-linearly as hardness drops, so the top of the range stays distinguishable (0.9 vs 1.0), and the
 * falloff gets a higher power at low hardness: 0 is a feathery brush, 1 a hard edge with ~1 px of
 * anti-aliasing.
 */
export function brushAlpha(d: number, radius: number, hardness: number): number {
  if (d >= radius) return 0;
  const h = Math.min(1, Math.max(0, hardness));
  const soft = Math.max(Math.min(1, radius) * 0.75, radius * Math.pow(1 - h, 0.7));
  const core = radius - soft;
  if (d <= core) return 1;
  const t = (d - core) / soft;
  const s = 1 - t * t * (3 - 2 * t);
  return Math.pow(s, 1 + 2 * (1 - h) * (1 - h));
}

export interface Brush {
  radius: number;
  hardness: number;
  /** 0..1 */
  opacity: number;
}

/**
 * One continuous stroke: the layer as it was at stroke start and the highest coverage each pixel got so
 * far (0..255). Dabs inside a stroke raise coverage to a maximum instead of adding up, so holding a soft
 * brush in place or moving slowly does not darken the spot (no airbrush build-up). A new stroke starts
 * from the current pixels and may build up over the previous one.
 */
export interface StrokeState {
  origin: Raster;
  cover: Uint8Array;
}

export const beginStroke = (r: Raster): StrokeState => ({ origin: cloneRaster(r), cover: new Uint8Array(r.width * r.height) });

/** Paints a round dab of `color`. Within a stroke (`s`) coverage does not build up. */
export function paintDab(r: Raster, cx: number, cy: number, b: Brush, color: RGBA, s?: StrokeState): Rect | null {
  return dabOp(r, cx, cy, b, s, (i, a, base) => blendPixel(r.data, base, i, color[0], color[1], color[2], (color[3] / 255) * a));
}

/** Eraser: brings back pixels of `source` (the raw page). */
export function restoreDab(r: Raster, source: Raster, cx: number, cy: number, b: Brush, s?: StrokeState): Rect | null {
  return dabOp(r, cx, cy, b, s, (i, a, base) => blendPixel(r.data, base, i, source.data[i]!, source.data[i + 1]!, source.data[i + 2]!, a));
}

/**
 * Brush on a transparent layer (notes for the typer): source-over with the brush alpha, so strokes keep
 * soft edges and the layer stays transparent elsewhere.
 */
export function paintDabOver(r: Raster, cx: number, cy: number, b: Brush, color: RGBA, s?: StrokeState): Rect | null {
  const ca = color[3] / 255;
  return dabOp(r, cx, cy, b, s, (i, a, base) => {
    const d = r.data;
    const sa = a * ca;
    const da = base[i + 3]! / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    for (let c = 0; c < 3; c++) d[i + c] = (color[c]! * sa + base[i + c]! * da * (1 - sa)) / oa;
    d[i + 3] = oa * 255;
  });
}

/** Eraser on a transparent layer: lowers alpha under the brush. */
export function eraseDabAlpha(r: Raster, cx: number, cy: number, b: Brush, s?: StrokeState): Rect | null {
  return dabOp(r, cx, cy, b, s, (i, a, base) => {
    r.data[i + 3] = base[i + 3]! * (1 - a);
  });
}

/** True when any pixel of the layer is not fully transparent. */
export function hasVisiblePixels(r: Raster): boolean {
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i]! > 0) return true;
  return false;
}

/** Clone stamp: copies from `source` (a snapshot taken at stroke start) at offset (dx, dy). */
export function cloneDab(r: Raster, source: Raster, cx: number, cy: number, dx: number, dy: number, b: Brush, s?: StrokeState): Rect | null {
  return dabOp(r, cx, cy, b, s, (i, a, base, x, y) => {
    const sx = x + dx;
    const sy = y + dy;
    if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) return;
    const j = (sy * source.width + sx) * 4;
    blendPixel(r.data, base, i, source.data[j]!, source.data[j + 1]!, source.data[j + 2]!, a);
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

/**
 * Runs `fn` for every pixel under a round dab with the effective alpha and the array to blend from: the
 * stroke origin when a stroke state is given (alpha = max coverage within the stroke x opacity), else the
 * current pixels (alpha accumulates: single dabs, tests).
 */
function dabOp(
  r: Raster,
  cx: number,
  cy: number,
  b: Brush,
  s: StrokeState | undefined,
  fn: (i: number, a: number, base: Uint8ClampedArray, x: number, y: number) => void,
): Rect | null {
  const rect = clipRect({ x: cx - b.radius, y: cy - b.radius, w: b.radius * 2 + 1, h: b.radius * 2 + 1 }, r.width, r.height);
  if (!rect) return null;
  const base = s ? s.origin.data : r.data;
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      let a = brushAlpha(Math.hypot(x + 0.5 - cx, y + 0.5 - cy), b.radius, b.hardness);
      if (a <= 0) continue;
      if (s) {
        const p = y * r.width + x;
        const c = Math.round(a * 255);
        if (c <= s.cover[p]!) continue;
        s.cover[p] = c;
        a = c / 255;
      }
      fn((y * r.width + x) * 4, a * b.opacity, base, x, y);
    }
  return rect;
}

function blendPixel(d: Uint8ClampedArray, base: Uint8ClampedArray, i: number, r: number, g: number, b: number, a: number) {
  d[i] = base[i]! + (r - base[i]!) * a;
  d[i + 1] = base[i + 1]! + (g - base[i + 1]!) * a;
  d[i + 2] = base[i + 2]! + (b - base[i + 2]!) * a;
  d[i + 3] = 255;
}

/** Points along a stroke segment, spaced by a fraction of the radius (continuous lines). */
export function strokePoints(x0: number, y0: number, x1: number, y1: number, radius: number): Array<[number, number]> {
  const step = Math.max(0.5, radius * 0.25);
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

export interface TextMaskOptions {
  /** Weak threshold: pixels darker than this may be text (the «порог» field). */
  threshold: number;
  /** Mask growth in px so anti-aliased edges are erased too. */
  dilate: number;
  /** Fraction of each box side skipped at the edges (bubble outline). */
  inset: number;
  /** Box rotation, degrees clockwise (ADR 0011). */
  rotation?: number;
}

/**
 * Text mask of one object for auto-clean (writes 255 into `mask`, one byte per pixel; returns the touched
 * rectangle). Pixels are classified by hysteresis instead of a single threshold: a pixel darker than
 * `threshold` counts only if its 8-connected dark region also holds «strong» pixels, much darker than the
 * box background. Letters always have such a core; JPEG ringing and block noise next to letters only
 * makes faint isolated specks, which no longer turn into stray (and then dilated) mask blobs. Faint pixels
 * touching a letter (its anti-aliased edge) stay, so no part of a letter is lost.
 */
export function textMask(r: Raster, box: Box, mask: Uint8Array, opts: TextMaskOptions): Rect | null {
  const hw = box.w / 2 - box.w * opts.inset;
  const hh = box.h / 2 - box.h * opts.inset;
  if (hw <= 0 || hh <= 0) return null;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rad = ((opts.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ex = Math.abs(hw * cos) + Math.abs(hh * sin);
  const ey = Math.abs(hw * sin) + Math.abs(hh * cos);
  const area = clipRect({ x: cx - ex, y: cy - ey, w: 2 * ex, h: 2 * ey }, r.width, r.height);
  if (!area) return null;
  const n = area.w * area.h;
  const L = new Float32Array(n).fill(-1); // -1 = outside the (rotated) box
  const hist = new Uint32Array(256);
  let count = 0;
  for (let y = 0; y < area.h; y++)
    for (let x = 0; x < area.w; x++) {
      const dx = area.x + x + 0.5 - cx;
      const dy = area.y + y + 0.5 - cy;
      if (Math.abs(dx * cos + dy * sin) > hw || Math.abs(-dx * sin + dy * cos) > hh) continue;
      const l = lum(r.data, ((area.y + y) * r.width + area.x + x) * 4);
      L[y * area.w + x] = l;
      hist[Math.min(255, Math.round(l))]!++;
      count++;
    }
  if (!count) return null;
  // background = 90th percentile of the box (the bubble paper; robust to the text itself)
  let acc = 0;
  let bg = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= count * 0.9) {
      bg = v;
      break;
    }
  }
  const weak = Math.min(opts.threshold, bg - 12);
  const strong = Math.min(weak - 40, bg - 90);
  const cls = new Uint8Array(n); // 0 none, 1 weak, 2 strong
  for (let k = 0; k < n; k++) if (L[k]! >= 0 && L[k]! < weak) cls[k] = L[k]! < strong ? 2 : 1;
  const keep = new Uint8Array(n);
  const stack: number[] = [];
  let any = false;
  for (let k = 0; k < n; k++) {
    if (cls[k] !== 2 || keep[k]) continue;
    any = true;
    keep[k] = 1;
    stack.push(k);
    while (stack.length) {
      const q = stack.pop()!;
      const qx = q % area.w;
      const qy = (q - qx) / area.w;
      for (let yy = -1; yy <= 1; yy++)
        for (let xx = -1; xx <= 1; xx++) {
          const nx = qx + xx;
          const ny = qy + yy;
          if (nx < 0 || ny < 0 || nx >= area.w || ny >= area.h) continue;
          const m = ny * area.w + nx;
          if (cls[m] && !keep[m]) {
            keep[m] = 1;
            stack.push(m);
          }
        }
    }
  }
  if (!any) return null;
  const d = Math.max(0, Math.round(opts.dilate));
  const out = clipRect({ x: area.x - d, y: area.y - d, w: area.w + 2 * d, h: area.h + 2 * d }, r.width, r.height)!;
  for (let y = 0; y < area.h; y++)
    for (let x = 0; x < area.w; x++) {
      if (!keep[y * area.w + x]) continue;
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

/**
 * Residual inspection (a hint, not a guarantee): pixels of the clean darker than their 9x9
 * neighbourhood mean by more than `sensitivity` levels, searched only where the raw had text (text masks
 * of the objects, grown by 3 px). A single leftover pixel stands out against the local mean, so it is
 * found too. Returns a per-pixel mask and the clusters (for markers visible at any zoom).
 */
export function findResiduals(
  clean: Raster,
  raw: Raster,
  objects: Array<{ box: Box; rotation?: number }>,
  opts: { sensitivity: number; threshold: number },
): { mask: Uint8Array; clusters: Rect[]; pixels: number } {
  const { width, height } = clean;
  const zone = new Uint8Array(width * height);
  for (const o of objects) textMask(raw, o.box, zone, { threshold: Math.min(250, opts.threshold + 40), dilate: 3, inset: 0, rotation: o.rotation ?? 0 });
  const out = new Uint8Array(width * height);
  const bounds = maskBounds(zone, width, height);
  if (!bounds) return { mask: out, clusters: [], pixels: 0 };
  const R = 4;
  const area = clipRect({ x: bounds.x - R, y: bounds.y - R, w: bounds.w + 2 * R, h: bounds.h + 2 * R }, width, height)!;
  const W = area.w + 1;
  const sum = new Float64Array(W * (area.h + 1));
  for (let y = 0; y < area.h; y++) {
    let row = 0;
    for (let x = 0; x < area.w; x++) {
      row += lum(clean.data, ((area.y + y) * width + area.x + x) * 4);
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1]! + row;
    }
  }
  let pixels = 0;
  for (let y = bounds.y; y < bounds.y + bounds.h; y++)
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      const p = y * width + x;
      if (!zone[p]) continue;
      const x0 = Math.max(area.x, x - R) - area.x;
      const y0 = Math.max(area.y, y - R) - area.y;
      const x1 = Math.min(area.x + area.w, x + R + 1) - area.x;
      const y1 = Math.min(area.y + area.h, y + R + 1) - area.y;
      const mean = (sum[y1 * W + x1]! - sum[y0 * W + x1]! - sum[y1 * W + x0]! + sum[y0 * W + x0]!) / ((x1 - x0) * (y1 - y0));
      if (mean - lum(clean.data, p * 4) > opts.sensitivity) {
        out[p] = 255;
        pixels++;
      }
    }
  return { mask: out, clusters: pixels ? clusterRects(out, width, height) : [], pixels };
}

/** Bounding boxes of regions of a mask; pixels closer than 4 px join one region. */
function clusterRects(mask: Uint8Array, width: number, height: number): Rect[] {
  const seen = new Uint8Array(mask.length);
  const out: Rect[] = [];
  const stack: number[] = [];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] || seen[p]) continue;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    seen[p] = 1;
    stack.push(p);
    while (stack.length) {
      const q = stack.pop()!;
      const qx = q % width;
      const qy = (q - qx) / width;
      if (qx < minX) minX = qx;
      if (qx > maxX) maxX = qx;
      if (qy < minY) minY = qy;
      if (qy > maxY) maxY = qy;
      for (let yy = -3; yy <= 3; yy++)
        for (let xx = -3; xx <= 3; xx++) {
          const nx = qx + xx;
          const ny = qy + yy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const m = ny * width + nx;
          if (mask[m] && !seen[m]) {
            seen[m] = 1;
            stack.push(m);
          }
        }
    }
    out.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
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
