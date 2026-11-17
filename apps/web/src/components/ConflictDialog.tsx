import { useEffect, useRef, useState } from 'react';
import type { Conflict } from '../lib/useObjectEditor.js';
import { STATE_LABEL } from '@komaflow/page-view';
import { t } from '../strings.js';

const show = (v: unknown) =>
  typeof v === 'boolean' ? (v ? 'да' : 'нет') : typeof v === 'string' && v in STATE_LABEL ? STATE_LABEL[v as keyof typeof STATE_LABEL] : String(v ?? '');

/** «Пока вы писали, это поле изменил <имя>» (docs/06-web.md §2). */
export function ConflictDialog({ conflict, onResolve }: { conflict: Conflict; onResolve: (how: 'mine' | 'theirs' | { merged: string }) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const field = conflict.fields[0]!;
  const textual = typeof conflict.mine[field] === 'string' && typeof conflict.theirs[field] === 'string';
  const [merging, setMerging] = useState(false);
  const [merged, setMerged] = useState(() => `${String(conflict.theirs[field] ?? '')}\n${String(conflict.mine[field] ?? '')}`);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
  }, []);

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="conflict-title" onCancel={(e) => e.preventDefault()}>
      <h2 id="conflict-title">{t.conflict.title(conflict.by?.display_name ?? t.conflict.someone)}</h2>
      <p className="muted">{conflict.fields.map((f) => t.conflict.field[f] ?? f).join(', ')}</p>
      {!merging ? (
        <div className="conflict-cols">
          <section>
            <h3>{t.conflict.mine}</h3>
            <pre>{show(conflict.mine[field])}</pre>
          </section>
          <section>
            <h3>{t.conflict.theirs}</h3>
            <pre>{show(conflict.theirs[field])}</pre>
          </section>
        </div>
      ) : (
        <textarea aria-label={t.conflict.merge} className="merge" value={merged} onChange={(e) => setMerged(e.target.value)} rows={6} autoFocus />
      )}
      <div className="dialog-actions">
        {!merging ? (
          <>
            <button className="primary" onClick={() => onResolve('mine')}>
              {t.conflict.keepMine}
            </button>
            <button onClick={() => onResolve('theirs')}>{t.conflict.acceptTheirs}</button>
            {textual && <button onClick={() => setMerging(true)}>{t.conflict.merge}</button>}
          </>
        ) : (
          <>
            <button className="primary" onClick={() => onResolve({ merged })}>
              {t.conflict.mergeSave}
            </button>
            <button onClick={() => setMerging(false)}>{t.back}</button>
          </>
        )}
      </div>
    </dialog>
  );
}
