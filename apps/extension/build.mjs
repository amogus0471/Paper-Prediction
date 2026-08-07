/**
 * Extension build.
 *
 *   1. Vite  → side panel (HTML + React, chunks are fine there)
 *   2. esbuild → service worker and content script as SINGLE self-contained
 *      files, because a content script is a classic script and any `import`
 *      statement in it is a hard runtime error
 *   3. copy manifest + icons
 *   4. assert the output is actually loadable, and carries no secrets
 *
 * Run: npm run build --workspace @polyfill/extension
 */
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Plain read+write, deliberately not cpSync/rmSync. Some filesystems (notably
// network/synced mounts — this bit us during dev) refuse to unlink a file that
// still has an open handle from a previous run, and both cpSync and rimraf do
// an unlink under the hood. Overwriting a file's content in place never needs
// one, so that's all this build ever does.
function copyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(src));
}
function copyDir(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const s = join(srcDir, entry);
    const d = join(destDir, entry);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');

const alias = {
  '@polyfill/core': resolve(root, '../../packages/core/src/index.ts'),
  '@polyfill/venues': resolve(root, '../../packages/venues/src/index.ts'),
};

console.log('▸ side panel');
await viteBuild({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'warn' });

console.log('▸ service worker + content script');
for (const [name, entry, format] of [
  // The worker is declared "type": "module", so ESM is correct there.
  ['src/background/index.js', 'src/background/index.ts', 'esm'],
  // The content script is a classic script: IIFE, zero imports, zero exports.
  ['src/content/index.js', 'src/content/index.ts', 'iife'],
]) {
  await esbuild({
    entryPoints: [resolve(root, entry)],
    outfile: resolve(dist, name),
    bundle: true,
    format,
    target: 'chrome116',
    platform: 'browser',
    minify: false,
    legalComments: 'none',
    alias,
  });
}

console.log('▸ manifest + icons');
mkdirSync(dist, { recursive: true });
copyFile(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));
copyDir(resolve(root, 'public/icons'), resolve(dist, 'icons'));

// Vite stamps `crossorigin` on every emitted module script and stylesheet.
// On a chrome-extension:// page that turns a same-origin fetch into an
// anonymous CORS request, which the extension scheme does not answer — the
// side panel then renders as a blank white pane with no console error that
// points at the cause. Strip it.
{
  const htmlPath = resolve(dist, 'src/sidepanel/index.html');
  const html = readFileSync(htmlPath, 'utf8').replace(/\s+crossorigin(?:="[^"]*")?/g, '');
  writeFileSync(htmlPath, html, 'utf8');
}

// ── verification ────────────────────────────────────────────────────────────
// A build that emits a content script Chrome refuses to run is worse than a
// build that fails, because you only find out after loading it.

const problems = [];

const content = readFileSync(resolve(dist, 'src/content/index.js'), 'utf8');
if (/^\s*import[\s{*'"]/m.test(content) || /^\s*export[\s{*]/m.test(content)) {
  problems.push('content script contains an import/export — Chrome will refuse to run it');
}

// A syntax error here loads fine and then fails at runtime as "Service worker
// registration failed (Status code: 15)", which points at nothing useful.
for (const rel of ['src/background/index.js', 'src/content/index.js', 'assets/sidepanel.js']) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(readFileSync(resolve(dist, rel), 'utf8'));
  } catch (e) {
    problems.push(`${rel} has a syntax error: ${e.message}`);
  }
}

// Every chrome.* namespace the code touches must be covered by a permission,
// or the call throws "Cannot read properties of undefined" at runtime.
const PERMISSION_FOR = {
  storage: 'storage',
  sidePanel: 'sidePanel',
  alarms: 'alarms',
  notifications: 'notifications',
  // Always available; no permission required.
  runtime: null,
  i18n: null,
};
{
  const manifestForPerms = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
  const granted = new Set(manifestForPerms.permissions ?? []);
  for (const rel of ['src/background/index.js', 'src/content/index.js', 'assets/sidepanel.js']) {
    const src = readFileSync(resolve(dist, rel), 'utf8');
    for (const m of src.matchAll(/chrome\.([a-zA-Z]+)/g)) {
      const ns = m[1];
      if (!(ns in PERMISSION_FOR)) {
        problems.push(`${rel} uses chrome.${ns}, which the build does not know about`);
      } else {
        const need = PERMISSION_FOR[ns];
        if (need && !granted.has(need)) {
          problems.push(`${rel} uses chrome.${ns} but "${need}" is not in manifest permissions`);
        }
      }
    }
  }
}

// The exact failure mode the side panel hits if crossorigin survives.
{
  const html = readFileSync(resolve(dist, 'src/sidepanel/index.html'), 'utf8');
  if (/crossorigin/.test(html)) {
    problems.push('side panel HTML still has a crossorigin attribute — it will render blank');
  }
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1].replace(/^\//, '');
    if (!/^(https?:)?\/\//.test(m[1]) && !existsSync(resolve(dist, ref))) {
      problems.push(`side panel references missing asset: ${m[1]}`);
    }
  }
}

const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
for (const path of [
  manifest.background.service_worker,
  manifest.side_panel.default_path,
  ...manifest.content_scripts.flatMap((c) => c.js),
  ...Object.values(manifest.icons),
]) {
  if (!existsSync(resolve(dist, path))) problems.push(`manifest references missing file: ${path}`);
}

// No secret may ever reach a bundle: the published artifact is world-readable.
const SECRET_PATTERNS = [
  /service_role/i,
  /\bsk-[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // A Supabase JWT with the service_role claim, base64-encoded.
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl/,
];
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|html|css|json)$/.test(e)) {
      const text = readFileSync(p, 'utf8');
      for (const re of SECRET_PATTERNS) {
        if (re.test(text)) problems.push(`possible secret in ${p.replace(dist, 'dist')}: ${re}`);
      }
    }
  }
};
walk(dist);

if (problems.length > 0) {
  console.error('\n✗ build failed verification:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const size = (p) => `${(statSync(resolve(dist, p)).size / 1024).toFixed(1)} KB`;
console.log(`\n✓ dist/ is loadable`);
console.log(`  service worker  ${size('src/background/index.js')}`);
console.log(`  content script  ${size('src/content/index.js')}  (budget 60 KB — runs on every page load)`);
console.log(`  side panel      ${size('assets/sidepanel.js')}`);
console.log(`  no secrets found in any bundled file`);
console.log(`\nLoad it: chrome://extensions → Developer mode → Load unpacked → apps/extension/dist`);
