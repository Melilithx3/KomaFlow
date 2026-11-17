import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { z } from 'zod';
import * as A from '@komaflow/contract';
import { ApiError, API_PREFIX, CLIENT_HEADER, SESSION_COOKIE, Sha256 } from '@komaflow/contract';
import { buildOpenApi } from '@komaflow/contract/openapi';
import type { ImageCodec } from '@komaflow/psd';
import { LoginLimiter } from './auth/rate-limit.js';
import type { Ctx } from './context.js';
import { VERSION } from './version.js';
import { getBlob, missingBlobs, openBlob, putBlob } from './services/blobs.js';
import {
  chapterDetail,
  createChapter,
  createProject,
  listChapters,
  listProjects,
  updateProject,
} from './services/catalog.js';
import { createExport, exportStatus, ExportWorker, getExport, listExports, openExportFile } from './services/exports.js';
import { markSeen, pageDetail, patchObject, setTyped } from './services/pages.js';
import { syncChapter } from './services/sync.js';
import {
  authenticate,
  checkCredentials,
  createSession,
  listSessions,
  revokeSession,
  sessionDTO,
  setPassword,
  userDTO,
  type AuthInfo,
} from './services/users.js';
import { verifyPassword } from './auth/password.js';

export interface AppOptions {
  codec: ImageCodec;
  logger?: boolean | object;
  /** Login failure delay; tests set it to 0. */
  loginDelay?: boolean;
}

export interface App {
  app: FastifyInstance;
  worker: ExportWorker;
}

const parse = <T extends z.ZodType>(schema: T, data: unknown): z.infer<T> => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiError('VALIDATION_ERROR', 'request does not match the schema', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
};

const idParam = (req: FastifyRequest, name = 'id'): string => {
  const v = (req.params as Record<string, string>)[name] ?? '';
  if (!A.Id.safeParse(v).success) throw new ApiError('NOT_FOUND', 'not found');
  return v;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CSP =
  "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
  "connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export function buildApp(ctx: Ctx, opts: AppOptions): App {
  const { cfg } = ctx;
  const app = Fastify({
    logger: opts.logger ?? { level: cfg.logLevel },
    trustProxy: cfg.trustProxy,
    bodyLimit: 16 * 1024 * 1024,
    genReqId: () => A.uuidv7(),
  });
  const worker = new ExportWorker(ctx, opts.codec, (msg, extra) => app.log.info(extra ?? {}, msg));
  const limiter = new LoginLimiter();

  void app.register(fastifyCookie);
  // Raw bodies (blob uploads) arrive as streams; JSON keeps the default parser.
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    if (!req.url.startsWith(API_PREFIX)) reply.header('Content-Security-Policy', CSP);
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      if (err.status >= 500) req.log.error({ err }, 'api error');
      return reply.status(err.status).send(err.toBody());
    }
    const e = err as { code?: string; statusCode?: number; message?: string };
    let api: ApiError;
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') api = new ApiError('PAYLOAD_TOO_LARGE', 'request body is too large');
    else if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') api = new ApiError('UNSUPPORTED_MEDIA', 'unsupported content type');
    else if (e.statusCode === 400 || e.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || err instanceof SyntaxError) {
      api = new ApiError('VALIDATION_ERROR', e.message ?? 'bad request');
    } else {
      req.log.error({ err }, 'unhandled error');
      api = new ApiError('INTERNAL_ERROR', 'internal error');
    }
    return reply.status(api.status).send(api.toBody());
  });

  // ------------------------------------------------------------ auth helpers
  const auth = (req: FastifyRequest): AuthInfo & { viaCookie: boolean } => {
    const h = req.headers.authorization;
    let token: string | undefined;
    let viaCookie = false;
    if (h?.startsWith('Bearer ')) token = h.slice(7).trim();
    else if (req.cookies[SESSION_COOKIE]) {
      token = req.cookies[SESSION_COOKIE];
      viaCookie = true;
    }
    const info = token ? authenticate(ctx, token) : null;
    if (!info) throw new ApiError('UNAUTHENTICATED', 'not signed in or the session has expired');
    if (viaCookie && !['GET', 'HEAD'].includes(req.method) && req.headers[CLIENT_HEADER] !== 'web') {
      throw new ApiError('FORBIDDEN', `missing ${CLIENT_HEADER}: web header`);
    }
    return { ...info, viaCookie };
  };
  const desktop = (a: AuthInfo) => {
    if (a.session.client !== 'desktop') throw new ApiError('FORBIDDEN', 'only the desktop client can do this');
  };

  /** Sends JSON with a weak ETag of the body; answers 304 on If-None-Match. */
  const withEtag = (req: FastifyRequest, reply: FastifyReply, body: unknown) => {
    const json = JSON.stringify(body);
    const etag = `W/"${createHash('sha1').update(json).digest('base64url')}"`;
    reply.header('ETag', etag).header('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.type('application/json; charset=utf-8').send(json);
  };

  const P = API_PREFIX;

  // ------------------------------------------------------------ public
  app.get('/healthz', async () => {
    let db = 'ok';
    try {
      ctx.db.get('SELECT 1');
    } catch {
      db = 'error';
    }
    return { ok: db === 'ok', version: VERSION, db };
  });

  app.post(`${P}/auth/login`, async (req, reply) => {
    const body = parse(A.LoginRequest, req.body);
    const ip = req.ip;
    if (limiter.isBlocked(ip, body.login)) throw new ApiError('RATE_LIMITED', 'too many attempts, try again later');
    const user = await checkCredentials(ctx, body.login, body.password);
    if (!user) {
      const delay = limiter.fail(ip, body.login);
      if (opts.loginDelay !== false) await sleep(delay);
      throw new ApiError('UNAUTHENTICATED', 'invalid login or password');
    }
    limiter.succeed(ip, body.login);
    const { token } = createSession(ctx, user.id, body.client, body.device_name);
    if (body.client === 'web') {
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: cfg.secureCookies,
        sameSite: 'lax',
        path: '/',
        maxAge: cfg.sessionDays * 86_400,
      });
      return { user: userDTO(user) };
    }
    return { user: userDTO(user), token };
  });

  // ------------------------------------------------------------ me
  app.post(`${P}/auth/logout`, async (req, reply) => {
    const a = auth(req);
    revokeSession(ctx, a.user.id, a.session.id);
    if (a.viaCookie) reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get(`${P}/me`, async (req) => {
    const a = auth(req);
    return { user: userDTO(a.user), session: sessionDTO(a.session, a.session.id) };
  });
  app.get(`${P}/me/sessions`, async (req) => {
    const a = auth(req);
    return { sessions: listSessions(ctx, a.user.id).map((s) => sessionDTO(s, a.session.id)) };
  });
  app.delete(`${P}/me/sessions/:id`, async (req) => {
    const a = auth(req);
    if (!revokeSession(ctx, a.user.id, idParam(req))) throw new ApiError('NOT_FOUND', 'session not found');
    return { ok: true };
  });
  app.post(`${P}/me/password`, async (req) => {
    const a = auth(req);
    const body = parse(A.ChangePasswordRequest, req.body);
    if (!(await verifyPassword(body.old_password, a.user.password_hash))) {
      throw new ApiError('VALIDATION_ERROR', 'old password is wrong', { issues: [{ path: 'old_password', message: 'wrong password' }] });
    }
    await setPassword(ctx, a.user.id, body.new_password);
    return { ok: true };
  });

  // ------------------------------------------------------------ projects & chapters
  app.get(`${P}/projects`, async (req) => {
    auth(req);
    return { projects: listProjects(ctx) };
  });
  app.post(`${P}/projects`, async (req, reply) => {
    auth(req);
    const project = createProject(ctx, parse(A.CreateProjectRequest, req.body));
    return reply.status(201).send({ project });
  });
  app.patch(`${P}/projects/:id`, async (req) => {
    auth(req);
    return { project: updateProject(ctx, idParam(req), parse(A.UpdateProjectRequest, req.body)) };
  });
  app.get(`${P}/projects/:id/chapters`, async (req) => {
    const a = auth(req);
    return { chapters: listChapters(ctx, idParam(req), a.user.id) };
  });
  app.post(`${P}/projects/:id/chapters`, async (req, reply) => {
    const a = auth(req);
    desktop(a);
    const r = createChapter(ctx, idParam(req), parse(A.CreateChapterRequest, req.body));
    return reply.status(r.created ? 201 : 200).send({ chapter: r.chapter });
  });
  app.get(`${P}/chapters/:id`, async (req, reply) => {
    const a = auth(req);
    return withEtag(req, reply, chapterDetail(ctx, idParam(req), a.user.id));
  });

  // ------------------------------------------------------------ blobs
  app.post(`${P}/blobs/check`, async (req) => {
    desktop(auth(req));
    const body = parse(A.BlobsCheckRequest, req.body);
    return { missing: missingBlobs(ctx, body.hashes) };
  });
  app.put(`${P}/blobs/:sha256`, async (req, reply) => {
    desktop(auth(req));
    const hash = (req.params as { sha256: string }).sha256;
    if (!Sha256.safeParse(hash).success) throw new ApiError('VALIDATION_ERROR', 'path must be a lower-case sha256');
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > cfg.maxBlobBytes) throw new ApiError('PAYLOAD_TOO_LARGE', 'file is too large');
    const body = req.body as Readable | undefined;
    if (!body || typeof (body as Readable).pipe !== 'function') {
      throw new ApiError('UNSUPPORTED_MEDIA', 'send the file bytes with an image Content-Type');
    }
    const { row, created } = await putBlob(ctx, hash, req.headers['content-type'], body);
    return reply.status(created ? 201 : 200).send({ ...row, created });
  });
  app.get(`${P}/blobs/:sha256`, async (req, reply) => {
    auth(req);
    const hash = (req.params as { sha256: string }).sha256;
    if (!Sha256.safeParse(hash).success || !getBlob(ctx, hash)) throw new ApiError('NOT_FOUND', 'blob not found');
    const etag = `"${hash}"`;
    reply.header('Cache-Control', 'public, max-age=31536000, immutable').header('ETag', etag);
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    const b = openBlob(ctx, hash);
    return reply.type(b.row.mime).header('Content-Length', b.size).send(b.stream);
  });

  // ------------------------------------------------------------ sync
  app.post(`${P}/chapters/:id/sync`, async (req) => {
    const a = auth(req);
    desktop(a);
    return syncChapter(ctx, idParam(req), a.user.id, parse(A.SyncRequest, req.body));
  });

  // ------------------------------------------------------------ pages & objects
  app.get(`${P}/pages/:id`, async (req, reply) => {
    const a = auth(req);
    return withEtag(req, reply, pageDetail(ctx, idParam(req), a.user.id));
  });
  app.put(`${P}/pages/:id/seen`, async (req) => {
    const a = auth(req);
    markSeen(ctx, idParam(req), a.user.id, parse(A.SeenRequest, req.body).markup_rev);
    return { ok: true };
  });
  app.put(`${P}/pages/:id/typed`, async (req) => {
    const a = auth(req);
    return { page: setTyped(ctx, idParam(req), a.user.id, parse(A.TypedRequest, req.body).typed) };
  });
  app.patch(`${P}/objects/:id`, async (req) => {
    const a = auth(req);
    return patchObject(ctx, idParam(req), a.user.id, parse(A.PatchObjectRequest, req.body));
  });

  // ------------------------------------------------------------ exports
  app.post(`${P}/chapters/:id/exports`, async (req, reply) => {
    const a = auth(req);
    const e = createExport(ctx, idParam(req), a.user.id, parse(A.CreateExportRequest, req.body ?? {}));
    void worker.kick();
    return reply.status(202).send({ export: e });
  });
  app.get(`${P}/chapters/:id/exports`, async (req) => {
    auth(req);
    return { exports: listExports(ctx, idParam(req)) };
  });
  app.get(`${P}/chapters/:id/export-status`, async (req) => {
    auth(req);
    return exportStatus(ctx, idParam(req));
  });
  app.get(`${P}/exports/:id`, async (req) => {
    auth(req);
    return getExport(ctx, idParam(req));
  });
  app.get(`${P}/exports/:id/download`, async (req, reply) => {
    auth(req);
    const f = openExportFile(ctx, idParam(req));
    return reply
      .type('application/zip')
      .header('Content-Length', f.size)
      .header('Content-Disposition', `attachment; filename="export.zip"; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .send(f.stream);
  });

  // ------------------------------------------------------------ dev docs
  if (cfg.dev) {
    app.get('/openapi.json', async () => buildOpenApi(VERSION));
  }

  // ------------------------------------------------------------ web static + SPA fallback
  const webDir = cfg.webDir;
  const hasWeb = webDir !== null && existsSync(join(webDir, 'index.html'));
  if (hasWeb) {
    void app.register(fastifyStatic, {
      root: webDir,
      wildcard: false,
      index: false,
      setHeaders: (res, path) => {
        if (/[\\/]assets[\\/]/.test(path)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else res.header('Cache-Control', 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !hasWeb || req.method !== 'GET') {
      const e = new ApiError('NOT_FOUND', 'route not found');
      return reply.status(404).send(e.toBody());
    }
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });

  return { app, worker };
}
