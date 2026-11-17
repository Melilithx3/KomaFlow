import type { Box, ObjectType, ReadingDirection } from '@komaflow/contract';

/** A file attached to a page: absolute path on disk (or a host-specific handle) + content hash. */
export interface FileRef {
  path: string;
  hash: string;
  width: number;
  height: number;
  mime: string;
}

export interface LocalObject {
  id: string;
  type: ObjectType;
  box: Box;
  text_box: Box | null;
  /** Degrees around the box centre, clockwise (ADR 0011). Missing in old workspaces = 0. */
  rotation?: number;
  source_text: string;
  /** source_text on the server as last seen by this desktop (base for sync, ADR 0013); undefined = never synced. */
  server_source?: string;
  /** 'auto' — from analysis; 'manual' — drawn by hand (docs/05 §3). */
  origin: 'auto' | 'manual';
  /** An auto object the user changed: re-analysis keeps it. */
  touched: boolean;
  /** Read-only data from the web (docs/05 §4.5). */
  web?: { flagged: boolean; comment: string; translation: string; state: string } | undefined;
  score?: number | undefined;
}

export interface LocalPage {
  id: string;
  idx: number;
  width: number;
  height: number;
  raw: FileRef;
  clean: FileRef | null;
  notes: FileRef | null;
  thumb: FileRef | null;
  /** Objects in reading order. */
  objects: LocalObject[];
  analyzed: boolean;
  /** markup_rev on the server after the last publish/download; null = never published. */
  server_markup_rev: number | null;
  /** Hash of the markup as last published, to show «изменена после публикации». */
  published_digest: string | null;
}

export interface Workspace {
  format: 1;
  /** Local id of the workspace (= server chapter id once linked). */
  id: string;
  title: string;
  server: { url: string; project_id: string; chapter_id: string; chapter_number: string } | null;
  reading_direction: ReadingDirection;
  pages: LocalPage[];
}

export const OBJECT_TYPE_KEYS: Record<string, ObjectType> = { '1': 'bubble', '2': 'sfx', '3': 'onomatopoeia', '4': 'text' };
