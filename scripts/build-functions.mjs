/**
 * Bundle each Edge Function into one self-contained, tree-shaken file.
 *
 * Each function pulls in only the part of packages/core it actually uses —
 * `quote` needs the fill engine but no venue adapters, so it does not ship
 * them. Deno's own imports (jsr:/npm:/https:) stay external and resolve at the
 * edge.
 *
 *   node scripts/build-functions.mjs
 *
 * Output: supabase/functions/<name>/dist.js
 */
import { build } from 'esbuild';
import { readdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fnRoot = join(root, 'supabase/functions');

/** Deno resolves these at runtime; esbuild must not try to follow them. */
const externalPrefixes = ['jsr:', 'npm:', 'https:', 'http:', 'node:'];

const keepDenoSpecifiers = {
  name: 'keep-deno-specifiers',
  setup(b) {
    b.onResolve({ filter: /^(jsr|npm|https?|node):/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

const entries = (await readdir(fnRoot, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
  .map((d) => d.name);

let total = 0;
for (const name of entries) {
  const entry = join(fnRoot, name, 'index.ts');
  try {
    await stat(entry);
  } catch {
    continue;
  }

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minify: true,
    write: false,
    legalComments: 'none',
    plugins: [keepDenoSpecifiers],
    external: externalPrefixes.map((p) => `${p}*`),
  });

  const code = result.outputFiles[0].text;
  const out = join(fnRoot, name, 'dist.js');
  await writeFile(
    out,
    `// GENERATED — built from index.ts by scripts/build-functions.mjs. Do not edit.\n${code}`,
    'utf8',
  );
  total += code.length;
  console.log(`${name.padEnd(14)} ${(code.length / 1024).toFixed(1)} KB`);
}

console.log(`\n${entries.length} functions, ${(total / 1024).toFixed(1)} KB total`);
