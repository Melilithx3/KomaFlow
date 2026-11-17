import type { ObjectType } from '@komaflow/contract';
import type { Host } from '../core/host.js';
import type { SidecarOptions } from '../core/sidecar.js';

/** Classes of the layout model (koharu-layout config.json). */
export const LAYOUT_CLASSES = ['bubble', 'text', 'onomatopoeia', 'panel'] as const;
export type LayoutClass = (typeof LAYOUT_CLASSES)[number];

export interface LayoutClassSetting {
  enabled: boolean;
  /** Our object type for this model class. */
  type: ObjectType;
  /** Score threshold 0..1; null = the model's recommended value. */
  threshold: number | null;
}

/** Desktop settings (docs/05 §6), kept in localStorage of the WebView (no secrets here). */
export interface Settings {
  serverUrl: string;
  backend: 'auto' | 'rocm' | 'cpu';
  ocrPaddingPx: number;
  layoutClasses: Record<LayoutClass, LayoutClassSetting>;
  /** OCR only boxes whose original is empty. */
  ocrOnlyEmpty: boolean;
}

const KEY = 'komaflow-desktop:settings';

export const DEFAULT_LAYOUT_CLASSES: Record<LayoutClass, LayoutClassSetting> = {
  bubble: { enabled: true, type: 'bubble', threshold: null },
  text: { enabled: true, type: 'text', threshold: null },
  onomatopoeia: { enabled: true, type: 'onomatopoeia', threshold: null },
  panel: { enabled: false, type: 'text', threshold: null },
};

export function defaultServer(host: Host): string {
  return host.kind === 'browser' ? window.location.origin : 'https://komaflow.tlinmo.site';
}

export function loadSettings(host: Host): Settings {
  const d: Settings = { serverUrl: defaultServer(host), backend: 'auto', ocrPaddingPx: 8, layoutClasses: DEFAULT_LAYOUT_CLASSES, ocrOnlyEmpty: true };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return { ...d, ...saved, layoutClasses: { ...DEFAULT_LAYOUT_CLASSES, ...saved.layoutClasses } };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/** Options for the sidecar: per-class mapping (null = class disabled) and thresholds. */
export function sidecarOptions(s: Settings, stages?: Array<'layout' | 'ocr'>): SidecarOptions {
  const class_map: Record<string, ObjectType | null> = {};
  const class_thresholds: Record<string, number> = {};
  for (const c of LAYOUT_CLASSES) {
    const cs = s.layoutClasses[c];
    class_map[c] = cs.enabled ? cs.type : null;
    if (cs.threshold !== null) class_thresholds[c] = cs.threshold;
  }
  return { backend: s.backend, ocr_padding_px: s.ocrPaddingPx, layout_threshold: null, class_map, class_thresholds, ...(stages ? { stages } : {}) };
}
