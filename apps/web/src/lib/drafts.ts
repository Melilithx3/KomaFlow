/**
 * Unsaved text kept in localStorage per object (docs/06-web.md §2): restored after reload and re-sent.
 * `base` is the object's text_ver at the moment editing of that field began, so a concurrent change
 * of the same field is detected as a conflict instead of being overwritten.
 */
import type { TextField } from '@komaflow/contract';

export type DraftValue = string | boolean;
export type Draft = Partial<Record<TextField, { value: DraftValue; base: number }>>;

const key = (objectId: string) => `komaflow:draft:${objectId}`;

export function loadDraft(objectId: string): Draft {
  try {
    const raw = localStorage.getItem(key(objectId));
    return raw ? (JSON.parse(raw) as Draft) : {};
  } catch {
    return {};
  }
}

export function saveDraft(objectId: string, d: Draft): void {
  try {
    if (Object.keys(d).length === 0) localStorage.removeItem(key(objectId));
    else localStorage.setItem(key(objectId), JSON.stringify(d));
  } catch {
    // storage full or disabled: the draft still lives in memory
  }
}
