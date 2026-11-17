import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import type { ObjectDTO, PageDetailResponse, PageDTO, TextChanges } from '@komaflow/contract';
import { formatCopyAll } from '@komaflow/page-view';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { fmtDate, t } from '../strings.js';
import { ErrorBox } from '../App.js';
import { useChapter } from './Chapter.js';
import { PageViewer, type PageViewerHandle } from '../components/PageViewer.js';
import { ObjectRow } from '../components/ObjectRow.js';
import { ExportPanel } from '../components/ExportPanel.js';

const SPLIT_KEY = 'komaflow:split';

export function PageScreen() {
  const { pageId } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const mobile = useIsMobile();
  const q = useQuery({
    queryKey: ['page', pageId],
    queryFn: () => api<PageDetailResponse>('GET', `/pages/${pageId}`),
    refetchInterval: 15_000,
  });
  const chapter = useChapter(q.data?.page.chapter_id, 60_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(true);
  const [showDeleted, setShowDeleted] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const viewer = useRef<PageViewerHandle>(null);
  const [split, setSplit] = useState(() => {
    try {
      return Number(localStorage.getItem(SPLIT_KEY)) || 0.5;
    } catch {
      return 0.5;
    }
  });

  const patch = useCallback(
    (id: string, base: number, changes: TextChanges) => api<ObjectDTO>('PATCH', `/objects/${id}`, { base_text_ver: base, changes }),
    [],
  );
  const onObject = useCallback(
    (o: ObjectDTO) => {
      qc.setQueryData<PageDetailResponse>(['page', pageId], (d) =>
        d
          ? {
              ...d,
              objects: d.objects.map((x) => (x.id === o.id ? o : x)),
              deleted_objects: d.deleted_objects.map((x) => (x.id === o.id ? o : x)),
            }
          : d,
      );
    },
    [qc, pageId],
  );

  const pages = chapter.data?.pages ?? [];
  const pos = pages.findIndex((p) => p.id === pageId);
  const goPage = useCallback(
    (dir: -1 | 1) => {
      const target = pages[pos + dir];
      if (target) nav(`/pages/${target.id}`);
    },
    [pages, pos, nav],
  );

  const onNav = useCallback((index: number, field: string) => {
    const row = document.querySelector<HTMLElement>(`.objects-live [data-obj-index="${index}"]`);
    if (!row) return;
    const el = row.querySelector<HTMLElement>(`[data-field="${field}"]`) ?? row.querySelector<HTMLElement>('[data-field="translation"]');
    el?.focus();
    row.scrollIntoView({ block: 'nearest' });
  }, []);

  const selectFromRow = useCallback((id: string) => {
    setSelected((cur) => {
      if (cur !== id) viewer.current?.centerOn(id);
      return id;
    });
  }, []);
  const selectFromViewer = useCallback((id: string) => {
    setSelected(id);
    document.querySelector(`[data-obj-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  // First visit: remember the current markup revision silently.
  const data = q.data;
  useEffect(() => {
    if (data && data.seen_markup_rev === null) {
      void api('PUT', `/pages/${data.page.id}/seen`, { markup_rev: data.page.markup_rev });
    }
  }, [data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      goPage(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPage]);

  const viewerObjects = useMemo(() => data?.objects.map((o) => ({ id: o.id, order: o.order, type: o.type, box: o.box })) ?? [], [data?.objects]);

  if (q.isPending) return <p className="center muted">{t.loading}</p>;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  const { page, objects, deleted_objects, revisions, seen_markup_rev } = q.data;

  const setTyped = async (typed: boolean) => {
    const r = await api<{ page: PageDTO }>('PUT', `/pages/${page.id}/typed`, { typed });
    qc.setQueryData<PageDetailResponse>(['page', pageId], (d) => (d ? { ...d, page: r.page } : d));
    void qc.invalidateQueries({ queryKey: ['chapter', page.chapter_id] });
  };
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(formatCopyAll(objects));
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    } catch {
      // clipboard blocked
    }
  };
  const ackMarkup = async () => {
    await api('PUT', `/pages/${page.id}/seen`, { markup_rev: page.markup_rev });
    await q.refetch();
    void qc.invalidateQueries({ queryKey: ['chapter', page.chapter_id] });
  };

  const changed = seen_markup_rev !== null && page.markup_rev > seen_markup_rev;
  const ch = chapter.data;

  const rows = (list: ObjectDTO[], deleted: boolean) =>
    list.map((o, i) => (
      <ObjectRow
        key={o.id}
        obj={o}
        index={i}
        selected={o.id === selected}
        mobile={mobile}
        deleted={deleted}
        onSelect={selectFromRow}
        onNav={onNav}
        onPageNav={goPage}
        patch={patch}
        onObject={onObject}
      />
    ));

  const viewerEl = (
    <PageViewer
      width={page.width}
      height={page.height}
      rawHash={page.raw_hash}
      cleanHash={page.clean_hash}
      notesHash={page.notes_hash}
      objects={viewerObjects}
      selectedId={selected}
      onSelect={selectFromViewer}
      handle={viewer}
    />
  );

  const table = (
    <div className="table-side">
      <div className="row wrap page-actions">
        <div className="crumbs">
          {ch && (
            <>
              <Link to={`/projects/${ch.project.id}`}>{ch.project.title}</Link> / <Link to={`/chapters/${ch.chapter.id}`}>{t.projects.chapter(ch.chapter.number)}</Link> /{' '}
            </>
          )}
          {t.chapter.page(page.idx)}
        </div>
        <span className="spacer" />
        <button onClick={() => void copyAll()} disabled={objects.length === 0}>
          {copiedAll ? t.page.copied : t.page.copyAll}
        </button>
        {!mobile && (
          <label className="check typed-toggle">
            <input type="checkbox" checked={page.typed} onChange={(e) => void setTyped(e.target.checked)} /> {t.page.typed}
          </label>
        )}
      </div>
      {changed && (
        <div className="banner" role="status">
          <strong>{t.banner.title}</strong>
          <ul>
            {revisions
              .filter((r) => r.rev > seen_markup_rev!)
              .map((r) => (
                <li key={r.rev}>
                  {t.banner.by(r.user_name, fmtDate(r.at))}: {describe(r.summary)}
                </li>
              ))}
          </ul>
          <button onClick={() => void ackMarkup()}>{t.banner.ok}</button>
        </div>
      )}
      {!mobile && <p className="hint">{t.page.keys}</p>}
      {objects.length === 0 ? (
        <p className="muted">{t.page.noObjects}</p>
      ) : (
        <div className={`objects objects-live${mobile ? ' cards' : ''}`} role="list">
          {!mobile && (
            <div className="obj obj-header" aria-hidden>
              <div>{t.page.columns.n}</div>
              <div>{t.page.columns.source}</div>
              <div>{t.page.columns.translation}</div>
              <div>{t.page.columns.state}</div>
              <div>{t.page.columns.comment}</div>
            </div>
          )}
          {rows(objects, false)}
        </div>
      )}
      {deleted_objects.length > 0 && (
        <details className="deleted-section" open={showDeleted} onToggle={(e) => setShowDeleted((e.target as HTMLDetailsElement).open)}>
          <summary>{t.page.deleted(deleted_objects.length)}</summary>
          {showDeleted && <div className={`objects${mobile ? ' cards' : ''}`}>{rows(deleted_objects, true)}</div>}
        </details>
      )}
      <ExportPanel chapterId={page.chapter_id} pageId={page.id} />
    </div>
  );

  if (mobile) {
    return (
      <div className="page-mobile">
        <div className={`mobile-viewer${viewerOpen ? '' : ' closed'}`}>
          {viewerOpen && viewerEl}
          <button className="small ghost viewer-toggle" onClick={() => setViewerOpen((v) => !v)}>
            {viewerOpen ? t.page.hidePage : t.page.showPage}
          </button>
        </div>
        {table}
        <nav className="bottom-bar">
          <button onClick={() => goPage(-1)} disabled={pos <= 0} aria-label={t.page.prev}>
            ←
          </button>
          <span>{pages.length ? t.page.of(pos + 1, pages.length) : t.chapter.page(page.idx)}</span>
          <button onClick={() => goPage(1)} disabled={pos < 0 || pos >= pages.length - 1} aria-label={t.page.next}>
            →
          </button>
          <label className="check">
            <input type="checkbox" checked={page.typed} onChange={(e) => void setTyped(e.target.checked)} /> {t.page.typed}
          </label>
        </nav>
      </div>
    );
  }

  return (
    <div className="page-split" style={{ gridTemplateColumns: `${split * 100}% 6px 1fr` }}>
      {viewerEl}
      <Divider
        onMove={(f) => {
          setSplit(f);
          try {
            localStorage.setItem(SPLIT_KEY, String(f));
          } catch {
            // ignore
          }
        }}
      />
      {table}
    </div>
  );
}

function describe(s: PageDetailResponse['revisions'][number]['summary']): string {
  const parts: string[] = [];
  if (s.added.length) parts.push(t.banner.added(s.added.length));
  if (s.moved.length) parts.push(t.banner.moved(s.moved.length));
  if (s.retyped.length) parts.push(t.banner.retyped(s.retyped.length));
  if (s.deleted.length) parts.push(t.banner.deleted(s.deleted.length));
  if (s.restored.length) parts.push(t.banner.restored(s.restored.length));
  if (s.reordered) parts.push(t.banner.reordered);
  if (s.clean_changed) parts.push(t.banner.clean);
  if (s.notes_changed) parts.push(t.banner.notes);
  return parts.join(', ') || '—';
}

function Divider({ onMove }: { onMove: (fraction: number) => void }) {
  return (
    <div
      className="divider"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        const parent = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        e.currentTarget.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => onMove(Math.min(0.8, Math.max(0.2, (ev.clientX - parent.left) / parent.width)));
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}
