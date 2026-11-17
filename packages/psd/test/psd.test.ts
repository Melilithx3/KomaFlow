import { describe, expect, it } from 'vitest';
import { initializeCanvas, readPsd } from 'ag-psd';

// Reading back needs ImageData only; no canvas in Node.
initializeCanvas(
  () => {
    throw new Error('canvas not available in tests');
  },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as never,
);
import { encodePng, makeFixtureChapter, Raster } from '@komaflow/contract/fixtures';
import type { ExportLayers } from '@komaflow/contract';
import { generatePsd, planLayers, selectPages, validateExportLayers, compositeOver, PsdError, psdFileName } from '../src/index.js';
import { sharpCodec } from '../src/node/sharp-codec.js';

const S = { raw_layer_visible: false, notes_opacity: 100 };
const L = (raw: boolean, clean: boolean, notes: boolean): ExportLayers => ({ raw, clean, notes, text: false });

function read(bytes: Uint8Array) {
  return readPsd(bytes, { useImageData: true, skipThumbnail: true });
}
/** Names top to bottom (ag-psd children are bottom-up). */
const topDown = (psd: ReturnType<typeof read>) => [...(psd.children ?? [])].reverse();

describe('planLayers / validation', () => {
  it('orders Notes, Raw, Clean and hides Raw by default', () => {
    const p = planLayers(L(true, true, true), { raw: true, clean: true, notes: true }, S);
    expect(p.map((l) => l.name)).toEqual(['Notes', 'Raw', 'Clean']);
    expect(p.find((l) => l.name === 'Raw')!.hidden).toBe(true);
    expect(planLayers(L(true, true, true), { raw: true, clean: true, notes: true }, { ...S, raw_layer_visible: true })[1]!.hidden).toBe(false);
  });
  it('skips layers that are not selected or missing', () => {
    expect(planLayers(L(true, true, true), { raw: true, clean: false, notes: false }, S).map((l) => l.name)).toEqual(['Raw']);
    expect(planLayers(L(false, false, true), { raw: true, clean: true, notes: false }, S)).toEqual([]);
  });
  it('rejects text and empty layer sets', () => {
    expect(validateExportLayers({ raw: true, clean: true, notes: true, text: true })).toMatch(/Текстовые/);
    expect(validateExportLayers(L(false, false, false))).not.toBeNull();
    expect(validateExportLayers(L(false, true, false))).toBeNull();
  });
});

describe('selectPages', () => {
  const pages = [
    { id: 'a', idx: 2, clean_hash: 'c', notes_hash: null, ready_for_typing: true },
    { id: 'b', idx: 1, clean_hash: null, notes_hash: 'n', ready_for_typing: false },
    { id: 'c', idx: 3, clean_hash: 'c', notes_hash: null, ready_for_typing: false },
  ];
  it('only ready by default', () => {
    const s = selectPages(pages, { only_ready: true, page_ids: null, layers: L(true, true, true) });
    expect(s.pages.map((p) => p.id)).toEqual(['a']);
    expect(s.skipped.map((x) => [x.page.id, x.reason])).toEqual([
      ['b', 'not_ready'],
      ['c', 'not_ready'],
    ]);
  });
  it('no_clean and no_layers reasons, page_ids filter', () => {
    const s = selectPages(pages, { only_ready: false, page_ids: null, layers: L(true, true, true) });
    expect(s.skipped.map((x) => [x.page.id, x.reason])).toEqual([['b', 'no_clean']]);
    const n = selectPages(pages, { only_ready: false, page_ids: ['a', 'b'], layers: L(false, false, true) });
    expect(n.pages.map((p) => p.id)).toEqual(['b']);
    expect(n.skipped.map((x) => [x.page.id, x.reason])).toEqual([['a', 'no_layers']]);
  });
  it('file names', () => expect(psdFileName(7)).toBe('007.psd'));
});

describe('generatePsd (golden: read back)', () => {
  const [p1, , p3] = makeFixtureChapter();

  it('V1: Notes / Raw (hidden) / Clean, sizes, no text layers', async () => {
    const out = await generatePsd(
      { page: { index: 1, width: p1!.width, height: p1!.height }, raw: p1!.raw, clean: p1!.clean!, notes: p1!.notes!, layers: L(true, true, true), settings: S },
      sharpCodec,
    );
    const psd = read(out);
    expect(psd.width).toBe(800);
    expect(psd.height).toBe(1200);
    const layers = topDown(psd);
    expect(layers.map((l) => l.name)).toEqual(['Notes', 'Raw', 'Clean']);
    expect(layers.map((l) => !!l.hidden)).toEqual([false, true, false]);
    for (const l of layers) {
      expect(l.children).toBeUndefined();
      expect(l.text).toBeUndefined();
      expect([l.left ?? 0, l.top ?? 0]).toEqual([0, 0]);
      // ag-psd trims nothing by default: layers match the document.
      expect(l.imageData!.width).toBe(800);
      expect(l.imageData!.height).toBe(1200);
    }
    // Notes keep transparency: a far corner is fully transparent.
    expect(layers[0]!.imageData!.data[3]).toBe(0);
    // Composite is built from visible layers (not empty).
    expect(psd.imageData!.data[3]).toBe(255);
  });

  it('V2: every allowed combination of checkboxes', async () => {
    for (const raw of [false, true])
      for (const clean of [false, true])
        for (const notes of [false, true]) {
          if (!raw && !clean && !notes) continue;
          const out = await generatePsd(
            { page: { index: 1, width: 800, height: 1200 }, raw: raw ? p1!.raw : undefined, clean: clean ? p1!.clean! : undefined, notes: notes ? p1!.notes! : undefined, layers: L(raw, clean, notes), settings: S },
            sharpCodec,
          );
          const names = topDown(read(out)).map((l) => l.name);
          expect(names).toEqual([notes && 'Notes', raw && 'Raw', clean && 'Clean'].filter(Boolean));
        }
  });

  it('V4: notes opacity and partially transparent pixels', async () => {
    const r = new Raster(64, 64, [0, 0, 0, 0]);
    r.rect(0, 0, 32, 64, [255, 0, 0, 128]);
    const notes = r.png();
    const clean = new Raster(64, 64, [255, 255, 255, 255]).png();
    const out = await generatePsd({ page: { index: 1, width: 64, height: 64 }, clean, notes, layers: L(false, true, true), settings: { ...S, notes_opacity: 40 } }, sharpCodec);
    const psd = read(out);
    const n = topDown(psd)[0]!;
    expect(n.name).toBe('Notes');
    expect(n.opacity).toBeCloseTo(0.4, 2);
    expect(n.imageData!.data[3]).toBe(128);
    expect(n.imageData!.data[0]).toBe(255);
    // composite: white under red at 128*0.4 alpha
    const c = psd.imageData!.data;
    expect(c[3]).toBe(255);
    expect(c[0]).toBe(255);
    expect(c[1]).toBeGreaterThan(200);
    expect(c[1]).toBeLessThan(255);
  });

  it('page without clean: transparent background (raw hidden)', async () => {
    const out = await generatePsd({ page: { index: 3, width: 800, height: 1200 }, raw: p3!.raw, layers: L(true, true, true), settings: S }, sharpCodec);
    const psd = read(out);
    expect(topDown(psd).map((l) => l.name)).toEqual(['Raw']);
    expect(psd.imageData!.data[3]).toBe(0);
  });

  it('errors: size mismatch, decode failure, too large', async () => {
    const small = encodePng(10, 10, new Uint8Array(400));
    await expect(generatePsd({ page: { index: 1, width: 800, height: 1200 }, clean: small, layers: L(false, true, false), settings: S }, sharpCodec)).rejects.toMatchObject({ code: 'GENERATION_FAILED' });
    await expect(generatePsd({ page: { index: 1, width: 10, height: 10 }, clean: new Uint8Array([1, 2, 3]), layers: L(false, true, false), settings: S }, sharpCodec)).rejects.toMatchObject({ code: 'DECODE_FAILED' });
    await expect(generatePsd({ page: { index: 1, width: 40_000, height: 10 }, clean: small, layers: L(false, true, false), settings: S }, sharpCodec)).rejects.toBeInstanceOf(PsdError);
  });

  it('robustness: 2000x3000 and 1600x10000 pages', async () => {
    for (const [w, h] of [
      [2000, 3000],
      [1600, 10000],
    ] as const) {
      const rgba = new Uint8Array(w * h * 4).fill(200);
      const png = encodePng(w, h, rgba);
      const t = performance.now();
      const out = await generatePsd({ page: { index: 1, width: w, height: h }, raw: png, clean: png, notes: png, layers: L(true, true, true), settings: S }, sharpCodec);
      const ms = performance.now() - t;
      expect(out.byteLength).toBeGreaterThan(0);
      expect(topDown(read(out)).length).toBe(3);
      console.log(`psd ${w}x${h}: ${ms.toFixed(0)} ms, ${(out.byteLength / 1e6).toFixed(1)} MB`);
    }
  });
});

describe('compositeOver', () => {
  it('blends with opacity', () => {
    const d = new Uint8Array([0, 0, 255, 255]);
    compositeOver(d, new Uint8Array([255, 0, 0, 255]), 0.5);
    expect(d[0]).toBeGreaterThan(120);
    expect(d[2]).toBeGreaterThan(120);
    expect(d[3]).toBe(255);
  });
});
