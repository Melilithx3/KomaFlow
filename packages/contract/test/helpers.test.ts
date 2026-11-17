import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  autoReadingOrder,
  boxInsidePage,
  canonicalJson,
  clampBox,
  insetBox,
  readImageHeader,
  sha256Hex,
  toCanonical,
  uuidv7,
  UuidV7,
  uuidv7Timestamp,
} from '../src/index.js';
import { encodePng } from '../src/fixtures/index.js';

describe('sha256', () => {
  it('matches node:crypto for various lengths', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 100_000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      expect(sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
  it('hashes utf-8 strings', () => {
    expect(sha256Hex('привет')).toBe(createHash('sha256').update('привет', 'utf8').digest('hex'));
  });
});

describe('uuidv7', () => {
  it('produces valid, time-ordered, unique ids', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7());
    for (const id of ids) expect(UuidV7.safeParse(id).success).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
  it('encodes the timestamp', () => {
    const t = Date.UTC(2027, 0, 1);
    expect(uuidv7Timestamp(uuidv7(t))).toBe(t);
  });
});

describe('canonicalJson', () => {
  it('sorts keys and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}',
    );
  });
  it('rejects non-integers but toCanonical converts them', () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
    expect(canonicalJson(toCanonical({ a: 1.15, b: 2 }))).toBe('{"a":"1.15","b":2}');
  });
  it('skips undefined keys', () => {
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
  });
});

describe('geometry', () => {
  const page = { width: 100, height: 200 };
  it('checks boxes inside the page', () => {
    expect(boxInsidePage({ x: 0, y: 0, w: 100, h: 200 }, page)).toBe(true);
    expect(boxInsidePage({ x: 1, y: 0, w: 100, h: 200 }, page)).toBe(false);
    expect(boxInsidePage({ x: 0, y: 0, w: 0, h: 5 }, page)).toBe(false);
    expect(boxInsidePage({ x: 0.5, y: 0, w: 5, h: 5 }, page)).toBe(false);
  });
  it('clamps boxes', () => {
    expect(clampBox({ x: -10, y: 190, w: 50, h: 50 }, page)).toEqual({ x: 0, y: 190, w: 40, h: 10 });
    expect(clampBox({ x: 150, y: 10, w: 5, h: 5 }, page)).toEqual({ x: 99, y: 10, w: 1, h: 5 });
  });
  it('insets boxes', () => {
    expect(insetBox({ x: 10, y: 10, w: 100, h: 50 }, 0.1)).toEqual({ x: 20, y: 15, w: 80, h: 40 });
  });
});

describe('autoReadingOrder', () => {
  const b = (id: string, x: number, y: number, w = 100, h = 100) => ({ id, box: { x, y, w, h } });
  it('rtl: rows top to bottom, right to left', () => {
    const items = [b('tl', 0, 0), b('tr', 300, 20), b('bl', 0, 300), b('br', 300, 310)];
    expect(autoReadingOrder(items, 'rtl')).toEqual(['tr', 'tl', 'br', 'bl']);
    expect(autoReadingOrder(items, 'ltr')).toEqual(['tl', 'tr', 'bl', 'br']);
  });
  it('does not group boxes with small vertical overlap', () => {
    const items = [b('a', 0, 0, 100, 100), b('b', 300, 60, 100, 100)];
    // overlap 40 / 100 = 0.4 <= 0.5 -> separate rows
    expect(autoReadingOrder(items, 'rtl')).toEqual(['a', 'b']);
  });
  it('handles empty and single inputs', () => {
    expect(autoReadingOrder([], 'rtl')).toEqual([]);
    expect(autoReadingOrder([b('x', 5, 5)], 'ltr')).toEqual(['x']);
  });
});

describe('readImageHeader', () => {
  it('reads PNG size', () => {
    const png = encodePng(3, 2, new Uint8Array(24));
    expect(readImageHeader(png)).toEqual({ mime: 'image/png', width: 3, height: 2 });
  });
  it('reads JPEG SOF', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 3, 0, 0, 0]);
    expect(readImageHeader(jpeg)).toEqual({ mime: 'image/jpeg', width: 30, height: 20 });
  });
  it('reads WebP VP8L', () => {
    const b = new Uint8Array(30);
    b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    b.set([...'WEBPVP8L'].map((c) => c.charCodeAt(0)), 8);
    b[20] = 0x2f;
    const bits = (10 - 1) | ((7 - 1) << 14);
    b.set([bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff], 21);
    expect(readImageHeader(b)).toEqual({ mime: 'image/webp', width: 10, height: 7 });
  });
  it('rejects garbage', () => {
    expect(readImageHeader(new TextEncoder().encode('<svg></svg> not an image at all'))).toBeNull();
  });
});
