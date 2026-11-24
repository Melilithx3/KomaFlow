import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ALLOWED_MIME, ApiError, MAX_SIDE_PX, readImageHeader, uuidv7, type ImageMime } from '@komaflow/contract';
import { iso, type Ctx } from '../context.js';

export interface BlobRow {
  hash: string;
  size: number;
  mime: string;
  width: number | null;
  height: number | null;
  created_at: string;
}

/** data/blobs/ab/cd/<sha256> (docs/01-data-model.md §6). */
export function blobPath(ctx: Ctx, hash: string): string {
  return join(ctx.cfg.blobDir, hash.slice(0, 2), hash.slice(2, 4), hash);
}

export function getBlob(ctx: Ctx, hash: string): BlobRow | undefined {
  return ctx.db.get<BlobRow>('SELECT * FROM blobs WHERE hash = ?', hash);
}

export function missingBlobs(ctx: Ctx, hashes: readonly string[]): string[] {
  const uniq = [...new Set(hashes)];
  return uniq.filter((h) => !getBlob(ctx, h) || !existsSync(blobPath(ctx, h)));
}

/** First bytes are kept to read the image header (JPEG SOF can be far from the start). */
const HEADER_BYTES = 512 * 1024;

/**
 * Streams the body to tmp while hashing it, validates hash, signature and dimensions, then renames
 * atomically into place (docs/02-api.md §4). Idempotent.
 */
export async function putBlob(
  ctx: Ctx,
  hash: string,
  contentType: string | undefined,
  body: Readable,
): Promise<{ row: BlobRow; created: boolean }> {
  const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(ALLOWED_MIME as readonly string[]).includes(mime)) {
    body.resume();
    throw new ApiError('UNSUPPORTED_MEDIA', 'only image/png, image/jpeg, image/webp are allowed');
  }
  const existing = getBlob(ctx, hash);
  if (existing && existsSync(blobPath(ctx, hash))) {
    body.resume();
    return { row: existing, created: false };
  }

  mkdirSync(ctx.cfg.tmpDir, { recursive: true });
  const tmp = join(ctx.cfg.tmpDir, `${uuidv7()}.part`);
  const sha = createHash('sha256');
  const head: Buffer[] = [];
  let headLen = 0;
  let size = 0;
  const max = ctx.cfg.maxBlobBytes;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > max) {
        cb(new ApiError('PAYLOAD_TOO_LARGE', `file exceeds ${Math.round(max / 1024 / 1024)} MB`));
        return;
      }
      sha.update(chunk);
      if (headLen < HEADER_BYTES) {
        head.push(chunk);
        headLen += chunk.length;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(body, meter, createWriteStream(tmp));
    const actual = sha.digest('hex');
    if (actual !== hash) throw new ApiError('HASH_MISMATCH', 'body sha256 does not match the path', { actual });
    const header = readImageHeader(new Uint8Array(Buffer.concat(head)));
    if (!header) throw new ApiError('UNSUPPORTED_MEDIA', 'file is not a valid PNG, JPEG or WebP');
    if (header.mime !== (mime as ImageMime)) {
      throw new ApiError('UNSUPPORTED_MEDIA', `content is ${header.mime}, Content-Type says ${mime}`);
    }
    if (header.width < 1 || header.height < 1 || header.width > MAX_SIDE_PX || header.height > MAX_SIDE_PX) {
      throw new ApiError('PAYLOAD_TOO_LARGE', `image side must be 1..${MAX_SIDE_PX} px`, { ...header });
    }
    if (header.width * header.height > ctx.cfg.maxPixels) {
      throw new ApiError('PAYLOAD_TOO_LARGE', `image exceeds ${ctx.cfg.maxPixels} pixels`, { ...header });
    }
    const dest = blobPath(ctx, hash);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(tmp, dest);
    const row: BlobRow = { hash, size, mime: header.mime, width: header.width, height: header.height, created_at: iso(ctx.now()) };
    ctx.db.run(
      `INSERT INTO blobs (hash, size, mime, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (hash) DO NOTHING`,
      row.hash,
      row.size,
      row.mime,
      row.width,
      row.height,
      row.created_at,
    );
    return { row: getBlob(ctx, hash) ?? row, created: true };
  } catch (e) {
    rmSync(tmp, { force: true });
    if (!body.readableEnded) body.resume();
    throw e;
  }
}

export function openBlob(ctx: Ctx, hash: string): { row: BlobRow; stream: Readable; size: number } {
  const row = getBlob(ctx, hash);
  const path = blobPath(ctx, hash);
  if (!row || !existsSync(path)) throw new ApiError('NOT_FOUND', 'blob not found');
  return { row, stream: createReadStream(path), size: statSync(path).size };
}

/** Blobs not referenced by any page (for `komaflow-admin gc-blobs`). */
export function unreferencedBlobs(ctx: Ctx): BlobRow[] {
  return ctx.db.all<BlobRow>(
    `SELECT * FROM blobs b WHERE NOT EXISTS (
       SELECT 1 FROM pages p WHERE p.raw_hash = b.hash OR p.clean_hash = b.hash OR p.notes_hash = b.hash OR p.thumb_hash = b.hash OR p.typed_hash = b.hash)
       AND NOT EXISTS (SELECT 1 FROM page_reviews r WHERE r.marks_hash = b.hash)`,
  );
}

export function deleteBlob(ctx: Ctx, hash: string): void {
  rmSync(blobPath(ctx, hash), { force: true });
  ctx.db.run('DELETE FROM blobs WHERE hash = ?', hash);
}
