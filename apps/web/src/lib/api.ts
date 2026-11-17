import { API_PREFIX, ErrorBody, type ErrorCode } from '@komaflow/contract';
import { setOnline } from './online.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

let onUnauthenticated: () => void = () => {};
export function setUnauthenticatedHandler(fn: () => void) {
  onUnauthenticated = fn;
}

/**
 * JSON request to the API with the cookie session. Writes carry the CSRF header (docs/02-api.md §1).
 * GET revalidation (ETag / 304) is handled by the browser cache: the server sends `no-cache` + ETag.
 */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-komaflow-client': 'web' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    setOnline(false);
    throw new HttpError(0, 'NETWORK', e instanceof Error ? e.message : 'network error', undefined);
  }
  setOnline(true);
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const parsed = ErrorBody.safeParse(json);
    const err = parsed.success
      ? new HttpError(res.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details)
      : new HttpError(res.status, 'INTERNAL_ERROR', `HTTP ${res.status}`, undefined);
    if (err.code === 'UNAUTHENTICATED' && path !== '/auth/login') onUnauthenticated();
    throw err;
  }
  return json as T;
}

export const blobUrl = (hash: string) => `${API_PREFIX}/blobs/${hash}`;
