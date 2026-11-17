import { z } from 'zod';
import { Box, Rotation, ClientKind, Id, LIMITS, ObjectType, ReadingDirection, Sha256, TranslationState, MAX_SIDE_PX } from './common.js';
import {
  ChapterDTO,
  ChapterListItem,
  ExportDTO,
  Manifest,
  MarkupRevisionDTO,
  MarkupSummary,
  ObjectDTO,
  PageDTO,
  PageSummary,
  ProjectDTO,
  SessionDTO,
  UserDTO,
} from './dto.js';
import { ProjectSettings } from './settings.js';

export const API_PREFIX = '/api/v1';
export const SESSION_COOKIE = 'komaflow_session';
export const CLIENT_HEADER = 'x-komaflow-client';

// ---------------------------------------------------------------- auth
export const LoginRequest = z.strictObject({
  login: z.string().min(1).max(100),
  password: z.string().min(1).max(1000),
  device_name: z.string().min(1).max(100),
  client: ClientKind,
});
export type LoginRequest = z.infer<typeof LoginRequest>;
export const LoginResponse = z.object({ user: UserDTO, token: z.string().optional() });
export type LoginResponse = z.infer<typeof LoginResponse>;

export const MeResponse = z.object({ user: UserDTO, session: SessionDTO });
export type MeResponse = z.infer<typeof MeResponse>;
export const SessionsResponse = z.object({ sessions: z.array(SessionDTO) });
export const ChangePasswordRequest = z.strictObject({
  old_password: z.string().min(1).max(1000),
  new_password: z.string().min(8).max(1000),
});
export const OkResponse = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------- projects & chapters
const Lang = z.string().min(2).max(16);
export const CreateProjectRequest = z.strictObject({
  title: z.string().trim().min(1).max(200),
  source_lang: Lang,
  target_lang: Lang,
  reading_direction: ReadingDirection.optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
export const UpdateProjectRequest = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  source_lang: Lang.optional(),
  target_lang: Lang.optional(),
  reading_direction: ReadingDirection.optional(),
  settings: ProjectSettings.optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;
export const ProjectsResponse = z.object({ projects: z.array(ProjectDTO) });
export const ProjectResponse = z.object({ project: ProjectDTO });

export const CreateChapterRequest = z.strictObject({
  number: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'chapter number like "12" or "12.5"'),
  title: z.string().trim().max(200).nullable().optional(),
});
export type CreateChapterRequest = z.infer<typeof CreateChapterRequest>;
export const ChaptersResponse = z.object({ chapters: z.array(ChapterListItem) });
export const ChapterResponse = z.object({ chapter: ChapterDTO });
export const ChapterDetailResponse = z.object({
  chapter: ChapterDTO,
  project: ProjectDTO,
  pages: z.array(PageSummary),
});
export type ChapterDetailResponse = z.infer<typeof ChapterDetailResponse>;

// ---------------------------------------------------------------- blobs
export const BlobsCheckRequest = z.strictObject({ hashes: z.array(Sha256).max(LIMITS.blobsCheck) });
export const BlobsCheckResponse = z.object({ missing: z.array(Sha256) });
export const BlobPutResponse = z.object({
  hash: Sha256,
  size: z.number().int(),
  mime: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  created: z.boolean(),
});

// ---------------------------------------------------------------- sync
const PageSide = z.number().int().min(1).max(MAX_SIDE_PX);
export const SyncObject = z.strictObject({
  id: z.uuidv7(),
  type: ObjectType,
  box: Box,
  text_box: Box.nullable().optional(),
  rotation: Rotation.optional(),
  source_text: z.string().max(LIMITS.source_text).optional(),
  /**
   * Server value of source_text the desktop last saw (ADR 0013). For an existing object the server takes
   * `source_text` only if its current value still equals this base (or the web never edited it).
   */
  source_text_base: z.string().max(LIMITS.source_text).nullable().optional(),
  /** Overwrite the server's source_text even if the web changed it («Перезаписать сервер»). */
  source_text_force: z.boolean().optional(),
});
export type SyncObject = z.infer<typeof SyncObject>;

export const SyncPage = z.strictObject({
  id: z.uuidv7(),
  idx: z.number().int().min(1).max(10_000),
  width: PageSide,
  height: PageSide,
  raw_hash: Sha256,
  clean_hash: Sha256.nullable().optional(),
  notes_hash: Sha256.nullable().optional(),
  thumb_hash: Sha256.nullable().optional(),
  base_markup_rev: z.number().int().min(0).nullable(),
  objects: z.array(SyncObject).max(2000),
});
export type SyncPage = z.infer<typeof SyncPage>;

export const SyncRequest = z.strictObject({ pages: z.array(SyncPage).min(1).max(1000) });
export type SyncRequest = z.infer<typeof SyncRequest>;
export const SourceConflict = z.object({ id: Id, server_source_text: z.string(), desktop_source_text: z.string() });
export type SourceConflict = z.infer<typeof SourceConflict>;
export const SyncResponse = z.object({
  pages: z.array(
    z.object({
      id: Id,
      markup_rev: z.number().int(),
      changed: z.boolean(),
      summary: MarkupSummary,
      /** Existing objects whose source_text was taken from the desktop. */
      source_updated: z.array(Id),
      /** source_text edited in the web since the desktop's base: not applied. */
      source_conflicts: z.array(SourceConflict),
    }),
  ),
});
export type SyncResponse = z.infer<typeof SyncResponse>;

// ---------------------------------------------------------------- pages & objects
export const PageDetailResponse = z.object({
  page: PageDTO,
  objects: z.array(ObjectDTO),
  deleted_objects: z.array(ObjectDTO),
  revisions: z.array(MarkupRevisionDTO),
  project_settings: ProjectSettings,
  seen_markup_rev: z.number().int().nullable(),
});
export type PageDetailResponse = z.infer<typeof PageDetailResponse>;

export const SeenRequest = z.strictObject({ markup_rev: z.number().int().min(0) });
export const TypedRequest = z.strictObject({ typed: z.boolean() });
export const PageResponse = z.object({ page: PageDTO });

export const TextChanges = z
  .strictObject({
    source_text: z.string().max(LIMITS.source_text).optional(),
    translation: z.string().max(LIMITS.translation).optional(),
    state: TranslationState.optional(),
    comment: z.string().max(LIMITS.comment).optional(),
    flagged: z.boolean().optional(),
  })
  .refine((c) => Object.keys(c).length > 0, 'changes must not be empty');
export type TextChanges = z.infer<typeof TextChanges>;

export const PatchObjectRequest = z.strictObject({
  base_text_ver: z.number().int().min(0),
  changes: TextChanges,
});
export type PatchObjectRequest = z.infer<typeof PatchObjectRequest>;

/** `details` of a 409 FIELD_CONFLICT. */
export const FieldConflictDetails = z.object({
  fields: z.array(z.string()),
  server_values: z.record(z.string(), z.unknown()),
  object: ObjectDTO,
  updated_by: UserDTO.nullable(),
});
export type FieldConflictDetails = z.infer<typeof FieldConflictDetails>;

// ---------------------------------------------------------------- exports
export const CreateExportRequest = z.strictObject({
  only_ready: z.boolean().optional(),
  page_ids: z.array(Id).min(1).max(1000).optional(),
  layers: z
    .strictObject({
      raw: z.boolean().optional(),
      clean: z.boolean().optional(),
      notes: z.boolean().optional(),
      text: z.boolean().optional(),
    })
    .optional(),
});
export type CreateExportRequest = z.infer<typeof CreateExportRequest>;
export const ExportResponse = z.object({ export: ExportDTO, manifest: Manifest.nullable().optional() });
export const ExportsResponse = z.object({ exports: z.array(ExportDTO) });

export const HealthResponse = z.object({ ok: z.boolean(), version: z.string(), db: z.string() });
