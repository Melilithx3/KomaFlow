import sharp from 'sharp';
import type { ImageCodec } from '../types.js';

/** Node codec on sharp/libvips (prebuilt for win32-x64 and linux-arm64, see ADR 0006). */
export const sharpCodec: ImageCodec = {
  async decode(bytes) {
    const { data, info } = await sharp(bytes, { limitInputPixels: 200_000_000 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) throw new Error(`unexpected channel count ${info.channels}`);
    return { width: info.width, height: info.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  },
};
