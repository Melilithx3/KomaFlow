-- Box rotation in whole degrees around the box centre (ADR 0011). Existing boxes are not rotated.
ALTER TABLE objects ADD COLUMN rot INTEGER NOT NULL DEFAULT 0 CHECK (rot BETWEEN -180 AND 180);
