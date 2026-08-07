/**
 * Scan SOURCE for secrets, before anything is deployed or published.
 *
 * `apps/extension/build.mjs` already scans the built extension bundle, but
 * nothing looked at `supabase/functions/` — which is the half that runs with
 * `service_role` and therefore the half where a leaked key matters most.
 *
 *   node scripts/check-secrets.mjs
 *
 * Exits non-zero on any hit so CI and a pre-deploy step can gate on it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_DIRS = ['supabase', 'packages', 'apps', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.turbo']);
const SCAN_EXT = /\.(ts|tsx|js|mjs|cjs|json|sql|yml|yaml|html|css|env)$/;

const PATTERNS = [
  // A Supabase JWT whose payload base64-encodes "service_role".
  { name: 'supabase service_role JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'openai-style key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'aws access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'generic assigned secret', re: /(?:secret|password|passwd|api_?key)\s*[:=]\s*['"][^'"\s]{16,}['"]/i },
];

/**
 * Lines that legitimately contain a pattern: the scanner's own definitions, and
 * `Deno.env.get('…SERVICE_ROLE_KEY')`, which is a variable NAME, not a value.
 */
function isAllowed(line, file) {
  if (/check-secrets\.mjs$/.test(file) || /build\.mjs$/.test(file)) return true;
  if (/Deno\.env\.get|process\.env\./.test(line)) return true;
  if (/^\s*(\/\/|--|\*|#)/.test(line)) return true; // comment
  return false;
}

const hits = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!SCAN_EXT.test(entry)) continue;

    const rel = relative(root, full);
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (isAllowed(line, rel)) return;
      for (const { name, re } of PATTERNS) {
        if (re.test(line)) hits.push({ rel, line: i + 1, name, text: line.trim().slice(0, 90) });
      }
    });
  }
}

for (const dir of SCAN_DIRS) walk(resolve(root, dir));

if (hits.length > 0) {
  console.error('✗ possible secrets in source:\n');
  for (const h of hits) console.error(`  ${h.rel}:${h.line}  [${h.name}]\n    ${h.text}`);
  console.error('\nIf one of these is a false positive, narrow the pattern rather than deleting it.');
  process.exit(1);
}

console.log(`✓ no secrets found in ${SCAN_DIRS.join(', ')}`);
