import { defaultExclude, defineConfig } from 'vitest/config';

/**
 * Default unit/HTTP test run (`pnpm test`). Integration tests (`*.int.test.ts`) need a live
 * MySQL and run separately via `pnpm test:int` (see vitest.int.config.ts), so they are excluded
 * here — the default suite stays DB-free and runnable anywhere.
 */
export default defineConfig({
  test: {
    exclude: [...defaultExclude, '**/*.int.test.ts'],
  },
});
