import { useEffect, useState } from 'react';
import type { Workspace } from '../core/model.js';
import { refreshWebData } from '../core/publish.js';
import { applyPull, findServerChapter, planPull, takes, type CatState, type PullChoice, type PullPlan } from '../core/pull.js';
import { saveWorkspace } from '../core/workspace.js';
import type { AppCtx } from './App.js';
import { Modal } from './Dialogs.js';

const STATE_RU: Record<CatState, string> = { same: 'без изменений', server: 'обновление на сервере', local: 'локальные изменения', conflict: 'конфликт' };

function counts(plan: PullPlan, cat: 'clean' | 'markup') {
  const c: Record<CatState, number> = { same: 0, server: 0, local: 0, conflict: 0 };
  for (const p of plan.pages) c[p[cat]]++;
  return c;
}

/**
 * «Синхронизировать» a local chapter with its server chapter (server → local, ADR 0020): preview of the
 * comparison per category, the user picks what to take. Local edits and conflicts are never replaced
 * unless chosen explicitly. Translation data comes automatically (as in the web).
 */
export function SyncDialog({ ctx, ws, onDone, onClose }: { ctx: AppCtx; ws: Workspace; onDone: (ws: Workspace, message: string) => void; onClose: () => void }) {
  const [plan, setPlan] = useState<PullPlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [choice, setChoice] = useState<PullChoice>({ clean: false, markup: false, conflicts: false });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const m = await findServerChapter(ctx.api, ws);
        if (!m.ok) return setErr(m.message);
        const p = await planPull(ctx.api, ws, m.chapterId);
        setPlan(p);
        // pre-select only categories with server updates
        setChoice({ clean: counts(p, 'clean').server > 0, markup: counts(p, 'markup').server > 0, conflicts: false });
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [ctx.api, ws]);

  const run = async () => {
    if (!plan) return;
    setProgress({ done: 0, total: plan.pages.length });
    try {
      const r = await applyPull(ctx.host, ctx.api, ws, plan, choice, (done, total) => setProgress({ done, total }));
      // translation, originals edited in the web, flags and comments: automatic, as in the web
      const next = await refreshWebData(ctx.api, r.ws);
      await saveWorkspace(ctx.host, next);
      onDone(next, `Синхронизировано: клин — ${r.pulled.clean} стр., разметка — ${r.pulled.markup} стр.; перевод и комментарии обновлены.`);
    } catch (e) {
      setProgress(null);
      setErr(`Синхронизация не удалась, локальная глава не изменена: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const cats = [
    { key: 'clean' as const, label: 'Клин', hint: 'изображения клина и пометок' },
    { key: 'markup' as const, label: 'Разметка', hint: 'боксы, поворот, тип, порядок' },
  ];
  const conflicts = plan ? plan.pages.filter((p) => (choice.clean && p.clean === 'conflict') || (choice.markup && p.markup === 'conflict')).length : 0;
  const willTake = plan ? plan.pages.filter((p) => takes(p.clean, choice.clean, choice.conflicts) || takes(p.markup, choice.markup, choice.conflicts)) : [];

  return (
    <Modal title={`Синхронизировать: ${ws.title}`} onClose={progress ? undefined : onClose} wide>
      {err && <p className="error">{err}</p>}
      {!plan && !err && <p className="muted">Ищу главу на сервере и сравниваю…</p>}
      {plan && !progress && (
        <>
          <p className="muted small">
            С сервера в эту главу: глава {plan.detail.chapter.number} проекта «{plan.detail.project.title}».
            {plan.relink && ' Глава будет связана с серверной (найдена по одинаковым raw-страницам).'}
            {plan.serverOnly.length > 0 && ` На сервере есть страницы, которых здесь нет: ${plan.serverOnly.join(', ')} (не подтягиваются).`}
            {plan.localOnly.length > 0 && ` Только здесь: ${plan.localOnly.join(', ')} (уйдут на сервер при публикации).`}
          </p>
          <div className="sync-cats">
            {cats.map((c) => {
              const n = counts(plan, c.key);
              const avail = n.server + n.conflict > 0;
              return (
                <label key={c.key} className={`sync-cat${avail ? '' : ' idle'}`}>
                  <input type="checkbox" disabled={!avail} checked={choice[c.key] && avail} onChange={(e) => setChoice({ ...choice, [c.key]: e.target.checked })} />
                  <span>
                    <b>{c.label}</b> <span className="muted small">({c.hint})</span>
                    <br />
                    <span className="small">
                      {avail ? '' : 'нечего подтягивать · '}
                      {(Object.keys(n) as CatState[])
                        .filter((k) => n[k] > 0)
                        .map((k) => `${STATE_RU[k]}: ${n[k]}`)
                        .join(' · ')}
                    </span>
                  </span>
                </label>
              );
            })}
            <div className="sync-cat idle">
              <input type="checkbox" checked disabled aria-label="Перевод" />
              <span>
                <b>Перевод</b> <span className="muted small">(оригиналы, перевод, флажки, комментарии)</span>
                <br />
                <span className="small">подтягивается автоматически, как в вебе</span>
              </span>
            </div>
          </div>
          {conflicts > 0 && (
            <label className="check warn-text">
              <input type="checkbox" checked={choice.conflicts} onChange={(e) => setChoice({ ...choice, conflicts: e.target.checked })} />
              Взять серверную версию и на конфликтных страницах ({conflicts}) — локальные изменения там будут заменены
            </label>
          )}
          <div className="preview-table">
            <table>
              <thead>
                <tr>
                  <th>Стр.</th>
                  <th>Клин</th>
                  <th>Разметка</th>
                </tr>
              </thead>
              <tbody>
                {plan.pages.map((p) => (
                  <tr key={p.local.id}>
                    <td>{p.local.idx}</td>
                    {(['clean', 'markup'] as const).map((k) => (
                      <td key={k} className={`st-${p[k]}`}>
                        {STATE_RU[p[k]]}
                        {takes(p[k], choice[k], choice.conflicts) && ' → взять с сервера'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dialog-actions">
            <span className="muted">Будет обновлено страниц: {willTake.length}</span>
            <button onClick={onClose}>Отмена</button>
            <button className="primary" onClick={() => void run()}>
              {willTake.length ? 'Синхронизировать' : 'Обновить только перевод'}
            </button>
          </div>
        </>
      )}
      {progress && (
        <div role="status">
          <p>
            Загрузка: {progress.done} из {progress.total}…
          </p>
          <progress max={Math.max(1, progress.total)} value={progress.done} />
        </div>
      )}
    </Modal>
  );
}
