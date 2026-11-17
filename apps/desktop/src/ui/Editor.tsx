import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { OBJECT_TYPES } from '@komaflow/contract';
import { changeCase, TYPE_STYLE } from '@komaflow/page-view';
import {
  ApplyAnalysis,
  ApplyOcr,
  AutoOrder,
  DeleteObject,
  MoveInOrder,
  Reorder,
  SetBox,
  SetRotation,
  SetSourceText,
  SetType,
  replacedByAnalysis,
} from '../core/commands.js';
import { OBJECT_TYPE_KEYS, type LocalPage, type Workspace } from '../core/model.js';
import { refreshWebData } from '../core/publish.js';
import { ocrBlocker, analysisBlocker, type AnalyzeResult, type OcrBatchResult } from '../core/sidecar.js';
import { Store } from '../core/store.js';
import { autosaver, pageStatus } from '../core/workspace.js';
import type { AppCtx } from './App.js';
import { Canvas, type Tool } from './Canvas.js';
import { ImportDialog, Modal, PublishDialog } from './Dialogs.js';
import { LayoutSettings } from './LayoutSettings.js';
import { sidecarOptions } from './session.js';

type Dialog = null | 'clean' | 'notes' | 'publish' | 'layout';

export function Editor({ ctx, initial, onClose }: { ctx: AppCtx; initial: Workspace; onClose: () => void }) {
  const store = useMemo(() => new Store(initial), [initial]);
  const state = useSyncExternalStore(store.subscribe, store.get);
  const { ws, sel } = state;
  const page = ws.pages.find((p) => p.id === sel.pageId) ?? ws.pages[0]!;
  const selected = page.objects.find((o) => o.id === sel.objectId) ?? null;
  const [tool, setTool] = useState<Tool>('select');
  const [showClean, setShowClean] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [task, setTask] = useState<{ label: string; done: number; total: number; cancel?: () => void } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const orderSeq = useRef<string[]>([]);
  const sourceRef = useRef<HTMLTextAreaElement>(null);

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
      const cur = store.get();
      const i = cur.ws.pages.findIndex((p) => p.id === cur.sel.pageId);
      const next = cur.ws.pages[i + d];
      if (next) store.select({ pageId: next.id });
    },
    [store],
  );

  /** Step 1: layout only (boxes), so the cleaner can fix overlaps, duplicates and misses before OCR. */
  const runLayout = useCallback(
    async (pages: LocalPage[]) => {
      const blocker = analysisBlocker(ctx.caps);
      if (blocker || !ctx.sidecar) return setMessage(blocker);
      const replaced = pages.reduce((n, p) => n + replacedByAnalysis(p), 0);
      if (replaced > 0 && !window.confirm(`Повторная разметка заменит ${replaced} автоматических нетронутых боксов. Ручные и изменённые останутся. Продолжить?`)) return;
      const sc = ctx.sidecar;
      const jobId = await sc.analyze(
        pages.map((p) => ({ page_id: p.id, image_path: p.raw.path })),
        sidecarOptions(ctx.settings, ['layout']),
      );
      setTask({ label: 'Разметка', done: 0, total: pages.length, cancel: () => void sc.cancel(jobId) });
      try {
        const j = await sc.wait<AnalyzeResult>(jobId, (x) => setTask((t) => t && { ...t, done: x.progress.done, total: x.progress.total || t.total }));
        if (j.state === 'done' && j.result) {
          for (const r of j.result.pages) store.exec(ApplyAnalysis(r.page_id, r.objects, store.get().ws.reading_direction));
          store.patch((w) => ({ ...w, pages: w.pages.map((p) => (j.result!.pages.some((r) => r.page_id === p.id) ? { ...p, analyzed: true } : p)) }));
          setMessage('Разметка готова. Поправьте боксы и запустите OCR.');
        } else if (j.state === 'failed') setMessage(`Разметка не удалась: ${j.error}`);
      } finally {
        setTask(null);
      }
    },
    [ctx, store],
  );

  /** Step 2: OCR of the existing (corrected) boxes, rotated ones straightened. */
  const runOcr = useCallback(
    async (pages: LocalPage[], onlyIds?: string[]) => {
      const blocker = ocrBlocker(ctx.caps);
      if (blocker || !ctx.sidecar) return setMessage(blocker);
      const onlyEmpty = !onlyIds && ctx.settings.ocrOnlyEmpty;
      const req = pages
        .map((p) => ({
          page_id: p.id,
          image_path: p.raw.path,
          boxes: p.objects
            .filter((o) => (onlyIds ? onlyIds.includes(o.id) : !onlyEmpty || !o.source_text.trim()))
            .map((o) => ({ id: o.id, box: o.box, rotation: o.rotation ?? 0 })),
        }))
        .filter((p) => p.boxes.length > 0);
      const total = req.reduce((n, p) => n + p.boxes.length, 0);
      if (total === 0) return setMessage(onlyEmpty ? 'Нет боксов с пустым оригиналом.' : 'Нет боксов для OCR.');
      const sc = ctx.sidecar;
      const jobId = await sc.ocrBatch(req, sidecarOptions(ctx.settings));
      setTask({ label: 'OCR', done: 0, total, cancel: () => void sc.cancel(jobId) });
      try {
        const j = await sc.wait<OcrBatchResult>(jobId, (x) => setTask((t) => t && { ...t, done: x.progress.done, total: x.progress.total || t.total }));
        if (j.state === 'done' && j.result) {
          for (const r of j.result.pages) store.exec(ApplyOcr(r.page_id, new Map(r.results.map((x) => [x.id, x.source_text]))));
          setMessage(`OCR готов: ${total} боксов.`);
        } else if (j.state === 'failed') setMessage(`OCR не удался: ${j.error}`);
      } finally {
        setTask(null);
      }
    },
    [ctx, store],
  );

  // keyboard shortcuts (docs/05 §2)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      const k = e.key;
      if (e.ctrlKey && (k === 'z' || k === 'я') && !typing) return e.preventDefault(), store.undo();
      if (e.ctrlKey && (k === 'y' || k === 'н') && !typing) return e.preventDefault(), store.redo();
      if (e.ctrlKey && (k === 's' || k === 'ы')) return e.preventDefault(), void saver.flush().then(() => setMessage('Сохранено'));
      if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
      // read the store, not the render closure: keys may arrive before React re-renders
      const cur = store.get();
      const pg = cur.ws.pages.find((p) => p.id === cur.sel.pageId) ?? cur.ws.pages[0]!;
      const so = pg.objects.find((o) => o.id === cur.sel.objectId) ?? null;
      const code = e.code;
      if (code === 'KeyV') setTool('select');
      else if (code === 'KeyR') setTool('draw');
      else if (code === 'KeyO') {
        orderSeq.current = [];
        setTool((t) => (t === 'order' ? 'select' : 'order'));
      } else if (code === 'KeyA') store.exec(AutoOrder(pg, cur.ws.reading_direction));
      else if (code === 'KeyF') setFitSignal((n) => n + 1);
      else if (code === 'BracketLeft') goPage(-1);
      else if (code === 'BracketRight') goPage(1);
      else if (code === 'Enter' && so) sourceRef.current?.focus();
      else if (code === 'Tab' && pg.objects.length && (e.target === document.body || e.target instanceof HTMLCanvasElement)) {
        const i = pg.objects.findIndex((o) => o.id === so?.id);
        const n = pg.objects[(i + (e.shiftKey ? -1 : 1) + pg.objects.length) % pg.objects.length]!;
        store.select({ objectId: n.id });
      } else if (OBJECT_TYPE_KEYS[k] && so) store.exec(SetType(pg.id, so.id, OBJECT_TYPE_KEYS[k]!));
      else if ((k === 'Delete' || k === 'Backspace') && so) store.exec(DeleteObject(pg.id, so.id));
      else if ((code === 'KeyQ' || code === 'KeyE') && so) {
        const step = e.shiftKey ? 15 : 1;
        store.exec(SetRotation(pg.id, so.id, (so.rotation ?? 0) + (code === 'KeyQ' ? -step : step), 'keys'));
      } else if (k.startsWith('Arrow') && so) {
        const s = e.shiftKey ? 10 : 1;
        const d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[k] as [number, number];
        const b = so.box;
        store.exec(SetBox(pg.id, so.id, { ...b, x: Math.min(Math.max(0, b.x + d[0]), pg.width - b.w), y: Math.min(Math.max(0, b.y + d[1]), pg.height - b.h) }, 'keys'));
      } else return;
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.startsWith('Arrow') || e.code === 'KeyQ' || e.code === 'KeyE') store.endGesture();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', up);
    };
  }, [store, goPage, saver]);

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

  /** Enter in the original → next object's original (Shift+Enter = new line). */
  const sourceKeys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    store.endGesture();
    const i = page.objects.findIndex((o) => o.id === selected?.id);
    const next = page.objects[i + 1];
    if (next) {
      store.select({ objectId: next.id });
      requestAnimationFrame(() => sourceRef.current?.focus());
    } else sourceRef.current?.blur();
  };

  const layoutOff = analysisBlocker(ctx.caps);
  const ocrOff = ocrBlocker(ctx.caps);
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
        <strong className="title" title={ws.title}>
          {ws.title}
        </strong>
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
        <button onClick={() => store.undo()} disabled={!store.canUndo()} title="Отменить (Ctrl+Z)" aria-label="Отменить">
          ↶
        </button>
        <button onClick={() => store.redo()} disabled={!store.canRedo()} title="Повторить (Ctrl+Y)" aria-label="Повторить">
          ↷
        </button>
        <span className="sep" />
        <div className="group" role="group" aria-label="Анализ">
          <span className="group-label">1. Разметка</span>
          <button disabled={!!layoutOff || !!task} title={layoutOff ?? 'Найти боксы на странице'} onClick={() => void runLayout([page])}>
            стр.
          </button>
          <button disabled={!!layoutOff || !!task} title={layoutOff ?? 'Найти боксы на всех страницах'} onClick={() => void runLayout(ws.pages)}>
            глава
          </button>
          <button onClick={() => setDialog('layout')} title="Параметры разметки по классам" aria-label="Параметры разметки">
            ⚙
          </button>
        </div>
        <div className="group" role="group" aria-label="OCR">
          <span className="group-label">2. OCR</span>
          <button disabled={!!ocrOff || !!task} title={ocrOff ?? 'Распознать текст в боксах страницы'} onClick={() => void runOcr([page])}>
            стр.
          </button>
          <button disabled={!!ocrOff || !!task} title={ocrOff ?? 'Распознать текст во всей главе'} onClick={() => void runOcr(ws.pages)}>
            глава
          </button>
        </div>
        <span className="sep" />
        <button onClick={() => setDialog('clean')}>Клин…</button>
        <button onClick={() => setDialog('notes')}>Пометки…</button>
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
              <span>{message}</span>
              <button className="link" onClick={() => setMessage(null)} aria-label="Скрыть">
                ×
              </button>
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
              <span className="page-item-row">
                <b>{p.idx}</b> <span className="muted">{p.objects.length} об.</span>
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
        <div className="stage-help">Колесо — прокрутка · Shift+колесо — вбок · Ctrl+колесо — масштаб · Q/E — поворот</div>
      </main>

      <aside className="side">
        <div className="side-head">
          <strong>Объекты ({page.objects.length})</strong>
          <span className="muted small">перетащите или впишите номер</span>
        </div>
        <ol className="objects" aria-label="Объекты" onDragLeave={() => setDropAt(null)}>
          {page.objects.map((o, i) => (
            <li
              key={o.id}
              className={`${o.id === sel.objectId ? 'active' : ''}${dropAt === i ? ' drop-before' : ''}${dropAt === i + 1 && i === page.objects.length - 1 ? ' drop-after' : ''}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', o.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setDropAt(e.clientY > r.top + r.height / 2 ? i + 1 : i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('text/plain');
                const from = page.objects.findIndex((x) => x.id === id);
                const to = dropAt ?? i;
                setDropAt(null);
                if (from >= 0) store.exec(MoveInOrder(page, id, to > from ? to - 1 : to));
              }}
              onDragEnd={() => setDropAt(null)}
              onClick={() => store.select({ objectId: o.id })}
            >
              <OrderNumber
                n={i + 1}
                max={page.objects.length}
                color={TYPE_STYLE[o.type].color}
                shape={TYPE_STYLE[o.type].shape}
                onChange={(n) => store.exec(MoveInOrder(page, o.id, n - 1))}
              />
              <span className="otext">{o.source_text || <em className="muted">{TYPE_STYLE[o.type].label}</em>}</span>
              {(o.rotation ?? 0) !== 0 && <span className="muted small">{o.rotation}°</span>}
              {o.web?.flagged && <span className="flag">⚑</span>}
            </li>
          ))}
        </ol>
        {selected && (
          <div className="inspector">
            <div className="row">
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
              <label title="Поворот: Q / E (Shift — по 15°), или тяните кружок над боксом">
                Поворот, °{' '}
                <input
                  type="number"
                  min={-180}
                  max={180}
                  value={selected.rotation ?? 0}
                  onChange={(e) => store.exec(SetRotation(page.id, selected.id, Number(e.target.value), 'input'))}
                  onBlur={() => store.endGesture()}
                  className="num-input"
                />
              </label>
            </div>
            <div className="muted small">
              x {selected.box.x}, y {selected.box.y}, {selected.box.w}×{selected.box.h}
              {selected.origin === 'auto' && ` · авто${selected.score ? ` ${selected.score.toFixed(2)}` : ''}${selected.touched ? ', изменён' : ''}`}
            </div>
            <label>
              <span className="row between">
                <span>Оригинальный текст</span>
                <button
                  className="tiny"
                  title="Как в предложении (из КАПСА)"
                  disabled={!selected.source_text}
                  onClick={() => store.exec(SetSourceText(page.id, selected.id, changeCase(selected.source_text, 'sentence')))}
                >
                  Aa
                </button>
              </span>
              <textarea
                ref={sourceRef}
                rows={4}
                value={selected.source_text}
                onChange={(e) => store.exec(SetSourceText(page.id, selected.id, e.target.value))}
                onBlur={() => store.endGesture()}
                onKeyDown={sourceKeys}
                placeholder="Enter — к следующему объекту, Shift+Enter — перенос строки"
              />
            </label>
            <button disabled={!!ocrOff || !!task} title={ocrOff ?? ''} onClick={() => void runOcr([page], [selected.id])}>
              Перечитать OCR этого бокса
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
      ) : dialog === 'layout' ? (
        <Modal title="Параметры разметки" onClose={() => setDialog(null)}>
          <LayoutSettings settings={ctx.settings} onChange={ctx.setSettings} />
        </Modal>
      ) : null}
    </div>
  );
}

/** Reading-order number that can be typed: Enter or blur moves the object to that position. */
function OrderNumber({ n, max, color, shape, onChange }: { n: number; max: number; color: string; shape: string; onChange: (n: number) => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const commit = () => {
    const v = Number(edit);
    setEdit(null);
    if (Number.isInteger(v) && v >= 1 && v <= max && v !== n) onChange(v);
  };
  if (edit !== null)
    return (
      <input
        className="order-input"
        autoFocus
        value={edit}
        inputMode="numeric"
        onChange={(e) => setEdit(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEdit(null);
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
        aria-label="Номер по порядку"
      />
    );
  return (
    <button
      className={`num shape-${shape}`}
      style={{ background: color }}
      title="Щёлкните, чтобы вписать номер"
      onClick={(e) => {
        e.stopPropagation();
        setEdit(String(n));
      }}
    >
      {n}
    </button>
  );
}
