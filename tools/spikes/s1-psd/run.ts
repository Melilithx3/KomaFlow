/**
 * Spike S1 harness (docs/07-spikes.md): generates raster PSD variants into tools/spikes/s1-psd/out/,
 * reads them back with ag-psd and prints layer tree, timings and peak RSS.
 *   pnpm --filter @komaflow/tools s1 [-- --only V3]
 * The out/ folder is what the typer opens in Photoshop (see docs/spikes/S1-checklist.md).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeCanvas, readPsd } from 'ag-psd';
import { makeFixtureChapter, Raster } from '@komaflow/contract/fixtures';
import type { ExportLayers } from '@komaflow/contract';
import { generatePsd } from '@komaflow/psd';
import { sharpCodec } from '@komaflow/psd/sharp';

initializeCanvas(
  () => {
    throw new Error('no canvas');
  },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as never,
);

const OUT = join(import.meta.dirname, 'out');
mkdirSync(OUT, { recursive: true });
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const S = { raw_layer_visible: false, notes_opacity: 100 };

/** A page with manga-like noise so RLE does not trivialise sizes. */
function page(w: number, h: number, seed: number) {
  const raw = new Raster(w, h, [240, 238, 232, 255]);
  const clean = new Raster(w, h, [240, 238, 232, 255]);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 400; i++) {
    const x = Math.floor(rnd() * (w - 80));
    const y = Math.floor(rnd() * (h - 80));
    const c = Math.floor(rnd() * 200);
    for (const r of [raw, clean]) r.rect(x, y, 20 + Math.floor(rnd() * 60), 20 + Math.floor(rnd() * 60), [c, c, c, 255]);
  }
  for (let i = 0; i < 12; i++) {
    const x = Math.floor(rnd() * (w - 300));
    const y = Math.floor(rnd() * (h - 300));
    for (const r of [raw, clean]) r.rect(x, y, 260, 220, [255, 255, 255, 255]);
    for (let l = 0; l < 5; l++) raw.rect(x + 30, y + 30 + l * 36, 200, 14, [20, 20, 20, 255]);
  }
  const notes = new Raster(w, h, [0, 0, 0, 0]);
  notes.frame(Math.floor(w / 4), Math.floor(h / 4), Math.floor(w / 2), Math.floor(h / 6), 6, [220, 38, 38, 255]);
  notes.rect(Math.floor(w / 4) + 10, Math.floor(h / 4) + 10, 120, 60, [37, 99, 235, 120]);
  return { raw: raw.png(), clean: clean.png(), notes: notes.png() };
}

interface Variant {
  id: string;
  w: number;
  h: number;
  layers: ExportLayers;
  notesOpacity?: number;
  files?: { raw: Uint8Array; clean: Uint8Array; notes: Uint8Array };
}

const L = (raw: boolean, clean: boolean, notes: boolean): ExportLayers => ({ raw, clean, notes, text: false });
const fx = makeFixtureChapter()[0]!;
const variants: Variant[] = [
  { id: 'V1-2000x3000-all', w: 2000, h: 3000, layers: L(true, true, true) },
  { id: 'V1-fixture-800x1200', w: 800, h: 1200, layers: L(true, true, true), files: { raw: fx.raw, clean: fx.clean!, notes: fx.notes! } },
];
for (const raw of [false, true])
  for (const clean of [false, true])
    for (const notes of [false, true]) {
      if (!raw && !clean && !notes) continue;
      variants.push({ id: `V2-${raw ? 'R' : ''}${clean ? 'C' : ''}${notes ? 'N' : ''}`, w: 1200, h: 1800, layers: L(raw, clean, notes) });
    }
variants.push({ id: 'V3-1600x10000', w: 1600, h: 10000, layers: L(true, true, true) });
variants.push({ id: 'V4-notes-opacity-40', w: 1200, h: 1800, layers: L(false, true, true), notesOpacity: 40 });

const rows: string[] = [];
let peak = 0;
const sample = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
for (const v of variants) {
  if (only && !v.id.startsWith(only)) continue;
  const f = v.files ?? page(v.w, v.h, v.w * 7 + v.h);
  peak = process.memoryUsage().rss;
  const t = performance.now();
  const psd = await generatePsd(
    {
      page: { index: 1, width: v.w, height: v.h },
      raw: v.layers.raw ? f.raw : undefined,
      clean: v.layers.clean ? f.clean : undefined,
      notes: v.layers.notes ? f.notes : undefined,
      layers: v.layers,
      settings: { ...S, notes_opacity: v.notesOpacity ?? 100 },
    },
    sharpCodec,
  );
  const ms = performance.now() - t;
  peak = Math.max(peak, process.memoryUsage().rss);
  writeFileSync(join(OUT, `${v.id}.psd`), psd);
  const back = readPsd(psd, { useImageData: true, skipThumbnail: true });
  const tree = [...(back.children ?? [])]
    .reverse()
    .map((l) => `${l.name}${l.hidden ? '(hidden)' : ''}@${Math.round((l.opacity ?? 1) * 100)}%`)
    .join(' > ');
  const line = `${v.id.padEnd(24)} ${String(Math.round(ms)).padStart(6)} ms  ${(psd.byteLength / 1e6).toFixed(1).padStart(6)} MB  peak RSS ${Math.round(peak / 1e6)} MB  ${tree}`;
  console.log(line);
  rows.push(line);
}
clearInterval(sample);
writeFileSync(join(OUT, 'results.txt'), `node ${process.version} ${process.platform}-${process.arch}\n${rows.join('\n')}\n`);
console.log(`\nfiles in ${OUT}`);
