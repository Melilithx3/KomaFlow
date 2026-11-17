import {
  ProjectSettings,
  type Box,
  type ChapterDTO,
  type ObjectDTO,
  type ObjectType,
  type PageDTO,
  type ProjectDTO,
  type ReadingDirection,
  type TranslationState,
} from '@komaflow/contract';

export interface ProjectRow {
  id: string;
  title: string;
  source_lang: string;
  target_lang: string;
  reading_direction: ReadingDirection;
  settings_json: string;
  created_at: string;
}

export interface ChapterRow {
  id: string;
  project_id: string;
  number: string;
  title: string | null;
  created_at: string;
}

export interface PageRow {
  id: string;
  chapter_id: string;
  idx: number;
  width: number;
  height: number;
  raw_hash: string;
  clean_hash: string | null;
  notes_hash: string | null;
  thumb_hash: string | null;
  markup_rev: number;
  rev: number;
  typed_by: string | null;
  typed_at: string | null;
  created_at: string;
}

export interface ObjectRow {
  id: string;
  page_id: string;
  type: ObjectType;
  x: number;
  y: number;
  w: number;
  h: number;
  tx: number | null;
  ty: number | null;
  tw: number | null;
  th: number | null;
  ord: number;
  deleted: number;
  geometry_ver: number;
  source_text: string;
  translation: string;
  state: TranslationState;
  comment: string;
  flagged: number;
  text_ver: number;
  field_vers: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

export function parseSettings(json: string): ProjectSettings {
  return ProjectSettings.parse(JSON.parse(json));
}

export const projectDTO = (r: ProjectRow): ProjectDTO => ({
  id: r.id,
  title: r.title,
  source_lang: r.source_lang,
  target_lang: r.target_lang,
  reading_direction: r.reading_direction,
  settings: parseSettings(r.settings_json),
  created_at: r.created_at,
});

export const chapterDTO = (r: ChapterRow): ChapterDTO => ({
  id: r.id,
  project_id: r.project_id,
  number: r.number,
  title: r.title,
  created_at: r.created_at,
});

export const pageDTO = (r: PageRow): PageDTO => ({
  id: r.id,
  chapter_id: r.chapter_id,
  idx: r.idx,
  width: r.width,
  height: r.height,
  raw_hash: r.raw_hash,
  clean_hash: r.clean_hash,
  notes_hash: r.notes_hash,
  thumb_hash: r.thumb_hash,
  markup_rev: r.markup_rev,
  rev: r.rev,
  typed: r.typed_at !== null,
  typed_by: r.typed_by,
  typed_at: r.typed_at,
});

export const objBox = (r: ObjectRow): Box => ({ x: r.x, y: r.y, w: r.w, h: r.h });
export const objTextBox = (r: ObjectRow): Box | null =>
  r.tx === null || r.ty === null || r.tw === null || r.th === null ? null : { x: r.tx, y: r.ty, w: r.tw, h: r.th };

export const objectDTO = (r: ObjectRow): ObjectDTO => ({
  id: r.id,
  page_id: r.page_id,
  order: r.ord,
  type: r.type,
  box: objBox(r),
  text_box: objTextBox(r),
  geometry_ver: r.geometry_ver,
  source_text: r.source_text,
  translation: r.translation,
  state: r.state,
  comment: r.comment,
  flagged: r.flagged === 1,
  text_ver: r.text_ver,
  field_vers: JSON.parse(r.field_vers) as Record<string, number>,
  updated_at: r.updated_at,
  updated_by: r.updated_by,
});
