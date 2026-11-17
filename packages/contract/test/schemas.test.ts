import { describe, expect, it } from 'vitest';
import {
  PatchObjectRequest,
  SyncRequest,
  PsdSettings,
  DEFAULT_PSD_SETTINGS,
  CreateChapterRequest,
  ApiError,
  ROUTES,
  readImageHeader,
} from '../src/index.js';
import { makeFixtureChapter, fixtureSyncPage } from '../src/fixtures/index.js';
import { buildOpenApi } from '../src/openapi.js';

describe('schemas', () => {
  it('fixture sync payload is valid', () => {
    const pages = makeFixtureChapter().map((p) => fixtureSyncPage(p));
    const r = SyncRequest.safeParse({ pages });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('fixture PNGs have the page size', () => {
    for (const p of makeFixtureChapter()) {
      expect(readImageHeader(p.raw)).toEqual({ mime: 'image/png', width: p.width, height: p.height });
    }
  });
  it('rejects non-integer boxes, unknown types, non-v7 ids and extra keys', () => {
    const page = fixtureSyncPage(makeFixtureChapter()[0]!);
    const ok = (mut: (p: Record<string, unknown> & typeof page) => void) => {
      const p = structuredClone(page) as Record<string, unknown> & typeof page;
      mut(p);
      return SyncRequest.safeParse({ pages: [p] }).success;
    };
    expect(ok(() => {})).toBe(true);
    expect(ok((p) => (p.objects[0]!.box.x = 1.5))).toBe(false);
    expect(ok((p) => ((p.objects[0] as unknown as { type: string }).type = 'panel'))).toBe(false);
    expect(ok((p) => (p.id = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'))).toBe(false);
    expect(ok((p) => (p.objects[0]!.box.w = 0))).toBe(false);
    expect(ok((p) => (p.extra = 1))).toBe(false);
  });
  it('patch requires non-empty changes and respects limits', () => {
    expect(PatchObjectRequest.safeParse({ base_text_ver: 0, changes: {} }).success).toBe(false);
    expect(
      PatchObjectRequest.safeParse({ base_text_ver: 0, changes: { translation: 'x'.repeat(5001) } }).success,
    ).toBe(false);
    expect(PatchObjectRequest.safeParse({ base_text_ver: 0, changes: { comment: 'ok', flagged: true } }).success).toBe(
      true,
    );
  });
  it('default psd settings are valid', () => {
    expect(PsdSettings.parse(DEFAULT_PSD_SETTINGS)).toEqual(DEFAULT_PSD_SETTINGS);
  });
  it('chapter numbers', () => {
    expect(CreateChapterRequest.safeParse({ number: '12.5' }).success).toBe(true);
    expect(CreateChapterRequest.safeParse({ number: 'abc' }).success).toBe(false);
  });
  it('ApiError body', () => {
    const e = new ApiError('BLOBS_MISSING', 'missing', { missing: ['x'] });
    expect(e.status).toBe(409);
    expect(e.toBody()).toEqual({ error: { code: 'BLOBS_MISSING', message: 'missing', details: { missing: ['x'] } } });
  });
  it('openapi covers all routes', () => {
    const doc = buildOpenApi('test') as { paths: Record<string, Record<string, unknown>> };
    const count = Object.values(doc.paths).reduce((n, p) => n + Object.keys(p).length, 0);
    expect(count).toBe(ROUTES.length);
  });
});
