import { defineConfig } from 'vitest/config';

// Only the pure logic modules are unit-tested in CI (node env); the React Native UI (App.tsx,
// screens) has no device/emulator here and is typecheck-verified only.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
