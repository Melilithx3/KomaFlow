import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, type WriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Zip, ZipPassThrough, strToU8 } from 'fflate';
import {
  ApiError,
  DEFAULT_EXPORT_LAYERS,
  Manifest,
  psdHashParts,
  psdInputHash,
  staleReasons,
  uuidv7,
  type CreateExportRequest,
  type ExportDTO,
  type ExportLayers,
  type ExportPageError,
  type ExportParams,
  type ExportStatus,
  type ManifestPage,
  type PsdHashInput,
  type PsdSettings,
} from '@komaflow/contract';
import { GENERATOR, PsdError, generatePsd, psdFileName, selectPages, validateExportLayers, type ImageCodec } from '@komaflow/psd';
import { iso, type Ctx } from '../context.js';
import { blobPath } from './blobs.js';
import { getChapterRow, getProjectRow, pageSummaries } from './catalog.js';
import { objBox, objTextBox, parseSettings, type ObjectRow, type PageRow } from './rows.js';
import type { UserRow } from './users.js';

interface ExportRow {
  id: string;
  chapter_id: string;
  user_id: string;
  params_json: string;
  status: ExportDTO['status'];
  done_pages: number;
  total_pages: number;
  file_path: string | null;
  size_bytes: number | null;
  manifest_json: string | null;
  errors_json: string | null;
  created_at: string;
  finished_at: string | null;
  expires_at: string | null;
}

export const exportDTO = (r: ExportRow): ExportDTO => ({
  id: r.id,
  chapter_id: r.chapter_id,
  status: r.status,
  progress: { done: r.done_pages, total: r.total_pages },
  params: JSON.parse(r.params_json) as ExportParams,
  created_by: r.user_id,
  created_at: r.created_at,
  finished_at: r.finished_at,
  expires_at: r.expires_at,
  size_bytes: r.size_bytes,
  errors: r.errors_json ? (JSON.parse(r.errors_json) as ExportPageError[]) : [],
});

function getExportRow(ctx: Ctx, id: string): ExportRow {
  const r = ctx.db.get<ExportRow>('SELECT * FROM exports WHERE id = ?', id);
  if (!r) throw new ApiError('NOT_FOUND', 'export not found');
  return r;
}

export function resolveParams(req: CreateExportRequest): ExportParams {
  const layers: ExportLayers = { ...DEFAULT_EXPORT_LAYERS, ...req.layers };
  const err = validateExportLayers(layers);
  if (err) throw new ApiError('VALIDATION_ERROR', err, { issues: [{ path: 'layers', message: err }] });
  return { only_ready: req.only_ready ?? true, page_ids: req.page_ids ?? null, layers };
}

function selection(ctx: Ctx, chapterId: string, userId: string, params: ExportParams) {
  const summaries = pageSummaries(ctx, chapterId, userId);
  const rows = new Map(
    ctx.db.all<PageRow>('SELECT * FROM pages WHERE chapter_id = ?', chapterId).map((p) => [p.id, p]),
  );
  const pages = summaries.map((s) => {
    const r = rows.get(s.id)!;
    return { ...r, ready_for_typing: s.ready_for_typing };
  });
  return selectPages(pages, params);
}

export function createExport(ctx: Ctx, chapterId: string, userId: string, req: CreateExportRequest): ExportDTO {
  const params = resolveParams(req);
  return ctx.db.tx(() => {
    getChapterRow(ctx, chapterId);
    if (params.page_ids) {
      const known = new Set(
        ctx.db.all<{ id: string }>('SELECT id FROM pages WHERE chapter_id = ?', chapterId).map((r) => r.id),
      );
      const foreign = params.page_ids.filter((id) => !known.has(id));
      if (foreign.length) throw new ApiError('VALIDATION_ERROR', 'page_ids contain pages of another chapter', { page_ids: foreign });
    }
    const sel = selection(ctx, chapterId, userId, params);
    if (sel.pages.length === 0) {
      throw new ApiError('EXPORT_NOT_READY', 'no pages match the export parameters', {
        skipped_pages: sel.skipped.map((s) => ({ page_id: s.page.id, idx: s.page.idx, reason: s.reason })),
      });
    }
    const row: ExportRow = {
      id: uuidv7(),
      chapter_id: chapterId,
      user_id: userId,
      params_json: JSON.stringify(params),
      status: 'queued',
      done_pages: 0,
      total_pages: sel.pages.length,
      file_path: null,
      size_bytes: null,
      manifest_json: null,
      errors_json: null,
      created_at: iso(ctx.now()),
      finished_at: null,
      expires_at: null,
    };
    ctx.db.run(
      `INSERT INTO exports (id, chapter_id, user_id, params_json, status, total_pages, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      row.id,
      row.chapter_id,
      row.user_id,
      row.params_json,
      row.total_pages,
      row.created_at,
    );
    return exportDTO(row);
  });
}

export function getExport(ctx: Ctx, id: string): { export: ExportDTO; manifest: Manifest | null } {
  const r = getExportRow(ctx, id);
  return { export: exportDTO(r), manifest: r.manifest_json ? Manifest.parse(JSON.parse(r.manifest_json)) : null };
}

export function listExports(ctx: Ctx, chapterId: string): ExportDTO[] {
  getChapterRow(ctx, chapterId);
  return ctx.db
    .all<ExportRow>('SELECT * FROM exports WHERE chapter_id = ? ORDER BY created_at DESC, id DESC LIMIT 20', chapterId)
    .map(exportDTO);
}

export function openExportFile(ctx: Ctx, id: string): { stream: Readable; size: number; name: string } {
  const r = getExportRow(ctx, id);
  if (r.status === 'expired') throw new ApiError('GONE', 'export file was removed after its expiry');
  if (r.status !== 'done' || !r.file_path) throw new ApiError('EXPORT_NOT_READY', 'export is not finished');
  if (!existsSync(r.file_path)) throw new ApiError('GONE', 'export file is gone');
  const ch = getChapterRow(ctx, r.chapter_id);
  const pr = getProjectRow(ctx, ch.project_id);
  return { stream: createReadStream(r.file_path), size: statSync(r.file_path).size, name: `${pr.title} - ${ch.number}.zip` };
}

// ---------------------------------------------------------------- hashing

function hashInput(ctx: Ctx, page: PageRow, layers: ExportLayers, settings: PsdSettings): PsdHashInput {
  const objs = ctx.db.all<ObjectRow>('SELECT * FROM objects WHERE page_id = ? AND deleted = 0 ORDER BY ord', page.id);
  return {
    raw_hash: page.raw_hash,
    clean_hash: page.clean_hash,
    notes_hash: page.notes_hash,
    width: page.width,
    height: page.height,
    psd_settings: settings,
    layers,
    objects: objs.map((o) => ({
      id: o.id,
      type: o.type,
      box: objBox(o),
      text_box: objTextBox(o),
      order: o.ord,
      translation: o.translation,
      state: o.state,
    })),
  };
}

/** GET /chapters/{id}/export-status: freshness by psd_input_hash of the latest finished export. */
export function exportStatus(ctx: Ctx, chapterId: string): ExportStatus {
  const ch = getChapterRow(ctx, chapterId);
  const settings = parseSettings(getProjectRow(ctx, ch.project_id).settings_json).psd;
  const latest = ctx.db.get<ExportRow>(
    `SELECT * FROM exports WHERE chapter_id = ? AND status IN ('done', 'expired') AND manifest_json IS NOT NULL
      ORDER BY finished_at DESC, id DESC LIMIT 1`,
    chapterId,
  );
  const pages = ctx.db.all<PageRow>('SELECT * FROM pages WHERE chapter_id = ? ORDER BY idx', chapterId);
  if (!latest) {
    return { latest_export_id: null, finished_at: null, pages: pages.map((p) => ({ page_id: p.id, idx: p.idx, state: 'not_exported' })) };
  }
  const manifest = Manifest.parse(JSON.parse(latest.manifest_json!));
  const byId = new Map(manifest.pages.map((m) => [m.page_id, m]));
  const layers = manifest.params.layers;
  return {
    latest_export_id: latest.id,
    finished_at: latest.finished_at,
    pages: pages.map((p) => {
      const m = byId.get(p.id);
      if (!m) return { page_id: p.id, idx: p.idx, state: 'not_exported' as const };
      const input = hashInput(ctx, p, layers, settings);
      if (psdInputHash(input) === m.psd_input_hash) return { page_id: p.id, idx: p.idx, state: 'fresh' as const };
      const reasons = staleReasons(m.parts, psdHashParts(input));
      return { page_id: p.id, idx: p.idx, state: 'stale' as const, stale_reasons: reasons };
    }),
  };
}

// ---------------------------------------------------------------- worker

/**
 * In-process export queue: one job at a time, one page at a time, zip streamed to disk
 * (docs/04-psd.md §4). Jobs survive restarts: `running` ones are re-queued at start.
 */
export class ExportWorker {
  private busy: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly codec: ImageCodec,
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
  ) {
    ctx.db.run("UPDATE exports SET status = 'queued', done_pages = 0 WHERE status = 'running'");
  }

  /** Starts processing if idle. Returns the promise of the current drain loop. */
  kick(): Promise<void> {
    if (!this.busy && !this.stopped) {
      this.busy = this.drain().finally(() => {
        this.busy = null;
      });
    }
    return this.busy ?? Promise.resolve();
  }

  /** Resolves when the queue is empty (tests). */
  async idle(): Promise<void> {
    while (this.busy) await this.busy;
  }

  stop(): void {
    this.stopped = true;
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const job = this.ctx.db.get<ExportRow>("SELECT * FROM exports WHERE status = 'queued' ORDER BY created_at, id LIMIT 1");
      if (!job) return;
      try {
        await this.run(job);
      } catch (e) {
        this.log('export failed', { export_id: job.id, error: e instanceof Error ? e.message : String(e) });
        this.ctx.db.run(
          "UPDATE exports SET status = 'failed', finished_at = ?, errors_json = ? WHERE id = ?",
          iso(this.ctx.now()),
          JSON.stringify([{ page_id: job.chapter_id, code: 'GENERATION_FAILED', message: e instanceof Error ? e.message : String(e) }]),
          job.id,
        );
      }
    }
  }

  private async run(job: ExportRow): Promise<void> {
    const { ctx } = this;
    const started = performance.now();
    const params = JSON.parse(job.params_json) as ExportParams;
    const ch = getChapterRow(ctx, job.chapter_id);
    const project = getProjectRow(ctx, ch.project_id);
    const settings = parseSettings(project.settings_json).psd;
    const user = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', job.user_id);
    const sel = selection(ctx, job.chapter_id, job.user_id, params);
    ctx.db.run("UPDATE exports SET status = 'running', total_pages = ?, done_pages = 0 WHERE id = ?", sel.pages.length, job.id);

    mkdirSync(ctx.cfg.exportDir, { recursive: true });
    const finalPath = join(ctx.cfg.exportDir, `${job.id}.zip`);
    const partPath = `${finalPath}.part`;
    const file = createWriteStream(partPath);
    const zip = new ZipWriter(file);

    const manifestPages: ManifestPage[] = [];
    const errors: ExportPageError[] = [];
    let peakRss = 0;
    try {
      let done = 0;
      for (const page of sel.pages) {
        const t = performance.now();
        try {
          const read = async (h: string | null, want: boolean) =>
            want && h ? new Uint8Array(await readFile(blobPath(ctx, h))) : undefined;
          const psd = await generatePsd(
            {
              page: { index: page.idx, width: page.width, height: page.height },
              raw: await read(page.raw_hash, params.layers.raw),
              clean: await read(page.clean_hash, params.layers.clean),
              notes: await read(page.notes_hash, params.layers.notes),
              layers: params.layers,
              settings,
            },
            this.codec,
          );
          const name = psdFileName(page.idx);
          await zip.add(`${ch.number}/${name}`, psd);
          const input = hashInput(ctx, page, params.layers, settings);
          manifestPages.push({
            page_id: page.id,
            idx: page.idx,
            file: name,
            psd_input_hash: psdInputHash(input),
            markup_rev: page.markup_rev,
            raw_hash: page.raw_hash,
            clean_hash: page.clean_hash,
            notes_hash: page.notes_hash,
            parts: psdHashParts(input),
          });
        } catch (e) {
          const code = e instanceof PsdError ? e.code : (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'BLOB_MISSING' : 'GENERATION_FAILED';
          errors.push({ page_id: page.id, code, message: e instanceof Error ? e.message : String(e) });
        }
        done++;
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        ctx.db.run('UPDATE exports SET done_pages = ? WHERE id = ?', done, job.id);
        this.log('export page', { export_id: job.id, idx: page.idx, ms: Math.round(performance.now() - t) });
      }

      const finished = ctx.now();
      const manifest: Manifest = {
        format: 1,
        export_id: job.id,
        created_at: job.created_at,
        created_by: { id: job.user_id, login: user?.login ?? '' },
        project: { id: project.id, title: project.title },
        chapter: { id: ch.id, number: ch.number, title: ch.title },
        params,
        generator: { name: GENERATOR.name, version: GENERATOR.version },
        pages: manifestPages,
        skipped_pages: sel.skipped.map((s) => ({ page_id: s.page.id, idx: s.page.idx, reason: s.reason })),
      };
      await zip.add('manifest.json', strToU8(JSON.stringify(manifest, null, 2)));
      if (errors.length) await zip.add('errors.json', strToU8(JSON.stringify(errors, null, 2)));
      await zip.end();

      if (manifestPages.length === 0) {
        rmSync(partPath, { force: true });
        ctx.db.run(
          "UPDATE exports SET status = 'failed', finished_at = ?, errors_json = ? WHERE id = ?",
          iso(finished),
          JSON.stringify(errors),
          job.id,
        );
        return;
      }
      renameSync(partPath, finalPath);
      const expires = new Date(finished.getTime() + ctx.cfg.exportTtlDays * 86_400_000);
      ctx.db.run(
        `UPDATE exports SET status = 'done', finished_at = ?, expires_at = ?, file_path = ?, size_bytes = ?,
                manifest_json = ?, errors_json = ? WHERE id = ?`,
        iso(finished),
        iso(expires),
        finalPath,
        statSync(finalPath).size,
        JSON.stringify(manifest),
        JSON.stringify(errors),
        job.id,
      );
      this.log('export done', {
        export_id: job.id,
        pages: manifestPages.length,
        errors: errors.length,
        ms_per_page: Math.round((performance.now() - started) / Math.max(1, sel.pages.length)),
        peak_rss_mb: Math.round(peakRss / 1024 / 1024),
      });
    } catch (e) {
      zip.abort();
      rmSync(partPath, { force: true });
      throw e;
    }
  }
}

/** Streams a zip into a file with back-pressure; PSDs are stored (not deflated) to spare the Pi's CPU. */
class ZipWriter {
  private readonly zip: Zip;
  private error: Error | null = null;
  private ended: Promise<void>;
  constructor(private readonly out: WriteStream) {
    let resolveEnd!: () => void;
    let rejectEnd!: (e: Error) => void;
    this.ended = new Promise((res, rej) => {
      resolveEnd = res;
      rejectEnd = rej;
    });
    out.on('error', (e) => {
      this.error = e;
      rejectEnd(e);
    });
    out.on('finish', () => resolveEnd());
    this.zip = new Zip((err, chunk, final) => {
      if (err) {
        this.error = err;
        out.destroy(err);
        return;
      }
      out.write(chunk);
      if (final) out.end();
    });
  }

  async add(name: string, data: Uint8Array): Promise<void> {
    if (this.error) throw this.error;
    const entry = new ZipPassThrough(name);
    this.zip.add(entry);
    entry.push(data, true);
    if (this.out.writableNeedDrain) await new Promise<void>((r) => this.out.once('drain', () => r()));
    if (this.error) throw this.error;
  }

  async end(): Promise<void> {
    this.zip.end();
    await this.ended;
    if (this.error) throw this.error;
  }

  abort(): void {
    this.zip.terminate();
    this.out.destroy();
  }
}

/** Removes zip files of expired exports and marks them `expired` (docs/03-server-ops.md §5). */
export function expireExports(ctx: Ctx): number {
  const now = iso(ctx.now());
  const rows = ctx.db.all<ExportRow>("SELECT * FROM exports WHERE status = 'done' AND expires_at <= ?", now);
  for (const r of rows) {
    if (r.file_path) rmSync(r.file_path, { force: true });
    ctx.db.run("UPDATE exports SET status = 'expired', file_path = NULL WHERE id = ?", r.id);
  }
  return rows.length;
}
