import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, useParams, useSearchParams } from 'react-router';
import { readImageHeader, sha256Hex, type ObjectDTO, type PageDetailResponse, type PageReviewDTO, type PageSummary, type ReviewKind, type TextChanges } from '@komaflow/contract';
import { api, blobUrl, HttpError, uploadBlob } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { fmtDate, t } from '../strings.js';
import { ErrorBox } from '../App.js';
import { ObjectRow } from '../components/ObjectRow.js';
import { Icon } from '../components/Icon.js';
import { useChapter } from './Chapter.js';

type Tab = 'clean' | 'translation' | 'type';
const TABS: Tab[] = ['clean', 'translation', 'type'];

/**
 * «Редакция» of a chapter (ADR 0021): exactly three sub-tabs. Clean / type: the page image without UI or
 * box outlines, brush marks and a page comment (stored apart from the images). Translation: the existing
 * object rows (translation, flag, comment), the same data the translator sees.
 */
export function ReviewScreen() {
  const { chapterId, tab: tabParam } = useParams();
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'clean';
  const q = useChapter(chapterId);
  if (q.isPending) return <p className="center muted">{t.loading}</p>;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  const { chapter, project, pages } = q.data;
  return (
    <div className="page-pad review">
      <div className="screen-head">
        <div>
          <div className="crumbs">
            <Link to={`/projects/${project.id}`}>{project.title}</Link>
            <Icon name="chevron" size={14} />
            <Link to={`/chapters/${chapter.id}`}>{t.projects.chapter(chapter.number)}</Link>
            <Icon name="chevron" size={14} />
          </div>
          <h1>{t.review.tab}</h1>
        </div>
      </div>
      <nav className="seg review-tabs" aria-label={t.review.tab}>
        {TABS.map((x) => (
          <NavLink key={x} to={`/chapters/${chapter.id}/review/${x}`} className={({ isActive }) => (isActive || (x === 'clean' && !tabParam) ? 'active' : '')}>
            {t.review.tabs[x]}
          </NavLink>
        ))}
      </nav>
      {tab === 'translation' ? <TranslationReview pages={pages} /> : <MarksReview key={tab} kind={tab === 'clean' ? 'clean' : 'type'} pages={pages} />}
    </div>
  );
}

// ---------------------------------------------------------------- clean / type

function MarksReview({ kind, pages }: { kind: ReviewKind; pages: PageSummary[] }) {
  const [sp, setSp] = useSearchParams();
  const idx = Number(sp.get('p')) || pages[0]?.idx || 1;
  const page = pages.find((p) => p.idx === idx) ?? pages[0];
  const [uploadOpen, setUploadOpen] = useState(false);
  if (!page) return <p className="muted">{t.chapter.noPages}</p>;
  return (
    <div className="review-body">
      {kind === 'type' && (
        <div className="row">
          <button onClick={() => setUploadOpen(true)}>
            <Icon name="upload" size={16} /> {t.review.upload}
          </button>
        </div>
      )}
      <ul className="review-strip" aria-label="Страницы">
        {pages.map((p) => (
          <li key={p.id}>
            <button aria-pressed={p.id === page.id} onClick={() => setSp({ p: String(p.idx) }, { replace: true })} title={t.review.pageN(p.idx)}>
              <img src={blobUrl(kind === 'type' && p.typed_hash ? p.typed_hash : (p.thumb_hash ?? p.raw_hash))} alt="" loading="lazy" />
              <span>
                {p.idx}
                {kind === 'type' && (p.typed_hash ? ' ✓' : '')}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <PageMarks key={page.id} kind={kind} pageId={page.id} onNav={(d) => {
        const i = pages.findIndex((p) => p.id === page.id) + d;
        if (pages[i]) setSp({ p: String(pages[i]!.idx) }, { replace: true });
      }} />
      {uploadOpen && <TypedUpload pages={pages} onClose={() => setUploadOpen(false)} />}
    </div>
  );
}

function usePage(pageId: string) {
  return useQuery({ queryKey: ['page', pageId], queryFn: () => api<PageDetailResponse>('GET', `/pages/${pageId}`), refetchInterval: 30_000 });
}

async function canvasPng(c: HTMLCanvasElement): Promise<Uint8Array | null> {
  const g = c.getContext('2d')!;
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let any = false;
  for (let i = 3; i < d.length; i += 4)
    if (d[i]) {
      any = true;
      break;
    }
  if (!any) return null;
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

function PageMarks({ kind, pageId, onNav }: { kind: ReviewKind; pageId: string; onNav: (d: -1 | 1) => void }) {
  const qc = useQueryClient();
  const q = usePage(pageId);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<'brush' | 'eraser' | null>(null);
  const [size, setSize] = useState(12);
  const [showMarks, setShowMarks] = useState(true);
  const [comment, setComment] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<PageReviewDTO | null>(null);
  const base = useRef(0);
  const stroke = useRef<{ x: number; y: number } | null>(null);
  const review = q.data?.reviews.find((r) => r.kind === kind);
  const pg = q.data?.page;
  const image = pg ? (kind === 'clean' ? pg.clean_hash : pg.typed_hash) : null;

  /** Loads the saved review (marks + comment) into the editor. */
  const load = useCallback(async (r: PageReviewDTO) => {
    base.current = r.ver;
    setComment(r.comment);
    setDirty(false);
    const c = canvas.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    if (r.marks_hash) {
      const bmp = await createImageBitmap(await (await fetch(blobUrl(r.marks_hash))).blob());
      g.drawImage(bmp, 0, 0);
    }
  }, []);
  const loadedVer = useRef<number | null>(null);
  useEffect(() => {
    if (!review || !pg || dirty) return;
    if (loadedVer.current === review.ver) return;
    loadedVer.current = review.ver;
    void load(review);
  }, [review, pg, dirty, load]);

  const toImage = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height, k: c.width / r.width };
  };
  const dab = (from: { x: number; y: number }, to: { x: number; y: number }, k: number) => {
    const g = canvas.current!.getContext('2d')!;
    g.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    g.strokeStyle = '#ff1f4b';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = size * k;
    g.beginPath();
    g.moveTo(from.x, from.y);
    g.lineTo(to.x, to.y);
    g.stroke();
  };

  const save = async (baseVer = base.current) => {
    const c = canvas.current;
    if (!c) return;
    setBusy(true);
    setErr(null);
    try {
      const png = await canvasPng(c);
      let marks: string | null = null;
      if (png) {
        marks = sha256Hex(png);
        await uploadBlob(marks, png, 'image/png');
      }
      const r = await api<{ review: PageReviewDTO }>('PUT', `/pages/${pageId}/reviews/${kind}`, { base_ver: baseVer, marks_hash: marks, comment });
      base.current = r.review.ver;
      loadedVer.current = r.review.ver;
      setDirty(false);
      setConflict(null);
      qc.setQueryData<PageDetailResponse>(['page', pageId], (d) => (d ? { ...d, reviews: d.reviews.map((x) => (x.kind === kind ? r.review : x)) } : d));
    } catch (e) {
      if (e instanceof HttpError && e.code === 'REVISION_CONFLICT') setConflict((e.details as { review: PageReviewDTO }).review);
      else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (q.isPending) return <p className="muted">{t.loading}</p>;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  const p = q.data.page;
  return (
    <div className="marks-review">
      <div className="viewer-toolbar" role="toolbar">
        <button className="icon-btn" onClick={() => onNav(-1)} aria-label="Предыдущая страница">
          ‹
        </button>
        <strong>{t.review.pageN(p.idx)}</strong>
        <button className="icon-btn" onClick={() => onNav(1)} aria-label="Следующая страница">
          ›
        </button>
        <div className="seg" role="group">
          <button aria-pressed={tool === 'brush'} onClick={() => setTool(tool === 'brush' ? null : 'brush')} disabled={!image}>
            {t.review.brush}
          </button>
          <button aria-pressed={tool === 'eraser'} onClick={() => setTool(tool === 'eraser' ? null : 'eraser')} disabled={!image}>
            {t.review.eraser}
          </button>
        </div>
        <label className="check">
          {t.review.size} <input type="range" min={2} max={60} value={size} onChange={(e) => setSize(Number(e.target.value))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={showMarks} onChange={(e) => setShowMarks(e.target.checked)} /> {t.review.showMarks}
        </label>
        <button
          onClick={() => {
            const c = canvas.current;
            if (!c) return;
            c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
            setDirty(true);
          }}
          disabled={!image}
        >
          {t.review.clear}
        </button>
      </div>
      {image ? (
        <div className={`marks-stage${tool ? ' drawing' : ''}`}>
          <img src={blobUrl(image)} alt={t.review.pageN(p.idx)} draggable={false} />
          <canvas
            ref={canvas}
            width={p.width}
            height={p.height}
            style={{ visibility: showMarks ? 'visible' : 'hidden' }}
            onPointerDown={(e) => {
              if (!tool) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const pt = toImage(e);
              stroke.current = pt;
              dab(pt, pt, pt.k);
              setShowMarks(true);
              setDirty(true);
            }}
            onPointerMove={(e) => {
              if (!stroke.current) return;
              const pt = toImage(e);
              dab(stroke.current, pt, pt.k);
              stroke.current = pt;
            }}
            onPointerUp={() => (stroke.current = null)}
            onPointerCancel={() => (stroke.current = null)}
          />
        </div>
      ) : (
        <p className="muted">{kind === 'clean' ? t.review.noClean : t.review.noTyped}</p>
      )}
      <label className="review-comment">
        {t.review.comment}
        <textarea rows={3} value={comment} placeholder={t.review.commentPh} onChange={(e) => (setComment(e.target.value), setDirty(true))} />
      </label>
      <div className="row wrap">
        <button className="primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? t.review.saving : dirty ? t.review.save : t.review.saved}
        </button>
        {dirty && <span className="warn-text small">{t.review.unsaved}</span>}
        {review && review.updated_by_name && review.updated_at && <span className="muted small">{t.review.by(review.updated_by_name, fmtDate(review.updated_at))}</span>}
      </div>
      {err && <p className="error">{err}</p>}
      {conflict && (
        <div className="conflict-box" role="alert">
          <p>{t.review.conflict(conflict.updated_by_name ?? '—')}</p>
          <div className="row">
            <button
              onClick={() => {
                loadedVer.current = conflict.ver;
                setConflict(null);
                void load(conflict);
              }}
            >
              {t.review.takeTheirs}
            </button>
            <button className="primary" onClick={() => void save(conflict.ver)}>
              {t.review.keepMine}
            </button>
          </div>
        </div>
      )}
      <p className="muted small">{t.review.marksHint}</p>
    </div>
  );
}

// ---------------------------------------------------------------- translation

function TranslationReview({ pages }: { pages: PageSummary[] }) {
  return (
    <div className="review-body">
      <p className="muted small">{t.review.translationHint}</p>
      {pages.map((p) => (
        <details key={p.id} className="card review-page">
          <summary>
            <strong>{t.review.pageN(p.idx)}</strong> <span className="muted">{t.review.objects(p.counts.total)}</span>
            {p.flagged > 0 && <span className="badge flag">{t.review.flagged(p.flagged)}</span>}
          </summary>
          <PageObjects pageId={p.id} />
        </details>
      ))}
    </div>
  );
}

function PageObjects({ pageId }: { pageId: string }) {
  const qc = useQueryClient();
  const mobile = useIsMobile();
  const q = usePage(pageId);
  const [selected, setSelected] = useState<string | null>(null);
  const patch = useCallback((id: string, base: number, changes: TextChanges) => api<ObjectDTO>('PATCH', `/objects/${id}`, { base_text_ver: base, changes }), []);
  const onObject = useCallback(
    (o: ObjectDTO) => {
      qc.setQueryData<PageDetailResponse>(['page', pageId], (d) => (d ? { ...d, objects: d.objects.map((x) => (x.id === o.id ? o : x)) } : d));
      void qc.invalidateQueries({ queryKey: ['chapter'] });
    },
    [qc, pageId],
  );
  if (q.isPending) return <p className="muted">{t.loading}</p>;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  return (
    <div className={`objects objects-live${mobile ? ' cards' : ''}`} role="list">
      {q.data.objects.map((o, i) => (
        <ObjectRow key={o.id} obj={o} index={i} selected={o.id === selected} mobile={mobile} onSelect={setSelected} onNav={() => {}} onPageNav={() => {}} patch={patch} onObject={onObject} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- typed upload

interface UploadRow {
  file: File;
  bytes: Uint8Array;
  page: PageSummary | null;
  status: 'new' | 'replace' | 'same' | 'nopage' | 'nonumber' | 'duplicate';
  size: { width: number; height: number } | null;
  hash: string;
  on: boolean;
}

/** Last number in the file name: «page_012.png» → 12. */
const numberOf = (name: string) => {
  const m = name.replace(/\.[^.]+$/, '').match(/(\d+)(?!.*\d)/);
  return m ? Number(m[1]) : null;
};

function TypedUpload({ pages, onClose }: { pages: PageSummary[]; onClose: () => void }) {
  const qc = useQueryClient();
  const ref = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<UploadRow[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
  }, []);

  const pick = async (files: FileList | null) => {
    const list = [...(files ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const seen = new Set<string>();
    const out: UploadRow[] = [];
    for (const file of list) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const h = readImageHeader(bytes);
      const n = numberOf(file.name);
      const page = n === null ? null : (pages.find((p) => p.idx === n) ?? null);
      const hash = sha256Hex(bytes);
      let status: UploadRow['status'] = n === null ? 'nonumber' : !page ? 'nopage' : seen.has(page.id) ? 'duplicate' : page.typed_hash === hash ? 'same' : page.typed_hash ? 'replace' : 'new';
      if (!h && status !== 'nonumber') status = 'nopage';
      if (page && status !== 'duplicate') seen.add(page.id);
      // replacing an uploaded page is opt-in: nothing is overwritten silently
      out.push({ file, bytes, page, status, size: h ? { width: h.width, height: h.height } : null, hash, on: status === 'new' });
    }
    setRows(out);
  };

  const todo = rows?.filter((r) => r.on && (r.status === 'new' || r.status === 'replace')) ?? [];
  const apply = async () => {
    setProgress({ done: 0, total: todo.length, failed: 0 });
    let failed = 0;
    for (const [i, r] of todo.entries()) {
      try {
        await uploadBlob(r.hash, r.bytes, readImageHeader(r.bytes)!.mime);
        await api('PUT', `/pages/${r.page!.id}/typed-image`, { hash: r.hash });
      } catch {
        failed++;
      }
      setProgress({ done: i + 1, total: todo.length, failed });
    }
    await qc.invalidateQueries({ queryKey: ['chapter'] });
    await qc.invalidateQueries({ queryKey: ['page'] });
  };

  const label: Record<UploadRow['status'], string> = {
    new: t.review.stNew,
    replace: t.review.stReplace,
    same: t.review.stSame,
    nopage: t.review.stNoPage,
    nonumber: t.review.stNoNumber,
    duplicate: t.review.stDuplicate,
  };
  return (
    <dialog ref={ref} className="dialog wide" onCancel={onClose} aria-label={t.review.uploadTitle}>
      <div className="dialog-head">
        <h2>{t.review.uploadTitle}</h2>
        <button className="icon-btn" onClick={onClose} aria-label={t.close}>
          <Icon name="close" />
        </button>
      </div>
      {!progress && (
        <>
          <p className="muted">{t.review.uploadText}</p>
          <label className="file-btn">
            <Icon name="upload" size={16} /> {t.review.pick}
            <input type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(e) => void pick(e.target.files)} />
          </label>
          {rows && (
            <div className="preview-table">
              <table>
                <thead>
                  <tr>
                    <th />
                    <th>{t.review.file}</th>
                    <th>{t.review.target}</th>
                    <th>{t.review.status}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const can = r.status === 'new' || r.status === 'replace';
                    const sizeOff = r.page && r.size && (r.size.width !== r.page.width || r.size.height !== r.page.height);
                    return (
                      <tr key={i} className={can ? '' : 'muted'}>
                        <td>
                          <input
                            type="checkbox"
                            disabled={!can}
                            checked={r.on && can}
                            onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))}
                            aria-label={r.file.name}
                          />
                        </td>
                        <td>{r.file.name}</td>
                        <td>{r.page ? t.review.pageN(r.page.idx) : '—'}</td>
                        <td className={r.status === 'replace' ? 'warn-text' : ''}>
                          {label[r.status]}
                          {sizeOff && r.size && r.page && <span className="warn-text"> · {t.review.stSize(r.size.width, r.size.height, r.page.width, r.page.height)}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="dialog-actions">
            <button className="primary" disabled={todo.length === 0} onClick={() => void apply()}>
              {t.review.apply(todo.length)}
            </button>
          </div>
        </>
      )}
      {progress && (
        <div role="status">
          <p>
            {progress.done < progress.total ? t.review.uploading(progress.done, progress.total) : t.review.uploaded(progress.done - progress.failed)}
            {progress.failed > 0 && <span className="warn-text"> {t.review.failed(progress.failed)}</span>}
          </p>
          <progress max={Math.max(1, progress.total)} value={progress.done} />
          {progress.done >= progress.total && (
            <div className="dialog-actions">
              <button className="primary" onClick={onClose}>
                {t.close}
              </button>
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
