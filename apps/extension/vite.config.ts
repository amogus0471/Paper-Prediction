import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite builds the side panel only.
 *
 * The service worker and the content script are bundled separately by
 * build.mjs, because they have a constraint Vite's chunking cannot satisfy:
 * a content script is a CLASSIC script and may not contain an `import`
 * statement at all. Vite happily hoists shared code into a chunk and emits
 * `import { s as send } from "../../assets/…"`, which throws
 * "Cannot use import statement outside a module" the moment the page loads.
 * Those two entries must be single self-contained files, so esbuild builds
 * them directly.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@ghostfill/core': resolve(root, '../../packages/core/src/index.ts'),
      '@ghostfill/venues': resolve(root, '../../packages/venues/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    // Readable output makes a Web Store review, and your own debugging, easier.
    minify: false,
    modulePreload: false,
    rollupOptions: {
      input: { sidepanel: resolve(root, 'src/sidepanel/index.html') },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
