import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { OBJECT_TYPES } from '@komaflow/contract';
import { TYPE_STYLE } from '@komaflow/page-view';
import {
  ApplyAnalysis,
  AutoOrder,
  DeleteObject,
  MoveInOrder,
  Reorder,
  SetBox,
  SetSourceText,
  SetType,
  replacedByAnalysis,
} from '../core/commands.js';
import { OBJECT_TYPE_KEYS, type LocalPage, type Workspace } from '../core/model.js';
import { refreshWebData } from '../core/publish.js';
import { ocrBlocker, analysisBlocker, type AnalyzeResult } from '../core/sidecar.js';
import { Store } from '../core/store.js';
import { autosaver, pageStatus } from '../core/workspace.js';
import type { AppCtx } from './App.js';
import { Canvas, type Tool } from './Canvas.js';
import { ImportDialog, PublishDialog } from './Dialogs.js';

export function Editor({ ctx, initial, onClose }: { ctx: AppCtx; initial: Workspace; onClose: () => void }) {
  const store = useMemo(() => new Store(initial), [initial]);
  const state = useSyncExternalStore(store.subscribe, store.get);
  const { ws, sel } = state;
  const page = ws.pages.find((p) => p.id === sel.pageId) ?? ws.pages[0]!;
  const selected = page.objects.find((o) => o.id === sel.objectId) ?? null;
  const [tool, setTool] = useState<Tool>('select');
  const [showClean, setShowClean] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);
  const [dialog, setDialog] = useState<null | 'clean' | 'notes' | 'publish'>(null);
  const [task, setTask] = useState<{ label: string; done: number; total: number; cancel?: () => void } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const orderSeq = useRef<string[]>([]);

  // autosave (~1 s debounce, atomic writes, only changed pages)
  const saver = useMemo(() => autosaver(ctx.host, 1000, (e) => setMessage(`Не удалось сохранить: ${e instanceof Error ? e.message : e}`)), [ctx.host]);
  useEffect(() => store.subscribe(() => saver.schedule(store.get().ws)), [store, saver]);
  useEffect(() => () => void saver.flush(), [saver]);

  // flags and comments from the web every ~60 s while the window is active (docs/05 §4.5)
  useEffect(() => {
    if (!ws.server || !ctx.api.authed) return;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const next = await refreshWebData(ctx.api, store.get().ws);
        if (next !== store.get().ws) store.patch(() => next);
      } catch {
        // offline: try again later
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 60_000);
    return () => clearInterval(t);
  }, [ws.server, ctx.api, store]);

  const goPage = useCallback(
    (d: -1 | 1) => {
      const i = ws.pages.findIndex((p) => p.id === page.id);
      const next = ws.pages[i + d];
      if (next) store.select({ pageId: next.id });
    },
    [ws.pages, page.id, store],
  );

  const runAnalysis = useCallback(
    async (pages: LocalPage[]) => {
      const blocker = analysisBlocker(ctx.caps);
      if (blocker || !ctx.sidecar) return setMessage(blocker);
      const replaced = pages.reduce((n, p) => n + replacedByAnalysis(p), 0);
      if (replaced > 0 && !window.confirm(`Повторный анализ заменит ${replaced} автоматических нетронутых боксов. Ручные и изменённые останутся. Продолжить?`)) return;
      const sc = ctx.sidecar;
      const jobId = await sc.analyze(
        pages.map((p) => ({ page_id: p.id, image_path: p.raw.path })),
        { backend: ctx.settings.backend, ocr_padding_px: ctx.settings.ocrPaddingPx, layout_threshold: ctx.settings.layoutThreshold },
      );
      setTask({ label: 'Анализ', done: 0, total: pages.length, cancel: () => void sc.cancel(jobId) });
      try {
        const j = await sc.wait<AnalyzeResult>(jobId, (x) =>
          setTask((t) => t && { ...t, label: x.stage === 'ocr' ? 'OCR' : x.stage === 'layout' ? 'Разметка' : 'Анализ', done: x.progress.done, total: x.progress.total }),
        );
        if (j.state === 'done' && j.result) {
          for (const r of j.result.pages) store.exec(ApplyAnalysis(r.page_id, r.objects, ws.reading_direction));
          store.patch((w) => ({ ...w, pages: w.pages.map((p) => (j.result!.pages.some((r) => r.page_id === p.id) ? { ...p, analyzed: true } : p)) }));
          if (j.result.warnings.length) setMessage(j.result.warnings.join('; '));
        } else if (j.state === 'failed') setMessage(`Анализ не удался: ${j.error}`);
      } finally {
        setTask(null);
      }
    },
    [ctx, store, ws.reading_direction],
  );

  const rereadOcr = async () => {
    const block = ocrBlocker(ctx.caps);
    if (block || !ctx.sidecar || !selected) return setMessage(block);
    const sc = ctx.sidecar;
    const id = await sc.ocrBoxes(page.raw.path, [{ id: selected.id, box: selected.box }], {
      backend: ctx.settings.backend,
      ocr_padding_px: ctx.settings.ocrPaddingPx,
      layout_threshold: null,
    });
    setTask({ label: 'OCR', done: 0, total: 1, cancel: () => void sc.cancel(id) });
    try {
      const j = await sc.wait<{ results: Array<{ id: string; source_text: string }> }>(id, () => {});
      const r = j.result?.results[0];
      if (r) store.exec(SetSourceText(page.id, r.id, r.source_text));
      else if (j.error) setMessage(j.error);
    } finally {
      setTask(null);
    }
  };

  // keyboard shortcuts (docs/05 §2)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      const k = e.key;
      if (e.ctrlKey && (k === 'z' || k === 'я')) return e.preventDefault(), store.undo();
      if (e.ctrlKey && (k === 'y' || k === 'н')) return e.preventDefault(), store.redo();
      if (e.ctrlKey && (k === 's' || k === 'ы')) return e.preventDefault(), void saver.flush().then(() => setMessage('Сохранено'));
      if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
      // read the store, not the render closure: keys may arrive before React re-renders
      const cur = store.get();
      const page = cur.ws.pages.find((p) => p.id === cur.sel.pageId) ?? cur.ws.pages[0]!;
      const selected = page.objects.find((o) => o.id === cur.sel.objectId) ?? null;
      const code = e.code;
      if (code === 'KeyV') setTool('select');
      else if (code === 'KeyR') setTool('draw');
      else if (code === 'KeyO') {
        orderSeq.current = [];
        setTool((t) => (t === 'order' ? 'select' : 'order'));
      } else if (code === 'KeyA') store.exec(AutoOrder(page, ws.reading_direction));
      else if (code === 'KeyF') setFitSignal((n) => n + 1);
      else if (code === 'BracketLeft') goPage(-1);
      else if (code === 'BracketRight') goPage(1);
      else if (OBJECT_TYPE_KEYS[k] && selected) store.exec(SetType(page.id, selected.id, OBJECT_TYPE_KEYS[k]!));
      else if ((k === 'Delete' || k === 'Backspace') && selected) store.exec(DeleteObject(page.id, selected.id));
      else if (k.startsWith('Arrow') && selected) {
        e.preventDefault();
        const s = e.shiftKey ? 10 : 1;
        const d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[k] as [number, number];
        const b = selected.box;
        store.exec(SetBox(page.id, selected.id, { ...b, x: Math.min(Math.max(0, b.x + d[0]), page.width - b.w), y: Math.min(Math.max(0, b.y + d[1]), page.height - b.h) }, 'keys'));
      } else return;
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => e.key.startsWith('Arrow') && store.endGesture();
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', up);
    };
  }, [store, ws.reading_direction, goPage, saver]);

  // order mode: clicks assign 1, 2, 3… in sequence (remaining objects keep their relative order)
  const onOrderClick = (id: string) => {
    if (orderSeq.current.includes(id)) return;
    orderSeq.current = [...orderSeq.current, id];
    const rest = page.objects.map((o) => o.id).filter((x) => !orderSeq.current.includes(x));
    store.exec(Reorder(page.id, [...orderSeq.current, ...rest], 'Порядок кликами'));
    if (rest.length === 0) {
      orderSeq.current = [];
      setTool('select');
    }
  };

  const analysisOff = analysisBlocker(ctx.caps);
  const st = pageStatus(page);

  return (
    <div className="editor">
      <header className="toolbar">
        <button
          onClick={async () => {
            await saver.flush();
            onClose();
          }}
        >
          ← Главы
        </button>
        <strong className="title">{ws.title}</strong>
        <div className="seg" role="group" aria-label="Инструмент">
          <button aria-pressed={tool === 'select'} onClick={() => setTool('select')} title="Выбор (V)">
            Выбор
          </button>
          <button aria-pressed={tool === 'draw'} onClick={() => setTool('draw')} title="Рисовать бокс (R)">
            Бокс
          </button>
          <button aria-pressed={tool === 'order'} onClick={() => ((orderSeq.current = []), setTool(tool === 'order' ? 'select' : 'order'))} title="Порядок кликами (O)">
            Порядок
          </button>
        </div>
        <button onClick={() => store.exec(AutoOrder(page, ws.reading_direction))} title="Авто-порядок (A)">
          Авто-порядок
        </button>
        <button onClick={() => store.undo()} disabled={!store.canUndo()} title="Отменить (Ctrl+Z)">
          ↶
        </button>
        <button onClick={() => store.redo()} disabled={!store.canRedo()} title="Повторить (Ctrl+Y)">
          ↷
        </button>
        <span className="sep" />
        <button disabled={!!analysisOff || !!task} title={analysisOff ?? ''} onClick={() => void runAnalysis([page])}>
          Анализ страницы
        </button>
        <button disabled={!!analysisOff || !!task} title={analysisOff ?? ''} onClick={() => void runAnalysis(ws.pages)}>
          Анализ главы
        </button>
        <button onClick={() => setDialog('clean')}>Импорт клина</button>
        <button onClick={() => setDialog('notes')}>Импорт пометок</button>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={showClean} disabled={!page.clean} onChange={(e) => setShowClean(e.target.checked)} /> клин
        </label>
        <button onClick={() => setFitSignal((n) => n + 1)} title="Вписать (F)">
          Вписать
        </button>
        <button className="primary" onClick={() => setDialog('publish')} disabled={!ctx.api.authed} title={ctx.api.authed ? '' : 'Войдите на сервер'}>
          Опубликовать
        </button>
      </header>

      {(task || message) && (
        <div className="statusbar" role="status">
          {task && (
            <>
              {task.label}: {task.done}/{task.total} <progress max={Math.max(1, task.total)} value={task.done} />
              {task.cancel && <button onClick={task.cancel}>Отмена</button>}
            </>
          )}
          {message && (
            <>
              <span>{message}</span> <button className="link" onClick={() => setMessage(null)}>×</button>
            </>
          )}
        </div>
      )}

      <aside className="pages" aria-label="Страницы">
        {ws.pages.map((p) => {
          const s = pageStatus(p);
          return (
            <button key={p.id} className={`page-item${p.id === page.id ? ' active' : ''}`} onClick={() => store.select({ pageId: p.id })}>
              <img src={ctx.host.fileUrl((p.thumb ?? p.raw).path)} alt="" loading="lazy" />
              <span>
                {p.idx}. {p.objects.length} об.
              </span>
              <span className="marks">
                {s.analyzed && <i title="проанализирована">A</i>}
                {s.hasClean && <i title="есть клин">C</i>}
                {s.published && <i title="опубликована">↑</i>}
                {s.changedSincePublish && <i className="warn" title="изменена после публикации">●</i>}
                {p.objects.some((o) => o.web?.flagged) && <i className="flag" title="флажок из веба">⚑</i>}
              </span>
            </button>
          );
        })}
      </aside>

      <main className="stage">
        <Canvas
          store={store}
          page={page}
          imageUrl={ctx.host.fileUrl(page.raw.path)}
          cleanUrl={page.clean ? ctx.host.fileUrl(page.clean.path) : null}
          showClean={showClean && !!page.clean}
          selectedId={sel.objectId}
          tool={tool}
          onOrderClick={onOrderClick}
          fitSignal={fitSignal}
        />
        <div className="stage-info">
          Стр. {page.idx} · {page.width}×{page.height} · {st.published ? (st.changedSincePublish ? 'изменена после публикации' : 'опубликована') : 'не опубликована'}
          {tool === 'order' && ' · Порядок: щёлкайте боксы по очереди'}
        </div>
      </main>

      <aside className="side">
        <ol className="objects" aria-label="Объекты">
          {page.objects.map((o, i) => (
            <li
              key={o.id}
              className={o.id === sel.objectId ? 'active' : ''}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/plain', o.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                store.exec(MoveInOrder(page, e.dataTransfer.getData('text/plain'), i));
              }}
              onClick={() => store.select({ objectId: o.id })}
            >
              <span className={`num shape-${TYPE_STYLE[o.type].shape}`} style={{ background: TYPE_STYLE[o.type].color }}>
                {i + 1}
              </span>
              <span className="otext">{o.source_text || <em className="muted">{TYPE_STYLE[o.type].label}</em>}</span>
              {o.web?.flagged && <span className="flag">⚑</span>}
            </li>
          ))}
        </ol>
        {selected && (
          <div className="inspector">
            <label>
              Тип{' '}
              <select value={selected.type} onChange={(e) => store.exec(SetType(page.id, selected.id, e.target.value as (typeof OBJECT_TYPES)[number]))}>
                {OBJECT_TYPES.map((t, i) => (
                  <option key={t} value={t}>
                    {i + 1}. {TYPE_STYLE[t].label}
                  </option>
                ))}
              </select>
            </label>
            <div className="muted small">
              x {selected.box.x}, y {selected.box.y}, {selected.box.w}×{selected.box.h}
              {selected.origin === 'auto' && ` · авто${selected.score ? ` ${selected.score.toFixed(2)}` : ''}${selected.touched ? ', изменён' : ''}`}
            </div>
            <label>
              Оригинальный текст
              <textarea lang="ja" rows={4} value={selected.source_text} onChange={(e) => store.exec(SetSourceText(page.id, selected.id, e.target.value))} onBlur={() => store.endGesture()} />
            </label>
            <button disabled={!!ocrBlocker(ctx.caps) || !!task} title={ocrBlocker(ctx.caps) ?? ''} onClick={() => void rereadOcr()}>
              Перечитать OCR
            </button>
            {selected.web && (
              <div className="web">
                {selected.web.flagged && <p className="flag">⚑ Флажок из веба</p>}
                {selected.web.comment && <p>Комментарий: {selected.web.comment}</p>}
                {selected.web.translation && <p className="muted">Перевод: {selected.web.translation}</p>}
              </div>
            )}
          </div>
        )}
      </aside>

      {dialog === 'clean' || dialog === 'notes' ? (
        <ImportDialog ctx={ctx} kind={dialog} store={store} onClose={() => setDialog(null)} />
      ) : dialog === 'publish' ? (
        <PublishDialog ctx={ctx} store={store} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}
