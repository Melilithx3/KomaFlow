import { memo, useState } from 'react';
import type { ObjectDTO, TextChanges, TranslationState } from '@komaflow/contract';
import { STATE_LABEL, TYPE_STYLE } from '@komaflow/page-view';
import { useObjectEditor, type SaveStatus } from '../lib/useObjectEditor.js';
import { t } from '../strings.js';
import { AutoTextarea } from './AutoTextarea.js';
import { ConflictDialog } from './ConflictDialog.js';

export interface RowProps {
  obj: ObjectDTO;
  index: number;
  selected: boolean;
  mobile: boolean;
  deleted?: boolean;
  onSelect: (id: string) => void;
  onNav: (index: number, field: string) => void;
  onPageNav: (dir: -1 | 1) => void;
  patch: (id: string, base: number, changes: TextChanges) => Promise<ObjectDTO>;
  onObject: (o: ObjectDTO) => void;
}

const STATE_ICON: Record<TranslationState, string> = { empty: '○', translated: '●', skipped: '⤼', unreadable: '?' };

export const ObjectRow = memo(function ObjectRow(p: RowProps) {
  const ed = useObjectEditor(p.obj, { patch: p.patch, onObject: p.onObject });
  const [copied, setCopied] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [commentOpen, setCommentOpen] = useState(() => p.obj.comment !== '');
  const st = TYPE_STYLE[p.obj.type];
  const translation = ed.value('translation');
  const comment = ed.value('comment');
  const state = ed.value('state');
  const flagged = ed.value('flagged');

  const keys = (field: string) => (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && field === 'translation') {
      e.preventDefault();
      void ed.flush();
      p.onNav(p.index + 1, 'translation');
    } else if (e.ctrlKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      void ed.flush();
      p.onNav(p.index + (e.key === 'ArrowDown' ? 1 : -1), field);
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      void ed.flush();
      p.onPageNav(e.key === 'ArrowLeft' ? -1 : 1);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(translation);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard blocked: nothing else to do
    }
  };

  const sourceField = (
    <AutoTextarea
      data-field="source_text"
      aria-label={`${t.page.columns.source} ${p.obj.order}`}
      value={ed.value('source_text')}
      onChange={(e) => ed.set('source_text', e.target.value)}
      onBlur={() => void ed.flush()}
      onKeyDown={keys('source_text')}
      maxLength={5000}
      lang="ja"
    />
  );

  return (
    <div
      className={`obj${p.selected ? ' selected' : ''}${p.deleted ? ' deleted' : ''}`}
      data-obj-index={p.index}
      data-obj-id={p.obj.id}
      onFocusCapture={() => p.onSelect(p.obj.id)}
      onClick={() => p.onSelect(p.obj.id)}
    >
      <div className="obj-head">
        <span className={`num shape-${st.shape}`} style={{ background: st.color }} aria-label={`№ ${p.obj.order}`}>
          {p.obj.order}
        </span>
        <span className="type" style={{ color: st.color }}>
          {st.label}
        </span>
        <SaveMark status={ed.status} />
      </div>

      <div className="obj-source">
        {p.mobile && !sourceOpen ? (
          <button className="source-preview" onClick={() => setSourceOpen(true)} aria-label={`${t.page.columns.source}: ${ed.value('source_text')}`} lang="ja">
            {ed.value('source_text') || '—'}
          </button>
        ) : (
          sourceField
        )}
      </div>

      <div className="obj-translation">
        <AutoTextarea
          data-field="translation"
          aria-label={`${t.page.columns.translation} ${p.obj.order}`}
          value={translation}
          onChange={(e) => ed.set('translation', e.target.value)}
          onBlur={() => void ed.flush()}
          onKeyDown={keys('translation')}
          maxLength={5000}
          placeholder="…"
        />
        <button className="small ghost copy" onClick={() => void copy()} disabled={!translation} title={t.page.copy}>
          {copied ? t.page.copied : t.page.copy}
        </button>
      </div>

      <div className="obj-state">
        <label className="state-select" data-state={state}>
          <span aria-hidden>{STATE_ICON[state]}</span>
          <select aria-label={`${t.page.columns.state} ${p.obj.order}`} value={state} onChange={(e) => ed.set('state', e.target.value)}>
            {(['translated', 'empty', 'skipped', 'unreadable'] as const).map((s) => (
              <option key={s} value={s} disabled={s === 'translated' && !translation.trim()}>
                {STATE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="obj-comment">
        <label className="flag" title={t.page.flag}>
          <input type="checkbox" checked={flagged} onChange={(e) => ed.set('flagged', e.target.checked)} aria-label={`${t.page.flag} ${p.obj.order}`} />
          <span aria-hidden>⚑</span>
        </label>
        {commentOpen ? (
          <AutoTextarea
            data-field="comment"
            aria-label={`${t.page.comment} ${p.obj.order}`}
            value={comment}
            onChange={(e) => ed.set('comment', e.target.value)}
            onBlur={() => void ed.flush()}
            onKeyDown={keys('comment')}
            maxLength={2000}
            placeholder={t.page.comment}
          />
        ) : (
          <button className="small ghost" onClick={() => setCommentOpen(true)}>
            + {t.page.comment.toLowerCase()}
          </button>
        )}
      </div>
      {ed.conflict && <ConflictDialog conflict={ed.conflict} onResolve={ed.resolve} />}
    </div>
  );
});

function SaveMark({ status }: { status: SaveStatus }) {
  if (status === 'saved') return <span className="save saved" aria-label={t.page.saveState.saved} title={t.page.saveState.saved}>✓</span>;
  return (
    <span className={`save ${status}`} role="status">
      {t.page.saveState[status]}
    </span>
  );
}
