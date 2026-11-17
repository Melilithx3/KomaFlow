import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import type { ObjectDTO, PageDetailResponse, PageDTO, TextChanges } from '@komaflow/contract';
import { changeCase, formatCopyAll, type CaseMode } from '@komaflow/page-view';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { fmtDate, t } from '../strings.js';
import { ErrorBox } from '../App.js';
import { useChapter } from './Chapter.js';
import { PageViewer, type PageViewerHandle } from '../components/PageViewer.js';
import { ObjectRow } from '../components/ObjectRow.js';
import { ExportPanel } from '../components/ExportPanel.js';
import { AiJson } from '../components/AiJson.js';
import { Icon } from '../components/Icon.js';

const SPLIT_KEY = 'komaflow:split';
const MOBILE_VIEW_KEY = 'komaflow:mobile-viewer';

const readLs = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const writeLs = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // ignore
  }
};

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
  const [viewerOpen, setViewerOpen] = useState(() => readLs(MOBILE_VIEW_KEY) !== '0');
  const [showDeleted, setShowDeleted] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const viewer = useRef<PageViewerHandle>(null);
  const [split, setSplit] = useState(() => Number(readLs(SPLIT_KEY)) || 0.48);

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
    const el = row.querySelector<HTMLElement>(`textarea[data-field="${field}"]`) ?? row.querySelector<HTMLElement>('[data-field="translation"]');
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
    if (data && data.seen_markup_rev === null) void api('PUT', `/pages/${data.page.id}/seen`, { markup_rev: data.page.markup_rev });
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

  const viewerObjects = useMemo(
    () => data?.objects.map((o) => ({ id: o.id, order: o.order, type: o.type, box: o.box, rotation: o.rotation ?? 0 })) ?? [],
    [data?.objects],
  );

  if (q.isPending) return <p className="center muted">{t.loading}</p>;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  const { page, objects, deleted_objects, revisions, seen_markup_rev } = q.data;
  const done = objects.filter((o) => o.state !== 'empty').length;

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
  const caseAll = async (mode: CaseMode) => {
    let n = 0;
    for (const o of objects) {
      const next = changeCase(o.source_text, mode);
      if (next === o.source_text) continue;
      try {
        onObject(await patch(o.id, o.text_ver, { source_text: next }));
        n++;
      } catch {
        // edited concurrently: leave it, the user sees the row
      }
    }
    setNotice(t.page.caseDone(n));
    setTimeout(() => setNotice(null), 2500);
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
      compact={mobile}
    />
  );

  const header = (
    <div className="page-head">
      <div className="crumbs">
        {ch && (
          <>
            <Link to={`/projects/${ch.project.id}`}>{ch.project.title}</Link>
            <Icon name="chevron" size={14} />
            <Link to={`/chapters/${ch.chapter.id}`}>{t.projects.chapter(ch.chapter.number)}</Link>
            <Icon name="chevron" size={14} />
          </>
        )}
        <strong>{t.chapter.page(page.idx)}</strong>
        {!mobile && pages.length > 0 && (
          <span className="pager">
            <button className="icon-btn" onClick={() => goPage(-1)} disabled={pos <= 0} aria-label={t.page.prev} title={`${t.page.prev} (Alt+←)`}>
              <Icon name="left" />
            </button>
            {t.page.of(pos + 1, pages.length)}
            <button className="icon-btn" onClick={() => goPage(1)} disabled={pos < 0 || pos >= pages.length - 1} aria-label={t.page.next} title={`${t.page.next} (Alt+→)`}>
              <Icon name="right" />
            </button>
          </span>
        )}
      </div>
      <div className="page-progress">
        <div className="bar">
          <span style={{ width: `${objects.length ? (100 * done) / objects.length : 100}%` }} />
        </div>
        <span className="muted">{t.page.progress(done, objects.length)}</span>
      </div>
      <div className="toolbar-row">
        <button onClick={() => void copyAll()} disabled={objects.length === 0}>
          <Icon name={copiedAll ? 'check' : 'copy'} size={16} /> {copiedAll ? t.page.copied : t.page.copyAll}
        </button>
        <select
          className="menu-select"
          aria-label={t.page.caseMenu}
          value=""
          onChange={(e) => {
            if (e.target.value) void caseAll(e.target.value as CaseMode);
          }}
          disabled={objects.length === 0}
        >
          <option value="">Aa {t.page.caseMenu}…</option>
          {(['sentence', 'lower', 'upper'] as const).map((m) => (
            <option key={m} value={m}>
              {t.page.caseModes[m]}
            </option>
          ))}
        </select>
        {ch && (
          <AiJson
            pageIds={[page.id]}
            chapterNumber={ch.chapter.number}
            sourceLang={ch.project.source_lang}
            targetLang={ch.project.target_lang}
            fileName={`komaflow-${ch.chapter.number}-${String(page.idx).padStart(3, '0')}.json`}
          />
        )}
        {!mobile && (
          <label className={`typed-toggle${page.typed ? ' on' : ''}`}>
            <input type="checkbox" checked={page.typed} onChange={(e) => void setTyped(e.target.checked)} /> <Icon name="check" size={16} /> {t.page.typed}
          </label>
        )}
      </div>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );

  const table = (
    <div className="table-side">
      {header}
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
        <p className="empty">{t.page.noObjects}</p>
      ) : (
        <div className={`objects objects-live${mobile ? ' cards' : ''}`} role="list">
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
        {/* the viewer stays pinned at the top while the cards scroll under it */}
        <div className={`mobile-viewer${viewerOpen ? '' : ' closed'}`}>
          {viewerOpen && viewerEl}
          <button
            className="viewer-toggle"
            onClick={() => {
              setViewerOpen((v) => {
                writeLs(MOBILE_VIEW_KEY, v ? '0' : '1');
                return !v;
              });
            }}
          >
            <Icon name={viewerOpen ? 'up' : 'image'} size={16} /> {viewerOpen ? t.page.hidePage : t.page.showPage}
          </button>
        </div>
        {table}
        <nav className="bottom-bar">
          <button onClick={() => goPage(-1)} disabled={pos <= 0} aria-label={t.page.prev}>
            <Icon name="left" />
          </button>
          <span>{pages.length ? t.page.of(pos + 1, pages.length) : t.chapter.page(page.idx)}</span>
          <button onClick={() => goPage(1)} disabled={pos < 0 || pos >= pages.length - 1} aria-label={t.page.next}>
            <Icon name="right" />
          </button>
          <label className={`typed-toggle${page.typed ? ' on' : ''}`}>
            <input type="checkbox" checked={page.typed} onChange={(e) => void setTyped(e.target.checked)} /> {t.page.typed}
          </label>
        </nav>
      </div>
    );
  }

  return (
    <div className="page-split" style={{ gridTemplateColumns: `${split * 100}% 6px minmax(0, 1fr)` }}>
      {viewerEl}
      <Divider
        onMove={(f) => {
          setSplit(f);
          writeLs(SPLIT_KEY, String(f));
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
        const move = (ev: PointerEvent) => onMove(Math.min(0.75, Math.max(0.25, (ev.clientX - parent.left) / parent.width)));
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
