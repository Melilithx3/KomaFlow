import type { z } from 'zod';
import * as A from './api.js';
import { ExportStatus } from './dto.js';

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path relative to {@link A.API_PREFIX}; params as `{name}`. */
  path: string;
  summary: string;
  desktopOnly?: boolean;
  public?: boolean;
  body?: z.ZodType;
  response?: z.ZodType;
  /** Raw (non-JSON) request or response body. */
  binary?: 'request' | 'response';
}

/** API v1 route table (docs/02-api.md). Used to generate OpenAPI and checked by server tests. */
export const ROUTES: RouteDef[] = [
  { method: 'POST', path: '/auth/login', summary: 'Log in', public: true, body: A.LoginRequest, response: A.LoginResponse },
  { method: 'POST', path: '/auth/logout', summary: 'Revoke the current session', response: A.OkResponse },
  { method: 'GET', path: '/me', summary: 'Current user and session', response: A.MeResponse },
  { method: 'GET', path: '/me/sessions', summary: 'Sessions (devices) of the user', response: A.SessionsResponse },
  { method: 'DELETE', path: '/me/sessions/{id}', summary: 'Revoke a session', response: A.OkResponse },
  { method: 'POST', path: '/me/password', summary: 'Change password', body: A.ChangePasswordRequest, response: A.OkResponse },

  { method: 'GET', path: '/projects', summary: 'List projects', response: A.ProjectsResponse },
  { method: 'POST', path: '/projects', summary: 'Create project', body: A.CreateProjectRequest, response: A.ProjectResponse },
  { method: 'PATCH', path: '/projects/{id}', summary: 'Update project', body: A.UpdateProjectRequest, response: A.ProjectResponse },
  { method: 'GET', path: '/projects/{id}/chapters', summary: 'Chapters with progress', response: A.ChaptersResponse },
  {
    method: 'POST',
    path: '/projects/{id}/chapters',
    summary: 'Create (or get) chapter by number',
    desktopOnly: true,
    body: A.CreateChapterRequest,
    response: A.ChapterResponse,
  },
  { method: 'GET', path: '/chapters/{id}', summary: 'Chapter with page summaries (ETag)', response: A.ChapterDetailResponse },

  { method: 'POST', path: '/blobs/check', summary: 'Which blobs are missing', body: A.BlobsCheckRequest, response: A.BlobsCheckResponse },
  { method: 'PUT', path: '/blobs/{sha256}', summary: 'Upload blob (streaming; the web uploads typed pages and review marks, ADR 0021)', binary: 'request', response: A.BlobPutResponse },
  { method: 'GET', path: '/blobs/{sha256}', summary: 'Download blob (immutable)', binary: 'response' },

  { method: 'POST', path: '/chapters/{id}/sync', summary: 'Publish chapter markup', desktopOnly: true, body: A.SyncRequest, response: A.SyncResponse },

  { method: 'GET', path: '/pages/{id}', summary: 'Page with objects (ETag)', response: A.PageDetailResponse },
  { method: 'PUT', path: '/pages/{id}/seen', summary: 'Mark markup revision as seen', body: A.SeenRequest, response: A.OkResponse },
  { method: 'PUT', path: '/pages/{id}/typed', summary: 'Set the manual "typed" status', body: A.TypedRequest, response: A.PageResponse },
  { method: 'PUT', path: '/pages/{id}/reviews/{kind}', summary: 'Save the editorial review (marks + comment) of the clean or the typed page', body: A.PutReviewRequest, response: A.ReviewResponse },
  { method: 'PUT', path: '/pages/{id}/typed-image', summary: 'Bind an uploaded typed page image; marks the page typed', body: A.TypedImageRequest, response: A.PageResponse },
  { method: 'PATCH', path: '/objects/{id}', summary: 'Edit text data of an object', body: A.PatchObjectRequest },

  { method: 'POST', path: '/chapters/{id}/exports', summary: 'Start PSD export', body: A.CreateExportRequest, response: A.ExportResponse },
  { method: 'GET', path: '/chapters/{id}/exports', summary: 'Recent exports of chapter', response: A.ExportsResponse },
  { method: 'GET', path: '/chapters/{id}/export-status', summary: 'Freshness of the latest export', response: ExportStatus },
  { method: 'GET', path: '/exports/{id}', summary: 'Export status and manifest', response: A.ExportResponse },
  { method: 'GET', path: '/exports/{id}/download', summary: 'Download export zip', binary: 'response' },
];
