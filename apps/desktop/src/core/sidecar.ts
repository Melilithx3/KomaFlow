import type { Box, ObjectType } from '@komaflow/contract';
import type { Host } from './host.js';

export interface SidecarCaps {
  backends: Array<{ id: 'rocm' | 'cpu'; available: boolean; device?: string | null; arch?: string | null; error?: string }>;
  models: Record<'layout' | 'ocr' | 'lama', { installed: boolean; revision: string | null }>;
}

export interface SidecarJob<R> {
  id: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stage: string;
  progress: { done: number; total: number };
  result?: R;
  error?: string;
}

export interface AnalyzeResult {
  backend: string;
  warnings: string[];
  pages: Array<{ page_id: string; objects: Array<{ type: ObjectType; box: Box; score: number; source_text: string }> }>;
}

export interface SidecarOptions {
  backend: 'auto' | 'rocm' | 'cpu';
  ocr_padding_px: number;
  layout_threshold: number | null;
}

/** Client of the local Python service (docs/05 §9). */
export class SidecarClient {
  constructor(
    private readonly host: Host,
    readonly url: string,
    private readonly token: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.host.fetch(`${this.url}${path}`, {
      method,
      headers: { 'x-komaflow-token': this.token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `sidecar HTTP ${res.status}`);
    return json;
  }

  health = () => this.req<{ ok: boolean; version: string }>('GET', '/health');
  capabilities = () => this.req<SidecarCaps>('GET', '/capabilities');
  analyze = (pages: Array<{ page_id: string; image_path: string }>, options: SidecarOptions) =>
    this.req<{ job_id: string }>('POST', '/jobs', { kind: 'analyze_batch', pages, options }).then((r) => r.job_id);
  ocrBoxes = (image_path: string, boxes: Array<{ id: string; box: Box }>, options: SidecarOptions) =>
    this.req<{ job_id: string }>('POST', '/jobs', { kind: 'ocr_boxes', image_path, boxes, options }).then((r) => r.job_id);
  job = <R>(id: string) => this.req<SidecarJob<R>>('GET', `/jobs/${id}`);
  cancel = (id: string) => this.req<SidecarJob<unknown>>('DELETE', `/jobs/${id}`);

  /** Polls a job until it ends; reports progress. */
  async wait<R>(id: string, onProgress: (j: SidecarJob<R>) => void, intervalMs = 500): Promise<SidecarJob<R>> {
    for (;;) {
      const j = await this.job<R>(id);
      onProgress(j);
      if (j.state === 'done' || j.state === 'failed' || j.state === 'cancelled') return j;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/** Why analysis buttons are disabled (docs/05 §5), or null when they work. */
export function analysisBlocker(caps: SidecarCaps | null): string | null {
  if (!caps) return 'Движок анализа не установлен или не запущен. Боксы можно рисовать вручную.';
  if (!caps.models.layout.installed) return 'Модель разметки не загружена (Настройки → Движок).';
  if (!caps.backends.some((b) => b.available)) return 'Нет подходящего бэкенда (ROCm или CPU).';
  return null;
}

export function ocrBlocker(caps: SidecarCaps | null): string | null {
  const a = analysisBlocker(caps);
  if (a) return a;
  if (!caps!.models.ocr.installed) return 'Модель OCR не загружена.';
  if (!caps!.backends.find((b) => b.id === 'rocm')?.available) return 'OCR работает только на видеокарте (ROCm); на CPU он слишком медленный.';
  return null;
}
