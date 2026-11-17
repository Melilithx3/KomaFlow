import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'desktop', include: ['test/**/*.test.{ts,tsx}'], environment: 'node', testTimeout: 60_000, pool: 'forks' },
});
