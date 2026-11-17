import type { ExportLayers, PsdSettings } from '@komaflow/contract';
import type { TextObject } from './text.js';

export const GENERATOR = { name: 'komaflow-psd', version: '0.1.0' } as const;

/** PSD format limit for one side (docs/04-psd.md §4). */
export const PSD_MAX_SIDE = 30_000;

export interface DecodedImage {
  width: number;
  height: number;
  /** Non-premultiplied RGBA, 8 bits per channel. */
  rgba: Uint8Array;
}

/**
 * Injected image decoder (docs/04-psd.md §1). The core never touches Node-only APIs, so it can run
 * in a browser with a canvas-based codec. Raw pages may be PNG, JPEG or WebP, so the codec decodes
 * any of the allowed types, not only PNG.
 */
export interface ImageCodec {
  decode(bytes: Uint8Array): Promise<DecodedImage>;
}

export interface PsdPageInput {
  page: { index: number; width: number; height: number };
  raw?: Uint8Array | undefined;
  clean?: Uint8Array | undefined;
  notes?: Uint8Array | undefined;
  layers: ExportLayers;
  settings: PsdSettings;
  /** Objects for text layers (used only when `layers.text`). */
  objects?: TextObject[];
}

export type PsdErrorCode = 'PSD_TOO_LARGE' | 'DECODE_FAILED' | 'GENERATION_FAILED';

export class PsdError extends Error {
  constructor(
    readonly code: PsdErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PsdError';
  }
}
