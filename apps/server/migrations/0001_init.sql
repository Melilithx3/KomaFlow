-- Initial schema (docs/01-data-model.md §2).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  client TEXT NOT NULL CHECK (client IN ('web', 'desktop')),
  device_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  reading_direction TEXT NOT NULL DEFAULT 'rtl' CHECK (reading_direction IN ('rtl', 'ltr')),
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  number TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, number)
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id),
  idx INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  raw_hash TEXT NOT NULL,
  clean_hash TEXT,
  notes_hash TEXT,
  thumb_hash TEXT,
  markup_rev INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  typed_by TEXT REFERENCES users(id),
  typed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (chapter_id, idx)
);

CREATE TABLE objects (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  type TEXT NOT NULL CHECK (type IN ('bubble', 'sfx', 'onomatopoeia', 'text')),
  x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL,
  tx INTEGER, ty INTEGER, tw INTEGER, th INTEGER,
  ord INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  geometry_ver INTEGER NOT NULL DEFAULT 1,
  source_text TEXT NOT NULL DEFAULT '',
  translation TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'empty' CHECK (state IN ('empty', 'translated', 'skipped', 'unreadable')),
  comment TEXT NOT NULL DEFAULT '',
  flagged INTEGER NOT NULL DEFAULT 0,
  text_ver INTEGER NOT NULL DEFAULT 0,
  field_vers TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  CHECK ((tx IS NULL AND ty IS NULL AND tw IS NULL AND th IS NULL)
      OR (tx IS NOT NULL AND ty IS NOT NULL AND tw IS NOT NULL AND th IS NOT NULL))
);
CREATE INDEX objects_page ON objects(page_id, deleted, ord);

CREATE TABLE text_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  user_id TEXT,
  at TEXT NOT NULL,
  text_ver INTEGER NOT NULL
);
CREATE INDEX text_history_object ON text_history(object_id);

CREATE TABLE markup_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  user_id TEXT,
  at TEXT NOT NULL,
  summary_json TEXT NOT NULL
);
CREATE INDEX markup_revisions_page ON markup_revisions(page_id, rev);

CREATE TABLE page_seen (
  user_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  markup_rev INTEGER NOT NULL,
  PRIMARY KEY (user_id, page_id)
);

CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'expired')),
  done_pages INTEGER NOT NULL DEFAULT 0,
  total_pages INTEGER NOT NULL DEFAULT 0,
  file_path TEXT,
  size_bytes INTEGER,
  manifest_json TEXT,
  errors_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  expires_at TEXT
);
CREATE INDEX exports_chapter ON exports(chapter_id, created_at);
CREATE INDEX exports_status ON exports(status, created_at);
