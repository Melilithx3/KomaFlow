# 0001. Tooling and package layout

**Context.** Spec fixes pnpm + TS strict. TypeScript 7.0 (native port) is latest, but typescript-eslint supports only TS < 6.1.

**Decision.**
- TypeScript ~6.0, ESLint 10 + typescript-eslint, Prettier, vitest 5 with root `projects`.
- Internal packages (`@komaflow/contract`, `@komaflow/psd`) are source-only: `exports` point to `src/*.ts`; apps bundle them (Vite for web/desktop, esbuild for the server). No per-package build step, no stale `dist`.
- Node >= 24.7 (needed for built-in `crypto.argon2`, see 0002). Dev machine runs Node 26.

**Consequences.** Upgrade to TS 7 when typescript-eslint supports it. Server deploy ships a bundled `dist/server.js` + `node_modules` only for externals.
