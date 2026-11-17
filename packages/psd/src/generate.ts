import { writePsdUint8Array, type Layer, type Psd } from 'ag-psd';
import { planLayers, type LayerPlan } from './layers.js';
import { buildTextLayer, wantsTextLayer } from './text.js';
import { PSD_MAX_SIDE, PsdError, type DecodedImage, type ImageCodec, type PsdPageInput } from './types.js';

/** PSD file size limit (2 GB). */
const PSD_MAX_BYTES = 2 * 1024 ** 3 - 1;

/**
 * Builds a raster PSD (RGB, 8 bit) for one page (docs/04-psd.md §1–2).
 * Layers top to bottom: Notes, Raw (hidden unless `raw_layer_visible`), group Text (editable box text,
 * docs/04-psd.md §3), Clean. Text pixels are not pre-rendered: Photoshop redraws them on open.
 * Pure: no Node APIs; the codec is injected.
 */
export async function generatePsd(input: PsdPageInput, codec: ImageCodec): Promise<Uint8Array> {
  const { width, height } = input.page;
  if (width > PSD_MAX_SIDE || height > PSD_MAX_SIDE) {
    throw new PsdError('PSD_TOO_LARGE', `page ${width}x${height} exceeds PSD limit of ${PSD_MAX_SIDE}px`);
  }
  const plan = planLayers(
    input.layers,
    { raw: !!input.raw, clean: !!input.clean, notes: !!input.notes },
    input.settings,
  );
  const textObjects = input.layers.text ? (input.objects ?? []).filter(wantsTextLayer).sort((a, b) => a.order - b.order) : [];
  if (plan.length === 0 && textObjects.length === 0) throw new PsdError('GENERATION_FAILED', 'no layers to write');

  const bytesFor: Record<LayerPlan['name'], Uint8Array | undefined> = {
    Notes: input.notes,
    Raw: input.raw,
    Clean: input.clean,
  };

  // Bottom to top: ag-psd writes `children` in file order, which is bottom-first.
  const bottomUp = [...plan].reverse();
  const composite = new Uint8Array(width * height * 4);
  const children: Layer[] = [];
  const textGroup: Layer | null = textObjects.length
    ? {
        name: 'Text',
        opened: true,
        // bottom-up inside the group: the first object ends on top
        children: [...textObjects].reverse().map((o) => buildTextLayer(o, input.settings, input.page)),
      }
    : null;
  for (const l of bottomUp) {
    // the Text group sits right above Clean (or at the bottom when there is no Clean)
    if (textGroup && l.name !== 'Clean' && !children.includes(textGroup)) children.push(textGroup);
    const img = await decode(codec, bytesFor[l.name]!, l.name);
    if (img.width !== width || img.height !== height) {
      throw new PsdError(
        'GENERATION_FAILED',
        `${l.name} is ${img.width}x${img.height}, page is ${width}x${height}`,
      );
    }
    if (!l.hidden) compositeOver(composite, img.rgba, l.opacity / 100);
    children.push({
      name: l.name,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      hidden: l.hidden,
      opacity: l.opacity / 100,
      blendMode: 'normal',
      imageData: { width, height, data: toClamped(img.rgba) },
    });
  }

  if (textGroup && !children.includes(textGroup)) children.push(textGroup);
  const psd: Psd = {
    width,
    height,
    channels: 3,
    bitsPerChannel: 8,
    colorMode: 3, // RGB
    children,
    imageData: { width, height, data: toClamped(composite) },
    imageResources: {
      resolutionInfo: {
        horizontalResolution: input.settings.dpi,
        horizontalResolutionUnit: 'PPI',
        widthUnit: 'Inches',
        verticalResolution: input.settings.dpi,
        verticalResolutionUnit: 'PPI',
        heightUnit: 'Inches',
      },
    },
  };
  let out: Uint8Array;
  try {
    out = writePsdUint8Array(psd, { noBackground: true, generateThumbnail: false, invalidateTextLayers: textObjects.length > 0 });
  } catch (e) {
    throw new PsdError('GENERATION_FAILED', e instanceof Error ? e.message : String(e));
  }
  if (out.byteLength > PSD_MAX_BYTES) throw new PsdError('PSD_TOO_LARGE', 'PSD exceeds 2 GB');
  return out;
}

async function decode(codec: ImageCodec, bytes: Uint8Array, name: string): Promise<DecodedImage> {
  try {
    return await codec.decode(bytes);
  } catch (e) {
    throw new PsdError('DECODE_FAILED', `${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const toClamped = (a: Uint8Array) => new Uint8ClampedArray(a.buffer, a.byteOffset, a.byteLength);

/** Source-over compositing of non-premultiplied RGBA `src` (with layer opacity) onto `dst`, in place. */
export function compositeOver(dst: Uint8Array, src: Uint8Array, opacity: number): void {
  const k = Math.round(Math.min(Math.max(opacity, 0), 1) * 255);
  if (k === 0) return;
  for (let i = 0; i < dst.length; i += 4) {
    const sa = (src[i + 3]! * k + 127) / 255 / 255; // 0..1
    if (sa === 0) continue;
    const da = dst[i + 3]! / 255;
    const oa = sa + da * (1 - sa);
    for (let c = 0; c < 3; c++) {
      const v = (src[i + c]! * sa + dst[i + c]! * da * (1 - sa)) / oa;
      dst[i + c] = Math.round(v);
    }
    dst[i + 3] = Math.round(oa * 255);
  }
}
