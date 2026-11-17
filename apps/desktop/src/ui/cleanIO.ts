import type { Raster } from '../core/raster.js';

/**
 * Decodes image bytes without any network request: no `fetch` of blob:/asset: URLs, which the packaged
 * app's CSP blocks (this was the «Failed to fetch» of the clean tab).
 */
export async function decodeBytes(bytes: Uint8Array): Promise<Raster> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { width: d.width, height: d.height, data: d.data };
}

/** PNG bytes of a raster (lossless, as the clean is published). */
export async function encodePng(r: Raster): Promise<Uint8Array> {
  const c = new OffscreenCanvas(r.width, r.height);
  c.getContext('2d')!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
