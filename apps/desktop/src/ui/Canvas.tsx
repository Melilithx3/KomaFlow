import { useCallback, useEffect, useRef } from 'react';
import { boxFromPoints, type Box } from '@komaflow/contract';
import { fitViewport, hitTest, screenToImage, TYPE_STYLE, zoomAt, type Viewport } from '@komaflow/page-view';
import { AddObject, SetBox, newObject } from '../core/commands.js';
import type { LocalPage } from '../core/model.js';
import type { Store } from '../core/store.js';

export type Tool = 'select' | 'draw' | 'order';

interface Props {
  store: Store;
  page: LocalPage;
  imageUrl: string;
  cleanUrl: string | null;
  showClean: boolean;
  selectedId: string | null;
  tool: Tool;
  /** Called in order mode with the clicked object id. */
  onOrderClick: (id: string) => void;
  fitSignal: number;
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';
type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'box'; id: string; handle: Handle; start: { x: number; y: number }; orig: Box; gesture: string }
  | { kind: 'draw'; start: { x: number; y: number }; cur: { x: number; y: number } };

const HANDLE_PX = 7;

/**
 * Canvas renderer (docs/05 §2, §3): it holds no data, only draws the store and turns pointer input into
 * commands. Drawing is coalesced into one requestAnimationFrame for smooth pan/zoom on big pages.
 */
export function Canvas(p: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const vp = useRef<Viewport>({ scale: 0.25, x: 0, y: 0 });
  const img = useRef<HTMLImageElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const space = useRef(false);
  const frame = useRef(0);
  const props = useRef(p);
  props.current = p;

  const draw = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const c = ref.current;
      if (!c) return;
      const { page, selectedId } = props.current;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#1f2228';
      g.fillRect(0, 0, w, h);
      const v = vp.current;
      g.save();
      g.translate(v.x, v.y);
      g.scale(v.scale, v.scale);
      g.fillStyle = '#fff';
      g.fillRect(0, 0, page.width, page.height);
      if (img.current?.complete && img.current.naturalWidth) {
        g.imageSmoothingQuality = v.scale < 1 ? 'medium' : 'low';
        g.drawImage(img.current, 0, 0, page.width, page.height);
      }
      const lw = 2 / v.scale;
      const label = Math.max(14, 16 / v.scale);
      page.objects.forEach((o, i) => {
        const st = TYPE_STYLE[o.type];
        const sel = o.id === selectedId;
        g.lineWidth = sel ? lw * 2 : lw;
        g.strokeStyle = st.color;
        g.setLineDash(o.type === 'text' ? [lw * 4, lw * 2] : []);
        g.fillStyle = sel ? `${st.color}26` : 'transparent';
        if (sel) g.fillRect(o.box.x, o.box.y, o.box.w, o.box.h);
        g.strokeRect(o.box.x, o.box.y, o.box.w, o.box.h);
        g.setLineDash([]);
        // number badge with a type-specific shape
        const cx = o.box.x + label * 0.6;
        const cy = o.box.y + label * 0.6;
        g.fillStyle = st.color;
        g.beginPath();
        if (st.shape === 'circle') g.arc(cx, cy, label * 0.6, 0, Math.PI * 2);
        else if (st.shape === 'square') g.rect(cx - label * 0.55, cy - label * 0.55, label * 1.1, label * 1.1);
        else if (st.shape === 'diamond') {
          g.moveTo(cx, cy - label * 0.75);
          g.lineTo(cx + label * 0.75, cy);
          g.lineTo(cx, cy + label * 0.75);
          g.lineTo(cx - label * 0.75, cy);
          g.closePath();
        } else g.roundRect(cx - label * 0.7, cy - label * 0.5, label * 1.4, label, label * 0.3);
        g.fill();
        g.fillStyle = '#fff';
        g.font = `700 ${label * 0.75}px system-ui, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(i + 1), cx, cy + 0.5);
        if (o.web?.flagged) {
          g.fillStyle = '#dc2626';
          g.fillText('⚑', o.box.x + o.box.w - label * 0.5, o.box.y + label * 0.6);
        }
        if (sel && props.current.tool === 'select') {
          g.fillStyle = '#fff';
          g.strokeStyle = st.color;
          g.lineWidth = lw;
          const hs = HANDLE_PX / v.scale;
          for (const [hx, hy] of handlePoints(o.box)) {
            g.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
            g.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
          }
        }
      });
      const d = drag.current;
      if (d?.kind === 'draw') {
        const b = boxFromPoints(d.start.x, d.start.y, d.cur.x, d.cur.y);
        g.setLineDash([6 / v.scale, 4 / v.scale]);
        g.strokeStyle = '#2563eb';
        g.lineWidth = lw;
        g.strokeRect(b.x, b.y, b.w, b.h);
      }
      g.restore();
    });
  }, []);

  const fit = useCallback(() => {
    const c = ref.current;
    if (!c) return;
    vp.current = fitViewport(props.current.page, { width: c.clientWidth, height: c.clientHeight });
    draw();
  }, [draw]);

  // image loading (lazy: only the current page is in memory)
  useEffect(() => {
    const url = p.showClean && p.cleanUrl ? p.cleanUrl : p.imageUrl;
    const im = new Image();
    im.decoding = 'async';
    im.onload = draw;
    im.src = url;
    img.current = im;
    return () => {
      im.onload = null;
    };
  }, [p.imageUrl, p.cleanUrl, p.showClean, draw]);

  useEffect(fit, [p.page.id, p.fitSignal, fit]);
  useEffect(draw, [p.page, p.selectedId, p.tool, draw]);
  useEffect(() => {
    const c = ref.current!;
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      vp.current = zoomAt(vp.current, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      draw();
    };
    c.addEventListener('wheel', wheel, { passive: false });
    const kd = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        space.current = true;
        e.preventDefault();
      }
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
  }, [draw]);

  const toImage = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return screenToImage(vp.current, e.clientX - r.left, e.clientY - r.top);
  };

  const onDown = (e: React.PointerEvent) => {
    ref.current!.setPointerCapture(e.pointerId);
    const { page, store, tool, selectedId } = props.current;
    if (e.button === 1 || space.current) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: vp.current.x, vy: vp.current.y };
      return;
    }
    if (e.button !== 0) return;
    const pt = toImage(e);
    if (tool === 'draw') {
      drag.current = { kind: 'draw', start: pt, cur: pt };
      return;
    }
    const hit = hitTest(page.objects, pt.x, pt.y);
    if (tool === 'order') {
      if (hit) props.current.onOrderClick(hit.id);
      return;
    }
    const sel = page.objects.find((o) => o.id === selectedId);
    const handle = sel ? handleAt(sel.box, pt, HANDLE_PX / vp.current.scale) : null;
    const target = handle ? sel! : hit;
    if (!target) {
      store.select({ objectId: null });
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: vp.current.x, vy: vp.current.y };
      return;
    }
    store.select({ objectId: target.id });
    drag.current = { kind: 'box', id: target.id, handle: handle ?? 'move', start: pt, orig: target.box, gesture: String(performance.now()) };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const c = ref.current!;
    if (!d) {
      const { page, selectedId, tool } = props.current;
      const sel = page.objects.find((o) => o.id === selectedId);
      const h = tool === 'select' && sel ? handleAt(sel.box, toImage(e), HANDLE_PX / vp.current.scale) : null;
      c.style.cursor = space.current ? 'grab' : tool === 'draw' ? 'crosshair' : h ? CURSOR[h] : 'default';
      return;
    }
    if (d.kind === 'pan') {
      vp.current = { ...vp.current, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy };
      draw();
    } else if (d.kind === 'draw') {
      d.cur = toImage(e);
      draw();
    } else {
      const pt = toImage(e);
      const dx = Math.round(pt.x - d.start.x);
      const dy = Math.round(pt.y - d.start.y);
      const pg = props.current.page;
      let nb = resize(d.orig, d.handle, dx, dy);
      // moving keeps the size: clamp the position, not the box
      if (d.handle === 'move') nb = { ...nb, x: Math.min(Math.max(0, nb.x), pg.width - nb.w), y: Math.min(Math.max(0, nb.y), pg.height - nb.h) };
      props.current.store.exec(SetBox(pg.id, d.id, nb, d.gesture));
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    const { store, page } = props.current;
    if (d?.kind === 'draw') {
      const b = boxFromPoints(Math.round(d.start.x), Math.round(d.start.y), Math.round(d.cur.x), Math.round(d.cur.y));
      if (b.w >= 4 && b.h >= 4) {
        const o = newObject('bubble', b);
        store.exec(AddObject(page.id, o));
        store.select({ objectId: o.id });
      }
      draw();
    }
    store.endGesture();
  };

  return (
    <canvas
      ref={ref}
      className="canvas"
      tabIndex={0}
      aria-label="Холст страницы"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

const CURSOR: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };

function handlePoints(b: Box): Array<[number, number]> {
  const { x, y, w, h } = b;
  return [
    [x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2],
    [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2],
  ];
}
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function handleAt(b: Box, pt: { x: number; y: number }, tol: number): Handle | null {
  const pts = handlePoints(b);
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i]![0] - pt.x) <= tol && Math.abs(pts[i]![1] - pt.y) <= tol) return HANDLES[i]!;
  }
  return null;
}

/** New box after dragging a handle by (dx, dy) image px; never inverts, min 1 px. */
export function resize(b: Box, h: Handle, dx: number, dy: number): Box {
  let x0 = b.x;
  let y0 = b.y;
  let x1 = b.x + b.w;
  let y1 = b.y + b.h;
  if (h === 'move') return { ...b, x: b.x + dx, y: b.y + dy };
  if (h.includes('w')) x0 = Math.min(x0 + dx, x1 - 1);
  if (h.includes('e')) x1 = Math.max(x1 + dx, x0 + 1);
  if (h.includes('n')) y0 = Math.min(y0 + dy, y1 - 1);
  if (h.includes('s')) y1 = Math.max(y1 + dy, y0 + 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
