import { useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import type { MeResponse } from '@komaflow/contract';
import { api, HttpError, setUnauthenticatedHandler } from './lib/api.js';
import { useOnline } from './lib/online.js';
import { t } from './strings.js';
import { Icon } from './components/Icon.js';
import { LoginScreen } from './screens/Login.js';
import { ProjectsScreen } from './screens/Projects.js';
import { ChapterScreen } from './screens/Chapter.js';
import { PageScreen } from './screens/Page.js';
import { SettingsScreen } from './screens/Settings.js';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (n, e) => !(e instanceof HttpError && e.status >= 400 && e.status < 500) && n < 3,
        refetchOnWindowFocus: true,
        staleTime: 5_000,
      },
    },
  });
}

export function App({ client = makeQueryClient() }: { client?: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginScreen />} />
          <Route path="/*" element={<Authed />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<MeResponse>('GET', '/me'), staleTime: 60_000 });
}

function Authed() {
  const loc = useLocation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const me = useMe();

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      qc.clear();
      nav(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`, { replace: true });
    });
  }, [nav, qc]);

  if (me.isPending) return <p className="center muted">{t.loading}</p>;
  if (me.error) {
    if (me.error instanceof HttpError && me.error.code === 'UNAUTHENTICATED') {
      return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    }
    return <ErrorBox error={me.error} retry={() => void me.refetch()} />;
  }
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<ProjectsScreen />} />
        <Route path="/projects/:projectId" element={<ProjectsScreen />} />
        <Route path="/chapters/:chapterId" element={<ChapterScreen />} />
        <Route path="/pages/:pageId" element={<PageScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="*" element={<p className="center">{t.notFound}</p>} />
      </Routes>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const online = useOnline();
  const loc = useLocation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const logout = async () => {
    try {
      await api('POST', '/auth/logout');
    } finally {
      qc.clear();
      nav('/login');
    }
  };
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="logo" aria-hidden>
            K
          </span>
          {t.appName}
        </Link>
        <nav>
          <NavLink to="/" end>
            <Icon name="book" size={16} /> <span className="nav-text">{t.nav.projects}</span>
          </NavLink>
          <NavLink to="/settings">
            <Icon name="settings" size={16} /> <span className="nav-text">{t.nav.settings}</span>
          </NavLink>
          <button className="ghost" onClick={() => void logout()} title={t.nav.logout} aria-label={t.nav.logout}>
            <Icon name="logout" size={16} /> <span className="nav-text">{t.nav.logout}</span>
          </button>
        </nav>
      </header>
      {!online && (
        <div className="offline" role="alert">
          {t.offline}
        </div>
      )}
      <main className={loc.pathname.startsWith('/pages/') ? 'fill' : undefined}>{children}</main>
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="center error-box" role="alert">
      <p>{error instanceof HttpError && error.status === 404 ? t.notFound : `${t.errorGeneric}: ${error instanceof Error ? error.message : ''}`}</p>
      {retry && <button onClick={retry}>{t.retry}</button>}
    </div>
  );
}
