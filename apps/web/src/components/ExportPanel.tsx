import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_PREFIX, type ExportDTO, type ExportStatus, type Manifest } from '@komaflow/contract';
import { api, HttpError } from '../lib/api.js';
import { t } from '../strings.js';

interface Props {
  chapterId: string;
  /** Single-page export from the page screen. */
  pageId?: string;
  pageIdx?: Map<string, number>;
}

/** Export panel (docs/06-web.md §1.5). The "Текст" checkbox is shown off and disabled in MVP. */
export function ExportPanel({ chapterId, pageId, pageIdx }: Props) {
  const qc = useQueryClient();
  const [onlyReady, setOnlyReady] = useState(!pageId);
  const [layers, setLayers] = useState({ raw: true, clean: true, notes: true });
  const [job, setJob] = useState<ExportDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const downloaded = useRef<string | null>(null);

  const status = useQuery({
    queryKey: ['export-status', chapterId],
    queryFn: () => api<ExportStatus>('GET', `/chapters/${chapterId}/export-status`),
    enabled: !pageId,
    refetchInterval: 30_000,
  });

  const poll = useQuery({
    queryKey: ['export', job?.id],
    queryFn: () => api<{ export: ExportDTO; manifest: Manifest | null }>('GET', `/exports/${job!.id}`),
    enabled: !!job && (job.status === 'queued' || job.status === 'running'),
    refetchInterval: 1200,
  });
  const current = poll.data?.export ?? job;

  useEffect(() => {
    if (!current || current.status !== 'done' || downloaded.current === current.id) return;
    downloaded.current = current.id;
    setJob(current);
    void qc.invalidateQueries({ queryKey: ['export-status', chapterId] });
    window.location.assign(`${API_PREFIX}/exports/${current.id}/download`);
  }, [current, chapterId, qc]);
  useEffect(() => {
    if (current && current.status !== job?.status && (current.status === 'failed' || current.status === 'expired')) setJob(current);
  }, [current, job?.status]);

  const anyLayer = layers.raw || layers.clean || layers.notes;
  const busy = current?.status === 'queued' || current?.status === 'running';

  const start = async () => {
    setError(null);
    try {
      const r = await api<{ export: ExportDTO }>('POST', `/chapters/${chapterId}/exports`, {
        only_ready: onlyReady,
        ...(pageId ? { page_ids: [pageId] } : {}),
        layers: { ...layers, text: false },
      });
      downloaded.current = null;
      setJob(r.export);
    } catch (e) {
      if (e instanceof HttpError && e.code === 'EXPORT_NOT_READY') {
        const sk = (e.details?.skipped_pages as Array<{ idx: number; reason: string }> | undefined) ?? [];
        setError(`${t.export.noPages}${sk.length ? ': ' + sk.map((s) => `${t.chapter.page(s.idx)} — ${t.export.skipped[s.reason] ?? s.reason}`).join(', ') : ''}`);
      } else setError(e instanceof Error ? e.message : t.errorGeneric);
    }
  };

  const stale = status.data?.pages.filter((p) => p.state === 'stale') ?? [];

  return (
    <section className="export" aria-label={t.export.title}>
      <div className="export-row">
        <label className="check">
          <input type="checkbox" checked={onlyReady} onChange={(e) => setOnlyReady(e.target.checked)} /> {t.export.onlyReady}
        </label>
        <fieldset className="layers">
          <legend>{t.export.layers}</legend>
          {(['raw', 'clean', 'notes'] as const).map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} /> {k[0]!.toUpperCase() + k.slice(1)}
            </label>
          ))}
          <label className="check disabled" title={t.export.textHint}>
            <input type="checkbox" checked={false} disabled aria-describedby="text-hint" /> {t.export.text}
          </label>
        </fieldset>
        <button className="primary" onClick={() => void start()} disabled={!anyLayer || busy}>
          {pageId ? t.page.downloadPage : t.export.download}
        </button>
      </div>
      <p id="text-hint" className="hint">
        {t.export.textHint}
      </p>
      {current && (
        <p className="export-progress" role="status">
          {current.status === 'queued' && t.export.queued}
          {current.status === 'running' && t.export.running(current.progress.done, current.progress.total)}
          {current.status === 'done' && (
            <>
              {t.export.done}{' '}
              <a href={`${API_PREFIX}/exports/${current.id}/download`}>{t.export.again}</a>
            </>
          )}
          {current.status === 'failed' && t.export.failed}
          {current.status === 'expired' && t.export.expired}
          {busy && <progress max={Math.max(1, current.progress.total)} value={current.progress.done} />}
        </p>
      )}
      {current && current.errors.length > 0 && (
        <div className="export-errors" role="alert">
          <strong>{t.export.errorsTitle}</strong>
          <ul>
            {current.errors.map((e) => (
              <li key={e.page_id}>
                {pageIdx?.get(e.page_id) ? t.chapter.page(pageIdx.get(e.page_id)!) : e.page_id}: {t.export.pageErrors[e.code] ?? e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!pageId && status.data && (
        <p className={`freshness ${stale.length ? 'stale' : ''}`}>
          {!status.data.latest_export_id
            ? t.export.never
            : stale.length === 0
              ? t.export.fresh
              : `${t.export.stale(stale.length)}: ${stale
                  .map((p) => `${t.chapter.page(p.idx)} (${(p.stale_reasons ?? []).map((r) => t.export.reasons[r] ?? r).join(', ')})`)
                  .join('; ')}`}
        </p>
      )}
    </section>
  );
}
