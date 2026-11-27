// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a night-blue gradient, an
// elevated track with a train on the left, and a departure board on the
// right (line dots and minute bars). No CTA logo nor CTA lettering (an
// unofficial integration, CTA Trademark Guidelines for Developers).
// Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const NIGHT = [14, 24, 48];
const DUSK = [36, 58, 102];
const STEEL = [74, 86, 108];
const PANEL = [20, 30, 54];
const WHITE = [236, 240, 246];
const MUTED = [110, 124, 150];
const WINDOW = [250, 214, 120];
// 'L' line colors (the guidelines allow the route colors).
const LINES = [
  [198, 12, 48],
  [0, 155, 58],
  [98, 54, 27],
  [0, 161, 222],
];
const MINUTES = [3, 7, 12, 18];

function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.max(Math.abs(x - cx) - halfW + radius, 0);
  const dy = Math.max(Math.abs(y - cy) - halfH + radius, 0);
  return Math.hypot(dx, dy) - radius;
}

function pixel(x, y) {
  let color = mix(NIGHT, DUSK, y / HEIGHT);
  // Elevated structure: deck and columns.
  if (y >= 330 && y < 344 && x < 420) color = STEEL;
  for (const cx of [40, 150, 260, 370]) {
    if (Math.abs(x - cx) < 9 && y >= 344 && y < HEIGHT) color = mix(STEEL, NIGHT, 0.3);
    // Cross braces.
    const t = (y - 344) / 120;
    if (t > 0 && t < 1 && Math.abs(x - (cx + 55 - 110 * t)) < 3 && y < 464) {
      color = mix(STEEL, NIGHT, 0.4);
    }
  }
  // Train: two cars on the deck, windows lit.
  for (const cx of [110, 290]) {
    const car = roundedBox(x, y, cx, 296, 82, 30, 12);
    color = mix(color, [196, 202, 212], smooth(0, car));
    if (car < -4) {
      const wx = (x - cx + 70) % 28;
      if (x > cx - 70 && x < cx + 70 && wx > 6 && wx < 22 && y > 276 && y < 298) color = WINDOW;
      if (y > 312 && y < 316) color = LINES[0];
    }
  }
  // Departure board.
  const board = roundedBox(x, y, 620, 270, 150, 170, 22);
  color = mix(color, PANEL, smooth(0, board));
  if (board < -2) {
    for (const [i, minutes] of MINUTES.entries()) {
      const cy = 160 + i * 74;
      if (Math.hypot(x - 510, y - cy) < 16) color = LINES[i];
      const name = roundedBox(x, y, 590, cy - 8, 44, 6, 6);
      if (name < 0) color = WHITE;
      const sub = roundedBox(x, y, 575, cy + 12, 29, 4, 4);
      if (sub < 0) color = MUTED;
      const bar = roundedBox(
        x,
        y,
        700 - (40 - minutes * 2) / 2,
        cy,
        (40 - minutes * 2) / 2 + 6,
        10,
        8,
      );
      if (bar < 0) color = mix(WINDOW, WHITE, i / 4);
    }
  }
  // Stars.
  if (y < 220 && board > 0 && (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0 < 2e6) {
    color = WHITE;
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
