import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ObjectDTO, PageDetailResponse } from '@komaflow/contract';
import { buildTranslationJson, parseTranslationJson, type ExportPage, type ImportResult } from '@komaflow/page-view';
import { api, HttpError } from '../lib/api.js';
import { t } from '../strings.js';
import { Icon } from './Icon.js';

interface Props {
  /** Pages to export / import into (one page on the page screen, all on the chapter screen). */
  pageIds: string[];
  chapterNumber: string;
  sourceLang: string;
  targetLang: string;
  fileName: string;
}

interface Loaded {
  pages: ExportPage[];
  objects: Map<string, ObjectDTO>;
}

async function load(pageIds: string[]): Promise<Loaded> {
  const objects = new Map<string, ObjectDTO>();
  const pages: ExportPage[] = [];
  for (const id of pageIds) {
    const d = await api<PageDetailResponse>('GET', `/pages/${id}`);
    for (const o of d.objects) objects.set(o.id, o);
    pages.push({ idx: d.page.idx, objects: d.objects.map((o) => ({ id: o.id, order: o.order, type: o.type, source_text: o.source_text, translation: o.translation, state: o.state })) });
  }
  return { pages, objects };
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** «JSON для ИИ»: export objects with empty translations, import what the AI filled in (ADR 0012). */
export function AiJson(p: Props) {
  const [open, setOpen] = useState<null | 'export' | 'import'>(null);
  return (
    <div className="ai-json">
      <button onClick={() => setOpen('export')} title={t.ai.exportHint}>
        <Icon name="json" size={16} /> {t.ai.export}
      </button>
      <button onClick={() => setOpen('import')} title={t.ai.importHint}>
        <Icon name="upload" size={16} /> {t.ai.import}
      </button>
      {open === 'export' && <ExportDialog {...p} onClose={() => setOpen(null)} />}
      {open === 'import' && <ImportDialog {...p} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
  }, []);
  return (
    <dialog ref={ref} className="dialog wide" onCancel={onClose} aria-label={title}>
      <div className="dialog-head">
        <h2>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label={t.close}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function ExportDialog(p: Props & { onClose: () => void }) {
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    load(p.pageIds).then(setLoaded, (e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [p.pageIds]);
  useEffect(() => {
    if (loaded) setText(buildTranslationJson(loaded.pages, { chapter: p.chapterNumber, sourceLang: p.sourceLang, targetLang: p.targetLang, onlyUntranslated: onlyEmpty }));
  }, [loaded, onlyEmpty, p.chapterNumber, p.sourceLang, p.targetLang]);

  const count = text ? (JSON.parse(text) as { pages: Array<{ objects: unknown[] }> }).pages.reduce((n, pg) => n + pg.objects.length, 0) : 0;
  return (
    <Modal title={t.ai.exportTitle} onClose={p.onClose}>
      <p className="muted">{t.ai.exportText}</p>
      <label className="check">
        <input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} /> {t.ai.onlyEmpty}
      </label>
      {err && <p className="error">{err}</p>}
      {text === null ? (
        <p className="muted">{t.loading}</p>
      ) : (
        <>
          <textarea className="code" readOnly value={text} rows={12} aria-label="JSON" />
          <div className="dialog-actions">
            <span className="muted spacer-left">{t.ai.objects(count)}</span>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(text).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? t.page.copied : t.ai.copy}
            </button>
            <button className="primary" onClick={() => download(p.fileName, text)}>
              <Icon name="download" size={16} /> {t.ai.download}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ImportDialog(p: Props & { onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [result, setResult] = useState<(ImportResult & { loaded: Loaded }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(null);

  const check = async () => {
    setErr(null);
    setResult(null);
    try {
      const loaded = await load(p.pageIds);
      setResult({ ...parseTranslationJson(text, loaded.pages), loaded });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const todo = result ? result.matches.filter((m) => m.translation !== m.current && (overwrite || !m.current.trim())) : [];
  const kept = result ? result.matches.filter((m) => m.current.trim() && m.translation !== m.current && !overwrite).length : 0;

  const apply = async () => {
    if (!result) return;
    let failed = 0;
    setProgress({ done: 0, total: todo.length, failed: 0 });
    for (const [i, m] of todo.entries()) {
      const o = result.loaded.objects.get(m.objectId)!;
      try {
        await api('PATCH', `/objects/${o.id}`, { base_text_ver: o.text_ver, changes: { translation: m.translation } });
      } catch (e) {
        failed++;
        if (!(e instanceof HttpError)) throw e;
      }
      setProgress({ done: i + 1, total: todo.length, failed });
    }
    await qc.invalidateQueries({ queryKey: ['page'] });
    await qc.invalidateQueries({ queryKey: ['chapter'] });
  };

  return (
    <Modal title={t.ai.importTitle} onClose={p.onClose}>
      {!progress && (
        <>
          <p className="muted">{t.ai.importText}</p>
          <textarea className="code" value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={t.ai.paste} aria-label="JSON" />
          <div className="row wrap">
            <label className="file-btn">
              <Icon name="upload" size={16} /> {t.ai.file}
              <input type="file" accept=".json,application/json,text/plain" onChange={async (e) => setText((await e.target.files?.[0]?.text()) ?? '')} />
            </label>
            <span className="spacer" />
            <button className="primary" onClick={() => void check()} disabled={!text.trim()}>
              {t.ai.check}
            </button>
          </div>
        </>
      )}
      {err && <p className="error">{err}</p>}
      {result && !progress && (
        <>
          <p>
            {t.ai.found(result.matches.length)}
            {result.empty > 0 && ` ${t.ai.emptySkipped(result.empty)}`}
            {result.unmatched.length > 0 && <span className="warn-text"> {t.ai.unmatched(result.unmatched.map((u) => `${u.page ?? '?'}/${u.n ?? '?'}`).join(', '))}</span>}
          </p>
          <label className="check">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> {t.ai.overwrite}
            {kept > 0 && !overwrite && <span className="muted"> ({t.ai.kept(kept)})</span>}
          </label>
          <div className="preview-table">
            <table>
              <thead>
                <tr>
                  <th>{t.ai.where}</th>
                  <th>{t.page.columns.source}</th>
                  <th>{t.ai.newTranslation}</th>
                </tr>
              </thead>
              <tbody>
                {todo.slice(0, 200).map((m) => (
                  <tr key={m.objectId}>
                    <td className="nowrap">
                      {t.chapter.page(m.page)} · {m.n}
                    </td>
                    <td className="muted pre">{m.source}</td>
                    <td className="pre">{m.translation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dialog-actions">
            <button className="primary" onClick={() => void apply()} disabled={todo.length === 0}>
              {t.ai.apply(todo.length)}
            </button>
          </div>
        </>
      )}
      {progress && (
        <div role="status">
          <p>
            {progress.done < progress.total ? t.ai.applying(progress.done, progress.total) : t.ai.applied(progress.done - progress.failed)}
            {progress.failed > 0 && <span className="warn-text"> {t.ai.failed(progress.failed)}</span>}
          </p>
          <progress max={Math.max(1, progress.total)} value={progress.done} />
          {progress.done >= progress.total && (
            <div className="dialog-actions">
              <button className="primary" onClick={p.onClose}>
                {t.close}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
