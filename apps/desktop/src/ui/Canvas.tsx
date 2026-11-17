import { useCallback, useEffect, useRef } from 'react';
import { boxFromPoints, type Box } from '@komaflow/contract';
import { boxCorners, fitViewport, hitTest, labelAnchor, screenToImage, toBoxFrame, TYPE_STYLE, wheelAction, zoomAt, type Viewport } from '@komaflow/page-view';
import { AddObject, SetBox, SetRotation, newObject } from '../core/commands.js';
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

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move' | 'rotate';
type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'box'; id: string; handle: Handle; start: { x: number; y: number }; orig: Box; rotation: number; gesture: string }
  | { kind: 'draw'; start: { x: number; y: number }; cur: { x: number; y: number } };

const HANDLE_PX = 8;
const ROTATE_OFFSET_PX = 26;

/**
 * Canvas renderer (docs/05 §2, §3): it holds no data, only draws the store and turns pointer input into
 * commands. Wheel — vertical pan, Shift+wheel — horizontal, Ctrl+wheel / pinch — zoom, two-finger
 * trackpad scroll — free pan, Space+drag or middle button — pan.
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
      const { page, selectedId, tool } = props.current;
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
      g.save();
      g.translate(v.x, v.y);
      g.scale(v.scale, v.scale);
      g.shadowColor = '#0008';
      g.shadowBlur = 24 / v.scale;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, page.width, page.height);
      g.shadowBlur = 0;
      if (img.current?.complete && img.current.naturalWidth) {
        g.imageSmoothingQuality = v.scale < 1 ? 'medium' : 'low';
        g.drawImage(img.current, 0, 0, page.width, page.height);
      }
      const lw = 1.6 / v.scale;
      const label = Math.min(Math.max(20 / v.scale, 12), Math.min(page.width, page.height) * 0.06);
      const anySel = page.objects.some((o) => o.id === selectedId);
      page.objects.forEach((o, i) => {
        const st = TYPE_STYLE[o.type];
        const sel = o.id === selectedId;
        const rot = o.rotation ?? 0;
        g.globalAlpha = anySel && !sel ? 0.45 : 1;
        // box (rotated around its centre)
        g.save();
        g.translate(o.box.x + o.box.w / 2, o.box.y + o.box.h / 2);
        g.rotate((rot * Math.PI) / 180);
        g.lineWidth = sel ? lw * 2 : lw;
        g.strokeStyle = st.color;
        g.setLineDash(o.type === 'text' ? [lw * 4, lw * 2] : []);
        if (sel) {
          g.fillStyle = `${st.color}22`;
          g.fillRect(-o.box.w / 2, -o.box.h / 2, o.box.w, o.box.h);
        }
        g.strokeRect(-o.box.w / 2, -o.box.h / 2, o.box.w, o.box.h);
        g.setLineDash([]);
        if (sel && tool === 'select') {
          const hs = HANDLE_PX / v.scale;
          g.fillStyle = '#fff';
          g.lineWidth = lw;
          for (const [hx, hy] of localHandles(o.box)) {
            g.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
            g.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
          }
          // rotation handle above the top edge
          const ry = -o.box.h / 2 - ROTATE_OFFSET_PX / v.scale;
          g.beginPath();
          g.moveTo(0, -o.box.h / 2);
          g.lineTo(0, ry);
          g.stroke();
          g.beginPath();
          g.arc(0, ry, hs * 0.75, 0, Math.PI * 2);
          g.fill();
          g.stroke();
        }
        g.restore();
        // number badge outside the box, type-specific shape
        const a = labelAnchor(o.box, rot, label);
        g.fillStyle = st.color;
        g.strokeStyle = '#fff';
        g.lineWidth = label * 0.08;
        g.beginPath();
        if (st.shape === 'circle') g.arc(a.x, a.y, label * 0.6, 0, Math.PI * 2);
        else if (st.shape === 'square') g.rect(a.x - label * 0.55, a.y - label * 0.55, label * 1.1, label * 1.1);
        else if (st.shape === 'diamond') {
          g.moveTo(a.x, a.y - label * 0.75);
          g.lineTo(a.x + label * 0.75, a.y);
          g.lineTo(a.x, a.y + label * 0.75);
          g.lineTo(a.x - label * 0.75, a.y);
          g.closePath();
        } else g.roundRect(a.x - label * 0.75, a.y - label * 0.5, label * 1.5, label, label * 0.3);
        g.fill();
        g.stroke();
        g.fillStyle = '#fff';
        g.font = `700 ${label * 0.72}px system-ui, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(i + 1), a.x, a.y + 0.5);
        if (o.web?.flagged) {
          const tr = boxCorners(o.box, rot)[1]!;
          g.fillStyle = '#ef4444';
          g.fillText('⚑', tr.x + label * 0.4, tr.y - label * 0.2);
        }
      });
      g.globalAlpha = 1;
      const d = drag.current;
      if (d?.kind === 'draw') {
        const b = boxFromPoints(d.start.x, d.start.y, d.cur.x, d.cur.y);
        g.setLineDash([6 / v.scale, 4 / v.scale]);
        g.strokeStyle = '#818cf8';
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
      const a = wheelAction(e);
      const r = c.getBoundingClientRect();
      if (a.kind === 'zoom') vp.current = zoomAt(vp.current, a.factor, e.clientX - r.left, e.clientY - r.top);
      else vp.current = { ...vp.current, x: vp.current.x + a.dx, y: vp.current.y + a.dy };
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

  const toImage = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return screenToImage(vp.current, e.clientX - r.left, e.clientY - r.top);
  };

  const selectedHandle = (pt: { x: number; y: number }): Handle | null => {
    const { page, selectedId, tool } = props.current;
    const sel = page.objects.find((o) => o.id === selectedId);
    if (!sel || tool !== 'select') return null;
    return handleAt(sel.box, sel.rotation ?? 0, pt, HANDLE_PX / vp.current.scale, ROTATE_OFFSET_PX / vp.current.scale);
  };

  const onDown = (e: React.PointerEvent) => {
    ref.current!.setPointerCapture(e.pointerId);
    ref.current!.focus();
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
    const handle = selectedHandle(pt);
    const sel = page.objects.find((o) => o.id === selectedId);
    const target = handle ? sel! : hit;
    if (!target) {
      store.select({ objectId: null });
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: vp.current.x, vy: vp.current.y };
      return;
    }
    store.select({ objectId: target.id });
    drag.current = { kind: 'box', id: target.id, handle: handle ?? 'move', start: pt, orig: target.box, rotation: target.rotation ?? 0, gesture: String(performance.now()) };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const c = ref.current!;
    if (!d) {
      const { tool } = props.current;
      const h = selectedHandle(toImage(e));
      c.style.cursor = space.current ? 'grab' : tool === 'draw' ? 'crosshair' : h ? cursorFor(h) : 'default';
      return;
    }
    if (d.kind === 'pan') {
      vp.current = { ...vp.current, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy };
      draw();
    } else if (d.kind === 'draw') {
      d.cur = toImage(e);
      draw();
    } else {
      const pg = props.current.page;
      const pt = toImage(e);
      if (d.handle === 'rotate') {
        const cx = d.orig.x + d.orig.w / 2;
        const cy = d.orig.y + d.orig.h / 2;
        let deg = (Math.atan2(pt.y - cy, pt.x - cx) * 180) / Math.PI + 90;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        props.current.store.exec(SetRotation(pg.id, d.id, deg, d.gesture));
        return;
      }
      let nb = resizeRotated(d.orig, d.rotation, d.handle, pt.x - d.start.x, pt.y - d.start.y);
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

const CURSOR: Record<Exclude<Handle, 'rotate'>, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };
const cursorFor = (h: Handle) => (h === 'rotate' ? 'grab' : CURSOR[h]);

/** Handle points in the box frame (origin at the centre). */
function localHandles(b: Box): Array<[number, number]> {
  const x = b.w / 2;
  const y = b.h / 2;
  return [[-x, -y], [0, -y], [x, -y], [x, 0], [x, y], [0, y], [-x, y], [-x, 0]];
}
const HANDLES: Array<Exclude<Handle, 'move' | 'rotate'>> = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function handleAt(b: Box, rotation: number, pt: { x: number; y: number }, tol: number, rotateOffset: number): Handle | null {
  const lp = toBoxFrame(b, rotation, pt.x, pt.y);
  if (Math.abs(lp.x) <= tol && Math.abs(lp.y - (-b.h / 2 - rotateOffset)) <= tol) return 'rotate';
  const hs = localHandles(b);
  for (let i = 0; i < hs.length; i++) {
    if (Math.abs(hs[i]![0] - lp.x) <= tol && Math.abs(hs[i]![1] - lp.y) <= tol) return HANDLES[i]!;
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
  if (h === 'rotate') return b;
  if (h.includes('w')) x0 = Math.min(x0 + dx, x1 - 1);
  if (h.includes('e')) x1 = Math.max(x1 + dx, x0 + 1);
  if (h.includes('n')) y0 = Math.min(y0 + dy, y1 - 1);
  if (h.includes('s')) y1 = Math.max(y1 + dy, y0 + 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Resize of a rotated box: the drag is applied in the box's own frame, then the new centre is rotated
 * back, so the opposite edge stays where it was on screen. With rotation 0 equals {@link resize}.
 */
export function resizeRotated(b: Box, rotation: number, h: Handle, dx: number, dy: number): Box {
  if (h === 'move' || !rotation) {
    const r = resize(b, h, Math.round(dx), Math.round(dy));
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  }
  const a = (rotation * Math.PI) / 180;
  const ldx = dx * Math.cos(a) + dy * Math.sin(a);
  const ldy = -dx * Math.sin(a) + dy * Math.cos(a);
  const local = resize({ x: -b.w / 2, y: -b.h / 2, w: b.w, h: b.h }, h, ldx, ldy);
  const lcx = local.x + local.w / 2;
  const lcy = local.y + local.h / 2;
  const cx = b.x + b.w / 2 + lcx * Math.cos(a) - lcy * Math.sin(a);
  const cy = b.y + b.h / 2 + lcx * Math.sin(a) + lcy * Math.cos(a);
  const w = Math.max(1, Math.round(local.w));
  const hh = Math.max(1, Math.round(local.h));
  return { x: Math.round(cx - w / 2), y: Math.round(cy - hh / 2), w, h: hh };
}
