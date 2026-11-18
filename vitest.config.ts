import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'threads',
    maxWorkers: 2,
    include: ['test/{unit,integration,e2e}/**/*.test.ts'],
    globalSetup: ['./test/support/test-environment.ts'],
    setupFiles: ['./test/support/vitest-setup.ts'],
  },
});
