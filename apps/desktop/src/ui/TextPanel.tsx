import { useEffect, useRef, useState } from 'react';
import type { FieldConflictDetails, TextChanges } from '@komaflow/contract';
import type { ImportResult } from '@komaflow/page-view';
import type { LocalObject } from '../core/model.js';
import type { Store } from '../core/store.js';
import { applyImport, applyServerObjects, checkImport, exportJson, importTodo, loadServerText, patchText, type ServerText } from '../core/translation.js';
import type { AppCtx } from './App.js';
import { Modal } from './Dialogs.js';

type Field = 'translation' | 'comment';
const LABEL: Record<Field, string> = { translation: 'Перевод', comment: 'Комментарий' };

/**
 * Translation and comment of the selected object, edited like in the web (PATCH with base_text_ver,
 * debounced; a field conflict is shown with an explicit choice). The flag is the translator's signal for
 * the typer: shown as it is, not set from the desktop.
 */
export function ObjectTextEditor({ ctx, store, obj, published }: { ctx: AppCtx; store: Store; obj: LocalObject; published: boolean }) {
  const web = obj.web;
  const [draft, setDraft] = useState<Record<Field, string>>({ translation: web?.translation ?? '', comment: web?.comment ?? '' });
  const [dirty, setDirty] = useState<Partial<Record<Field, true>>>({});
  const [conflict, setConflict] = useState<FieldConflictDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(0);
  const live = useRef({ draft, dirty, web });
  live.current = { draft, dirty, web };

  // another object, or fresh server data for fields not being edited
  useEffect(() => {
    setDraft((d) => ({ translation: live.current.dirty.translation ? d.translation : (web?.translation ?? ''), comment: live.current.dirty.comment ? d.comment : (web?.comment ?? '') }));
  }, [web?.translation, web?.comment]);
  useEffect(() => {
    setDraft({ translation: obj.web?.translation ?? '', comment: obj.web?.comment ?? '' });
    setDirty({});
    setConflict(null);
    setError(null);
  }, [obj.id]);

  const send = async (changes: TextChanges, baseVer?: number) => {
    const w = live.current.web;
    if (!w || w.text_ver === undefined) return;
    clearTimeout(timer.current);
    setBusy(true);
    try {
      const r = await patchText(ctx.api, obj.id, baseVer ?? w.text_ver, changes);
      if (r.kind === 'ok') {
        store.patch((ws) => applyServerObjects(ws, [r.object]));
        setDirty((d) => {
          const n = { ...d };
          for (const k of Object.keys(changes) as Field[]) if (live.current.draft[k] === (r.object[k] as string)) delete n[k];
          return n;
        });
        setConflict(null);
        setError(null);
      } else if (r.kind === 'conflict') setConflict(r.details);
      else setError('Объект удалён на сервере.');
    } catch (e) {
      setError(`Не сохранено: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const flush = () => {
    const { draft: d, dirty: dd } = live.current;
    const changes: TextChanges = {};
    if (dd.translation) changes.translation = d.translation;
    if (dd.comment) changes.comment = d.comment;
    if (Object.keys(changes).length) void send(changes);
  };
  const edit = (f: Field, v: string) => {
    setDraft((d) => ({ ...d, [f]: v }));
    setDirty((d) => ({ ...d, [f]: true }));
    clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 1000);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!published || !web || web.text_ver === undefined)
    return <p className="muted small">Перевод и комментарии появятся после публикации страницы и входа на сервер.</p>;

  return (
    <div className="text-editor">
      {web.flagged && (
        <p className="flag" title="Флажок ставит переводчик для тайпера">
          ⚑ Флажок переводчика для тайпера
        </p>
      )}
      {(['translation', 'comment'] as Field[]).map((f) => (
        <label key={f}>
          <span className="row between">
            <span>{LABEL[f]}</span>
            <span className="muted small">{dirty[f] ? (busy ? 'сохранение…' : 'не сохранено') : ''}</span>
          </span>
          <textarea
            rows={f === 'translation' ? 3 : 2}
            value={draft[f]}
            onChange={(e) => edit(f, e.target.value)}
            onBlur={flush}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) flush();
            }}
            placeholder={f === 'translation' ? 'Перевод (сохраняется на сервере, как в вебе)' : 'Комментарий к объекту'}
          />
        </label>
      ))}
      {error && <p className="error small">{error}</p>}
      {conflict && (
        <div className="conflict" role="alert">
          <p>
            Пока вы печатали, на сервере изменили: {conflict.fields.map((f) => LABEL[f as Field] ?? f).join(', ')}
            {conflict.updated_by ? ` (${conflict.updated_by.display_name})` : ''}.
          </p>
          {conflict.fields.map((f) => (
            <p key={f} className="small">
              <b>На сервере:</b> {String(conflict.server_values[f] ?? '') || <em>пусто</em>}
            </p>
          ))}
          <div className="row">
            <button
              onClick={() => {
                store.patch((ws) => applyServerObjects(ws, [conflict.object]));
                setDraft({ translation: conflict.object.translation, comment: conflict.object.comment });
                setDirty({});
                setConflict(null);
              }}
            >
              Взять с сервера
            </button>
            <button
              className="primary"
              onClick={() => {
                const changes: TextChanges = {};
                for (const f of conflict.fields) if (f === 'translation' || f === 'comment') changes[f] = draft[f];
                void send(changes, conflict.object.text_ver);
              }}
            >
              Оставить моё
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** «JSON для ИИ» in the desktop: same file and rules as the web (ADR 0012), data straight from the server. */
export function AiJsonDialog({ ctx, store, onClose }: { ctx: AppCtx; store: Store; onClose: () => void }) {
  const ws = store.get().ws;
  const [tab, setTab] = useState<'export' | 'import'>('export');
  const [st, setSt] = useState<ServerText | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [text, setText] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadServerText(ctx.api, ws).then(setSt, (e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  const json = st ? exportJson(st, ws, onlyEmpty) : '';
  const todo = result ? importTodo(result, overwrite) : [];
  const unpublished = ws.pages.filter((p) => p.server_markup_rev === null).length;

  return (
    <Modal title="JSON для ИИ" onClose={onClose} wide>
      <div className="seg" role="tablist">
        <button aria-pressed={tab === 'export'} onClick={() => setTab('export')}>
          Экспорт
        </button>
        <button aria-pressed={tab === 'import'} onClick={() => setTab('import')}>
          Импорт перевода
        </button>
      </div>
      {unpublished > 0 && <p className="muted small">Неопубликованных страниц: {unpublished} — их объектов нет на сервере, в JSON они не попадут.</p>}
      {err && <p className="error">{err}</p>}
      {!st && !err && <p className="muted">Загрузка с сервера…</p>}
      {st && tab === 'export' && (
        <>
          <p className="muted small">Отдайте JSON ИИ-ассистенту: в файле инструкция, номера объектов, оригиналы и пустые поля translation. Ответ загрузите во вкладке «Импорт перевода».</p>
          <label className="check">
            <input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} /> Только непереведённые объекты
          </label>
          <textarea className="code" readOnly value={json} rows={12} aria-label="JSON" />
          <div className="dialog-actions">
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(json).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
            <button
              className="primary"
              onClick={() => {
                const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = `${ws.title}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Скачать .json
            </button>
          </div>
        </>
      )}
      {st && tab === 'import' && !progress && (
        <>
          <p className="muted small">Вставьте ответ ИИ или выберите файл. Объекты сопоставляются по id, а без него — по номеру страницы и объекта.</p>
          <textarea className="code" value={text} onChange={(e) => (setText(e.target.value), setResult(null))} rows={8} placeholder="Вставьте JSON сюда…" aria-label="JSON" />
          <div className="row">
            <label className="file-btn">
              Выбрать файл
              <input type="file" accept=".json,application/json,text/plain" onChange={async (e) => (setText((await e.target.files?.[0]?.text()) ?? ''), setResult(null))} />
            </label>
            <span className="spacer" />
            <button
              className="primary"
              disabled={!text.trim()}
              onClick={() => {
                setErr(null);
                try {
                  setResult(checkImport(text, st));
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Проверить
            </button>
          </div>
          {result && (
            <>
              <p>
                Найдено переводов: {result.matches.length}.{result.empty > 0 && ` Пустых пропущено: ${result.empty}.`}
                {result.unmatched.length > 0 && <span className="warn-text"> Не нашлись (стр./№): {result.unmatched.map((u) => `${u.page ?? '?'}/${u.n ?? '?'}`).join(', ')}.</span>}
              </p>
              <label className="check">
                <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Заменять уже существующие переводы
              </label>
              <div className="preview-table">
                <table>
                  <thead>
                    <tr>
                      <th>Где</th>
                      <th>Оригинал</th>
                      <th>Новый перевод</th>
                    </tr>
                  </thead>
                  <tbody>
                    {todo.slice(0, 200).map((m) => (
                      <tr key={m.objectId}>
                        <td>
                          стр. {m.page} · {m.n}
                        </td>
                        <td className="muted pre">{m.source}</td>
                        <td className="pre">{m.translation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="dialog-actions">
                <button
                  className="primary"
                  disabled={todo.length === 0}
                  onClick={async () => {
                    setProgress({ done: 0, total: todo.length, failed: 0 });
                    try {
                      const saved = await applyImport(ctx.api, st, todo, (done, failed) => setProgress({ done, total: todo.length, failed }));
                      store.patch((w) => applyServerObjects(w, saved));
                    } catch (e) {
                      setErr(e instanceof Error ? e.message : String(e));
                    }
                  }}
                >
                  Применить ({todo.length})
                </button>
              </div>
            </>
          )}
        </>
      )}
      {progress && (
        <div role="status">
          <p>
            {progress.done < progress.total ? `Сохраняю: ${progress.done} из ${progress.total}…` : `Готово, сохранено переводов: ${progress.done - progress.failed}.`}
            {progress.failed > 0 && <span className="warn-text"> Не удалось сохранить: {progress.failed} (кто-то правил одновременно — проверьте эти строки).</span>}
          </p>
          <progress max={Math.max(1, progress.total)} value={progress.done} />
          {progress.done >= progress.total && (
            <div className="dialog-actions">
              <button className="primary" onClick={onClose}>
                Закрыть
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
