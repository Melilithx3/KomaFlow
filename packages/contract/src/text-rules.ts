import type { TranslationState } from './common.js';
import type { TextField } from './dto.js';
import type { TextChanges } from './api.js';

export interface TextData {
  source_text: string;
  translation: string;
  state: TranslationState;
  comment: string;
  flagged: boolean;
  text_ver: number;
  field_vers: Partial<Record<TextField, number>>;
}

export type TextPatchResult =
  | { kind: 'ok'; next: TextData; changed: TextField[] }
  | { kind: 'conflict'; fields: TextField[] }
  | { kind: 'invalid'; message: string };

const FIELDS: readonly TextField[] = ['source_text', 'translation', 'state', 'comment', 'flagged'];

/**
 * Applies a web PATCH to an object's text data (docs/01-data-model.md §3.2–3.3).
 * Pure: the server persists `next` and writes history for `changed`.
 */
export function applyTextPatch(cur: TextData, baseTextVer: number, changes: TextChanges): TextPatchResult {
  const effective: Partial<Record<TextField, string | boolean>> = {};
  for (const f of FIELDS) {
    const v = changes[f];
    if (v !== undefined && v !== cur[f]) effective[f] = v;
  }
  // Only fields whose value really changes can conflict; an equal value is a no-op merge.
  const conflicts = (Object.keys(effective) as TextField[]).filter(
    (f) => (cur.field_vers[f] ?? 0) > baseTextVer,
  );
  if (conflicts.length > 0) return { kind: 'conflict', fields: conflicts };

  const translation = (effective.translation as string | undefined) ?? cur.translation;
  let state: TranslationState = (effective.state as TranslationState | undefined) ?? cur.state;
  if (changes.state === 'translated' && translation.trim() === '') {
    return { kind: 'invalid', message: 'state "translated" requires a non-empty translation' };
  }
  if (changes.state === undefined && effective.translation !== undefined) {
    if (translation.trim() !== '') state = 'translated';
    else if (cur.state === 'translated') state = 'empty';
  }
  if (state !== cur.state) effective.state = state;
  else delete effective.state;

  const changed = FIELDS.filter((f) => effective[f] !== undefined);
  if (changed.length === 0) return { kind: 'ok', next: cur, changed: [] };

  const text_ver = cur.text_ver + 1;
  const next: TextData = { ...cur, text_ver, field_vers: { ...cur.field_vers } };
  const target = next as unknown as Record<TextField, string | boolean>;
  for (const f of changed) {
    target[f] = effective[f]!;
    next.field_vers[f] = text_ver;
  }
  return { kind: 'ok', next, changed };
}
