// Bundles the server and the admin CLI. Workspace packages (TS sources) are inlined;
// npm dependencies stay external and are installed with `pnpm install --prod`.
import { build } from 'esbuild';

const externalNpm = {
  name: 'external-npm',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@komaflow/') || args.path.startsWith('node:')) return undefined;
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: { server: 'src/main.ts', admin: 'src/admin.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  plugins: [externalNpm],
  logLevel: 'info',
});
