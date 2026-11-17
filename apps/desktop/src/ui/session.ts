import type { Host } from '../core/host.js';

/** Desktop settings (docs/05 §6), kept in localStorage of the WebView (no secrets here). */
export interface Settings {
  serverUrl: string;
  backend: 'auto' | 'rocm' | 'cpu';
  ocrPaddingPx: number;
  layoutThreshold: number | null;
}

const KEY = 'komaflow-desktop:settings';

export function defaultServer(host: Host): string {
  return host.kind === 'browser' ? window.location.origin : 'https://komaflow.tlinmo.site';
}

export function loadSettings(host: Host): Settings {
  const d: Settings = { serverUrl: defaultServer(host), backend: 'auto', ocrPaddingPx: 8, layoutThreshold: null };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
