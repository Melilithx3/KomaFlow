import type { Box, ObjectType } from './common.js';
import type { MarkupSummary } from './dto.js';
import { boxesEqual } from './geometry.js';

export interface MarkupObjectState {
  id: string;
  type: ObjectType;
  box: Box;
  text_box: Box | null;
}

export interface StoredMarkupObject extends MarkupObjectState {
  ord: number;
  deleted: boolean;
}

export interface PageFiles {
  clean_hash: string | null;
  notes_hash: string | null;
  thumb_hash: string | null;
}

export interface MarkupDiff {
  summary: MarkupSummary;
  changed: boolean;
  /** Objects whose type/box/text_box/ord/deleted changed: their geometry_ver must grow. */
  geometryChanged: string[];
}

export function emptySummary(): MarkupSummary {
  return {
    added: [],
    moved: [],
    retyped: [],
    reordered: false,
    deleted: [],
    restored: [],
    clean_changed: false,
    notes_changed: false,
    thumb_changed: false,
  };
}

/**
 * Compares stored markup of a page with the incoming desktop state.
 * `next.objects` is the full list of non-deleted objects in reading order; position + 1 becomes `ord`.
 * `prev === null` means the page is new.
 */
export function diffMarkup(
  prev: { objects: readonly StoredMarkupObject[]; files: PageFiles } | null,
  next: { objects: readonly MarkupObjectState[]; files: PageFiles },
): MarkupDiff {
  const s = emptySummary();
  const geometry = new Set<string>();
  const prevById = new Map((prev?.objects ?? []).map((o) => [o.id, o]));
  const nextIds = new Set(next.objects.map((o) => o.id));

  next.objects.forEach((o, i) => {
    const p = prevById.get(o.id);
    if (!p) {
      s.added.push(o.id);
      return;
    }
    if (p.deleted) {
      s.restored.push(o.id);
      geometry.add(o.id);
    }
    if (p.type !== o.type) {
      s.retyped.push(o.id);
      geometry.add(o.id);
    }
    if (!boxesEqual(p.box, o.box) || !boxesEqual(p.text_box, o.text_box)) {
      s.moved.push(o.id);
      geometry.add(o.id);
    }
    if (!p.deleted && p.ord !== i + 1) geometry.add(o.id);
  });
  for (const p of prev?.objects ?? []) {
    if (!p.deleted && !nextIds.has(p.id)) {
      s.deleted.push(p.id);
      geometry.add(p.id);
    }
  }
  // Reordered: the relative order of objects alive both before and after changed.
  const survivorsBefore = (prev?.objects ?? [])
    .filter((p) => !p.deleted && nextIds.has(p.id))
    .sort((a, b) => a.ord - b.ord)
    .map((p) => p.id);
  const survivorSet = new Set(survivorsBefore);
  const survivorsAfter = next.objects.filter((o) => survivorSet.has(o.id)).map((o) => o.id);
  s.reordered = survivorsBefore.some((id, i) => survivorsAfter[i] !== id);

  const pf = prev?.files ?? { clean_hash: null, notes_hash: null, thumb_hash: null };
  s.clean_changed = pf.clean_hash !== next.files.clean_hash;
  s.notes_changed = pf.notes_hash !== next.files.notes_hash;
  s.thumb_changed = pf.thumb_hash !== next.files.thumb_hash;

  const changed =
    prev === null ||
    s.added.length + s.moved.length + s.retyped.length + s.deleted.length + s.restored.length > 0 ||
    s.reordered ||
    s.clean_changed ||
    s.notes_changed ||
    s.thumb_changed ||
    geometry.size > 0;
  return { summary: s, changed, geometryChanged: [...geometry] };
}
