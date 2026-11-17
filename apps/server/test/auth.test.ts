import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROUTES } from '@komaflow/contract';
import { makeTestApp, PASSWORD, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => t.close());

describe('auth', () => {
  it('healthz is public', async () => {
    const r = await t.inject('GET', '/healthz');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, db: 'ok' });
  });

  it('everything else needs a session', async () => {
    for (const r of ROUTES.filter((x) => !x.public)) {
      const path = r.path.replace(/\{[^}]+\}/g, '0190a000-0000-7000-8000-000000000000');
      const res = await t.inject(r.method, path, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
      expect(res.json.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('web login sets an httpOnly cookie, desktop gets a token', async () => {
    const r = await t.inject('POST', '/auth/login', { login: 'alice', password: PASSWORD, device_name: 'pc', client: 'web' });
    expect(r.status).toBe(200);
    expect(r.json.token).toBeUndefined();
    const cookie = String(([] as string[]).concat(r.headers['set-cookie'] as string)[0]);
    expect(cookie).toMatch(/komaflow_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const d = await t.inject('POST', '/auth/login', { login: 'ALICE', password: PASSWORD, device_name: 'pc', client: 'desktop' });
    expect(d.json.token).toMatch(/^[\w-]{43}$/);
    expect(d.json.user.login).toBe('alice');
  });

  it('same answer for unknown login and wrong password; rate limit after 5 failures', async () => {
    const a = await t.inject('POST', '/auth/login', { login: 'nobody', password: 'x', device_name: 'pc', client: 'web' });
    const b = await t.inject('POST', '/auth/login', { login: 'alice', password: 'wrong', device_name: 'pc', client: 'web' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.json).toEqual(b.json);
    for (let i = 0; i < 4; i++) await t.inject('POST', '/auth/login', { login: 'alice', password: 'wrong', device_name: 'pc', client: 'web' });
    const blocked = await t.inject('POST', '/auth/login', { login: 'alice', password: PASSWORD, device_name: 'pc', client: 'web' });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe('RATE_LIMITED');
    // another login from the same IP is not blocked
    const other = await t.inject('POST', '/auth/login', { login: 'bob', password: PASSWORD, device_name: 'pc', client: 'web' });
    expect(other.status).toBe(200);
  });

  it('me, sessions, revoke, logout', async () => {
    const web = await t.login('alice', 'web');
    const desk = await t.login('alice', 'desktop');
    const me = await web.req('GET', '/me');
    expect(me.json.user.login).toBe('alice');
    expect(me.json.session.client).toBe('web');
    const list = await web.req('GET', '/me/sessions');
    expect(list.json.sessions).toHaveLength(2);
    const deskId = list.json.sessions.find((s: { client: string }) => s.client === 'desktop').id;
    expect((await web.req('DELETE', `/me/sessions/${deskId}`)).status).toBe(200);
    expect((await desk.req('GET', '/me')).status).toBe(401);
    // bob cannot revoke alice's sessions
    const bob = await t.login('bob', 'web');
    const webId = list.json.sessions.find((s: { client: string }) => s.client === 'web').id;
    expect((await bob.req('DELETE', `/me/sessions/${webId}`)).status).toBe(404);
    expect((await web.req('POST', '/auth/logout')).status).toBe(200);
    expect((await web.req('GET', '/me')).status).toBe(401);
  });

  it('CSRF: cookie sessions need X-Komaflow-Client for writes', async () => {
    const web = await t.login('alice', 'web');
    const noHeader = await t.inject('POST', '/projects', { title: 'P', source_lang: 'ja', target_lang: 'ru' }, { cookie: web.cookie! });
    expect(noHeader.status).toBe(403);
    const get = await t.inject('GET', '/projects', undefined, { cookie: web.cookie! });
    expect(get.status).toBe(200);
    const ok = await web.req('POST', '/projects', { title: 'P', source_lang: 'ja', target_lang: 'ru' });
    expect(ok.status).toBe(201);
  });

  it('desktop-only endpoints reject web sessions', async () => {
    const web = await t.login('alice', 'web');
    for (const r of ROUTES.filter((x) => x.desktopOnly)) {
      const path = r.path.replace(/\{sha256\}/, 'a'.repeat(64)).replace(/\{[^}]+\}/g, '0190a000-0000-7000-8000-000000000000');
      const res = await web.req(r.method, path, r.binary ? new Uint8Array([1]) : {}, r.binary ? { 'content-type': 'image/png' } : {});
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
    }
  });

  it('sessions expire after 90 days without use, slide when used', async () => {
    const desk = await t.login('alice', 'desktop');
    t.advance(80 * 86_400_000);
    expect((await desk.req('GET', '/me')).status).toBe(200);
    t.advance(80 * 86_400_000);
    expect((await desk.req('GET', '/me')).status).toBe(200);
    t.advance(91 * 86_400_000);
    expect((await desk.req('GET', '/me')).status).toBe(401);
  });

  it('change password', async () => {
    const web = await t.login('alice', 'web');
    expect((await web.req('POST', '/me/password', { old_password: 'nope', new_password: 'new-password-1' })).status).toBe(422);
    expect((await web.req('POST', '/me/password', { old_password: PASSWORD, new_password: 'new-password-1' })).status).toBe(200);
    const r = await t.inject('POST', '/auth/login', { login: 'alice', password: 'new-password-1', device_name: 'pc', client: 'web' });
    expect(r.status).toBe(200);
  });

  it('security headers and JSON 404', async () => {
    const r = await t.inject('GET', '/api/v1/nope');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('NOT_FOUND');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('same-origin');
  });
});
