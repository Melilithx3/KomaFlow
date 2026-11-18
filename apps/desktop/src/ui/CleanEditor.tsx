import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { sha256Hex } from '@komaflow/contract';
import { fitViewport, screenToImage, wheelAction, zoomAt, type Viewport } from '@komaflow/page-view';
import { ImportFiles } from '../core/commands.js';
import type { LocalPage } from '../core/model.js';
import {
  applyMasked,
  cloneDab,
  cloneRaster,
  createRaster,
  eraseDabAlpha,
  floodFill,
  hasVisiblePixels,
  maskBounds,
  maskDab,
  maskToRaster,
  paintDab,
  paintDabOver,
  PixelHistory,
  pixelAt,
  readRegion,
  restoreDab,
  strokePoints,
  textMask,
  unionRect,
  type Raster,
  type Rect,
  type RGBA,
} from '../core/raster.js';
import { lamaBlocker, type InpaintResult } from '../core/sidecar.js';
import type { Store } from '../core/store.js';
import type { AppCtx } from './App.js';
import { decodeBytes, encodePng } from './cleanIO.js';

export type CleanTool = 'brush' | 'eraser' | 'fill' | 'stamp' | 'mask' | 'notes';

export interface CleanEditorHandle {
  /** Saves pending pixels as the page's clean (before switching page or mode). */
  save(): Promise<void>;
  dirty(): boolean;
}

export interface TaskFns {
  setTask: (t: { label: string; done: number; total: number; cancel?: () => void } | null) => void;
  setMessage: (m: string | null) => void;
}

interface Props extends TaskFns {
  ctx: AppCtx;
  store: Store;
  page: LocalPage;
  selectedId: string | null;
  fitSignal: number;
  handle?: Ref<CleanEditorHandle>;
}

const TOOL_KEYS: Record<string, CleanTool> = { KeyB: 'brush', KeyE: 'eraser', KeyG: 'fill', KeyS: 'stamp', KeyM: 'mask', KeyN: 'notes' };
const TOOL_RU: Record<CleanTool, string> = { brush: 'Кисть (B)', eraser: 'Ластик → raw (E)', fill: 'Заливка (G)', stamp: 'Штамп (S, Alt+щелчок — источник)', mask: 'Маска LaMa (M, Shift — стереть)', notes: 'Пометка для тайпера (N, Shift — стереть): отдельный слой Notes' };

const hexToRgba = (h: string): RGBA => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const rgbaToHex = (c: RGBA) => `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Text-mask parameters for auto-clean (persisted per device). */
interface MaskParams {
  threshold: number;
  dilate: number;
}
const MP_KEY = 'komaflow-desktop:mask-params';
const loadMaskParams = (): MaskParams => {
  try {
    return { threshold: 150, dilate: 3, ...(JSON.parse(localStorage.getItem(MP_KEY) ?? '{}') as Partial<MaskParams>) };
  } catch {
    return { threshold: 150, dilate: 3 };
  }
};

/**
 * Clean editor (ADR 0015): the page clean is a full-resolution raster edited in the WebView. Tools: brush,
 * eraser (back to raw), flood fill, clone stamp, LaMa mask brush; auto-clean = text mask from boxes + LaMa.
 * Saving writes a PNG into the workspace and binds it as the page's clean (undoable in the markup history).
 */
export function CleanEditor(p: Props) {
  const view = useRef<HTMLCanvasElement>(null);
  const work = useRef<Raster | null>(null);
  const raw = useRef<Raster | null>(null);
  const mask = useRef<Uint8Array | null>(null);
  const workCanvas = useRef<OffscreenCanvas | null>(null);
  /** Notes for the typer: a transparent layer over the clean, published as the page's notes (docs/04 §2). */
  const notes = useRef<Raster | null>(null);
  const notesCanvas = useRef<OffscreenCanvas | null>(null);
  const notesImage = useRef<ImageData | null>(null);
  const notesHistory = useRef(new PixelHistory());
  const notesDirty = useRef(false);
  /** Which layer each undo step belongs to (both layers share Ctrl+Z). */
  const undoOrder = useRef<Array<'work' | 'notes'>>([]);
  const redoOrder = useRef<Array<'work' | 'notes'>>([]);
  const maskCanvas = useRef<OffscreenCanvas | null>(null);
  const workImage = useRef<ImageData | null>(null);
  const maskImage = useRef<ImageData | null>(null);
  const history = useRef(new PixelHistory());
  const vp = useRef<Viewport>({ scale: 0.25, x: 0, y: 0 });
  const frame = useRef(0);
  const stroke = useRef<{ last: [number, number]; origin: Raster; dirty: Rect | null; stampOffset?: [number, number]; erase?: boolean } | null>(null);
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const space = useRef(false);
  const stampSource = useRef<[number, number] | null>(null);
  const dirty = useRef(false);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  const [tool, setTool] = useState<CleanTool>('brush');
  const [size, setSize] = useState(24);
  const [hardness, setHardness] = useState(0.8);
  const [opacity, setOpacity] = useState(1);
  const [color, setColor] = useState('#ffffff');
  const [notesColor, setNotesColor] = useState('#ff2d2d');
  const [showNotes, setShowNotes] = useState(true);
  const [tolerance, setTolerance] = useState(24);
  const [showBoxes, setShowBoxes] = useState(true);
  const [loading, setLoading] = useState(true);
  const [mp, setMp] = useState<MaskParams>(loadMaskParams);
  const props = useRef(p);
  props.current = p;
  const settings = useRef({ tool, size, hardness, opacity, color, tolerance, showBoxes, notesColor, showNotes });
  settings.current = { tool, size, hardness, opacity, color, tolerance, showBoxes, notesColor, showNotes };

  // ---------------------------------------------------------------- rendering
  const draw = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const c = view.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#16181d';
      g.fillRect(0, 0, w, h);
      const v = vp.current;
      const pg = props.current.page;
      g.save();
      g.translate(v.x, v.y);
      g.scale(v.scale, v.scale);
      g.imageSmoothingEnabled = v.scale < 2;
      if (workCanvas.current) g.drawImage(workCanvas.current, 0, 0);
      if (notesCanvas.current && settings.current.showNotes) g.drawImage(notesCanvas.current, 0, 0);
      if (maskCanvas.current) g.drawImage(maskCanvas.current, 0, 0);
      if (settings.current.showBoxes) {
        g.lineWidth = 1.2 / v.scale;
        g.setLineDash([5 / v.scale, 4 / v.scale]);
        for (const o of pg.objects) {
          g.strokeStyle = o.id === props.current.selectedId ? '#818cf8' : '#818cf880';
          g.save();
          g.translate(o.box.x + o.box.w / 2, o.box.y + o.box.h / 2);
          g.rotate(((o.rotation ?? 0) * Math.PI) / 180);
          g.strokeRect(-o.box.w / 2, -o.box.h / 2, o.box.w, o.box.h);
          g.restore();
        }
        g.setLineDash([]);
      }
      const cur = cursor.current;
      const st = settings.current;
      if (cur && st.tool !== 'fill') {
        g.lineWidth = 1 / v.scale;
        g.strokeStyle = '#000a';
        g.beginPath();
        g.arc(cur.x, cur.y, st.size / 2, 0, Math.PI * 2);
        g.stroke();
        g.strokeStyle = '#fffc';
        g.beginPath();
        g.arc(cur.x, cur.y, st.size / 2 + 1 / v.scale, 0, Math.PI * 2);
        g.stroke();
      }
      if (st.tool === 'stamp' && stampSource.current) {
        const [sx, sy] = stampSource.current;
        g.strokeStyle = '#22d3ee';
        g.lineWidth = 2 / v.scale;
        g.beginPath();
        g.moveTo(sx - 8 / v.scale, sy);
        g.lineTo(sx + 8 / v.scale, sy);
        g.moveTo(sx, sy - 8 / v.scale);
        g.lineTo(sx, sy + 8 / v.scale);
        g.stroke();
      }
      g.restore();
    });
  }, []);

  /** Pushes changed pixels of `rect` into the display canvases. */
  const flush = useCallback(
    (rect: Rect | null, alsoMask = false) => {
      if (!rect) return;
      if (workImage.current && workCanvas.current) workCanvas.current.getContext('2d')!.putImageData(workImage.current, 0, 0, rect.x, rect.y, rect.w, rect.h);
      if (alsoMask && mask.current && maskImage.current && maskCanvas.current) {
        const m = mask.current;
        const d = maskImage.current.data;
        const W = maskImage.current.width;
        for (let y = rect.y; y < rect.y + rect.h; y++)
          for (let x = rect.x; x < rect.x + rect.w; x++) {
            const i = y * W + x;
            d[i * 4 + 3] = m[i] ? 130 : 0;
          }
        maskCanvas.current.getContext('2d')!.putImageData(maskImage.current, 0, 0, rect.x, rect.y, rect.w, rect.h);
      }
      draw();
    },
    [draw],
  );

  const flushNotes = useCallback(
    (rect: Rect | null) => {
      if (!rect || !notesImage.current || !notesCanvas.current) return;
      notesCanvas.current.getContext('2d')!.putImageData(notesImage.current, 0, 0, rect.x, rect.y, rect.w, rect.h);
      draw();
    },
    [draw],
  );

  const fullRect = (): Rect => ({ x: 0, y: 0, w: work.current!.width, h: work.current!.height });

  // ---------------------------------------------------------------- loading
  useEffect(() => {
    let alive = true;
    setLoading(true);
    history.current.clear();
    notesHistory.current.clear();
    undoOrder.current = [];
    redoOrder.current = [];
    dirty.current = false;
    notesDirty.current = false;
    stampSource.current = null;
    void (async () => {
      const pg = p.page;
      try {
        const [rw, base, nt] = await Promise.all([
          p.ctx.host.readFile(pg.raw.path).then(decodeBytes),
          pg.clean ? p.ctx.host.readFile(pg.clean.path).then(decodeBytes) : null,
          pg.notes ? p.ctx.host.readFile(pg.notes.path).then(decodeBytes) : null,
        ]);
        if (!alive) return;
        raw.current = rw;
        work.current = base ?? cloneRaster(rw);
        mask.current = new Uint8Array(rw.width * rw.height);
        workImage.current = new ImageData(work.current.data as Uint8ClampedArray<ArrayBuffer>, rw.width, rw.height);
        maskImage.current = new ImageData(rw.width, rw.height);
        for (let i = 0; i < rw.width * rw.height; i++) maskImage.current.data[i * 4] = 239; // red overlay
        workCanvas.current = new OffscreenCanvas(rw.width, rw.height);
        maskCanvas.current = new OffscreenCanvas(rw.width, rw.height);
        notes.current = nt && nt.width === rw.width && nt.height === rw.height ? nt : createRaster(rw.width, rw.height);
        notesImage.current = new ImageData(notes.current.data as Uint8ClampedArray<ArrayBuffer>, rw.width, rw.height);
        notesCanvas.current = new OffscreenCanvas(rw.width, rw.height);
        notesCanvas.current.getContext('2d')!.putImageData(notesImage.current, 0, 0);
        const c = view.current!;
        vp.current = fitViewport(rw, { width: c.clientWidth, height: c.clientHeight });
        flush(fullRect(), true);
        if (!pg.clean) p.setMessage('Клина ещё нет: начинаем с копии raw. Сотрите текст инструментами или автоклином, затем «Сохранить клин».');
      } catch (e) {
        p.setMessage(`Не удалось открыть страницу: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // reload only when the page (or its stored clean) changes
  }, [p.page.id, p.page.clean?.hash, p.page.notes?.hash]);

  useEffect(() => {
    const c = view.current;
    if (c && work.current) vp.current = fitViewport(work.current, { width: c.clientWidth, height: c.clientHeight });
    draw();
  }, [p.fitSignal, draw]);
  useEffect(draw, [showBoxes, showNotes, tool, size, p.selectedId, p.page.objects, draw]);

  // ---------------------------------------------------------------- saving
  const save = useCallback(async () => {
    const w = work.current;
    if (!w || (!dirty.current && !notesDirty.current)) return;
    const { ctx, store, page } = props.current;
    const wsId = store.get().ws.id;
    const saved: string[] = [];
    if (dirty.current) {
      const bytes = await encodePng(w);
      const hash = sha256Hex(bytes);
      const path = await ctx.host.saveImage(wsId, hash, bytes, 'image/png');
      store.exec(ImportFiles('clean', [{ pageId: page.id, file: { path, hash, width: w.width, height: w.height, mime: 'image/png' } }]));
      dirty.current = false;
      saved.push('клин');
    }
    const n = notes.current;
    if (notesDirty.current && n) {
      // only a layer the cleaner actually drew on goes to the server
      if (hasVisiblePixels(n)) {
        const bytes = await encodePng(n);
        const hash = sha256Hex(bytes);
        const path = await ctx.host.saveImage(wsId, hash, bytes, 'image/png');
        store.exec(ImportFiles('notes', [{ pageId: page.id, file: { path, hash, width: n.width, height: n.height, mime: 'image/png' } }]));
        saved.push('пометки');
      } else if (page.notes) {
        store.exec(ImportFiles('notes', [{ pageId: page.id, file: null }]));
        saved.push('пометки удалены');
      }
      notesDirty.current = false;
    }
    rerender();
    props.current.setMessage(`Страница ${page.idx}: сохранено — ${saved.join(', ')}.`);
  }, []);
  useImperativeHandle(p.handle, () => ({ save, dirty: () => dirty.current || notesDirty.current }), [save]);

  /** Records a finished edit for the shared undo history. */
  const pushHistory = (layer: 'work' | 'notes', rect: Rect, before: Raster) => {
    (layer === 'work' ? history : notesHistory).current.push(rect, before);
    undoOrder.current.push(layer);
    redoOrder.current = [];
  };
  const undoRedo = (redo: boolean) => {
    const from = redo ? redoOrder : undoOrder;
    const to = redo ? undoOrder : redoOrder;
    const layer = from.current.pop();
    if (!layer) return;
    const target = layer === 'work' ? work.current : notes.current;
    if (!target) return;
    const h = (layer === 'work' ? history : notesHistory).current;
    const rect = redo ? h.redo(target) : h.undo(target);
    if (!rect) return;
    to.current.push(layer);
    if (layer === 'work') {
      flush(rect);
      markDirty();
    } else {
      flushNotes(rect);
      markNotesDirty();
    }
  };
  const markNotesDirty = () => {
    if (!notesDirty.current) {
      notesDirty.current = true;
      rerender();
    }
  };

  const markDirty = () => {
    if (!dirty.current) {
      dirty.current = true;
      rerender();
    }
  };

  // ---------------------------------------------------------------- LaMa
  const autoMask = (boxesOnly: 'selected' | 'page') => {
    const w = work.current;
    const m = mask.current;
    if (!w || !m) return null;
    const pg = props.current.page;
    const objs = boxesOnly === 'selected' ? pg.objects.filter((o) => o.id === props.current.selectedId) : pg.objects;
    if (objs.length === 0) {
      props.current.setMessage(boxesOnly === 'selected' ? 'Выберите бокс (в режиме разметки или щелчком по списку).' : 'На странице нет боксов.');
      return null;
    }
    let rect: Rect | null = null;
    for (const o of objs) rect = unionRect(rect, textMask(w, o.box, m, { threshold: mp.threshold, dilate: mp.dilate, inset: 0.04 }));
    flush(rect, true);
    if (!rect) props.current.setMessage('В боксах не найден тёмный текст: закрасьте маску вручную (M) или поднимите порог.');
    return rect;
  };

  const runLama = async () => {
    try {
      await runLamaInner();
    } catch (e) {
      props.current.setTask(null);
      props.current.setMessage(`LaMa: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const runLamaInner = async () => {
    const { ctx, store, setTask, setMessage } = props.current;
    const blocker = lamaBlocker(ctx.caps);
    const w = work.current;
    const m = mask.current;
    if (!w || !m) return;
    if (blocker || !ctx.sidecar) return setMessage(blocker);
    const bounds = maskBounds(m, w.width, w.height);
    if (!bounds) return setMessage('Маска пуста: закрасьте её (M) или нажмите «Автомаска».');
    const sc = ctx.sidecar;
    const wsId = store.get().ws.id;
    const stamp = Date.now();
    const imagePath = await ctx.host.writeTemp(wsId, `lama-${stamp}-image.png`, await encodePng(w));
    const maskPath = await ctx.host.writeTemp(wsId, `lama-${stamp}-mask.png`, await encodePng(maskToRaster(m, w.width, w.height)));
    const outPath = imagePath.replace(/-image\.png$/, '-out.png');
    const id = await sc.inpaint([{ id: 'page', image_path: imagePath, mask_path: maskPath, out_path: outPath }], { backend: ctx.settings.backend });
    setTask({ label: 'LaMa', done: 0, total: 1, cancel: () => void sc.cancel(id) });
    try {
      const j = await sc.wait<InpaintResult>(id, () => {});
      if (j.state !== 'done' || !j.result) return setMessage(j.state === 'failed' ? `LaMa: ${j.error}` : 'LaMa отменён.');
      const result = await decodeBytes(await ctx.host.readFile(j.result.results[0]!.out_path));
      pushHistory('work', bounds, readRegion(w, bounds));
      applyMasked(w, result, m);
      m.fill(0);
      flush(fullRect(), true);
      markDirty();
    } finally {
      setTask(null);
    }
  };

  /** Auto-clean of the whole chapter: text masks from all boxes, one LaMa job, results bound as cleans. */
  const autoCleanChapter = async () => {
    try {
      await autoCleanChapterInner();
    } catch (e) {
      props.current.setTask(null);
      props.current.setMessage(`Автоклин: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const autoCleanChapterInner = async () => {
    const { ctx, store, setTask, setMessage } = props.current;
    const blocker = lamaBlocker(ctx.caps);
    if (blocker || !ctx.sidecar) return setMessage(blocker);
    const ws = store.get().ws;
    const pages = ws.pages.filter((pg) => pg.objects.length > 0);
    if (!window.confirm(`Автоклин ${pages.length} стр. по всем боксам. Существующий клин будет дочищен (можно отменить Ctrl+Z в режиме разметки). Продолжить?`)) return;
    await save();
    const sc = ctx.sidecar;
    const stamp = Date.now();
    const items: Array<{ id: string; image_path: string; mask_path: string; out_path: string }> = [];
    setTask({ label: 'Маски', done: 0, total: pages.length });
    for (const [i, pg] of pages.entries()) {
      const base = await decodeBytes(await ctx.host.readFile((pg.clean ?? pg.raw).path));
      const m = new Uint8Array(base.width * base.height);
      for (const o of pg.objects) textMask(base, o.box, m, { threshold: mp.threshold, dilate: mp.dilate, inset: 0.04 });
      if (!maskBounds(m, base.width, base.height)) continue;
      const imagePath = await ctx.host.writeTemp(ws.id, `chap-${stamp}-${pg.idx}-image.png`, await encodePng(base));
      const maskPath = await ctx.host.writeTemp(ws.id, `chap-${stamp}-${pg.idx}-mask.png`, await encodePng(maskToRaster(m, base.width, base.height)));
      items.push({ id: pg.id, image_path: imagePath, mask_path: maskPath, out_path: imagePath.replace(/-image\.png$/, '-out.png') });
      setTask({ label: 'Маски', done: i + 1, total: pages.length });
    }
    if (!items.length) {
      setTask(null);
      return setMessage('Текст в боксах не найден.');
    }
    const id = await sc.inpaint(items, { backend: ctx.settings.backend });
    setTask({ label: 'LaMa', done: 0, total: items.length, cancel: () => void sc.cancel(id) });
    try {
      const j = await sc.wait<InpaintResult>(id, (x) => setTask({ label: 'LaMa', done: x.progress.done, total: items.length, cancel: () => void sc.cancel(id) }));
      if (j.state !== 'done' || !j.result) return setMessage(j.state === 'failed' ? `LaMa: ${j.error}` : 'Автоклин отменён.');
      const files = [];
      for (const r of j.result.results) {
        const bytes = await ctx.host.readFile(r.out_path);
        const pg = ws.pages.find((x) => x.id === r.id)!;
        const hash = sha256Hex(bytes);
        const path = await ctx.host.saveImage(ws.id, hash, bytes, 'image/png');
        files.push({ pageId: pg.id, file: { path, hash, width: pg.width, height: pg.height, mime: 'image/png' } });
      }
      store.exec(ImportFiles('clean', files));
      setMessage(`Автоклин: обработано страниц — ${files.length}. Проверьте и дочистите вручную.`);
    } finally {
      setTask(null);
    }
  };

  // ---------------------------------------------------------------- pointer
  const toImage = (e: { clientX: number; clientY: number }) => {
    const r = view.current!.getBoundingClientRect();
    return screenToImage(vp.current, e.clientX - r.left, e.clientY - r.top);
  };

  const brush = () => ({ radius: Math.max(0.5, settings.current.size / 2), hardness: settings.current.hardness, opacity: settings.current.opacity });

  const applyAt = (x: number, y: number): Rect | null => {
    const w = work.current!;
    const s = stroke.current!;
    const st = settings.current;
    switch (st.tool) {
      case 'brush':
        return paintDab(w, x, y, brush(), hexToRgba(st.color));
      case 'eraser':
        return restoreDab(w, raw.current!, x, y, brush());
      case 'stamp':
        return s.stampOffset ? cloneDab(w, s.origin, x, y, s.stampOffset[0], s.stampOffset[1], brush()) : null;
      case 'notes':
        return s.erase ? eraseDabAlpha(notes.current!, x, y, brush()) : paintDabOver(notes.current!, x, y, brush(), hexToRgba(st.notesColor));
      case 'mask':
        return null;
      default:
        return null;
    }
  };

  const onDown = (e: React.PointerEvent) => {
    const w = work.current;
    if (!w || loading) return;
    view.current!.setPointerCapture(e.pointerId);
    view.current!.focus();
    if (e.button === 1 || space.current || e.button === 2) {
      pan.current = { sx: e.clientX, sy: e.clientY, vx: vp.current.x, vy: vp.current.y };
      return;
    }
    const pt = toImage(e);
    const st = settings.current;
    if (e.altKey && st.tool === 'brush') {
      setColor(rgbaToHex(pixelAt(w, Math.min(w.width - 1, Math.max(0, pt.x)), Math.min(w.height - 1, Math.max(0, pt.y)))));
      return;
    }
    if (e.altKey && st.tool === 'stamp') {
      stampSource.current = [Math.round(pt.x), Math.round(pt.y)];
      draw();
      return;
    }
    if (st.tool === 'fill') {
      const before = cloneRaster(w);
      const rect = floodFill(w, pt.x, pt.y, hexToRgba(st.color), st.tolerance);
      if (rect) {
        pushHistory('work', rect, readRegion(before, rect));
        flush(rect);
        markDirty();
      }
      return;
    }
    if (st.tool === 'mask') {
      const rect = maskDab(mask.current!, w.width, w.height, pt.x, pt.y, st.size / 2, e.shiftKey);
      stroke.current = { last: [pt.x, pt.y], origin: w, dirty: rect };
      flush(rect, true);
      return;
    }
    if (st.tool === 'stamp' && !stampSource.current) {
      props.current.setMessage('Штамп: сначала Alt+щелчок по месту-источнику.');
      return;
    }
    if (st.tool === 'notes' && !st.showNotes) setShowNotes(true);
    const origin = cloneRaster(st.tool === 'notes' ? notes.current! : w);
    stroke.current = {
      last: [pt.x, pt.y],
      origin,
      dirty: null,
      erase: st.tool === 'notes' && e.shiftKey,
      ...(st.tool === 'stamp' && stampSource.current ? { stampOffset: [Math.round(stampSource.current[0] - pt.x), Math.round(stampSource.current[1] - pt.y)] as [number, number] } : {}),
    };
    const rect = applyAt(pt.x, pt.y);
    stroke.current.dirty = rect;
    if (st.tool === 'notes') flushNotes(rect);
    else flush(rect);
  };

  const onMove = (e: React.PointerEvent) => {
    const pt = toImage(e);
    cursor.current = pt;
    if (pan.current) {
      vp.current = { ...vp.current, x: pan.current.vx + e.clientX - pan.current.sx, y: pan.current.vy + e.clientY - pan.current.sy };
      draw();
      return;
    }
    const s = stroke.current;
    if (!s) return draw();
    const w = work.current!;
    let rect: Rect | null = null;
    for (const [x, y] of strokePoints(s.last[0], s.last[1], pt.x, pt.y, settings.current.size / 2)) {
      rect =
        settings.current.tool === 'mask'
          ? unionRect(rect, maskDab(mask.current!, w.width, w.height, x, y, settings.current.size / 2, e.shiftKey))
          : unionRect(rect, applyAt(x, y));
    }
    s.last = [pt.x, pt.y];
    s.dirty = unionRect(s.dirty, rect);
    if (settings.current.tool === 'notes') flushNotes(rect);
    else flush(rect, settings.current.tool === 'mask');
  };

  const onUp = () => {
    pan.current = null;
    const s = stroke.current;
    stroke.current = null;
    if (!s || settings.current.tool === 'mask' || !s.dirty) return;
    if (settings.current.tool === 'notes') {
      pushHistory('notes', s.dirty, readRegion(s.origin, s.dirty));
      markNotesDirty();
      return;
    }
    pushHistory('work', s.dirty, readRegion(s.origin, s.dirty));
    markDirty();
  };

  // wheel, keys
  useEffect(() => {
    const c = view.current!;
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const a = wheelAction(e);
      const r = c.getBoundingClientRect();
      if (a.kind === 'zoom') vp.current = zoomAt(vp.current, a.factor, e.clientX - r.left, e.clientY - r.top);
      else vp.current = { ...vp.current, x: vp.current.x + a.dx, y: vp.current.y + a.dy };
      draw();
    };
    c.addEventListener('wheel', wheel, { passive: false });
    const kd = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const w = work.current;
      if (e.code === 'Space') {
        space.current = true;
        e.preventDefault();
        return;
      }
      if (e.ctrlKey && (e.code === 'KeyZ' || e.code === 'KeyY')) {
        e.preventDefault();
        if (!w) return;
        undoRedo(!(e.code === 'KeyZ' && !e.shiftKey));
        return;
      }
      if (e.ctrlKey && e.code === 'KeyS') {
        e.preventDefault();
        void save();
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (TOOL_KEYS[e.code]) setTool(TOOL_KEYS[e.code]!);
      else if (e.code === 'BracketLeft') setSize((s) => Math.max(1, Math.round(s / 1.2)));
      else if (e.code === 'BracketRight') setSize((s) => Math.min(400, Math.round(s * 1.2) + 1));
      else if (e.code === 'Enter') void runLama();
      else if (e.code === 'Escape' && mask.current && w) {
        mask.current.fill(0);
        flush(fullRect(), true);
      } else return;
      e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === 'Space') space.current = false;
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      ro.disconnect();
      c.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, [draw, flush, save]);

  const lamaOff = lamaBlocker(p.ctx.caps);
  const updateMp = (patch: Partial<MaskParams>) => {
    const next = { ...mp, ...patch };
    setMp(next);
    try {
      localStorage.setItem(MP_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  return (
    <div className="clean-editor">
      <div className="clean-tools" role="toolbar" aria-label="Инструменты клина">
        <div className="seg">
          {(Object.keys(TOOL_RU) as CleanTool[]).map((t) => (
            <button key={t} aria-pressed={tool === t} onClick={() => setTool(t)} title={TOOL_RU[t]}>
              {{ brush: 'Кисть', eraser: 'Ластик', fill: 'Заливка', stamp: 'Штамп', mask: 'Маска', notes: 'Пометка' }[t]}
            </button>
          ))}
        </div>
        {tool !== 'fill' && (
          <label className="check" title="[ и ] — меньше/больше">
            Размер <input type="range" min={1} max={300} value={size} onChange={(e) => setSize(Number(e.target.value))} /> <span className="mono">{size}</span>
          </label>
        )}
        {tool === 'notes' && (
          <label className="check" title="Цвет пометки; Shift — стирать пометки">
            Цвет пометки <input type="color" value={notesColor} onChange={(e) => setNotesColor(e.target.value)} />
          </label>
        )}
        {(tool === 'brush' || tool === 'eraser' || tool === 'stamp' || tool === 'notes') && (
          <>
            <label className="check">
              Жёсткость <input type="range" min={0} max={1} step={0.05} value={hardness} onChange={(e) => setHardness(Number(e.target.value))} />
            </label>
            <label className="check">
              Непрозр. <input type="range" min={0.05} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
            </label>
          </>
        )}
        {(tool === 'brush' || tool === 'fill') && (
          <label className="check" title="Alt+щелчок кистью — пипетка">
            Цвет <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
        )}
        {tool === 'fill' && (
          <label className="check">
            Допуск <input type="range" min={0} max={128} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} /> <span className="mono">{tolerance}</span>
          </label>
        )}
        <span className="sep" />
        <div className="group" role="group" aria-label="Автоклин">
          <span className="group-label">LaMa</span>
          <button onClick={() => autoMask('selected')} title="Маска текста в выбранном боксе">
            маска: бокс
          </button>
          <button onClick={() => autoMask('page')} title="Маска текста во всех боксах страницы">
            маска: стр.
          </button>
          <button className="primary" disabled={!!lamaOff} title={lamaOff ?? 'Стереть по маске (Enter)'} onClick={() => void runLama()}>
            Стереть
          </button>
          <button
            disabled={!!lamaOff}
            title={lamaOff ?? 'Маска по всем боксам + LaMa'}
            onClick={() => {
              if (autoMask('page')) void runLama();
            }}
          >
            Автоклин стр.
          </button>
          <button disabled={!!lamaOff} title={lamaOff ?? 'Автоклин всех страниц главы'} onClick={() => void autoCleanChapter()}>
            главы
          </button>
        </div>
        <label className="check" title="Пиксели темнее порога внутри бокса считаются текстом">
          порог <input type="number" min={20} max={250} value={mp.threshold} onChange={(e) => updateMp({ threshold: Number(e.target.value) })} className="num-input" />
        </label>
        <label className="check" title="Расширение маски, px">
          +px <input type="number" min={0} max={20} value={mp.dilate} onChange={(e) => updateMp({ dilate: Number(e.target.value) })} className="num-input" />
        </label>
        <span className="spacer" />
        <label className="check" title="Слой пометок для тайпера (уходит на сервер как Notes)">
          <input type="checkbox" checked={showNotes} onChange={(e) => setShowNotes(e.target.checked)} /> пометки
        </label>
        <label className="check">
          <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} /> боксы
        </label>
        <button
          onClick={() => {
            const w = work.current;
            if (!w || !raw.current) return;
            pushHistory('work', fullRect(), readRegion(w, fullRect()));
            w.data.set(raw.current.data);
            flush(fullRect());
            markDirty();
          }}
          title="Вернуть всю страницу к raw (можно отменить)"
        >
          Сбросить к raw
        </button>
        <button className={dirty.current || notesDirty.current ? 'primary' : ''} disabled={!dirty.current && !notesDirty.current} onClick={() => void save()} title="Клин и пометки (Ctrl+S)">
          {dirty.current || notesDirty.current ? 'Сохранить' : 'Сохранено'}
        </button>
      </div>
      <div className="stage">
        <canvas
          ref={view}
          className="canvas"
          tabIndex={0}
          aria-label="Клин страницы"
          style={{ cursor: tool === 'fill' ? 'crosshair' : 'none' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={() => {
            cursor.current = null;
            draw();
          }}
          onContextMenu={(e) => e.preventDefault()}
        />
        {loading && <div className="stage-info">Загрузка страницы…</div>}
        <div className="stage-help">B кисть · E ластик · G заливка · S штамп · M маска · N пометка · [ ] размер · Enter — LaMa · Esc — сбросить маску · Ctrl+Z</div>
      </div>
    </div>
  );
}
