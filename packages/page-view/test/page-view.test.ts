import { describe, expect, it } from 'vitest';
import { centerOn, fitViewport, formatCopyAll, hitTest, imageToScreen, screenToImage, zoomAt, TYPE_STYLE } from '../src/index.js';

describe('viewport', () => {
  it('fits and centres', () => {
    const v = fitViewport({ width: 1000, height: 2000 }, { width: 532, height: 532 });
    expect(v.scale).toBeCloseTo(0.25);
    expect(v.x).toBeCloseTo(141);
    expect(v.y).toBeCloseTo(16);
  });
  it('zoom keeps the cursor point fixed', () => {
    const v = { scale: 0.5, x: 10, y: 20 };
    const before = screenToImage(v, 200, 300);
    const z = zoomAt(v, 2, 200, 300);
    expect(z.scale).toBe(1);
    const after = imageToScreen(z, before.x, before.y);
    expect(after.x).toBeCloseTo(200);
    expect(after.y).toBeCloseTo(300);
  });
  it('centers on a box', () => {
    const c = centerOn({ scale: 1, x: 0, y: 0 }, { x: 100, y: 100, w: 50, h: 50 }, { width: 400, height: 400 });
    expect(imageToScreen(c, 125, 125)).toEqual({ x: 200, y: 200 });
  });
  it('hit test picks the smallest box', () => {
    const items = [
      { id: 'big', box: { x: 0, y: 0, w: 100, h: 100 } },
      { id: 'small', box: { x: 10, y: 10, w: 10, h: 10 } },
    ];
    expect(hitTest(items, 15, 15)!.id).toBe('small');
    expect(hitTest(items, 50, 50)!.id).toBe('big');
    expect(hitTest(items, 500, 50)).toBeNull();
  });
});

describe('copy all', () => {
  it('formats by order with marks', () => {
    expect(
      formatCopyAll([
        { order: 2, translation: 'Второй\nстрока', state: 'translated' },
        { order: 1, translation: ' Первый ', state: 'translated' },
        { order: 3, translation: '', state: 'skipped' },
        { order: 4, translation: '', state: 'unreadable' },
        { order: 5, translation: '', state: 'empty' },
      ]),
    ).toBe('1. Первый\n\n2. Второй\nстрока\n\n3. (пропущено)\n\n4. (нечитаемо)\n\n5. (пусто)');
  });
  it('palette has distinct colours and shapes', () => {
    const s = Object.values(TYPE_STYLE);
    expect(new Set(s.map((x) => x.color)).size).toBe(4);
    expect(new Set(s.map((x) => x.shape)).size).toBe(4);
  });
});
