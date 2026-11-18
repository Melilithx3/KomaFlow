import { autoReadingOrder, boxesEqual, clampBox, uuidv7, type Box, type ObjectType, type ReadingDirection } from '@komaflow/contract';
import type { FileRef, LocalObject, LocalPage, Workspace } from './model.js';
import type { Command } from './store.js';

const mapPage = (ws: Workspace, pageId: string, fn: (p: LocalPage) => LocalPage): Workspace => {
  let changed = false;
  const pages = ws.pages.map((p) => {
    if (p.id !== pageId) return p;
    const n = fn(p);
    if (n !== p) changed = true;
    return n;
  });
  return changed ? { ...ws, pages } : ws;
};

const mapObject = (ws: Workspace, pageId: string, objectId: string, fn: (o: LocalObject) => LocalObject) =>
  mapPage(ws, pageId, (p) => {
    let changed = false;
    const objects = p.objects.map((o) => {
      if (o.id !== objectId) return o;
      const n = fn(o);
      if (n !== o) changed = true;
      return n;
    });
    return changed ? { ...p, objects } : p;
  });

/**
 * Snapshot of a page's objects: simple, correct undo for structural edits. `compute` runs once on the
 * first apply; redo re-applies the stored result. Merging keeps the first "before" and the last "after".
 */
class PageObjectsCommand implements Command {
  before: LocalObject[] | null = null;
  after: LocalObject[] | null = null;
  constructor(
    readonly label: string,
    readonly pageId: string,
    private readonly compute: ((p: LocalPage) => LocalObject[] | null) | null,
    readonly mergeKey: string | null = null,
  ) {}

  apply(ws: Workspace): Workspace {
    return mapPage(ws, this.pageId, (p) => {
      if (this.after) return { ...p, objects: this.after };
      const n = this.compute?.(p) ?? null;
      if (!n) return p;
      this.before = p.objects;
      this.after = n;
      return { ...p, objects: n };
    });
  }

  revert(ws: Workspace): Workspace {
    const b = this.before;
    return b ? mapPage(ws, this.pageId, (p) => ({ ...p, objects: b })) : ws;
  }

  merge(next: Command): Command {
    const m = new PageObjectsCommand(this.label, this.pageId, null, this.mergeKey);
    m.before = this.before;
    m.after = next instanceof PageObjectsCommand && next.after ? next.after : this.after;
    return m;
  }
}

const pageObjectsCommand = (label: string, pageId: string, compute: (p: LocalPage) => LocalObject[] | null, mergeKey?: string): Command =>
  new PageObjectsCommand(label, pageId, compute, mergeKey ?? null);

const touch = (o: LocalObject): LocalObject => (o.origin === 'auto' && !o.touched ? { ...o, touched: true } : o);

export function newObject(type: ObjectType, box: Box, source_text = ''): LocalObject {
  return { id: uuidv7(), type, box, text_box: null, source_text, origin: 'manual', touched: false };
}

export const AddObject = (pageId: string, obj: LocalObject, index?: number) =>
  pageObjectsCommand('Добавить бокс', pageId, (p) => {
    const list = [...p.objects];
    list.splice(index ?? list.length, 0, { ...obj, box: clampBox(obj.box, p) });
    return list;
  });

export const DeleteObject = (pageId: string, objectId: string) =>
  pageObjectsCommand('Удалить бокс', pageId, (p) => (p.objects.some((o) => o.id === objectId) ? p.objects.filter((o) => o.id !== objectId) : null));

/** Move / resize. Use the same `gesture` id for every step of one drag so it becomes one undo entry. */
export const SetBox = (pageId: string, objectId: string, box: Box, gesture?: string) =>
  pageObjectsCommand(
    'Изменить бокс',
    pageId,
    (p) => {
      const o = p.objects.find((x) => x.id === objectId);
      const b = clampBox(box, p);
      if (!o || boxesEqual(o.box, b)) return null;
      return p.objects.map((x) => (x.id === objectId ? touch({ ...x, box: b }) : x));
    },
    gesture ? `box:${objectId}:${gesture}` : undefined,
  );

/** Rotation in whole degrees, normalised to -180..180. Same `gesture` → one undo entry. */
export const normalizeAngle = (deg: number) => {
  let a = Math.round(deg) % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a === -180 ? 180 : a;
};

export const SetRotation = (pageId: string, objectId: string, deg: number, gesture?: string) =>
  pageObjectsCommand(
    'Поворот бокса',
    pageId,
    (p) => {
      const o = p.objects.find((x) => x.id === objectId);
      const r = normalizeAngle(deg);
      if (!o || (o.rotation ?? 0) === r) return null;
      return p.objects.map((x) => (x.id === objectId ? touch({ ...x, rotation: r }) : x));
    },
    gesture ? `rot:${objectId}:${gesture}` : undefined,
  );

/** Applies OCR results to existing boxes (separate OCR run, docs: layout first, then OCR). One undo entry. */
export const ApplyOcr = (pageId: string, texts: ReadonlyMap<string, string>) =>
  pageObjectsCommand('OCR', pageId, (p) => {
    let changed = false;
    const objects = p.objects.map((o) => {
      const t = texts.get(o.id);
      if (t === undefined || t === o.source_text) return o;
      changed = true;
      return { ...o, source_text: t };
    });
    return changed ? objects : null;
  });

export const SetType = (pageId: string, objectId: string, type: ObjectType) =>
  pageObjectsCommand('Тип объекта', pageId, (p) => {
    const o = p.objects.find((x) => x.id === objectId);
    if (!o || o.type === type) return null;
    return p.objects.map((x) => (x.id === objectId ? touch({ ...x, type }) : x));
  });

export const SetSourceText = (pageId: string, objectId: string, text: string) =>
  pageObjectsCommand(
    'Оригинальный текст',
    pageId,
    (p) => {
      const o = p.objects.find((x) => x.id === objectId);
      if (!o || o.source_text === text) return null;
      return p.objects.map((x) => (x.id === objectId ? touch({ ...x, source_text: text }) : x));
    },
    `text:${objectId}`,
  );

/** Sets reading order to the given ids (all ids of the page). */
export const Reorder = (pageId: string, ids: string[], label = 'Порядок чтения') =>
  pageObjectsCommand(label, pageId, (p) => {
    if (ids.length !== p.objects.length || ids.every((id, i) => p.objects[i]!.id === id)) return null;
    const byId = new Map(p.objects.map((o) => [o.id, o]));
    if (!ids.every((id) => byId.has(id))) return null;
    return ids.map((id) => byId.get(id)!);
  });

export const AutoOrder = (page: LocalPage, dir: ReadingDirection) =>
  Reorder(page.id, autoReadingOrder(page.objects, dir), 'Авто-порядок');

/** Moves one object to position `to` (0-based). */
export const MoveInOrder = (page: LocalPage, objectId: string, to: number) => {
  const ids = page.objects.map((o) => o.id).filter((id) => id !== objectId);
  ids.splice(Math.max(0, Math.min(to, ids.length)), 0, objectId);
  return Reorder(page.id, ids);
};

export interface DetectedObject {
  type: ObjectType;
  box: Box;
  score: number;
  source_text: string;
}

/**
 * ApplyAnalysis (docs/05 §3, §4.1): replaces auto, untouched objects with new detections; manual and
 * touched objects stay. Then applies the automatic reading order. One undo entry.
 */
export const ApplyAnalysis = (pageId: string, detected: DetectedObject[], dir: ReadingDirection) =>
  pageObjectsCommand('Анализ страницы', pageId, (p) => {
    const kept = p.objects.filter((o) => o.origin === 'manual' || o.touched);
    const added: LocalObject[] = detected.map((d) => ({
      id: uuidv7(),
      type: d.type,
      box: clampBox(d.box, p),
      text_box: null,
      source_text: d.source_text,
      origin: 'auto',
      touched: false,
      score: d.score,
    }));
    const all = [...kept, ...added];
    const byId = new Map(all.map((o) => [o.id, o]));
    return autoReadingOrder(all, dir).map((id) => byId.get(id)!);
  });

/** How many objects ApplyAnalysis would replace (for the confirmation dialog). */
export const replacedByAnalysis = (p: LocalPage) => p.objects.filter((o) => o.origin === 'auto' && !o.touched).length;

/** ImportClean / ImportNotes: binds files to pages (one undo entry for the whole import). */
export function ImportFiles(kind: 'clean' | 'notes', files: Array<{ pageId: string; file: FileRef | null }>): Command {
  let before: Map<string, FileRef | null> | null = null;
  const label = kind === 'clean' ? 'Импорт клина' : 'Импорт пометок';
  return {
    label,
    apply(ws) {
      const prev = new Map<string, FileRef | null>();
      const byPage = new Map(files.map((f) => [f.pageId, f.file]));
      let changed = false;
      const pages = ws.pages.map((p) => {
        if (!byPage.has(p.id)) return p;
        const f = byPage.get(p.id) ?? null; // null removes the file (e.g. notes erased to nothing)
        if ((p[kind]?.hash ?? null) === (f?.hash ?? null)) return p;
        prev.set(p.id, p[kind]);
        changed = true;
        return { ...p, [kind]: f };
      });
      if (!changed) return ws;
      before = prev;
      return { ...ws, pages };
    },
    revert(ws) {
      if (!before) return ws;
      const b = before;
      return { ...ws, pages: ws.pages.map((p) => (b.has(p.id) ? { ...p, [kind]: b.get(p.id)! } : p)) };
    },
  };
}

export function updateObjectWeb(ws: Workspace, pageId: string, objectId: string, web: LocalObject['web']): Workspace {
  return mapObject(ws, pageId, objectId, (o) => ({ ...o, web }));
}
