/**
 * Zip `dist/` into a file a person can download and load without npm.
 *
 *   node scripts/pack.mjs        (or: npm run pack --workspace @polyfill/extension)
 *
 * Written by hand rather than shelling out to `zip` or pulling in a dependency:
 * `zip` does not exist on a default Windows box, PowerShell's Compress-Archive
 * writes backslash separators that Chrome rejects, and a build tool that only
 * works on the maintainer's machine is not a build tool. Node has DEFLATE in
 * core, and the ZIP container is about sixty lines.
 *
 * Store-compatible on purpose: no top-level folder, manifest.json at the root.
 */
import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const outDir = resolve(root, '../../release');

const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
const outFile = resolve(outDir, `paper-predictions-${manifest.version}.zip`);

/** Every file under dist, with ZIP-style forward-slash paths. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// CRC-32, table-driven. The ZIP central directory stores it per entry and an
// unzipper that checks it will reject the archive if it is wrong.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// DOS time/date. Fixed rather than "now" so the same dist always zips to the
// same bytes — a reproducible artifact is one you can compare against a release.
const DOS_TIME = 0;
const DOS_DATE = (2026 - 1980) * 512 + 1 * 32 + 1;

const files = walk(dist).sort();
const chunks = [];
const central = [];
let offset = 0;

for (const abs of files) {
  const name = relative(dist, abs).split('\\').join('/');
  const raw = readFileSync(abs);
  const deflated = deflateRawSync(raw, { level: 9 });
  // Only compress when it actually helps; tiny PNGs get bigger under DEFLATE.
  const useDeflate = deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(raw);
  const nameBuf = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, body);

  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4); // version made by
  dir.writeUInt16LE(20, 6); // version needed
  dir.writeUInt16LE(0, 8);
  dir.writeUInt16LE(method, 10);
  dir.writeUInt16LE(DOS_TIME, 12);
  dir.writeUInt16LE(DOS_DATE, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(body.length, 20);
  dir.writeUInt32LE(raw.length, 24);
  dir.writeUInt16LE(nameBuf.length, 28);
  dir.writeUInt32LE(0, 38); // external attrs
  dir.writeUInt32LE(offset, 42);
  central.push(dir, nameBuf);

  offset += local.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, end]));

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`✓ ${relative(resolve(root, '../..'), outFile).split('\\').join('/')}`);
console.log(`  ${files.length} files, ${kb(statSync(outFile).size)}`);
console.log(`\nUnzip it, then: chrome://extensions → Developer mode → Load unpacked`);
