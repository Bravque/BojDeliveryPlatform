import { defineConfig } from 'vitest/config';

/**
 * Integration test run (`pnpm test:int`). Executes only `*.int.test.ts` against a real MySQL
 * (DATABASE_URL). Suites self-skip when DATABASE_URL is absent, so this is safe to run locally;
 * in CI the `integration` job provides the database. Files run serially (shared DB) with a
 * generous timeout.
 */
export default defineConfig({
  test: {
    include: ['**/*.int.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
