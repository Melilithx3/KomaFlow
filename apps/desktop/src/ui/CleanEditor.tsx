import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { sha256Hex } from '@komaflow/contract';
import { fitViewport, pointInBox, screenToImage, wheelAction, zoomAt, type Viewport } from '@komaflow/page-view';
import { ImportFiles, withPageFile } from '../core/commands.js';
import type { LocalPage } from '../core/model.js';
import {
  applyMasked,
  beginStroke,
  cloneDab,
  cloneRaster,
  createRaster,
  eraseDabAlpha,
  findResiduals,
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
  type StrokeState,
  type Rect,
  type RGBA,
} from '../core/raster.js';
import { lamaBlocker, type InpaintResult } from '../core/sidecar.js';
import type { Store } from '../core/store.js';
import type { AppCtx } from './App.js';
import { decodeBytes, encodePng } from './cleanIO.js';

export type CleanTool = 'brush' | 'eraser' | 'fill' | 'stamp' | 'mask' | 'notes';

export interface CleanEditorHandle {
  /** Saves pending pixels as the page's clean (before switching page or mode); false = failed (message shown). */
  save(): Promise<boolean>;
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

/** Brush size slider: logarithmic, 0.5…400 px, so small sizes get fine steps (0.1 px below 10). */
const SIZE_MIN = 0.5;
const SIZE_MAX = 400;
const SLIDER_STEPS = 1000;
const sizeToSlider = (v: number) => Math.round((Math.log(v / SIZE_MIN) / Math.log(SIZE_MAX / SIZE_MIN)) * SLIDER_STEPS);
export const roundSize = (v: number) => {
  const c = Math.min(SIZE_MAX, Math.max(SIZE_MIN, v));
  return c < 10 ? Math.round(c * 10) / 10 : Math.round(c);
};
const sliderToSize = (pos: number) => roundSize(SIZE_MIN * Math.pow(SIZE_MAX / SIZE_MIN, pos / SLIDER_STEPS));
/** Autosave delay after the last edit. */
const AUTOSAVE_MS = 1500;

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
  const stroke = useRef<{ last: [number, number]; state: StrokeState | null; dirty: Rect | null; stampOffset?: [number, number]; erase?: boolean } | null>(null);
  const rawCanvas = useRef<OffscreenCanvas | null>(null);
  /** Residual inspection overlay (never part of the clean). */
  const residualCanvas = useRef<OffscreenCanvas | null>(null);
  const residualClusters = useRef<Rect[]>([]);
  const residualTimer = useRef(0);
  const saveTimer = useRef(0);
  const saving = useRef<Promise<boolean> | null>(null);
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const space = useRef(false);
  const stampSource = useRef<[number, number] | null>(null);
  const dirty = useRef(false);

  const [tool, setTool] = useState<CleanTool>('brush');
  const [size, setSize] = useState(24);
  /** 0…100 % in the UI, 0…1 for the brush. */
  const [hardness, setHardness] = useState(80);
  const [opacity, setOpacity] = useState(100);
  const [showRaw, setShowRaw] = useState(false);
  const [residuals, setResiduals] = useState(false);
  const [sensitivity, setSensitivity] = useState(35);
  const [residualCount, setResidualCount] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<{ kind: 'saved' | 'pending' | 'saving' | 'error'; error?: string }>({ kind: 'saved' });
  const [color, setColor] = useState('#ffffff');
  const [notesColor, setNotesColor] = useState('#ff2d2d');
  const [showNotes, setShowNotes] = useState(true);
  const [tolerance, setTolerance] = useState(24);
  const [showBoxes, setShowBoxes] = useState(true);
  const [loading, setLoading] = useState(true);
  const [mp, setMp] = useState<MaskParams>(loadMaskParams);
  const mpRef = useRef(mp);
  mpRef.current = mp;
  const sensRef = useRef(sensitivity);
  sensRef.current = sensitivity;
  const props = useRef(p);
  props.current = p;
  const settings = useRef({ tool, size, hardness, opacity, color, tolerance, showBoxes, notesColor, showNotes, showRaw, residuals });
  settings.current = { tool, size, hardness, opacity, color, tolerance, showBoxes, notesColor, showNotes, showRaw, residuals };

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
      const st0 = settings.current;
      const base = st0.showRaw ? rawCanvas.current : workCanvas.current;
      if (base) g.drawImage(base, 0, 0);
      if (!st0.showRaw) {
        if (notesCanvas.current && st0.showNotes) g.drawImage(notesCanvas.current, 0, 0);
        if (maskCanvas.current) g.drawImage(maskCanvas.current, 0, 0);
        if (st0.residuals && residualCanvas.current) {
          g.drawImage(residualCanvas.current, 0, 0);
          // rings keep single leftover pixels visible at any zoom
          g.strokeStyle = '#ff00ff';
          g.lineWidth = 2 / v.scale;
          for (const c of residualClusters.current) {
            g.beginPath();
            g.arc(c.x + c.w / 2, c.y + c.h / 2, Math.max(c.w, c.h) / 2 + 8 / v.scale, 0, Math.PI * 2);
            g.stroke();
          }
        }
      }
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
      if (cur && st.tool !== 'fill' && !st.showRaw) {
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

  /** Recomputes the residual overlay (debounced after edits). Reads the clean, never writes it. */
  const updateResiduals = useCallback(
    (delay = 300) => {
      clearTimeout(residualTimer.current);
      if (!settings.current.residuals) return;
      residualTimer.current = window.setTimeout(() => {
        const w = work.current;
        const rw = raw.current;
        if (!w || !rw) return;
        const res = findResiduals(w, rw, props.current.page.objects, { sensitivity: sensRef.current, threshold: mpRef.current.threshold });
        const img = new ImageData(w.width, w.height);
        for (let p = 0; p < res.mask.length; p++)
          if (res.mask[p]) img.data.set([255, 0, 255, 255], p * 4);
        const c = residualCanvas.current ?? new OffscreenCanvas(w.width, w.height);
        c.getContext('2d')!.putImageData(img, 0, 0);
        residualCanvas.current = c;
        residualClusters.current = res.clusters;
        setResidualCount(res.clusters.length);
        draw();
      }, delay);
    },
    [draw],
  );

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
    clearTimeout(saveTimer.current);
    setSaveState({ kind: 'saved' });
    residualClusters.current = [];
    residualCanvas.current = null;
    setResidualCount(null);
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
        rawCanvas.current = new OffscreenCanvas(rw.width, rw.height);
        rawCanvas.current.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rw.data), rw.width, rw.height), 0, 0);
        maskCanvas.current = new OffscreenCanvas(rw.width, rw.height);
        notes.current = nt && nt.width === rw.width && nt.height === rw.height ? nt : createRaster(rw.width, rw.height);
        notesImage.current = new ImageData(notes.current.data as Uint8ClampedArray<ArrayBuffer>, rw.width, rw.height);
        notesCanvas.current = new OffscreenCanvas(rw.width, rw.height);
        notesCanvas.current.getContext('2d')!.putImageData(notesImage.current, 0, 0);
        const c = view.current!;
        vp.current = fitViewport(rw, { width: c.clientWidth, height: c.clientHeight });
        flush(fullRect(), true);
        updateResiduals(0);
        // no clean yet: it starts as a copy of raw and is saved right away (raw itself is never changed)
        if (!pg.clean) {
          dirty.current = true;
          void save();
        }
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
  /**
   * Writes pending pixels: the clean (PNG, content-addressed in the workspace) and the notes layer when it
   * was drawn on. Binding is not an undo entry (pixel undo lives in the editor). Errors are shown and keep
   * the edits pending; success is reported only after the file is written.
   */
  const saveNow = useCallback(async (): Promise<boolean> => {
    const w = work.current;
    if (!w || (!dirty.current && !notesDirty.current)) return true;
    const { ctx, store, page } = props.current;
    const wsId = store.get().ws.id;
    clearTimeout(saveTimer.current);
    setSaveState({ kind: 'saving' });
    try {
      if (dirty.current) {
        dirty.current = false; // edits during the write mark it dirty again
        const bytes = await encodePng(w);
        const hash = sha256Hex(bytes);
        const path = await ctx.host.saveImage(wsId, hash, bytes, 'image/png');
        store.patch((ws) => withPageFile(ws, page.id, 'clean', { path, hash, width: w.width, height: w.height, mime: 'image/png' }));
      }
      const n = notes.current;
      if (notesDirty.current && n) {
        notesDirty.current = false;
        // only a layer the cleaner actually drew on goes to the server
        if (hasVisiblePixels(n)) {
          const bytes = await encodePng(n);
          const hash = sha256Hex(bytes);
          const path = await ctx.host.saveImage(wsId, hash, bytes, 'image/png');
          store.patch((ws) => withPageFile(ws, page.id, 'notes', { path, hash, width: n.width, height: n.height, mime: 'image/png' }));
        } else store.patch((ws) => withPageFile(ws, page.id, 'notes', null));
      }
      const more = dirty.current || notesDirty.current;
      setSaveState({ kind: more ? 'pending' : 'saved' });
      if (more) schedule();
      return true;
    } catch (e) {
      dirty.current = true;
      const msg = e instanceof Error ? e.message : String(e);
      setSaveState({ kind: 'error', error: msg });
      props.current.setMessage(`Страница ${page.idx}: клин НЕ сохранён — ${msg}`);
      return false;
    }
  }, []);
  /** One write at a time; a save requested meanwhile runs after it. */
  const save = useCallback(async (): Promise<boolean> => {
    while (saving.current) await saving.current;
    saving.current = saveNow().finally(() => (saving.current = null));
    return saving.current;
  }, [saveNow]);
  const schedule = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(), AUTOSAVE_MS);
  };
  useImperativeHandle(p.handle, () => ({ save, dirty: () => dirty.current || notesDirty.current || !!saving.current }), [save]);

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
    notesDirty.current = true;
    setSaveState({ kind: 'pending' });
    schedule();
  };

  const markDirty = () => {
    dirty.current = true;
    setSaveState({ kind: 'pending' });
    schedule();
    updateResiduals();
  };

  // ---------------------------------------------------------------- LaMa
  const autoMask = (boxesOnly: 'selected' | 'page' | { id: string }) => {
    const w = work.current;
    const m = mask.current;
    if (!w || !m) return null;
    const pg = props.current.page;
    const pick = typeof boxesOnly === 'object' ? boxesOnly.id : boxesOnly === 'selected' ? props.current.selectedId : null;
    const objs = boxesOnly === 'page' ? pg.objects : pg.objects.filter((o) => o.id === pick);
    if (objs.length === 0) {
      props.current.setMessage(boxesOnly === 'selected' ? 'Выберите бокс (в режиме разметки или щелчком по списку).' : 'На странице нет боксов.');
      return null;
    }
    let rect: Rect | null = null;
    for (const o of objs) rect = unionRect(rect, textMask(w, o.box, m, { threshold: mp.threshold, dilate: mp.dilate, inset: 0.04, rotation: o.rotation ?? 0 }));
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
    if (!(await save())) return;
    const sc = ctx.sidecar;
    const stamp = Date.now();
    const items: Array<{ id: string; image_path: string; mask_path: string; out_path: string }> = [];
    setTask({ label: 'Маски', done: 0, total: pages.length });
    for (const [i, pg] of pages.entries()) {
      const base = await decodeBytes(await ctx.host.readFile((pg.clean ?? pg.raw).path));
      const m = new Uint8Array(base.width * base.height);
      for (const o of pg.objects) textMask(base, o.box, m, { threshold: mp.threshold, dilate: mp.dilate, inset: 0.04, rotation: o.rotation ?? 0 });
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

  const brush = () => ({ radius: Math.max(0.25, settings.current.size / 2), hardness: settings.current.hardness / 100, opacity: settings.current.opacity / 100 });

  const applyAt = (x: number, y: number): Rect | null => {
    const w = work.current!;
    const s = stroke.current!;
    const ss = s.state ?? undefined;
    const st = settings.current;
    switch (st.tool) {
      case 'brush':
        return paintDab(w, x, y, brush(), hexToRgba(st.color), ss);
      case 'eraser':
        return restoreDab(w, raw.current!, x, y, brush(), ss);
      case 'stamp':
        return s.stampOffset && ss ? cloneDab(w, ss.origin, x, y, s.stampOffset[0], s.stampOffset[1], brush(), ss) : null;
      case 'notes':
        return s.erase ? eraseDabAlpha(notes.current!, x, y, brush(), ss) : paintDabOver(notes.current!, x, y, brush(), hexToRgba(st.notesColor), ss);
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
    if (st.showRaw) {
      props.current.setMessage('Сейчас показан RAW: нажмите R, чтобы вернуться к клину и рисовать.');
      return;
    }
    if (e.altKey && st.tool === 'mask') {
      // Alt+click in the mask tool: text mask of the object under the cursor
      const hit = [...props.current.page.objects].reverse().find((o) => pointInBox(o.box, o.rotation ?? 0, pt.x, pt.y));
      if (hit) autoMask({ id: hit.id });
      else props.current.setMessage('Alt+щелчок маской — по боксу: маска текста этого объекта.');
      return;
    }
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
      stroke.current = { last: [pt.x, pt.y], state: null, dirty: rect };
      flush(rect, true);
      return;
    }
    if (st.tool === 'stamp' && !stampSource.current) {
      props.current.setMessage('Штамп: сначала Alt+щелчок по месту-источнику.');
      return;
    }
    if (st.tool === 'notes' && !st.showNotes) setShowNotes(true);
    stroke.current = {
      last: [pt.x, pt.y],
      state: beginStroke(st.tool === 'notes' ? notes.current! : w),
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
    if (!s || !s.state || settings.current.tool === 'mask' || !s.dirty) return;
    if (settings.current.tool === 'notes') {
      pushHistory('notes', s.dirty, readRegion(s.state.origin, s.dirty));
      markNotesDirty();
      return;
    }
    pushHistory('work', s.dirty, readRegion(s.state.origin, s.dirty));
    markDirty();
  };

  // wheel, keys
  useEffect(() => {
    const c = view.current!;
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.altKey) {
        // Alt+wheel: brush size (no scroll, no zoom)
        const d = e.deltaY || e.deltaX;
        if (d) setSize((v) => roundSize(v * (d < 0 ? 1.1 : 1 / 1.1) + (d < 0 ? 0.1 : -0.1)));
        draw();
        return;
      }
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
      if (e.altKey && e.code === 'KeyM') {
        // Alt+M: mask tool + text mask of the selected object
        e.preventDefault();
        setTool('mask');
        autoMask('selected');
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (TOOL_KEYS[e.code]) setTool(TOOL_KEYS[e.code]!);
      else if (e.code === 'BracketLeft') setSize((s) => roundSize(s / 1.2 - 0.1));
      else if (e.code === 'BracketRight') setSize((s) => roundSize(s * 1.2 + 0.1));
      else if (e.code === 'KeyR') setShowRaw((v) => !v);
      else if (e.code === 'KeyI') setResiduals((v) => !v);
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
  // Alt alone focuses the menu in some WebViews: keep the canvas focused for Alt+wheel / Alt+click
  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') e.preventDefault();
    };
    window.addEventListener('keyup', up);
    return () => window.removeEventListener('keyup', up);
  }, []);
  useEffect(() => {
    if (residuals) updateResiduals(0);
    else {
      clearTimeout(residualTimer.current);
      setResidualCount(null);
    }
    draw();
  }, [residuals, sensitivity, mp.threshold, p.page.objects, updateResiduals, draw]);
  useEffect(draw, [showRaw, draw]);
  // pending edits are written when the editor goes away (page or mode switch saves explicitly too)
  useEffect(() => () => clearTimeout(saveTimer.current), []);

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
          <label className="check" title="Диаметр кисти, px. [ и ] или Alt+колесо — меньше/больше">
            Размер{' '}
            <input type="range" className="slider" min={0} max={SLIDER_STEPS} step={1} value={sizeToSlider(size)} onChange={(e) => setSize(sliderToSize(Number(e.target.value)))} />
            <input
              type="number"
              className="num-input"
              min={SIZE_MIN}
              max={SIZE_MAX}
              step={size < 10 ? 0.1 : 1}
              value={size}
              onChange={(e) => e.target.value !== '' && setSize(roundSize(Number(e.target.value)))}
              aria-label="Размер кисти, px"
            />
          </label>
        )}
        {tool === 'notes' && (
          <label className="check" title="Цвет пометки; Shift — стирать пометки">
            Цвет пометки <input type="color" value={notesColor} onChange={(e) => setNotesColor(e.target.value)} />
          </label>
        )}
        {(tool === 'brush' || tool === 'eraser' || tool === 'stamp' || tool === 'notes') && (
          <>
            <label className="check" title="Жёсткость края, %: 0 — очень мягкая кисть, 100 — жёсткий край">
              Жёсткость <input type="range" className="slider" min={0} max={100} step={1} value={hardness} onChange={(e) => setHardness(Number(e.target.value))} />
              <span className="mono val">{hardness}%</span>
            </label>
            <label className="check" title="Непрозрачность мазка, %. В пределах одного мазка краска не накапливается">
              Непрозр. <input type="range" className="slider" min={1} max={100} step={1} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
              <span className="mono val">{opacity}%</span>
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
        <label className="check" title="Подсветка возможных остатков текста (I). Только подсказка: отсутствие подсветки не гарантирует чистоту">
          <input type="checkbox" checked={residuals} onChange={(e) => setResiduals(e.target.checked)} /> остатки
          {residuals && (
            <>
              <input type="range" className="slider short" min={8} max={90} step={1} value={100 - sensitivity} onChange={(e) => setSensitivity(100 - Number(e.target.value))} aria-label="Чувствительность" title="Чувствительность" />
              <span className="mono val">{residualCount ?? '…'}</span>
            </>
          )}
        </label>
        <label className="check" title="Показать исходник (R). Клин не меняется">
          <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} /> RAW
        </label>
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
        <button
          className={`save-state ${saveState.kind}`}
          disabled={saveState.kind === 'saved' || saveState.kind === 'saving'}
          onClick={() => void save()}
          title={saveState.kind === 'error' ? `Ошибка: ${saveState.error}. Нажмите, чтобы повторить` : 'Сохраняется автоматически; Ctrl+S — сейчас'}
        >
          {{ saved: 'Сохранено', pending: 'Сохранить', saving: 'Сохранение…', error: 'Ошибка — повторить' }[saveState.kind]}
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
        {showRaw && !loading && <div className="stage-info raw-badge">RAW · R — вернуться к клину</div>}
        <div className="stage-help">B кисть · E ластик · G заливка · S штамп · M маска (Alt+щелчок / Alt+M — по объекту) · N пометка · [ ] или Alt+колесо — размер · R — RAW · I — остатки · Enter — LaMa · Esc — сбросить маску · Ctrl+Z</div>
      </div>
    </div>
  );
}
