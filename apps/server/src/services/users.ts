import { createHash, randomBytes } from 'node:crypto';
import { ApiError, uuidv7, type ClientKind, type SessionDTO, type UserDTO } from '@komaflow/contract';
import { hashPassword, verifyPassword, dummyHash } from '../auth/password.js';
import { iso, type Ctx } from '../context.js';

export interface UserRow {
  id: string;
  login: string;
  display_name: string;
  password_hash: string;
  disabled: number;
  created_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  client: ClientKind;
  device_name: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface AuthInfo {
  user: UserRow;
  session: SessionRow;
}

export const userDTO = (u: Pick<UserRow, 'id' | 'login' | 'display_name'>): UserDTO => ({
  id: u.id,
  login: u.login,
  display_name: u.display_name,
});

export const sessionDTO = (s: SessionRow, currentId: string): SessionDTO => ({
  id: s.id,
  client: s.client,
  device_name: s.device_name,
  created_at: s.created_at,
  last_used_at: s.last_used_at,
  expires_at: s.expires_at,
  current: s.id === currentId,
});

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createUser(ctx: Ctx, login: string, displayName: string, password: string): Promise<UserRow> {
  if (!/^[\w.-]{2,50}$/.test(login)) throw new ApiError('VALIDATION_ERROR', 'login: 2-50 chars of [A-Za-z0-9_.-]');
  if (password.length < 8) throw new ApiError('VALIDATION_ERROR', 'password must have at least 8 characters');
  if (ctx.db.get('SELECT 1 FROM users WHERE login = ?', login)) {
    throw new ApiError('VALIDATION_ERROR', `user ${login} already exists`);
  }
  const row: UserRow = {
    id: uuidv7(),
    login,
    display_name: displayName || login,
    password_hash: await hashPassword(password, ctx.cfg.argon2),
    disabled: 0,
    created_at: iso(ctx.now()),
  };
  ctx.db.run(
    'INSERT INTO users (id, login, display_name, password_hash, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    row.id,
    row.login,
    row.display_name,
    row.password_hash,
    row.created_at,
  );
  return row;
}

export function findUser(ctx: Ctx, login: string): UserRow | undefined {
  return ctx.db.get<UserRow>('SELECT * FROM users WHERE login = ?', login);
}

export async function setPassword(ctx: Ctx, userId: string, password: string): Promise<void> {
  if (password.length < 8) throw new ApiError('VALIDATION_ERROR', 'password must have at least 8 characters');
  const hash = await hashPassword(password, ctx.cfg.argon2);
  ctx.db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, userId);
}

/** Checks credentials; same timing and error for unknown login and wrong password. */
export async function checkCredentials(ctx: Ctx, login: string, password: string): Promise<UserRow | null> {
  const u = findUser(ctx, login);
  const ok = await verifyPassword(password, u?.password_hash ?? (await dummyHash(ctx.cfg.argon2)));
  if (!u || !ok || u.disabled) return null;
  return u;
}

export function createSession(ctx: Ctx, userId: string, client: ClientKind, deviceName: string) {
  const token = randomBytes(32).toString('base64url');
  const now = ctx.now();
  const row: SessionRow = {
    id: uuidv7(),
    user_id: userId,
    token_hash: tokenHash(token),
    client,
    device_name: deviceName,
    created_at: iso(now),
    last_used_at: iso(now),
    expires_at: iso(new Date(now.getTime() + ctx.cfg.sessionDays * 86_400_000)),
    revoked_at: null,
  };
  ctx.db.run(
    `INSERT INTO sessions (id, user_id, token_hash, client, device_name, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.user_id,
    row.token_hash,
    row.client,
    row.device_name,
    row.created_at,
    row.last_used_at,
    row.expires_at,
  );
  return { token, session: row };
}

/** Sliding expiration is refreshed at most once per hour to spare the SD card. */
const TOUCH_INTERVAL_MS = 3_600_000;

export function authenticate(ctx: Ctx, token: string): AuthInfo | null {
  const s = ctx.db.get<SessionRow>('SELECT * FROM sessions WHERE token_hash = ?', tokenHash(token));
  if (!s || s.revoked_at) return null;
  const now = ctx.now();
  if (new Date(s.expires_at).getTime() <= now.getTime()) return null;
  const user = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', s.user_id);
  if (!user || user.disabled) return null;
  if (now.getTime() - new Date(s.last_used_at).getTime() > TOUCH_INTERVAL_MS) {
    s.last_used_at = iso(now);
    s.expires_at = iso(new Date(now.getTime() + ctx.cfg.sessionDays * 86_400_000));
    ctx.db.run('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?', s.last_used_at, s.expires_at, s.id);
  }
  return { user, session: s };
}

export function revokeSession(ctx: Ctx, userId: string, sessionId: string): boolean {
  return (
    ctx.db.run(
      'UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      iso(ctx.now()),
      sessionId,
      userId,
    ).changes > 0
  );
}

export function listSessions(ctx: Ctx, userId: string): SessionRow[] {
  return ctx.db.all<SessionRow>(
    'SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC',
    userId,
    iso(ctx.now()),
  );
}
