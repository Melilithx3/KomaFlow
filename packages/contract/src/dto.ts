import { z } from 'zod';
import { Box, Rotation, ClientKind, Id, IsoDateTime, ObjectType, ReadingDirection, Sha256, TranslationState } from './common.js';
import { ExportLayers, ProjectSettings } from './settings.js';

export const UserDTO = z.object({ id: Id, login: z.string(), display_name: z.string() });
export type UserDTO = z.infer<typeof UserDTO>;

export const SessionDTO = z.object({
  id: Id,
  client: ClientKind,
  device_name: z.string(),
  created_at: IsoDateTime,
  last_used_at: IsoDateTime,
  expires_at: IsoDateTime,
  current: z.boolean(),
});
export type SessionDTO = z.infer<typeof SessionDTO>;

export const ProjectDTO = z.object({
  id: Id,
  title: z.string(),
  source_lang: z.string(),
  target_lang: z.string(),
  reading_direction: ReadingDirection,
  settings: ProjectSettings,
  created_at: IsoDateTime,
});
export type ProjectDTO = z.infer<typeof ProjectDTO>;

export const ChapterDTO = z.object({
  id: Id,
  project_id: Id,
  number: z.string(),
  title: z.string().nullable(),
  created_at: IsoDateTime,
});
export type ChapterDTO = z.infer<typeof ChapterDTO>;

export const ChapterListItem = ChapterDTO.extend({
  page_count: z.number().int(),
  clean_count: z.number().int(),
  translated_count: z.number().int(),
  ready_count: z.number().int(),
  typed_count: z.number().int(),
});
export type ChapterListItem = z.infer<typeof ChapterListItem>;

export const FIELD_NAMES = ['source_text', 'translation', 'state', 'comment', 'flagged'] as const;
export const TextField = z.enum(FIELD_NAMES);
export type TextField = z.infer<typeof TextField>;

export const ObjectDTO = z.object({
  id: Id,
  page_id: Id,
  order: z.number().int(),
  type: ObjectType,
  box: Box,
  text_box: Box.nullable(),
  rotation: Rotation,
  geometry_ver: z.number().int(),
  source_text: z.string(),
  translation: z.string(),
  state: TranslationState,
  comment: z.string(),
  flagged: z.boolean(),
  text_ver: z.number().int(),
  field_vers: z.record(z.string(), z.number().int()),
  updated_at: IsoDateTime,
  updated_by: Id.nullable(),
});
export type ObjectDTO = z.infer<typeof ObjectDTO>;

export const PageDTO = z.object({
  id: Id,
  chapter_id: Id,
  idx: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  raw_hash: Sha256,
  clean_hash: Sha256.nullable(),
  notes_hash: Sha256.nullable(),
  thumb_hash: Sha256.nullable(),
  markup_rev: z.number().int(),
  rev: z.number().int(),
  typed: z.boolean(),
  typed_by: Id.nullable(),
  typed_at: IsoDateTime.nullable(),
});
export type PageDTO = z.infer<typeof PageDTO>;

export const StateCounts = z.object({
  total: z.number().int(),
  empty: z.number().int(),
  translated: z.number().int(),
  skipped: z.number().int(),
  unreadable: z.number().int(),
});
export type StateCounts = z.infer<typeof StateCounts>;

export const PageSummary = PageDTO.pick({
  id: true,
  idx: true,
  width: true,
  height: true,
  raw_hash: true,
  thumb_hash: true,
  markup_rev: true,
  rev: true,
  typed: true,
}).extend({
  has_clean: z.boolean(),
  counts: StateCounts,
  flagged: z.number().int(),
  translation_done: z.boolean(),
  ready_for_typing: z.boolean(),
  markup_changed_for_me: z.boolean(),
});
export type PageSummary = z.infer<typeof PageSummary>;

export const MarkupSummary = z.object({
  added: z.array(Id),
  moved: z.array(Id),
  retyped: z.array(Id),
  reordered: z.boolean(),
  deleted: z.array(Id),
  restored: z.array(Id),
  clean_changed: z.boolean(),
  notes_changed: z.boolean(),
  thumb_changed: z.boolean(),
});
export type MarkupSummary = z.infer<typeof MarkupSummary>;

export const MarkupRevisionDTO = z.object({
  rev: z.number().int(),
  at: IsoDateTime,
  user_id: Id.nullable(),
  user_name: z.string().nullable(),
  summary: MarkupSummary,
});
export type MarkupRevisionDTO = z.infer<typeof MarkupRevisionDTO>;

export const EXPORT_STATUSES = ['queued', 'running', 'done', 'failed', 'expired'] as const;
export const ExportState = z.enum(EXPORT_STATUSES);

export const ExportParams = z.object({
  only_ready: z.boolean(),
  page_ids: z.array(Id).nullable(),
  layers: ExportLayers,
});
export type ExportParams = z.infer<typeof ExportParams>;

export const EXPORT_PAGE_ERROR_CODES = ['PSD_TOO_LARGE', 'DECODE_FAILED', 'GENERATION_FAILED', 'BLOB_MISSING'] as const;

export const ExportPageError = z.object({ page_id: Id, code: z.string(), message: z.string() });
export type ExportPageError = z.infer<typeof ExportPageError>;

export const ExportDTO = z.object({
  id: Id,
  chapter_id: Id,
  status: ExportState,
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
  params: ExportParams,
  created_by: Id,
  created_at: IsoDateTime,
  finished_at: IsoDateTime.nullable(),
  expires_at: IsoDateTime.nullable(),
  size_bytes: z.number().int().nullable(),
  errors: z.array(ExportPageError),
});
export type ExportDTO = z.infer<typeof ExportDTO>;

export const STALE_REASONS = ['clean', 'notes', 'markup', 'translation', 'settings'] as const;
export const StaleReason = z.enum(STALE_REASONS);
export type StaleReason = z.infer<typeof StaleReason>;

export const ExportStatus = z.object({
  latest_export_id: Id.nullable(),
  finished_at: IsoDateTime.nullable(),
  pages: z.array(
    z.object({
      page_id: Id,
      idx: z.number().int(),
      state: z.enum(['fresh', 'stale', 'not_exported']),
      stale_reasons: z.array(StaleReason).optional(),
    }),
  ),
});
export type ExportStatus = z.infer<typeof ExportStatus>;

export const SKIP_PAGE_REASONS = ['not_ready', 'no_clean', 'no_layers'] as const;

/** `manifest.json` inside the export zip (docs/04-psd.md §4). */
export const ManifestPage = z.object({
  page_id: Id,
  idx: z.number().int(),
  file: z.string(),
  psd_input_hash: Sha256,
  markup_rev: z.number().int(),
  raw_hash: Sha256,
  clean_hash: Sha256.nullable(),
  notes_hash: Sha256.nullable(),
  /** Hash components, used to explain why a page became stale. */
  parts: z.object({
    clean: Sha256,
    notes: Sha256,
    markup: Sha256,
    translation: Sha256,
    settings: Sha256,
  }),
});
export type ManifestPage = z.infer<typeof ManifestPage>;

export const Manifest = z.object({
  format: z.literal(1),
  export_id: Id,
  created_at: IsoDateTime,
  created_by: z.object({ id: Id, login: z.string() }),
  project: z.object({ id: Id, title: z.string() }),
  chapter: z.object({ id: Id, number: z.string(), title: z.string().nullable() }),
  params: ExportParams,
  generator: z.object({ name: z.string(), version: z.string() }),
  pages: z.array(ManifestPage),
  skipped_pages: z.array(z.object({ page_id: Id, idx: z.number().int(), reason: z.string() })),
});
export type Manifest = z.infer<typeof Manifest>;
