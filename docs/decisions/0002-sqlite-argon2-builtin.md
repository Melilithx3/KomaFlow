# 0002. SQLite driver and password hashing without native modules (preliminary, confirm in S3)

**Context.** Server must install on Orange Pi (linux-arm64) without a compiler. Candidates: `better-sqlite3` vs `node:sqlite`; `argon2` (native) vs WASM.

**Decision.** Use built-in `node:sqlite` (`DatabaseSync`, has `backup()`) and built-in `crypto.argon2` (argon2id, Node >= 24.7, OpenSSL 3.2+). Both hidden behind thin modules (`db/driver.ts`, `auth/password.ts`). Hashes stored in PHC string format so parameters can change later. Defaults m=64 MiB, t=3, p=1, configurable via env; S3 tunes them for 0.3–0.5 s on the Pi.

**Consequences.** Zero native deps for DB and auth. Requires official Node builds (bundled OpenSSL). If S3 shows problems, swap the driver module only.
