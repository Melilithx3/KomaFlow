import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  dataDir: string;
  dbPath: string;
  blobDir: string;
  tmpDir: string;
  exportDir: string;
  backupDir: string;
  webDir: string | null;
  migrationsDir: string;
  host: string;
  port: number;
  baseUrl: string | null;
  trustProxy: boolean;
  sessionDays: number;
  maxBlobBytes: number;
  maxPixels: number;
  exportTtlDays: number;
  logLevel: string;
  dev: boolean;
  /** Secure flag of the session cookie (off only for local http dev). */
  secureCookies: boolean;
  argon2: { memoryKiB: number; passes: number; parallelism: number };
}

type Env = Record<string, string | undefined>;

const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v: string | undefined, d: number) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid number in env: ${v}`);
  return n;
};

export function loadConfig(env: Env = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = resolve(env.KOMAFLOW_DATA_DIR ?? './data');
  const dev = bool(env.KOMAFLOW_DEV, env.NODE_ENV === 'development');
  const cfg: Config = {
    dataDir,
    dbPath: join(dataDir, 'db.sqlite'),
    blobDir: join(dataDir, 'blobs'),
    tmpDir: resolve(env.KOMAFLOW_TMP_DIR ?? join(dataDir, 'tmp')),
    exportDir: resolve(env.KOMAFLOW_EXPORT_DIR ?? join(dataDir, 'exports')),
    backupDir: join(dataDir, 'backups'),
    webDir: env.KOMAFLOW_WEB_DIR ? resolve(env.KOMAFLOW_WEB_DIR) : null,
    migrationsDir: resolve(env.KOMAFLOW_MIGRATIONS_DIR ?? defaultMigrationsDir()),
    host: env.KOMAFLOW_HOST ?? '127.0.0.1',
    port: int(env.KOMAFLOW_PORT, 8787),
    baseUrl: env.KOMAFLOW_BASE_URL ?? null,
    trustProxy: bool(env.KOMAFLOW_TRUST_PROXY, true),
    sessionDays: int(env.KOMAFLOW_SESSION_DAYS, 90),
    maxBlobBytes: int(env.KOMAFLOW_MAX_BLOB_MB, 128) * 1024 * 1024,
    maxPixels: int(env.KOMAFLOW_MAX_PIXELS, 200_000_000),
    exportTtlDays: int(env.KOMAFLOW_EXPORT_TTL_DAYS, 7),
    logLevel: env.KOMAFLOW_LOG_LEVEL ?? 'info',
    dev,
    secureCookies: bool(env.KOMAFLOW_SECURE_COOKIES, !dev),
    argon2: {
      memoryKiB: int(env.KOMAFLOW_ARGON2_MEMORY_KIB, 65536),
      passes: int(env.KOMAFLOW_ARGON2_PASSES, 3),
      parallelism: int(env.KOMAFLOW_ARGON2_PARALLELISM, 1),
    },
    ...overrides,
  };
  return cfg;
}

function defaultMigrationsDir(): string {
  // dist/server.js and src/config.ts both sit one level below the package root.
  return fileURLToPath(new URL('../migrations', import.meta.url));
}
