import { canonicalJson, toCanonical, type CanonicalValue } from './canonical-json.js';
import type { Box, ObjectType, TranslationState } from './common.js';
import type { StaleReason } from './dto.js';
import type { ExportLayers, PsdSettings } from './settings.js';
import { sha256Hex } from './sha256.js';

export interface PsdHashObject {
  id: string;
  type: ObjectType;
  box: Box;
  text_box: Box | null;
  order: number;
  translation: string;
  state: TranslationState;
}

export interface PsdHashInput {
  raw_hash: string;
  clean_hash: string | null;
  notes_hash: string | null;
  width: number;
  height: number;
  psd_settings: PsdSettings;
  layers: ExportLayers;
  /** Non-deleted objects in reading order. */
  objects: PsdHashObject[];
}

const boxValue = (b: Box | null): CanonicalValue => (b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null);

/** psd_input_hash (docs/01-data-model.md §5). */
export function psdInputHash(input: PsdHashInput): string {
  return sha256Hex(
    canonicalJson({
      raw_hash: input.raw_hash,
      clean_hash: input.clean_hash,
      notes_hash: input.notes_hash,
      width: input.width,
      height: input.height,
      psd_settings: toCanonical(input.psd_settings),
      layers: toCanonical(input.layers),
      objects: input.objects.map((o) => ({
        id: o.id,
        type: o.type,
        box: boxValue(o.box),
        text_box: boxValue(o.text_box),
        order: o.order,
        translation: o.translation,
        state: o.state,
      })),
    }),
  );
}

export type PsdHashParts = Record<StaleReason, string>;

/** Partial hashes stored in the manifest so the UI can explain why a page is stale. */
export function psdHashParts(input: PsdHashInput): PsdHashParts {
  const h = (v: CanonicalValue) => sha256Hex(canonicalJson(v));
  return {
    clean: h(input.clean_hash),
    notes: h(input.notes_hash),
    markup: h({
      raw_hash: input.raw_hash,
      width: input.width,
      height: input.height,
      objects: input.objects.map((o) => ({
        id: o.id,
        type: o.type,
        box: boxValue(o.box),
        text_box: boxValue(o.text_box),
        order: o.order,
      })),
    }),
    translation: h(input.objects.map((o) => ({ id: o.id, translation: o.translation, state: o.state }))),
    settings: h({ psd_settings: toCanonical(input.psd_settings), layers: toCanonical(input.layers) }),
  };
}

export function staleReasons(saved: PsdHashParts, current: PsdHashParts): StaleReason[] {
  return (Object.keys(current) as StaleReason[]).filter((k) => saved[k] !== current[k]);
}
