import { memo, useState } from 'react';
import type { ObjectDTO, TextChanges, TranslationState } from '@komaflow/contract';
import { changeCase, STATE_LABEL, TYPE_STYLE } from '@komaflow/page-view';
import { useObjectEditor, type SaveStatus } from '../lib/useObjectEditor.js';
import { t } from '../strings.js';
import { AutoTextarea } from './AutoTextarea.js';
import { ConflictDialog } from './ConflictDialog.js';
import { Icon } from './Icon.js';

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

const STATES: TranslationState[] = ['translated', 'empty', 'skipped', 'unreadable'];

export const ObjectRow = memo(function ObjectRow(p: RowProps) {
  const ed = useObjectEditor(p.obj, { patch: p.patch, onObject: p.onObject });
  const [copied, setCopied] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [commentOpen, setCommentOpen] = useState(() => p.obj.comment !== '');
  const st = TYPE_STYLE[p.obj.type];
  const translation = ed.value('translation');
  const source = ed.value('source_text');
  const comment = ed.value('comment');
  const state = ed.value('state');
  const flagged = ed.value('flagged');

  /** Enter → same field of the next object (translation and original), Shift+Enter → new line. */
  const keys = (field: string) => (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && (field === 'translation' || field === 'source_text')) {
      e.preventDefault();
      void ed.flush();
      p.onNav(p.index + 1, field);
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
      // clipboard blocked
    }
  };

  const fixCase = () => {
    const next = changeCase(source, 'sentence');
    if (next !== source) ed.set('source_text', next);
  };

  const sourceField = (
    <AutoTextarea
      data-field="source_text"
      aria-label={`${t.page.columns.source} ${p.obj.order}`}
      value={source}
      onChange={(e) => ed.set('source_text', e.target.value)}
      onBlur={() => void ed.flush()}
      onKeyDown={keys('source_text')}
      maxLength={5000}
      className="source"
    />
  );

  return (
    <div
      className={`obj${p.selected ? ' selected' : ''}${p.deleted ? ' deleted' : ''}`}
      data-obj-index={p.index}
      data-obj-id={p.obj.id}
      data-state={state}
      onFocusCapture={() => p.onSelect(p.obj.id)}
      onClick={() => p.onSelect(p.obj.id)}
      role="listitem"
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
        <div className="field-label">
          <span>{t.page.columns.source}</span>
          <button className="tiny ghost" onClick={fixCase} title={t.page.caseOne} aria-label={`${t.page.caseOne} ${p.obj.order}`} disabled={!source}>
            Aa
          </button>
        </div>
        {p.mobile && !sourceOpen ? (
          <button className="source-preview" onClick={() => setSourceOpen(true)} aria-label={`${t.page.columns.source}: ${source}`}>
            {source || '—'}
          </button>
        ) : (
          sourceField
        )}
      </div>

      <div className="obj-translation">
        <div className="field-label">
          <span>{t.page.columns.translation}</span>
          <button className="tiny ghost" onClick={() => void copy()} disabled={!translation} title={t.page.copy}>
            <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? t.page.copied : t.page.copy}
          </button>
        </div>
        <AutoTextarea
          data-field="translation"
          aria-label={`${t.page.columns.translation} ${p.obj.order}`}
          value={translation}
          onChange={(e) => ed.set('translation', e.target.value)}
          onBlur={() => void ed.flush()}
          onKeyDown={keys('translation')}
          maxLength={5000}
          placeholder={t.page.translationPlaceholder}
          className="translation"
        />
      </div>

      <div className="obj-meta">
        <select className={`state-pill state-${state}`} aria-label={`${t.page.columns.state} ${p.obj.order}`} value={state} onChange={(e) => ed.set('state', e.target.value)}>
          {STATES.map((s) => (
            <option key={s} value={s} disabled={s === 'translated' && !translation.trim()}>
              {STATE_LABEL[s]}
            </option>
          ))}
        </select>
        <label className={`flag-toggle${flagged ? ' on' : ''}`} title={t.page.flag}>
          <input type="checkbox" checked={flagged} onChange={(e) => ed.set('flagged', e.target.checked)} aria-label={`${t.page.flag} ${p.obj.order}`} />
          <Icon name="flag" size={16} />
        </label>
        {!commentOpen && (
          <button className="tiny ghost" onClick={() => setCommentOpen(true)}>
            + {t.page.comment.toLowerCase()}
          </button>
        )}
      </div>
      {commentOpen && (
        <div className="obj-comment">
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
        </div>
      )}
      {ed.conflict && <ConflictDialog conflict={ed.conflict} onResolve={ed.resolve} />}
    </div>
  );
});

function SaveMark({ status }: { status: SaveStatus }) {
  return (
    <span className={`save ${status}`} role={status === 'saved' ? undefined : 'status'} title={t.page.saveState[status]}>
      {status === 'saved' ? <Icon name="check" size={14} label={t.page.saveState.saved} /> : t.page.saveState[status]}
    </span>
  );
}
