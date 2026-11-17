import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'page-view', include: ['test/**/*.test.ts'] },
});
