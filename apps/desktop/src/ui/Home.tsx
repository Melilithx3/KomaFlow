import { useEffect, useState } from 'react';
import type { ChapterListItem, ProjectDTO } from '@komaflow/contract';
import type { Workspace } from '../core/model.js';
import { downloadChapter } from '../core/publish.js';
import { analysisBlocker } from '../core/sidecar.js';
import { loadWorkspace, saveWorkspace, workspaceFromImages } from '../core/workspace.js';
import type { AppCtx } from './App.js';
import type { Settings } from './session.js';
import { LayoutSettings } from './LayoutSettings.js';

interface Props {
  ctx: AppCtx;
  onSettings: (s: Settings) => void;
  onLogin: (url: string, login: string, password: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onOpen: (ws: Workspace) => Promise<void>;
  onOpenSaved: (id: string) => Promise<void>;
}

/** Start screen: sign-in, local chapters, open a folder, download from the server, settings. */
export function Home({ ctx, onSettings, onLogin, onLogout, onOpen, onOpenSaved }: Props) {
  const { host, settings, user } = ctx;
  const [saved, setSaved] = useState<Workspace[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const ids = await host.listWorkspaces();
      const list = (await Promise.all(ids.map((id) => loadWorkspace(host, id)))).filter((w): w is Workspace => !!w);
      setSaved(list);
    })();
  }, [host]);

  const openFolder = async () => {
    setErr(null);
    const folder = await host.pickFolder('Папка с raw-страницами главы');
    if (!folder) return;
    setBusy('Считаю хэши страниц…');
    try {
      const imgs = await host.scanImages(folder);
      if (!imgs.length) throw new Error('В папке нет PNG, JPEG или WebP');
      const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? 'Глава';
      const ws = workspaceFromImages(name, imgs);
      await saveWorkspace(host, ws);
      await onOpen(ws);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="home">
      <h1>komaflow</h1>
      <section className="card">
        <h2>Сервер</h2>
        {user ? (
          <p>
            Вы вошли как <strong>{user}</strong> на {settings.serverUrl}.{' '}
            <button onClick={() => void onLogout()}>Выйти</button>
          </p>
        ) : (
          <LoginForm settings={settings} onLogin={onLogin} />
        )}
      </section>

      <section className="card">
        <h2>Главы на этом компьютере</h2>
        <div className="row">
          <button className="primary" onClick={() => void openFolder()}>
            Открыть папку с raw…
          </button>
          {busy && <span className="muted">{busy}</span>}
        </div>
        {err && <p className="error">{err}</p>}
        <ul className="list">
          {saved.map((w) => (
            <li key={w.id}>
              <button className="link" onClick={() => void onOpenSaved(w.id)}>
                {w.title}
              </button>{' '}
              <span className="muted">
                {w.pages.length} стр.{w.server ? ` · глава ${w.server.chapter_number} на сервере` : ' · не опубликована'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {user && <ServerChapters ctx={ctx} onOpen={onOpen} />}

      <section className="card">
        <h2>Движок анализа</h2>
        <EngineStatus ctx={ctx} />
        <div className="row">
          <label>
            Бэкенд{' '}
            <select value={settings.backend} onChange={(e) => onSettings({ ...settings, backend: e.target.value as Settings['backend'] })}>
              <option value="auto">авто</option>
              <option value="rocm">ROCm</option>
              <option value="cpu">CPU</option>
            </select>
          </label>
        </div>
        <h3>Параметры разметки</h3>
        <LayoutSettings settings={settings} onChange={onSettings} />
        <p className="muted small">Установка движка: `komaflow-sidecar install` (см. sidecar/README.md). Без него боксы рисуются вручную.</p>
      </section>
      {host.kind === 'browser' && <p className="muted small">Режим разработки в браузере: файлы держатся в памяти вкладки.</p>}
    </div>
  );

  function ServerChapters({ ctx: c, onOpen: open }: { ctx: AppCtx; onOpen: (ws: Workspace) => Promise<void> }) {
    const [projects, setProjects] = useState<ProjectDTO[]>([]);
    const [pid, setPid] = useState<string>('');
    const [chapters, setChapters] = useState<ChapterListItem[]>([]);
    const [progress, setProgress] = useState<string | null>(null);
    useEffect(() => {
      void c.api.projects().then((p) => {
        setProjects(p);
        setPid((cur) => cur || p[0]?.id || '');
      });
    }, [c.api]);
    useEffect(() => {
      if (pid) void c.api.chapters(pid).then(setChapters);
    }, [c.api, pid]);
    return (
      <section className="card">
        <h2>Загрузить с сервера</h2>
        <select value={pid} onChange={(e) => setPid(e.target.value)} aria-label="Проект">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <ul className="list">
          {chapters.map((ch) => (
            <li key={ch.id}>
              <button
                className="link"
                onClick={async () => {
                  setProgress('0%');
                  try {
                    const ws = await downloadChapter(c.host, c.api, ch.id, (d, n) => setProgress(`${Math.round((100 * d) / n)}%`));
                    await saveWorkspace(c.host, ws);
                    await open(ws);
                  } catch (e) {
                    setProgress(`Ошибка: ${e instanceof Error ? e.message : e}`);
                  }
                }}
              >
                Глава {ch.number}
              </button>{' '}
              <span className="muted">{ch.page_count} стр.</span>
            </li>
          ))}
        </ul>
        {progress && <p className="muted">Загрузка: {progress}</p>}
      </section>
    );
  }
}

function LoginForm({ settings, onLogin }: { settings: Settings; onLogin: (url: string, l: string, p: string) => Promise<void> }) {
  const [url, setUrl] = useState(settings.serverUrl);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          await onLogin(url.replace(/\/$/, ''), login, password);
        } catch (x) {
          setErr(x instanceof Error ? x.message : String(x));
        }
      }}
    >
      <label>
        Адрес сервера <input value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        Логин <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" />
      </label>
      <label>
        Пароль <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>
      {err && <p className="error">{err}</p>}
      <button className="primary">Войти</button>
    </form>
  );
}

function EngineStatus({ ctx }: { ctx: AppCtx }) {
  const e = ctx.engine;
  if (e.state === 'starting') return <p className="muted">Запускаю движок…</p>;
  if (e.state === 'none') return <p className="muted">Движок не установлен: анализ и автоклин недоступны, всё остальное работает вручную.</p>;
  if (e.state === 'error')
    return (
      <div>
        <p className="error">Движок не запустился:</p>
        <pre className="log">{e.error}</pre>
        <button onClick={ctx.restartEngine}>Перезапустить движок</button>
      </div>
    );
  const blocker = analysisBlocker(ctx.caps);
  return (
    <p className="row">
      <span className={blocker ? 'muted' : 'ok'}>
        {!ctx.caps
          ? 'Движок запущен, проверяю видеокарту…'
          : (blocker ?? `Готов: ${ctx.caps.backends.filter((b) => b.available).map((b) => (b.id === 'rocm' ? `ROCm (${b.device ?? b.arch})` : 'CPU')).join(', ')}. Модели остаются загруженными между запусками.`)}
      </span>
      <button className="tiny" onClick={ctx.restartEngine}>
        Перезапустить
      </button>
    </p>
  );
}
