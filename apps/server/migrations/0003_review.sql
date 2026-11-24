-- Editorial review (ADR 0021): typed page images uploaded from the web, review marks and comments per page.
-- Marks are separate transparent images: never part of the clean, the typed page or the PSD.
ALTER TABLE pages ADD COLUMN typed_hash TEXT REFERENCES blobs(hash);

CREATE TABLE page_reviews (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('clean', 'type')),
  marks_hash TEXT REFERENCES blobs(hash),
  comment TEXT NOT NULL DEFAULT '',
  ver INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT REFERENCES users(id),
  PRIMARY KEY (page_id, kind)
);
