/**
 * Draw the Paper Predictions mark as PNGs, at every size the manifest needs.
 *
 * Drawn in code rather than downscaled from the 1024px render, because a 16px
 * favicon made by resampling a 1024px image is mush. At this size every stroke
 * has to land on a whole pixel, so the geometry is recomputed per size and the
 * stroke width is floored to at least 1px.
 *
 * The mark: a rounded-square outline holding three horizontal bars of
 * decreasing width — solid, half-filled, outline-only. It reads as an order
 * book whose liquidity thins as you walk down it, which is the whole product.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');

const BG = [0x0b, 0x0d, 0x10, 255]; // near-black, matches --bg
// Brand blue, the same #3B82F6 the popup and dashboard use. It was violet
// while the rest of the UI already wasn't — an icon that doesn't match the
// thing it opens reads as someone else's extension in the toolbar.
const BLUE = [0x3b, 0x82, 0xf6, 255];
const CLEAR = [0, 0, 0, 0];

/** A tiny RGBA canvas with just the primitives this mark needs. */
function canvas(size) {
  const px = new Uint8Array(size * size * 4);
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 4;
    px[o] = c[0];
    px[o + 1] = c[1];
    px[o + 2] = c[2];
    px[o + 3] = c[3];
  };
  return {
    px,
    put,
    fill: (c) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, c);
    },
    /** Filled rounded rect. r=0 gives a plain rect. */
    roundRect: (x0, y0, w, h, r, c) => {
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const dx = Math.max(x0 + r - x, x - (x0 + w - 1 - r), 0);
          const dy = Math.max(y0 + r - y, y - (y0 + h - 1 - r), 0);
          if (dx * dx + dy * dy <= r * r + r) put(x, y, c);
        }
      }
    },
  };
}

function strokeRoundRect(cv, x0, y0, w, h, r, t, colour, bg) {
  cv.roundRect(x0, y0, w, h, r, colour);
  // Punch the middle back out to leave an outline of thickness t.
  cv.roundRect(x0 + t, y0 + t, w - 2 * t, h - 2 * t, Math.max(0, r - t), bg);
}

function icon(size) {
  const cv = canvas(size);
  // Transparent outside the badge so it sits well on any toolbar colour.
  cv.fill(CLEAR);

  const pad = Math.round(size * 0.09);
  const box = size - pad * 2;
  const radius = Math.round(box * 0.26);
  const stroke = Math.max(1, Math.round(size * 0.062));

  // Badge: violet outline over the app background.
  cv.roundRect(pad, pad, box, box, radius, BG);
  strokeRoundRect(cv, pad, pad, box, box, radius, stroke, BLUE, BG);

  // Three depth bars, thinning downward.
  const inner = box - stroke * 2 - Math.round(size * 0.08);
  const left = pad + stroke + Math.round(size * 0.04);
  const barH = Math.max(1, Math.round(size * 0.115));
  const gap = Math.max(1, Math.round(size * 0.055));
  const top = pad + Math.round(box * 0.26);
  const thin = Math.max(1, Math.round(size * 0.025));

  // 1 — full width, solid: deep liquidity at the top of book.
  cv.roundRect(left, top, inner, barH, Math.max(1, Math.round(barH * 0.22)), BLUE);

  // 2 — narrower, half filled: it is already thinning.
  const w2 = Math.round(inner * 0.72);
  const y2 = top + barH + gap;
  strokeRoundRect(cv, left, y2, w2, barH, Math.max(1, Math.round(barH * 0.22)), thin, BLUE, BG);
  cv.roundRect(left + thin, y2 + thin, Math.round(w2 * 0.55) - thin, barH - thin * 2, 0, BLUE);

  // 3 — narrowest, outline only: the last level, barely there.
  const w3 = Math.round(inner * 0.44);
  const y3 = y2 + barH + gap;
  strokeRoundRect(cv, left, y3, w3, barH, Math.max(1, Math.round(barH * 0.22)), thin, BLUE, BG);

  return { px: cv.px, size };
}

// ── PNG encoding ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng({ px, size }) {
  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.subarray(y * size * 4, (y + 1) * size * 4).forEach((v, i) => {
      raw[y * (size * 4 + 1) + 1 + i] = v;
    });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(icon(size));
  writeFileSync(resolve(OUT, `icon${size}.png`), png);
  console.log(`icon${size}.png  ${png.length} bytes`);
}
console.log('\nRebuild to pick these up: npm run build --workspace @polyfill/extension');
