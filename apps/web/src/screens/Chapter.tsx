import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { ChapterDetailResponse, ExportStatus, PageSummary } from '@komaflow/contract';
import { api, blobUrl } from '../lib/api.js';
import { t } from '../strings.js';
import { ErrorBox } from '../App.js';
import { ExportPanel } from '../components/ExportPanel.js';
import { AiJson } from '../components/AiJson.js';
import { Icon } from '../components/Icon.js';

type Filter = 'all' | 'unready' | 'flagged' | 'ready';

export function useChapter(chapterId: string | undefined, interval = 30_000) {
  return useQuery({
    queryKey: ['chapter', chapterId],
    queryFn: () => api<ChapterDetailResponse>('GET', `/chapters/${chapterId}`),
    enabled: !!chapterId,
    refetchInterval: interval,
  });
}

const FILTERS: Record<Filter, (p: PageSummary) => boolean> = {
  all: () => true,
  unready: (p) => !p.ready_for_typing,
  flagged: (p) => p.flagged > 0,
  ready: (p) => p.ready_for_typing,
};

export function ChapterScreen() {
  const { chapterId } = useParams();
  const q = useChapter(chapterId);
  const [filter, setFilter] = useState<Filter>('all');
  const status = useQuery({
    queryKey: ['export-status', chapterId],
    queryFn: () => api<ExportStatus>('GET', `/chapters/${chapterId}/export-status`),
    refetchInterval: 30_000,
  });
  const staleIds = useMemo(() => new Set(status.data?.pages.filter((p) => p.state === 'stale').map((p) => p.page_id)), [status.data]);
  const idxMap = useMemo(() => new Map(q.data?.pages.map((p) => [p.id, p.idx])), [q.data]);

  if (q.isPending) return <p className="center muted">{t.loading}</p>;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  const { chapter, project, pages } = q.data;
  const shown = pages.filter(FILTERS[filter]);

  return (
    <div className="page-pad">
      <div className="screen-head">
        <div>
          <div className="crumbs">
            <Link to={`/projects/${project.id}`}>{project.title}</Link>
            <Icon name="chevron" size={14} />
          </div>
          <h1>
            {t.projects.chapter(chapter.number)}
            {chapter.title ? <span className="muted"> · {chapter.title}</span> : null}
          </h1>
        </div>
        <AiJson
          pageIds={pages.map((p) => p.id)}
          chapterNumber={chapter.number}
          sourceLang={project.source_lang}
          targetLang={project.target_lang}
          fileName={`komaflow-${chapter.number}.json`}
        />
      </div>
      <ExportPanel chapterId={chapter.id} pageIdx={idxMap} />
      <div className="row wrap filters" role="group" aria-label="Фильтр">
        {(Object.keys(FILTERS) as Filter[]).map((f) => (
          <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t.chapter.filters[f]}
          </button>
        ))}
      </div>
      {pages.length === 0 ? (
        <p className="muted">{t.chapter.noPages}</p>
      ) : shown.length === 0 ? (
        <p className="muted">{t.chapter.noMatch}</p>
      ) : (
        <ul className="grid">
          {shown.map((p) => (
            <li key={p.id}>
              <Link to={`/pages/${p.id}`} className="card page-card">
                <div className="thumb" style={{ aspectRatio: `${p.width} / ${p.height}` }}>
                  <img src={blobUrl(p.thumb_hash ?? p.raw_hash)} alt={t.chapter.page(p.idx)} loading="lazy" decoding="async" />
                  {p.typed && <span className="badge typed">✓ {t.chapter.typed}</span>}
                </div>
                <div className="page-card-body">
                  <div className="row between">
                    <strong>{t.chapter.page(p.idx)}</strong>
                    <span className="mini-progress" aria-hidden>
                      <span style={{ width: `${p.counts.total ? (100 * (p.counts.total - p.counts.empty)) / p.counts.total : 100}%` }} />
                    </span>
                  </div>
                  <div className="badges">
                    <span className={`badge ${p.has_clean ? 'ok' : 'warn'}`}>{p.has_clean ? t.chapter.hasClean : t.chapter.noClean}</span>
                    <span className={`badge ${p.translation_done ? 'ok' : ''}`}>{t.chapter.translation(p.counts.total - p.counts.empty, p.counts.total)}</span>
                    {p.ready_for_typing && !p.typed && <span className="badge ok">{t.chapter.ready}</span>}
                    {p.flagged > 0 && <span className="badge flag">⚑ {t.chapter.flags(p.flagged)}</span>}
                    {p.markup_changed_for_me && <span className="badge info">{t.chapter.markupChanged}</span>}
                    {staleIds.has(p.id) && <span className="badge warn">{t.chapter.changedAfterExport}</span>}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
