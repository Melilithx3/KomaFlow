import { describe, expect, it } from 'vitest';
import {
  applyMasked,
  brushAlpha,
  cloneDab,
  eraseDabAlpha,
  hasVisiblePixels,
  paintDabOver,
  cloneRaster,
  createRaster,
  floodFill,
  maskBounds,
  maskDab,
  paintDab,
  PixelHistory,
  pixelAt,
  readRegion,
  restoreDab,
  strokePoints,
  textMask,
} from '../src/core/raster.js';

const brush = { radius: 5, hardness: 1, opacity: 1 };

describe('raster tools', () => {
  it('brush alpha: solid core, soft edge, zero outside', () => {
    expect(brushAlpha(0, 10, 0.5)).toBe(1);
    expect(brushAlpha(7.5, 10, 0.5)).toBeGreaterThan(0);
    expect(brushAlpha(7.5, 10, 0.5)).toBeLessThan(1);
    expect(brushAlpha(10, 10, 0.5)).toBe(0);
  });

  it('paint dab colours a disc and reports its rect; eraser brings raw back', () => {
    const raw = createRaster(40, 40, [10, 20, 30, 255]);
    const r = cloneRaster(raw);
    const rect = paintDab(r, 20, 20, brush, [255, 255, 255, 255]);
    expect(rect).toEqual({ x: 15, y: 15, w: 11, h: 11 });
    expect(pixelAt(r, 20, 20)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(r, 2, 2)).toEqual([10, 20, 30, 255]);
    restoreDab(r, raw, 20, 20, brush);
    expect(pixelAt(r, 20, 20)).toEqual([10, 20, 30, 255]);
    expect(paintDab(r, -100, -100, brush, [0, 0, 0, 255])).toBeNull();
  });

  it('clone stamp copies from the offset source', () => {
    const r = createRaster(40, 40, [0, 0, 0, 255]);
    paintDab(r, 30, 30, { radius: 3, hardness: 1, opacity: 1 }, [200, 0, 0, 255]);
    const src = cloneRaster(r);
    cloneDab(r, src, 10, 10, 20, 20, { radius: 2, hardness: 1, opacity: 1 });
    expect(pixelAt(r, 10, 10)).toEqual([200, 0, 0, 255]);
  });

  it('flood fill stays inside the outline, within tolerance', () => {
    const r = createRaster(20, 20, [250, 250, 250, 255]);
    for (let i = 0; i < 20; i++) r.data.set([0, 0, 0, 255], (10 * 20 + i) * 4); // horizontal wall at y=10
    r.data.set([245, 245, 245, 255], (3 * 20 + 3) * 4); // near-white noise
    const rect = floodFill(r, 1, 1, [255, 0, 0, 255], 10);
    expect(rect).toEqual({ x: 0, y: 0, w: 20, h: 10 });
    expect(pixelAt(r, 3, 3)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(r, 5, 15)).toEqual([250, 250, 250, 255]);
  });

  it('text mask picks dark strokes inside the box (inset skips the outline) and dilates', () => {
    const r = createRaster(50, 50, [255, 255, 255, 255]);
    for (let x = 0; x < 50; x++) r.data.set([0, 0, 0, 255], (5 * 50 + x) * 4); // outline row at y=5 (box edge)
    for (let x = 20; x < 30; x++) r.data.set([0, 0, 0, 255], (25 * 50 + x) * 4); // "text"
    const mask = new Uint8Array(50 * 50);
    textMask(r, { x: 5, y: 5, w: 40, h: 40 }, mask, { threshold: 128, dilate: 2, inset: 0.05 });
    expect(mask[25 * 50 + 25]).toBe(255);
    expect(mask[27 * 50 + 25]).toBe(255); // dilated
    expect(mask[5 * 50 + 25]).toBe(0); // outline excluded
    expect(maskBounds(mask, 50, 50)).toEqual({ x: 18, y: 23, w: 14, h: 5 });
  });

  it('LaMa result is pasted only under the mask', () => {
    const r = createRaster(10, 10, [0, 0, 0, 255]);
    const res = createRaster(10, 10, [255, 255, 255, 255]);
    const mask = new Uint8Array(100);
    maskDab(mask, 10, 10, 5, 5, 1, false);
    applyMasked(r, res, mask);
    expect(pixelAt(r, 5, 5)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(r, 0, 0)).toEqual([0, 0, 0, 255]);
  });

  it('undo/redo restores rectangles; strokes are continuous', () => {
    const r = createRaster(30, 30, [0, 0, 0, 255]);
    const h = new PixelHistory();
    const origin = cloneRaster(r);
    const rect = paintDab(r, 15, 15, brush, [255, 255, 255, 255])!;
    h.push(rect, readRegion(origin, rect));
    expect(pixelAt(r, 15, 15)[0]).toBe(255);
    h.undo(r);
    expect(pixelAt(r, 15, 15)[0]).toBe(0);
    h.redo(r);
    expect(pixelAt(r, 15, 15)[0]).toBe(255);
    const pts = strokePoints(0, 0, 10, 0, 4);
    expect(pts.at(-1)).toEqual([10, 0]);
    expect(pts.length).toBe(10);
  });
});


describe('notes layer (transparent)', () => {
  it('paints over transparency with alpha and erases back to transparent', () => {
    const r = createRaster(30, 30);
    expect(hasVisiblePixels(r)).toBe(false);
    paintDabOver(r, 15, 15, { radius: 4, hardness: 1, opacity: 1 }, [255, 0, 0, 255]);
    expect(pixelAt(r, 15, 15)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(r, 1, 1)[3]).toBe(0);
    expect(hasVisiblePixels(r)).toBe(true);
    paintDabOver(r, 15, 15, { radius: 4, hardness: 1, opacity: 0.5 }, [0, 0, 255, 255]);
    const mixed = pixelAt(r, 15, 15);
    expect(mixed[3]).toBe(255);
    expect(mixed[0]).toBeGreaterThan(100);
    expect(mixed[2]).toBeGreaterThan(100);
    eraseDabAlpha(r, 15, 15, { radius: 6, hardness: 1, opacity: 1 });
    expect(hasVisiblePixels(r)).toBe(false);
  });
});
