import { sha256Hex } from '../sha256.js';
import type { ChapterDTO, ObjectDTO, PageDetailResponse, ProjectDTO } from '../index.js';
import { fixtureSyncPage, makeFixtureChapter, type FixturePage } from './index.js';

/** Minimal HTTP abstraction so the seeder runs over `fetch` (tools) and `app.inject` (admin, tests). */
export interface SeedHttp {
  (req: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH';
    path: string;
    json?: unknown;
    bytes?: Uint8Array;
    contentType?: string;
  }): Promise<{ status: number; body: unknown }>;
}

export interface SeedOptions {
  projectTitle?: string;
  chapterNumber?: string;
  /** Also fill translations of page 1 via PATCH, as the web would. */
  translateFirstPage?: boolean;
  log?: (msg: string) => void;
}

export interface SeedResult {
  project: ProjectDTO;
  chapter: ChapterDTO;
  pages: FixturePage[];
}

function ok(r: { status: number; body: unknown }, what: string) {
  if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/**
 * Publishes the synthetic fixture chapter through the real API, exactly like the desktop does:
 * project → chapter → blobs/check → PUT missing → sync. Requires a desktop session.
 */
export async function seedFixtureChapter(http: SeedHttp, opts: SeedOptions = {}): Promise<SeedResult> {
  const log = opts.log ?? (() => {});
  const title = opts.projectTitle ?? 'Межвидовые рецензенты (демо)';
  const projects = ok(await http({ method: 'GET', path: '/projects' }), 'list projects') as { projects: ProjectDTO[] };
  let project = projects.projects.find((p) => p.title === title);
  if (!project) {
    project = (
      ok(
        await http({ method: 'POST', path: '/projects', json: { title, source_lang: 'ja', target_lang: 'ru', reading_direction: 'rtl' } }),
        'create project',
      ) as { project: ProjectDTO }
    ).project;
    log(`project created: ${project.title}`);
  }
  const chapter = (
    ok(
      await http({ method: 'POST', path: `/projects/${project.id}/chapters`, json: { number: opts.chapterNumber ?? '1', title: 'Демо-глава' } }),
      'create chapter',
    ) as { chapter: ChapterDTO }
  ).chapter;

  const pages = makeFixtureChapter();
  const files = new Map<string, Uint8Array>();
  for (const p of pages) for (const f of [p.raw, p.clean, p.notes]) if (f) files.set(sha256Hex(f), f);
  const { missing } = ok(await http({ method: 'POST', path: '/blobs/check', json: { hashes: [...files.keys()] } }), 'blobs/check') as {
    missing: string[];
  };
  for (const h of missing) {
    ok(await http({ method: 'PUT', path: `/blobs/${h}`, bytes: files.get(h)!, contentType: 'image/png' }), `upload ${h}`);
  }
  log(`uploaded ${missing.length} file(s)`);

  // base_markup_rev must match the server (re-running the seed is idempotent).
  const detail = ok(await http({ method: 'GET', path: `/chapters/${chapter.id}` }), 'chapter') as {
    pages: Array<{ id: string; markup_rev: number }>;
  };
  const revs = new Map(detail.pages.map((p) => [p.id, p.markup_rev]));
  ok(
    await http({
      method: 'POST',
      path: `/chapters/${chapter.id}/sync`,
      json: { pages: pages.map((p) => fixtureSyncPage(p, revs.get(p.id) ?? null)) },
    }),
    'sync',
  );
  log(`synced ${pages.length} page(s) into chapter ${chapter.number}`);

  if (opts.translateFirstPage) {
    const p1 = pages[0]!;
    const d = ok(await http({ method: 'GET', path: `/pages/${p1.id}` }), 'page') as PageDetailResponse;
    for (const o of d.objects as ObjectDTO[]) {
      const fx = p1.objects.find((x) => x.id === o.id);
      if (!fx || o.translation) continue;
      ok(await http({ method: 'PATCH', path: `/objects/${o.id}`, json: { base_text_ver: o.text_ver, changes: { translation: fx.translation } } }), 'patch');
    }
    log('page 1 translated');
  }
  return { project, chapter, pages };
}
