import { describe, expect, it } from 'vitest';
import { buildTranslationJson, changeCase, labelAnchor, parseTranslationJson, pointInBox, wheelAction } from '../src/index.js';
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


describe('rotation, labels, wheel', () => {
  it('point in rotated box', () => {
    const b = { x: 0, y: 40, w: 100, h: 20 };
    expect(pointInBox(b, 0, 95, 50)).toBe(true);
    expect(pointInBox(b, 90, 95, 50)).toBe(false);
    expect(pointInBox(b, 90, 50, 5)).toBe(true);
  });
  it('label sits outside the box', () => {
    expect(labelAnchor({ x: 100, y: 100, w: 50, h: 50 }, 0, 20).y).toBeLessThan(100);
    const atTop = labelAnchor({ x: 100, y: 0, w: 50, h: 50 }, 0, 20);
    expect(atTop.x).toBeLessThan(100);
  });
  it('wheel mapping', () => {
    const base = { deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false };
    expect(wheelAction(base)).toEqual({ kind: 'pan', dx: -0, dy: -100 });
    expect(wheelAction({ ...base, shiftKey: true })).toEqual({ kind: 'pan', dx: -100, dy: 0 });
    expect(wheelAction({ ...base, deltaX: 30, deltaY: 10 })).toEqual({ kind: 'pan', dx: -30, dy: -10 });
    const z = wheelAction({ ...base, ctrlKey: true });
    expect(z.kind === 'zoom' && z.factor).toBeLessThan(1);
  });
});

describe('case', () => {
  it('sentence case for OCR caps', () => {
    expect(changeCase("WHAT?! I'M NOT GOING... NO WAY.\nTHE END", 'sentence')).toBe("What?! I'm not going... No way.\nThe end");
    expect(changeCase('ここが噂の店か…', 'sentence')).toBe('ここが噂の店か…');
    expect(changeCase('Hi', 'upper')).toBe('HI');
  });
});

describe('translation json', () => {
  const pages = [
    { idx: 1, objects: [{ id: 'a', order: 1, type: 'bubble', source_text: 'HELLO', translation: '', state: 'empty' }, { id: 'b', order: 2, type: 'sfx', source_text: 'BAM', translation: 'БАМ', state: 'translated' }] },
    { idx: 2, objects: [{ id: 'c', order: 1, type: 'bubble', source_text: 'BYE', translation: '', state: 'empty' }] },
  ];
  it('exports empty translations, optionally only untranslated', () => {
    const doc = JSON.parse(buildTranslationJson(pages, { sourceLang: 'en', targetLang: 'ru', chapter: '3' }));
    expect(doc.pages[0].objects).toEqual([
      { n: 1, id: 'a', type: 'bubble', source: 'HELLO', translation: '' },
      { n: 2, id: 'b', type: 'sfx', source: 'BAM', translation: '' },
    ]);
    const only = JSON.parse(buildTranslationJson(pages, { sourceLang: 'en', targetLang: 'ru', onlyUntranslated: true }));
    expect(only.pages[0].objects.map((o: { id: string }) => o.id)).toEqual(['a']);
  });
  it('imports by id, falls back to page+n, reports unmatched; tolerates code fences', () => {
    const answer = '```json\n' + JSON.stringify({ pages: [{ page: 1, objects: [{ n: 1, id: 'a', translation: 'Привет' }, { n: 2, translation: 'Бах' }, { n: 9, translation: 'x' }] }, { page: 2, objects: [{ n: 1, translation: '' }] }] }) + '\n```';
    const r = parseTranslationJson(answer, pages);
    expect(r.matches.map((m) => [m.objectId, m.translation])).toEqual([['a', 'Привет'], ['b', 'Бах']]);
    expect(r.unmatched).toEqual([{ page: 1, n: 9, id: null }]);
    expect(r.empty).toBe(1);
    expect(() => parseTranslationJson('nope', pages)).toThrow(/JSON/);
  });
});
