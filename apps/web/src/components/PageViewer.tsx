import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { Box, ObjectType } from '@komaflow/contract';
import { centerOn, fitViewport, hitTest, screenToImage, TYPE_STYLE, zoomAt, type Viewport } from '@komaflow/page-view';
import { blobUrl } from '../lib/api.js';
import { t } from '../strings.js';

export interface ViewerObject {
  id: string;
  order: number;
  type: ObjectType;
  box: Box;
}

export interface PageViewerHandle {
  centerOn(id: string): void;
}

interface Props {
  width: number;
  height: number;
  rawHash: string;
  cleanHash: string | null;
  notesHash: string | null;
  objects: ViewerObject[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  handle?: Ref<PageViewerHandle>;
}

/** Page view with pan / zoom / pinch and numbered boxes (docs/06-web.md §1.4). */
export const PageViewer = memo(function PageViewer(p: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'raw' | 'clean'>('raw');
  const [showNotes, setShowNotes] = useState(false);
  const [numbersOnClean, setNumbersOnClean] = useState(false);
  const [vp, setVp] = useState<Viewport>({ scale: 0.2, x: 0, y: 0 });
  const vpRef = useRef(vp);
  vpRef.current = vp;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);

  const size = () => {
    const r = wrap.current?.getBoundingClientRect();
    return { width: r?.width ?? 800, height: r?.height ?? 600 };
  };
  /** Until the user pans or zooms, the page follows the container size. */
  const touched = useRef(false);
  const fit = useCallback(() => {
    touched.current = false;
    setVp(fitViewport({ width: p.width, height: p.height }, size()));
  }, [p.width, p.height]);
  useLayoutEffect(fit, [fit, p.rawHash]);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!touched.current && el.clientWidth > 0 && el.clientHeight > 0) setVp(fitViewport({ width: p.width, height: p.height }, size()));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [p.width, p.height]);

  useImperativeHandle(p.handle, () => ({
    centerOn(id: string) {
      const o = p.objects.find((x) => x.id === id);
      if (o) {
        touched.current = true;
        setVp((v) => centerOn(v, o.box, size()));
      }
    },
  }));

  // Wheel zoom needs a non-passive listener.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      touched.current = true;
      const r = el.getBoundingClientRect();
      setVp((v) => zoomAt(v, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    wrap.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 1) drag.current = { ...local(e), moved: false };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), cx: (a!.x + b!.x) / 2, cy: (a!.y + b!.y) / 2 };
      drag.current = null;
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const pt = local(e);
    pointers.current.set(e.pointerId, pt);
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const cx = (a!.x + b!.x) / 2;
      const cy = (a!.y + b!.y) / 2;
      const prev = pinch.current;
      touched.current = true;
      setVp((v) => {
        const z = zoomAt(v, dist / Math.max(1, prev.dist), cx, cy);
        return { ...z, x: z.x + (cx - prev.cx), y: z.y + (cy - prev.cy) };
      });
      pinch.current = { dist, cx, cy };
    } else if (drag.current) {
      const dx = pt.x - drag.current.x;
      const dy = pt.y - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
      if (drag.current.moved) {
        touched.current = true;
        setVp((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
        drag.current = { x: pt.x, y: pt.y, moved: true };
      }
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (d && !d.moved && pointers.current.size === 0) {
      const ip = screenToImage(vpRef.current, local(e).x, local(e).y);
      const hit = hitTest(p.objects, ip.x, ip.y);
      if (hit) p.onSelect(hit.id);
    }
    if (pointers.current.size === 0) drag.current = null;
  };

  const zoomBy = (f: number) => {
    touched.current = true;
    setVp((v) => zoomAt(v, f, size().width / 2, size().height / 2));
  };

  const img = mode === 'clean' && p.cleanHash ? p.cleanHash : p.rawHash;
  const showNumbers = mode === 'raw' || numbersOnClean;
  const labelSize = Math.max(18, Math.min(p.width, p.height) * 0.028);

  return (
    <div className="viewer">
      <div className="viewer-toolbar" role="toolbar">
        <div className="seg" role="group" aria-label="Изображение">
          <button aria-pressed={mode === 'raw'} onClick={() => setMode('raw')}>
            {t.page.raw}
          </button>
          <button aria-pressed={mode === 'clean'} onClick={() => setMode('clean')} disabled={!p.cleanHash} title={p.cleanHash ? '' : t.page.noClean}>
            {t.page.clean}
          </button>
        </div>
        {p.notesHash && (
          <label className="check">
            <input type="checkbox" checked={showNotes} onChange={(e) => setShowNotes(e.target.checked)} /> {t.page.notes}
          </label>
        )}
        {mode === 'clean' && (
          <label className="check">
            <input type="checkbox" checked={numbersOnClean} onChange={(e) => setNumbersOnClean(e.target.checked)} /> {t.page.numbers}
          </label>
        )}
        <span className="spacer" />
        <button aria-label={t.page.zoomOut} onClick={() => zoomBy(1 / 1.25)}>
          −
        </button>
        <button aria-label={t.page.zoomIn} onClick={() => zoomBy(1.25)}>
          +
        </button>
        <button onClick={fit}>{t.page.fit}</button>
      </div>
      <div
        ref={wrap}
        className="viewer-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={fit}
      >
        <div
          className="viewer-stage"
          style={{ width: p.width, height: p.height, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.scale})` }}
        >
          <img src={blobUrl(img)} width={p.width} height={p.height} alt="" draggable={false} decoding="async" />
          {showNotes && p.notesHash && <img src={blobUrl(p.notesHash)} width={p.width} height={p.height} alt="" draggable={false} className="notes" />}
          {showNumbers && (
            <svg viewBox={`0 0 ${p.width} ${p.height}`} width={p.width} height={p.height} className="boxes" aria-hidden>
              {p.objects.map((o) => (
                <BoxMark key={o.id} o={o} selected={o.id === p.selectedId} size={labelSize} scale={vp.scale} />
              ))}
            </svg>
          )}
        </div>
      </div>
    </div>
  );
});

function BoxMark({ o, selected, size, scale }: { o: ViewerObject; selected: boolean; size: number; scale: number }) {
  const st = TYPE_STYLE[o.type];
  const stroke = Math.max(2, 2 / scale);
  const s = size;
  const cx = o.box.x + s * 0.6;
  const cy = o.box.y + s * 0.6;
  const shape =
    st.shape === 'circle' ? (
      <circle cx={cx} cy={cy} r={s * 0.6} />
    ) : st.shape === 'square' ? (
      <rect x={cx - s * 0.55} y={cy - s * 0.55} width={s * 1.1} height={s * 1.1} />
    ) : st.shape === 'diamond' ? (
      <polygon points={`${cx},${cy - s * 0.75} ${cx + s * 0.75},${cy} ${cx},${cy + s * 0.75} ${cx - s * 0.75},${cy}`} />
    ) : (
      <rect x={cx - s * 0.7} y={cy - s * 0.5} width={s * 1.4} height={s} rx={s * 0.3} />
    );
  return (
    <g>
      <rect
        x={o.box.x}
        y={o.box.y}
        width={o.box.w}
        height={o.box.h}
        fill={selected ? `${st.color}22` : 'none'}
        stroke={st.color}
        strokeWidth={selected ? stroke * 2 : stroke}
        strokeDasharray={o.type === 'text' ? `${stroke * 4} ${stroke * 2}` : undefined}
      />
      <g fill={st.color} stroke="#fff" strokeWidth={stroke * 0.6}>
        {shape}
      </g>
      <text x={cx} y={cy} fill="#fff" fontSize={s * 0.75} fontWeight={700} textAnchor="middle" dominantBaseline="central">
        {o.order}
      </text>
    </g>
  );
}
