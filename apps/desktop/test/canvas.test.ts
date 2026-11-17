import { describe, expect, it } from 'vitest';
import { resize } from '../src/ui/Canvas.js';

describe('box handles', () => {
  const b = { x: 10, y: 10, w: 20, h: 20 };
  it('moves and resizes from each side, never inverts', () => {
    expect(resize(b, 'move', 5, -3)).toEqual({ x: 15, y: 7, w: 20, h: 20 });
    expect(resize(b, 'se', 5, 5)).toEqual({ x: 10, y: 10, w: 25, h: 25 });
    expect(resize(b, 'nw', 5, 5)).toEqual({ x: 15, y: 15, w: 15, h: 15 });
    expect(resize(b, 'w', 100, 0)).toEqual({ x: 29, y: 10, w: 1, h: 20 });
    expect(resize(b, 'n', 0, -5)).toEqual({ x: 10, y: 5, w: 20, h: 25 });
  });
});

import { boxCorners } from '@komaflow/page-view';
import { handleAt, resizeRotated } from '../src/ui/Canvas.js';

describe('rotated boxes', () => {
  it('resizing a rotated box keeps the opposite edge in place', () => {
    const b = { x: 100, y: 100, w: 80, h: 40 };
    const before = boxCorners(b, 30);
    // drag the east handle outwards along the box's own x axis by 20 px
    const a = (30 * Math.PI) / 180;
    const nb = resizeRotated(b, 30, 'e', 20 * Math.cos(a), 20 * Math.sin(a));
    expect(nb.w).toBe(100);
    expect(nb.h).toBe(40);
    const after = boxCorners(nb, 30);
    // west corners (0 = top-left, 3 = bottom-left) stay within rounding
    expect(Math.abs(after[0]!.x - before[0]!.x)).toBeLessThan(1);
    expect(Math.abs(after[3]!.y - before[3]!.y)).toBeLessThan(1);
  });
  it('rotation 0 behaves like the plain resize; handles respect rotation', () => {
    expect(resizeRotated({ x: 10, y: 10, w: 20, h: 20 }, 0, 'se', 5, 5)).toEqual({ x: 10, y: 10, w: 25, h: 25 });
    const b = { x: 0, y: 0, w: 100, h: 20 };
    // rotated 90°: the box's "east" handle sits below the centre on screen
    expect(handleAt(b, 90, { x: 50, y: 60 }, 3, 20)).toBe('e');
    expect(handleAt(b, 0, { x: 50, y: -20 }, 3, 20)).toBe('rotate');
  });
});
