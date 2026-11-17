import { useCallback, useEffect, useState } from 'react';
import { ApiClient, ApiFailure } from '../core/api.js';
import type { Host } from '../core/host.js';
import type { Workspace } from '../core/model.js';
import { SidecarClient, type SidecarCaps } from '../core/sidecar.js';
import { loadWorkspace, workspaceFiles } from '../core/workspace.js';
import { Editor } from './Editor.js';
import { Home } from './Home.js';
import { loadSettings, saveSettings, type Settings } from './session.js';

export interface AppCtx {
  host: Host;
  api: ApiClient;
  settings: Settings;
  sidecar: SidecarClient | null;
  caps: SidecarCaps | null;
  user: string | null;
  setSettings: (s: Settings) => void;
  engine: EngineState;
  restartEngine: () => void;
}

/** Sidecar status shown on the start screen. */
export type EngineState = { state: 'starting' } | { state: 'none' } | { state: 'ready'; url: string } | { state: 'error'; error: string };

export function App({ host }: { host: Host }) {
  const [settings, setSettings] = useState(() => loadSettings(host));
  const [api, setApi] = useState<ApiClient | null>(null);
  const [user, setUser] = useState<string | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [sidecar, setSidecar] = useState<SidecarClient | null>(null);
  const [caps, setCaps] = useState<SidecarCaps | null>(null);

  // restore the saved token for the server
  useEffect(() => {
    let alive = true;
    void (async () => {
      const token = await host.getToken(settings.serverUrl);
      const client = new ApiClient(host, settings.serverUrl, token);
      if (!alive) return;
      setApi(client);
      if (token) {
        try {
          setUser((await client.me()).user.display_name);
        } catch (e) {
          if (e instanceof ApiFailure && e.status === 401) await host.setToken(settings.serverUrl, null);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [host, settings.serverUrl]);

  // the sidecar is optional: without it the app works manually (docs/05 §5)
  const [engine, setEngine] = useState<EngineState>({ state: 'starting' });
  const [engineRun, setEngineRun] = useState(0);
  useEffect(() => {
    let alive = true;
    setEngine({ state: 'starting' });
    setSidecar(null);
    setCaps(null);
    void (async () => {
      try {
        const s = await host.startSidecar();
        if (!alive) return;
        if (!s) return setEngine({ state: 'none' });
        const c = new SidecarClient(host, s.url, s.token);
        setSidecar(c);
        setEngine({ state: 'ready', url: s.url });
        setCaps(await c.capabilities());
      } catch (e) {
        if (alive) setEngine({ state: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [host, engineRun]);

  const updateSettings = useCallback((s: Settings) => {
    saveSettings(s);
    setSettings(s);
  }, []);

  if (!api) return <div className="center">Загрузка…</div>;
  const ctx: AppCtx = { host, api, settings, sidecar, caps, user, setSettings: updateSettings, engine, restartEngine: () => setEngineRun((n) => n + 1) };

  if (ws) return <Editor ctx={ctx} initial={ws} onClose={() => setWs(null)} />;
  return (
    <Home
      ctx={ctx}
      onSettings={updateSettings}
      onLogin={async (url, login, password) => {
        const client = new ApiClient(host, url, null);
        const r = await client.login(login, password, await host.deviceName());
        await host.setToken(url, r.token ?? null);
        if (url !== settings.serverUrl) updateSettings({ ...settings, serverUrl: url });
        setApi(client);
        setUser(r.user.display_name);
      }}
      onLogout={async () => {
        await api.logout().catch(() => {});
        await host.setToken(settings.serverUrl, null);
        setUser(null);
      }}
      onOpen={async (w) => {
        await host.allowFiles(workspaceFiles(w));
        setWs(w);
      }}
      onOpenSaved={async (id) => {
        const w = await loadWorkspace(host, id);
        if (!w) return;
        await host.allowFiles(workspaceFiles(w));
        setWs(w);
      }}
    />
  );
}
