import type { Raster } from '../core/raster.js';

/** Decodes any page image the WebView can show into an RGBA raster. */
export async function loadRaster(url: string): Promise<Raster> {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { width: d.width, height: d.height, data: d.data };
}

export async function decodeBytes(bytes: Uint8Array): Promise<Raster> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  try {
    return await loadRaster(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** PNG bytes of a raster (lossless, as the clean is published). */
export async function encodePng(r: Raster): Promise<Uint8Array> {
  const c = new OffscreenCanvas(r.width, r.height);
  c.getContext('2d')!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
