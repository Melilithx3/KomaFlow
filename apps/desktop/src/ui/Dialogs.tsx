import { useEffect, useState, type ReactNode } from 'react';
import type { ProjectDTO } from '@komaflow/contract';
import { ApiFailure } from '../core/api.js';
import { ImportFiles } from '../core/commands.js';
import { applicable, matchImport, type ImportPlan } from '../core/importMatch.js';
import { downloadChapter, planPublish, publish, type PublishEvent, type SourceConflictItem } from '../core/publish.js';
import type { Store } from '../core/store.js';
import { fileRef, saveWorkspace } from '../core/workspace.js';
import type { AppCtx } from './App.js';

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose?: () => void; wide?: boolean }) {
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`modal${wide ? ' wide' : ''}`}>
        <div className="modal-head">
          <h2>{title}</h2>
          {onClose && (
            <button className="link" onClick={onClose} aria-label="Закрыть">
              ×
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

const STATUS_RU = { matched: 'совпало', size_mismatch: 'размер не совпадает с raw', missing: 'нет файла' } as const;

/** Import of clean / notes (docs/05 §4.2): folder → matching table → «Применить». */
export function ImportDialog({ ctx, kind, store, onClose }: { ctx: AppCtx; kind: 'clean' | 'notes'; store: Store; onClose: () => void }) {
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pick = async () => {
    setErr(null);
    const folder = await ctx.host.pickFolder(kind === 'clean' ? 'Папка с клином (PNG)' : 'Папка с пометками (прозрачные PNG)');
    if (!folder) return;
    try {
      setPlan(matchImport(store.get().ws.pages, await ctx.host.scanImages(folder)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const ok = plan ? applicable(plan) : [];
  return (
    <Modal title={kind === 'clean' ? 'Импорт клина' : 'Импорт пометок'} onClose={onClose}>
      <button className="primary" onClick={() => void pick()}>
        Выбрать папку…
      </button>
      {err && <p className="error">{err}</p>}
      {plan && (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Стр.</th>
                <th>Raw</th>
                <th>Файл</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((r) => (
                <tr key={r.pageId} className={r.status === 'matched' ? '' : 'warn'}>
                  <td>{r.pageIdx}</td>
                  <td>{r.pageName}</td>
                  <td>{r.file?.name ?? '—'}</td>
                  <td>
                    {STATUS_RU[r.status]}
                    {r.status === 'size_mismatch' && r.file && ` (${r.file.width}×${r.file.height})`}
                    {r.rule === 'number' && r.status === 'matched' && ' (по номеру)'}
                  </td>
                </tr>
              ))}
              {plan.extra.map((f) => (
                <tr key={f.path} className="muted">
                  <td>—</td>
                  <td>—</td>
                  <td>{f.name}</td>
                  <td>лишний файл</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button
              className="primary"
              disabled={ok.length === 0}
              onClick={() => {
                store.exec(ImportFiles(kind, ok.map((r) => ({ pageId: r.pageId, file: fileRef(r.file!) }))));
                onClose();
              }}
            >
              Применить ({ok.length})
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** Publish (docs/05 §4.3): link to a server chapter, summary, upload with progress, conflicts. */
export function PublishDialog({ ctx, store, onClose }: { ctx: AppCtx; store: Store; onClose: () => void }) {
  const ws = store.get().ws;
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [projectId, setProjectId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [number, setNumber] = useState(() => ws.title.match(/\d+(\.\d+)?/)?.[0] ?? '');
  const [phase, setPhase] = useState<'link' | 'summary' | 'running' | 'conflict' | 'sources' | 'done'>(ws.server ? 'summary' : 'link');
  const [log, setLog] = useState<string>('');
  const [conflict, setConflict] = useState<Array<{ id: string; markup_rev: number | null }>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceConflictItem[]>([]);

  useEffect(() => {
    if (phase === 'link') void ctx.api.projects().then((p) => (setProjects(p), setProjectId((c) => c || p[0]?.id || '')));
  }, [ctx.api, phase]);

  const link = async () => {
    setErr(null);
    try {
      const pid = projectId === '__new' ? (await ctx.api.createProject(newTitle.trim())).id : projectId;
      const ch = await ctx.api.createChapter(pid, number.trim());
      store.patch((w) => ({ ...w, server: { url: ctx.api.baseUrl, project_id: pid, chapter_id: ch.id, chapter_number: ch.number } }));
      setPhase('summary');
    } catch (e) {
      setErr(e instanceof ApiFailure && e.code === 'VALIDATION_ERROR' ? 'Номер главы вида «12» или «12.5»' : e instanceof Error ? e.message : String(e));
    }
  };

  const run = async (overwrite?: Map<string, number | null>, forceSource?: ReadonlySet<string>) => {
    setPhase('running');
    setErr(null);
    const onEvent = (e: PublishEvent) =>
      setLog(
        e.kind === 'stage'
          ? { thumbs: 'Миниатюры…', check: 'Проверяю файлы на сервере…', upload: 'Загрузка файлов…', sync: 'Публикация разметки…' }[e.stage]
          : e.kind === 'upload'
            ? `Загружено файлов: ${e.done} из ${e.total}`
            : `Повтор загрузки (${e.attempt})…`,
      );
    try {
      const r = await publish(ctx.host, ctx.api, store.get().ws, { onEvent, overwriteRevs: overwrite, forceSource });
      if (r.kind === 'conflict') {
        setConflict(r.pages);
        setPhase('conflict');
      } else {
        if (r.kind === 'ok') {
          store.patch(() => r.ws);
          await saveWorkspace(ctx.host, r.ws);
          const texts = r.pages.reduce((n, p) => n + p.source_updated.length, 0);
          setLog(`Опубликовано страниц: ${r.pages.filter((p) => p.changed).length}${texts ? `, обновлено оригиналов: ${texts}` : ''}`);
          if (r.sourceConflicts.length) {
            setSources(r.sourceConflicts);
            setPhase('sources');
            return;
          }
        } else setLog('Изменений нет — публиковать нечего.');
        setPhase('done');
      }
    } catch (e) {
      setErr(`${e instanceof Error ? e.message : String(e)}. Публикацию можно повторить: уже загруженные файлы не будут загружаться заново.`);
      setPhase('summary');
    }
  };

  const plan = planPublish(store.get().ws);
  const idxOf = (id: string) => store.get().ws.pages.find((p) => p.id === id)?.idx;

  return (
    <Modal title="Опубликовать главу" onClose={phase === 'running' ? undefined : onClose}>
      {phase === 'link' && (
        <div className="form">
          <label>
            Проект{' '}
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
              <option value="__new">+ новый проект…</option>
            </select>
          </label>
          {projectId === '__new' && (
            <label>
              Название проекта <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            </label>
          )}
          <label>
            Номер главы <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="12" />
          </label>
          <button className="primary" onClick={() => void link()} disabled={!number.trim() || (projectId === '__new' && !newTitle.trim())}>
            Далее
          </button>
        </div>
      )}
      {phase === 'summary' && (
        <div>
          <p>
            Глава {store.get().ws.server?.chapter_number}: новых страниц — {plan.newPages.length}, изменённых — {plan.changedPages.length}, объектов в них — {plan.objectCount}, файлов к проверке —{' '}
            {plan.files.length} (миниатюры будут созданы).
          </p>
          <button className="primary" onClick={() => void run()}>
            Опубликовать
          </button>
        </div>
      )}
      {phase === 'running' && <p role="status">{log}</p>}
      {phase === 'sources' && (
        <div>
          <p className="ok">{log}</p>
          <p>
            Оригинальный текст этих объектов уже исправили в вебе после вашей последней публикации. Ваш вариант пока не отправлен:
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Стр. / №</th>
                <th>В вебе</th>
                <th>У вас</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((c) => (
                <tr key={c.objectId}>
                  <td>
                    {c.pageIdx} / {c.order}
                  </td>
                  <td className="pre">{c.server}</td>
                  <td className="pre">{c.desktop}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button
              onClick={async () => {
                const byId = new Map(sources.map((c) => [c.objectId, c.server]));
                store.patch((w) => ({
                  ...w,
                  pages: w.pages.map((p) => ({
                    ...p,
                    objects: p.objects.map((o) => (byId.has(o.id) ? { ...o, source_text: byId.get(o.id)!, server_source: byId.get(o.id)! } : o)),
                  })),
                }));
                await saveWorkspace(ctx.host, store.get().ws);
                setLog('Оставлены версии из веба.');
                setPhase('done');
              }}
            >
              Оставить версию из веба
            </button>
            <button className="danger" onClick={() => void run(undefined, new Set(sources.map((c) => c.objectId)))}>
              Перезаписать мой вариант
            </button>
          </div>
        </div>
      )}
      {phase === 'conflict' && (
        <div>
          <p className="error">
            Разметку страниц {conflict.map((c) => idxOf(c.id)).join(', ')} кто-то изменил на сервере после вашей последней публикации или загрузки.
          </p>
          <div className="row">
            <button
              onClick={async () => {
                const sv = store.get().ws.server!;
                const fresh = await downloadChapter(ctx.host, ctx.api, sv.chapter_id);
                store.reset({ ...fresh, id: store.get().ws.id, title: store.get().ws.title });
                setLog('Загружена версия сервера.');
                setPhase('done');
              }}
            >
              Загрузить версию сервера (локальные изменения будут потеряны)
            </button>
            <button className="danger" onClick={() => void run(new Map(conflict.map((c) => [c.id, c.markup_rev])))}>
              Перезаписать сервер (страницы {conflict.map((c) => idxOf(c.id)).join(', ')})
            </button>
          </div>
        </div>
      )}
      {phase === 'done' && (
        <div>
          <p className="ok">{log}</p>
          <button className="primary" onClick={onClose}>
            Готово
          </button>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </Modal>
  );
}
