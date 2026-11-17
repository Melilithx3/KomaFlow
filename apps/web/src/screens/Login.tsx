import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import type { LoginResponse } from '@komaflow/contract';
import { api, HttpError } from '../lib/api.js';
import { t } from '../strings.js';

/** A readable device name from the user agent, e.g. "Chrome, Android". */
export function guessDevice(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Браузер';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser}, ${os}` : browser;
}

export function LoginScreen() {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [device, setDevice] = useState(() => guessDevice(navigator.userAgent));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<LoginResponse>('POST', '/auth/login', { login, password, device_name: device || 'Браузер', client: 'web' });
      qc.clear();
      const next = params.get('next');
      nav(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
    } catch (err) {
      setError(err instanceof HttpError && err.code === 'RATE_LIMITED' ? t.login.limited : err instanceof HttpError && err.status === 401 ? t.login.wrong : t.errorGeneric);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form onSubmit={(e) => void submit(e)} className="card">
        <h1>{t.login.title}</h1>
        <label>
          {t.login.login}
          <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoCapitalize="none" required autoFocus />
        </label>
        <label>
          {t.login.password}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <label>
          {t.login.device}
          <input value={device} onChange={(e) => setDevice(e.target.value)} maxLength={100} />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {t.login.submit}
        </button>
      </form>
    </div>
  );
}
