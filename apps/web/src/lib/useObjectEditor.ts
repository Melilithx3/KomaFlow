import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldConflictDetails, ObjectDTO, TextField, TextChanges, UserDTO } from '@komaflow/contract';
import { HttpError } from './api.js';
import { loadDraft, saveDraft, type Draft, type DraftValue } from './drafts.js';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

export interface Conflict {
  fields: TextField[];
  mine: Partial<Record<TextField, DraftValue>>;
  theirs: Partial<Record<TextField, DraftValue>>;
  by: UserDTO | null;
  serverTextVer: number;
}

export interface EditorDeps {
  patch: (id: string, base: number, changes: TextChanges) => Promise<ObjectDTO>;
  /** Called with the fresh object after a save or a conflict (to update the query cache). */
  onObject: (o: ObjectDTO) => void;
  debounceMs?: number;
}

const TEXT_DEBOUNCED: readonly TextField[] = ['translation', 'source_text', 'comment'];

/**
 * Autosave of one object's web fields (docs/06-web.md §2): debounce ~800 ms and on blur, drafts in
 * localStorage, one request in flight per object, retries with growing pause, per-field conflicts.
 */
export function useObjectEditor(obj: ObjectDTO, deps: EditorDeps) {
  const [draft, setDraftState] = useState<Draft>(() => loadDraft(obj.id));
  const [status, setStatus] = useState<SaveStatus>(() => (Object.keys(loadDraft(obj.id)).length ? 'dirty' : 'saved'));
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const draftRef = useRef(draft);
  const objRef = useRef(obj);
  objRef.current = obj;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const retryDelay = useRef(1000);
  const conflictRef = useRef<Conflict | null>(null);
  conflictRef.current = conflict;

  const setDraft = useCallback(
    (d: Draft) => {
      draftRef.current = d;
      saveDraft(objRef.current.id, d);
      setDraftState(d);
    },
    [],
  );

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (conflictRef.current) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    const d = draftRef.current;
    const fields = Object.keys(d) as TextField[];
    if (fields.length === 0) {
      setStatus('saved');
      return;
    }
    const changes: Record<string, DraftValue> = {};
    let base = Infinity;
    for (const f of fields) {
      changes[f] = d[f]!.value;
      base = Math.min(base, d[f]!.base);
    }
    inFlight.current = true;
    setStatus('saving');
    try {
      const fresh = await depsRef.current.patch(objRef.current.id, base, changes as TextChanges);
      retryDelay.current = 1000;
      depsRef.current.onObject(fresh);
      // Keep only what the user typed after this request was sent, now based on our own version.
      const cur = draftRef.current;
      const next: Draft = {};
      for (const f of Object.keys(cur) as TextField[]) {
        if (cur[f]!.value !== changes[f]) next[f] = { value: cur[f]!.value, base: fresh.text_ver };
      }
      setDraft(next);
      setStatus(Object.keys(next).length ? 'dirty' : 'saved');
      if (Object.keys(next).length) again.current = true;
    } catch (e) {
      if (e instanceof HttpError && e.code === 'FIELD_CONFLICT' && e.details) {
        const det = e.details as unknown as FieldConflictDetails;
        depsRef.current.onObject(det.object);
        const fs = det.fields as TextField[];
        setConflict({
          fields: fs,
          mine: Object.fromEntries(fs.map((f) => [f, draftRef.current[f]?.value])),
          theirs: det.server_values as Partial<Record<TextField, DraftValue>>,
          by: det.updated_by,
          serverTextVer: det.object.text_ver,
        });
        // Non-conflicting fields can go on the fresh base.
        const cur = draftRef.current;
        const rebased: Draft = {};
        for (const f of Object.keys(cur) as TextField[]) rebased[f] = fs.includes(f) ? cur[f]! : { ...cur[f]!, base: det.object.text_ver };
        setDraft(rebased);
        setStatus('error');
      } else if (e instanceof HttpError && (e.code === 'NETWORK' || e.status >= 500 || e.status === 429)) {
        setStatus('error');
        const delay = retryDelay.current;
        retryDelay.current = Math.min(delay * 2, 30_000);
        timer.current = setTimeout(() => void flush(), delay);
      } else if (e instanceof HttpError && e.status === 422) {
        // Invalid change (e.g. limits): keep the draft, show the error, do not loop.
        setStatus('error');
      } else {
        setStatus('error');
      }
    } finally {
      inFlight.current = false;
      if (again.current) {
        again.current = false;
        if (!timer.current) void flush();
      }
    }
  }, [setDraft]);

  const schedule = useCallback(
    (ms: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), ms);
    },
    [flush],
  );

  /** Sets a field locally; text fields are debounced, state / flag are sent at once. */
  const set = useCallback(
    (field: TextField, value: DraftValue) => {
      const cur = draftRef.current;
      const o = objRef.current;
      const serverValue = o[field] as DraftValue;
      const next: Draft = { ...cur };
      if (value === serverValue && !cur[field]) return;
      next[field] = { value, base: cur[field]?.base ?? o.text_ver };
      setDraft(next);
      setStatus('dirty');
      if (TEXT_DEBOUNCED.includes(field)) schedule(depsRef.current.debounceMs ?? 800);
      else void flush();
    },
    [flush, schedule, setDraft],
  );

  const resolve = useCallback(
    (how: 'mine' | 'theirs' | { merged: string }) => {
      const c = conflictRef.current;
      if (!c) return;
      const cur = { ...draftRef.current };
      for (const f of c.fields) {
        if (how === 'theirs') delete cur[f];
        else if (how === 'mine') cur[f] = { value: c.mine[f] ?? cur[f]?.value ?? '', base: c.serverTextVer };
        else cur[f] = { value: how.merged, base: c.serverTextVer };
      }
      setDraft(cur);
      conflictRef.current = null;
      setConflict(null);
      void flush();
    },
    [flush, setDraft],
  );

  // Restored drafts are re-sent right away.
  useEffect(() => {
    if (Object.keys(draftRef.current).length) void flush();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [flush]);

  const value = <F extends TextField>(f: F): ObjectDTO[F] => (draft[f] ? (draft[f]!.value as ObjectDTO[F]) : obj[f]);

  return { value, set, flush, status, conflict, resolve, dirty: Object.keys(draft).length > 0 };
}
