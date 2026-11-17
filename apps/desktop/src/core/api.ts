import {
  API_PREFIX,
  ErrorBody,
  type ChapterDetailResponse,
  type ChapterDTO,
  type ChapterListItem,
  type ErrorCode,
  type LoginResponse,
  type PageDetailResponse,
  type ProjectDTO,
  type SyncRequest,
  type SyncResponse,
} from '@komaflow/contract';
import type { Host } from './host.js';

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Typed client of the server API for a desktop session (Bearer token). */
export class ApiClient {
  constructor(
    private readonly host: Host,
    readonly baseUrl: string,
    private token: string | null,
  ) {}

  get authed() {
    return this.token !== null;
  }
  get bearer() {
    return this.token;
  }

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.host.fetch(`${this.baseUrl}${API_PREFIX}${path}`, {
        method,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiFailure(0, 'NETWORK', e instanceof Error ? e.message : String(e));
    }
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const p = ErrorBody.safeParse(json);
      if (p.success) throw new ApiFailure(res.status, p.data.error.code, p.data.error.message, p.data.error.details);
      throw new ApiFailure(res.status, 'INTERNAL_ERROR', `HTTP ${res.status}`);
    }
    return json as T;
  }

  async login(login: string, password: string, device: string): Promise<LoginResponse> {
    const r = await this.req<LoginResponse>('POST', '/auth/login', { login, password, device_name: device, client: 'desktop' });
    this.token = r.token ?? null;
    return r;
  }
  async logout() {
    try {
      await this.req('POST', '/auth/logout');
    } finally {
      this.token = null;
    }
  }
  me = () => this.req<{ user: { login: string; display_name: string } }>('GET', '/me');
  projects = () => this.req<{ projects: ProjectDTO[] }>('GET', '/projects').then((r) => r.projects);
  createProject = (title: string) => this.req<{ project: ProjectDTO }>('POST', '/projects', { title, source_lang: 'ja', target_lang: 'ru' }).then((r) => r.project);
  chapters = (projectId: string) => this.req<{ chapters: ChapterListItem[] }>('GET', `/projects/${projectId}/chapters`).then((r) => r.chapters);
  createChapter = (projectId: string, number: string, title?: string) =>
    this.req<{ chapter: ChapterDTO }>('POST', `/projects/${projectId}/chapters`, { number, title: title ?? null }).then((r) => r.chapter);
  chapter = (id: string) => this.req<ChapterDetailResponse>('GET', `/chapters/${id}`);
  page = (id: string) => this.req<PageDetailResponse>('GET', `/pages/${id}`);
  checkBlobs = (hashes: string[]) => this.req<{ missing: string[] }>('POST', '/blobs/check', { hashes }).then((r) => r.missing);
  sync = (chapterId: string, body: SyncRequest) => this.req<SyncResponse>('POST', `/chapters/${chapterId}/sync`, body);

  async blob(hash: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const res = await this.host.fetch(`${this.baseUrl}${API_PREFIX}/blobs/${hash}`, { headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new ApiFailure(res.status, 'NOT_FOUND', `blob ${hash}: HTTP ${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'image/png' };
  }
}
