import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'threads',
    maxWorkers: 2,
    globalSetup: ['./test/support/build-workers.ts'],
    setupFiles: ['./test/support/vitest-setup.ts'],
  },
});
