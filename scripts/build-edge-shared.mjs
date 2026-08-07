/**
 * Bundle packages/core + packages/venues into one Deno-compatible ESM file for
 * the Edge Functions.
 *
 * The alternative — reimplementing walkBook in the Edge runtime — is how a
 * simulator ends up quoting one price and filling another. There is exactly one
 * fill engine in this repo, it lives in packages/core, and it is property
 * tested. This script ships that same code to the server.
 *
 *   node scripts/build-edge-shared.mjs
 *
 * Output: supabase/functions/_shared/ghostfill.js  (generated, do not edit)
 */
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = resolve(root, 'supabase/functions/_shared/ghostfill.js');

const entry = `
export * from '${resolve(root, 'packages/core/src/index.ts').replace(/\\/g, '/')}';
export * from '${resolve(root, 'packages/venues/src/index.ts').replace(/\\/g, '/')}';
`;

await mkdir(dirname(outFile), { recursive: true });

const result = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
  legalComments: 'none',
  alias: {
    '@ghostfill/core': resolve(root, 'packages/core/src/index.ts'),
  },
});

const banner = `// GENERATED FILE — DO NOT EDIT.
// Built from packages/core + packages/venues by scripts/build-edge-shared.mjs.
// Regenerate with: npm run build:edge
`;

const code = banner + result.outputFiles[0].text;
await writeFile(outFile, code, 'utf8');

// A bundle that lost walkBook would fail silently at runtime rather than here,
// so assert the exports the Edge Functions actually depend on.
const required = [
  'walkBook',
  'checkBookInvariants',
  'depthNotional',
  'midPrice',
  'takerLevels',
  'applyAdverseTicks',
  'slippageBps',
  'computeFee',
  'parseFeeModel',
  'ticketMath',
  'REALISM',
  'createAdapters',
  'PolymarketAdapter',
  'KalshiAdapter',
  'brier',
  'logScore',
  'edgeBps',
];
const written = await readFile(outFile, 'utf8');
const missing = required.filter((name) => !new RegExp(`\\b${name}\\b`).test(written));
if (missing.length > 0) {
  console.error(`Bundle is missing required exports: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`wrote ${outFile} (${(code.length / 1024).toFixed(1)} KB, ${required.length} exports verified)`);
