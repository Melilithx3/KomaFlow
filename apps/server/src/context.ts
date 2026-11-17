import type { Config } from './config.js';
import type { Db } from './db/driver.js';

export interface Ctx {
  db: Db;
  cfg: Config;
  /** Injectable clock (tests move time forward). */
  now: () => Date;
}

export const iso = (d: Date) => d.toISOString();
