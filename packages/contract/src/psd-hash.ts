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
  /** Degrees; part of the hash only with text layers (ADR 0011). */
  rotation?: number;
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
  /** Non-deleted objects in reading order (ignored unless `layers.text`). */
  objects: PsdHashObject[];
}

const boxValue = (b: Box | null): CanonicalValue => (b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null);

/** The parts of the input that actually influence the PSD (docs/01-data-model.md §5). */
function effective(input: PsdHashInput) {
  const l = input.layers;
  return {
    width: input.width,
    height: input.height,
    layers: toCanonical(l),
    raw_hash: l.raw ? input.raw_hash : null,
    clean_hash: l.clean ? input.clean_hash : null,
    notes_hash: l.notes ? input.notes_hash : null,
    psd_settings: l.text
      ? toCanonical(input.psd_settings)
      : toCanonical({
          raw_layer_visible: input.psd_settings.raw_layer_visible,
          notes_opacity: input.psd_settings.notes_opacity,
        }),
    objects: l.text
      ? input.objects.map((o) => ({
          id: o.id,
          type: o.type,
          box: boxValue(o.box),
          text_box: boxValue(o.text_box),
          rotation: o.rotation ?? 0,
          order: o.order,
          translation: o.translation,
          state: o.state,
        }))
      : [],
  };
}

/** psd_input_hash (docs/01-data-model.md §5). */
export function psdInputHash(input: PsdHashInput): string {
  return sha256Hex(canonicalJson(effective(input)));
}

export type PsdHashParts = Record<StaleReason, string>;

/**
 * Partial hashes stored in the manifest so the UI can explain why a page is stale.
 * In MVP only `clean`, `notes` and `settings` can differ (objects are not part of the PSD).
 */
export function psdHashParts(input: PsdHashInput): PsdHashParts {
  const e = effective(input);
  const h = (v: CanonicalValue) => sha256Hex(canonicalJson(v));
  return {
    clean: h(e.clean_hash),
    notes: h(e.notes_hash),
    markup: h({
      raw_hash: e.raw_hash,
      width: e.width,
      height: e.height,
      objects: e.objects.map((o) => ({ id: o.id, type: o.type, box: o.box, text_box: o.text_box, rotation: o.rotation, order: o.order })),
    }),
    translation: h(e.objects.map((o) => ({ id: o.id, translation: o.translation, state: o.state }))),
    settings: h({ layers: e.layers, psd_settings: e.psd_settings }),
  };
}

export function staleReasons(saved: PsdHashParts, current: PsdHashParts): StaleReason[] {
  return (Object.keys(current) as StaleReason[]).filter((k) => saved[k] !== current[k]);
}
