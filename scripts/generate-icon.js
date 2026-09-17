'use strict';

// Generates build/icon.png (512x512) — a rounded-corner gradient tile used as
// the application icon. Run with: node scripts/generate-icon.js
// electron-builder derives the Windows .ico / macOS .icns from this PNG.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const RADIUS = 96;

// Gradient endpoints (accent blue -> violet), matching the app theme.
const C1 = [79, 140, 255];
const C2 = [123, 97, 255];

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function insideRounded(x, y) {
  const r = RADIUS;
  const minX = r;
  const maxX = SIZE - r;
  const minY = r;
  const maxY = SIZE - r;
  let cx = x;
  let cy = y;
  if (x < minX) cx = minX;
  else if (x > maxX) cx = maxX;
  if (y < minY) cy = minY;
  else if (y > maxY) cy = maxY;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function buildRaw() {
  const rows = [];
  for (let y = 0; y < SIZE; y += 1) {
    const row = Buffer.alloc(1 + SIZE * 4);
    row[0] = 0; // filter type: none
    for (let x = 0; x < SIZE; x += 1) {
      const off = 1 + x * 4;
      const t = (x + y) / (2 * SIZE);
      const inside = insideRounded(x, y);
      row[off] = lerp(C1[0], C2[0], t);
      row[off + 1] = lerp(C1[1], C2[1], t);
      row[off + 2] = lerp(C1[2], C2[2], t);
      row[off + 3] = inside ? 255 : 0;
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

// ---- Minimal PNG encoder ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng() {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(buildRaw(), { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'icon.png');
fs.writeFileSync(outPath, encodePng());
console.log('Wrote', outPath);
