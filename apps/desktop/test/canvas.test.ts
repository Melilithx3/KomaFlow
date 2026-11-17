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
