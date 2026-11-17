import { describe, expect, it } from 'vitest';
import {
  applyTextPatch,
  diffMarkup,
  pageStatus,
  countStates,
  psdInputHash,
  psdHashParts,
  staleReasons,
  DEFAULT_PSD_SETTINGS,
  DEFAULT_EXPORT_LAYERS,
  type TextData,
  type PsdHashInput,
} from '../src/index.js';

const base: TextData = {
  source_text: 'src',
  translation: '',
  state: 'empty',
  comment: '',
  flagged: false,
  text_ver: 0,
  field_vers: {},
};

describe('applyTextPatch', () => {
  it('non-empty translation implies translated', () => {
    const r = applyTextPatch(base, 0, { translation: 'Привет' });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.next.state).toBe('translated');
    expect(r.next.text_ver).toBe(1);
    expect(r.changed).toEqual(['translation', 'state']);
    expect(r.next.field_vers).toEqual({ translation: 1, state: 1 });
  });
  it('clearing translation returns to empty only from translated', () => {
    const t = applyTextPatch(base, 0, { translation: 'x' });
    if (t.kind !== 'ok') throw new Error('unexpected');
    const r = applyTextPatch(t.next, 1, { translation: '' });
    expect(r.kind === 'ok' && r.next.state).toBe('empty');
    const skipped: TextData = { ...base, state: 'skipped', translation: 'x' };
    const r2 = applyTextPatch(skipped, 0, { translation: '' });
    expect(r2.kind === 'ok' && r2.next.state).toBe('skipped');
  });
  it('explicit translated requires text', () => {
    expect(applyTextPatch(base, 0, { state: 'translated' }).kind).toBe('invalid');
    expect(applyTextPatch(base, 0, { state: 'translated', translation: 'ok' }).kind).toBe('ok');
  });
  it('skipped / unreadable allowed with any text', () => {
    const r = applyTextPatch(base, 0, { state: 'unreadable' });
    expect(r.kind === 'ok' && r.next.state).toBe('unreadable');
  });
  it('unchanged value creates no version', () => {
    const r = applyTextPatch(base, 0, { comment: '', flagged: false });
    expect(r.kind === 'ok' && r.changed).toEqual([]);
    expect(r.kind === 'ok' && r.next.text_ver).toBe(0);
  });
  it('different fields merge, same field conflicts', () => {
    const a = applyTextPatch(base, 0, { comment: 'A' });
    if (a.kind !== 'ok') throw new Error('unexpected');
    expect(applyTextPatch(a.next, 0, { flagged: true }).kind).toBe('ok');
    expect(applyTextPatch(a.next, 0, { comment: 'B' })).toEqual({ kind: 'conflict', fields: ['comment'] });
    expect(applyTextPatch(a.next, 0, { comment: 'A' }).kind).toBe('ok');
  });
});

describe('diffMarkup', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };
  const files = { clean_hash: null, notes_hash: null, thumb_hash: null };
  const stored = [
    { id: 'a', type: 'bubble' as const, box, text_box: null, ord: 1, deleted: false },
    { id: 'b', type: 'bubble' as const, box, text_box: null, ord: 2, deleted: false },
    { id: 'c', type: 'sfx' as const, box, text_box: null, ord: 0, deleted: true },
  ];
  it('identical state is unchanged', () => {
    const d = diffMarkup({ objects: stored, files }, { objects: stored.slice(0, 2), files });
    expect(d.changed).toBe(false);
    expect(d.geometryChanged).toEqual([]);
  });
  it('detects add, move, retype, delete, restore, files', () => {
    const d = diffMarkup(
      { objects: stored, files },
      {
        objects: [
          { id: 'c', type: 'sfx', box, text_box: null },
          { id: 'b', type: 'text', box: { ...box, x: 1 }, text_box: null },
          { id: 'n', type: 'bubble', box, text_box: null },
        ],
        files: { ...files, clean_hash: 'x' },
      },
    );
    expect(d.summary).toMatchObject({
      added: ['n'],
      moved: ['b'],
      retyped: ['b'],
      deleted: ['a'],
      restored: ['c'],
      reordered: false,
      clean_changed: true,
    });
    expect(d.changed).toBe(true);
    expect(new Set(d.geometryChanged)).toEqual(new Set(['a', 'b', 'c']));
  });
  it('detects pure reordering', () => {
    const d = diffMarkup({ objects: stored, files }, { objects: [stored[1]!, stored[0]!], files });
    expect(d.summary.reordered).toBe(true);
    expect(d.changed).toBe(true);
  });
  it('new page is always changed', () => {
    expect(diffMarkup(null, { objects: [], files }).changed).toBe(true);
  });
});

describe('pageStatus', () => {
  it('computes readiness', () => {
    const counts = countStates(['translated', 'skipped']);
    expect(pageStatus({ clean_hash: 'h', counts, typed_at: null, markup_rev: 2, seen_markup_rev: 1 })).toEqual({
      has_clean: true,
      translation_done: true,
      ready_for_typing: true,
      typed: false,
      markup_changed_for_me: true,
    });
    const s = pageStatus({
      clean_hash: null,
      counts: countStates(['empty']),
      typed_at: 'x',
      markup_rev: 1,
      seen_markup_rev: null,
    });
    expect(s).toMatchObject({ ready_for_typing: false, translation_done: false, typed: true, markup_changed_for_me: false });
  });
  it('page without objects is done', () => {
    const s = pageStatus({ clean_hash: 'h', counts: countStates([]), typed_at: null, markup_rev: 0, seen_markup_rev: 0 });
    expect(s.ready_for_typing).toBe(true);
  });
});

describe('psdInputHash', () => {
  const input: PsdHashInput = {
    raw_hash: 'a'.repeat(64),
    clean_hash: 'b'.repeat(64),
    notes_hash: null,
    width: 800,
    height: 1200,
    psd_settings: DEFAULT_PSD_SETTINGS,
    layers: { ...DEFAULT_EXPORT_LAYERS, text: false },
    objects: [
      {
        id: 'o1',
        type: 'bubble',
        box: { x: 1, y: 2, w: 3, h: 4 },
        text_box: null,
        order: 1,
        translation: 'Да',
        state: 'translated',
      },
    ],
  };
  const withTranslation = (t: string) => ({ ...input, objects: [{ ...input.objects[0]!, translation: t }] });
  it('without text layers: translation, markup and font settings do not affect the hash', () => {
    const h = psdInputHash(input);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(psdInputHash(structuredClone(input))).toBe(h);
    expect(psdInputHash(withTranslation('Нет'))).toBe(h);
    expect(psdInputHash({ ...input, objects: [] })).toBe(h);
    expect(psdInputHash({ ...input, psd_settings: { ...DEFAULT_PSD_SETTINGS, default_font: 'X' } })).toBe(h);
  });
  it('clean, notes, layer flags and raw/notes settings do', () => {
    const h = psdInputHash(input);
    expect(psdInputHash({ ...input, clean_hash: 'c'.repeat(64) })).not.toBe(h);
    expect(psdInputHash({ ...input, notes_hash: 'd'.repeat(64) })).not.toBe(h);
    expect(psdInputHash({ ...input, layers: { ...input.layers, raw: false } })).not.toBe(h);
    expect(psdInputHash({ ...input, psd_settings: { ...DEFAULT_PSD_SETTINGS, notes_opacity: 50 } })).not.toBe(h);
  });
  it('disabled layers ignore their files', () => {
    const noClean = { ...input, layers: { ...input.layers, clean: false } };
    expect(psdInputHash({ ...noClean, clean_hash: 'c'.repeat(64) })).toBe(psdInputHash(noClean));
  });
  it('with text layers translation, rotation and font settings count', () => {
    const t = { ...input, layers: { ...input.layers, text: true } };
    expect(psdInputHash({ ...t, objects: withTranslation('Нет').objects })).not.toBe(psdInputHash(t));
    expect(psdInputHash({ ...t, objects: [{ ...t.objects[0]!, rotation: 5 }] })).not.toBe(psdInputHash(t));
    expect(psdInputHash({ ...t, psd_settings: { ...DEFAULT_PSD_SETTINGS, default_font: 'X' } })).not.toBe(psdInputHash(t));
    expect(staleReasons(psdHashParts(t), psdHashParts({ ...t, objects: withTranslation('Нет').objects }))).toEqual(['translation']);
    expect(DEFAULT_EXPORT_LAYERS.text).toBe(true);
  });
  it('explains staleness by parts', () => {
    const before = psdHashParts(input);
    const after = psdHashParts({ ...withTranslation('Нет'), clean_hash: 'c'.repeat(64) });
    expect(staleReasons(before, after)).toEqual(['clean']);
    const s2 = psdHashParts({ ...input, psd_settings: { ...DEFAULT_PSD_SETTINGS, raw_layer_visible: true } });
    expect(staleReasons(before, s2)).toEqual(['settings']);
  });
});
