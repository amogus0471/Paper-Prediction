import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@ghostfill/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@ghostfill/venues': fileURLToPath(
        new URL('../../packages/venues/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 180000,
  },
});
