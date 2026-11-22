// Golden Pancake Stack — Maple, Butter & Berries
// Pure Node 22, zero dependencies. Hand-written rasterizer: draws a tall stack
// of golden pancakes with melting butter, dripping maple syrup and berries on
// a plate, then encodes it as a PNG with Node's built-in zlib.
// Output: /output/entry.png (1024x1024, RGB, <= 1 MiB).

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) + smooth value noise for food texture.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261123);
const GRID = 64;
const gridVals: number[] = [];
for (let i = 0; i < (GRID + 1) * (GRID + 1); i++) gridVals.push(rand());

function smoothNoise(x: number, y: number): number {
  // Low-frequency value noise in [-1, 1]; smooth so the PNG stays small.
  const gx = (x / W) * GRID;
  const gy = (y / H) * GRID;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const i00 = gridVals[y0 * (GRID + 1) + x0];
  const i10 = gridVals[y0 * (GRID + 1) + x0 + 1];
  const i01 = gridVals[(y0 + 1) * (GRID + 1) + x0];
  const i11 = gridVals[(y0 + 1) * (GRID + 1) + x0 + 1];
  const top = i00 + (i10 - i00) * sx;
  const bot = i01 + (i11 - i01) * sx;
  return (top + (bot - top) * sy) * 2 - 1;
}

// ---------------------------------------------------------------------------
// Canvas: RGB buffer + alpha-blend pixel helpers.
// ---------------------------------------------------------------------------
const px = new Uint8Array(W * H * 3);

type RGB = [number, number, number];

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function setPx(x: number, y: number, c: RGB): void {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
}

function blendPx(x: number, y: number, c: RGB, a: number): void {
  if (x < 0 || x >= W || y < 0 || y >= H || a <= 0) return;
  if (a >= 1) {
    setPx(x, y, c);
    return;
  }
  const i = (y * W + x) * 3;
  px[i] = clamp255(px[i] * (1 - a) + c[0] * a);
  px[i + 1] = clamp255(px[i + 1] * (1 - a) + c[1] * a);
  px[i + 2] = clamp255(px[i + 2] * (1 - a) + c[2] * a);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

// Fill a horizontal span [x0, x1] on row y with a colour function.
function span(y: number, x0: number, x1: number, fn: (x: number) => RGB): void {
  if (y < 0 || y >= H) return;
  const a = Math.max(0, Math.ceil(x0));
  const b = Math.min(W - 1, Math.floor(x1));
  for (let x = a; x <= b; x++) setPx(x, y, fn(x));
}

function spanBlend(
  y: number,
  x0: number,
  x1: number,
  alpha: number,
  fn: (x: number) => RGB,
): void {
  if (y < 0 || y >= H) return;
  const a = Math.max(0, Math.ceil(x0));
  const b = Math.min(W - 1, Math.floor(x1));
  for (let x = a; x <= b; x++) blendPx(x, y, fn(x), alpha);
}

// Filled ellipse with a per-pixel colour function (dx, dy in [-1, 1]).
function ellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fn: (nx: number, ny: number, x: number, y: number) => RGB,
): void {
  const y0 = Math.max(0, Math.ceil(cy - ry));
  const y1 = Math.min(H - 1, Math.floor(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const ny = (y - cy) / ry;
    const dx = Math.sqrt(Math.max(0, 1 - ny * ny));
    const x0 = cx - rx * dx;
    const x1 = cx + rx * dx;
    span(y, x0, x1, (x) => fn((x - cx) / rx, ny, x, y));
  }
}

function ellipseBlend(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  alpha: number,
  fn: (nx: number, ny: number, x: number, y: number) => RGB,
): void {
  const y0 = Math.max(0, Math.ceil(cy - ry));
  const y1 = Math.min(H - 1, Math.floor(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const ny = (y - cy) / ry;
    const dx = Math.sqrt(Math.max(0, 1 - ny * ny));
    spanBlend(y, cx - rx * dx, cx + rx * dx, alpha, (x) =>
      fn((x - cx) / rx, ny, x, y),
    );
  }
}

// Filled disc (circle) with radial shading.
function disc(cx: number, cy: number, r: number, c: RGB, shade: number): void {
  ellipse(cx, cy, r, r, (nx, ny) => {
    const d = Math.sqrt(nx * nx + ny * ny);
    const t = Math.max(0, 1 - d);
    const s = 1 - shade * (1 - t);
    return [clamp255(c[0] * s), clamp255(c[1] * s), clamp255(c[2] * s)];
  });
}

// Thick line with round caps, drawn as a chain of discs (for syrup drips).
function thickLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  c: RGB,
): void {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    disc(lerp(x0, x1, t), lerp(y0, y1, t), w / 2, c, 0.12);
  }
}

// Rounded rectangle, vertical gradient, optional per-pixel noise.
function roundRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  top: RGB,
  bottom: RGB,
): void {
  const yA = Math.max(0, Math.ceil(y0));
  const yB = Math.min(H - 1, Math.floor(y1));
  for (let y = yA; y <= yB; y++) {
    const t = (y - y0) / Math.max(1, y1 - y0);
    const base = mix(top, bottom, t);
    let a = x0;
    let b = x1;
    if (y < y0 + r) {
      const dy = y0 + r - y;
      const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
      a = x0 + r - dx;
      b = x1 - r + dx;
    } else if (y > y1 - r) {
      const dy = y - (y1 - r);
      const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
      a = x0 + r - dx;
      b = x1 - r + dx;
    }
    span(y, a, b, (x) => {
      const n = smoothNoise(x, y) * 5;
      return [clamp255(base[0] + n), clamp255(base[1] + n), clamp255(base[2] + n)];
    });
  }
}

// ---------------------------------------------------------------------------
// 1. Warm background: cream radial glow + soft vignette.
// ---------------------------------------------------------------------------
const BG_CENTER: RGB = [252, 238, 205];
const BG_EDGE: RGB = [228, 186, 130];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x - 512) / 720;
    const dy = (y - 430) / 720;
    const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
    const t = d * d * (3 - 2 * d);
    const c = mix(BG_CENTER, BG_EDGE, t);
    const n = smoothNoise(x, y) * 3;
    setPx(x, y, [clamp255(c[0] + n), clamp255(c[1] + n), clamp255(c[2] + n)]);
  }
}

// Soft warm light pool behind the plate.
ellipseBlend(512, 560, 470, 380, 0.35, () => [255, 246, 220]);

// ---------------------------------------------------------------------------
// 2. Plate shadow + plate.
// ---------------------------------------------------------------------------
ellipseBlend(512, 838, 400, 72, 0.28, () => [120, 70, 30]);
ellipseBlend(512, 830, 385, 66, 0.18, () => [120, 70, 30]);
// Plate body: pale cream, slightly darker rim ring.
ellipse(512, 800, 392, 118, (nx, ny) => {
  const d = Math.sqrt(nx * nx + ny * ny);
  const base: RGB = d > 0.86 ? [226, 205, 170] : [250, 244, 230];
  const n = smoothNoise(512 + nx * 392, 800 + ny * 118) * 2;
  return [clamp255(base[0] + n), clamp255(base[1] + n), clamp255(base[2] + n)];
});
// Inner plate well line.
ellipseBlend(512, 800, 330, 92, 0.25, () => [210, 185, 145]);

// ---------------------------------------------------------------------------
// 3. Pancake stack: 5 golden discs, bottom at y ~ 800, top at y ~ 430.
// ---------------------------------------------------------------------------
const STACK_CX = 512;
const LAYERS = 5;
const LAYER_H = 66;
const TOP_Y = 452;
const GOLD_TOP: RGB = [238, 183, 92];
const GOLD_SIDE: RGB = [214, 148, 52];
const GOLD_DARK: RGB = [176, 112, 32];

for (let i = 0; i < LAYERS; i++) {
  const topY = TOP_Y + i * LAYER_H;
  const rx = 282 - i * 7;
  const wob = Math.sin(i * 1.7) * 6;
  const cx = STACK_CX + wob;
  // Side band: golden gradient, darker toward the bottom edge.
  roundRect(cx - rx, topY, cx + rx, topY + LAYER_H + 26, 22, GOLD_SIDE, GOLD_DARK);
  // Toasted speckles on the side.
  for (let s = 0; s < 46; s++) {
    const sx = cx - rx + 18 + rand() * (2 * rx - 36);
    const sy = topY + 8 + rand() * (LAYER_H + 6);
    const r = 1.5 + rand() * 3.5;
    disc(sx, sy, r, [150, 92, 26], 0.1);
  }
  // Top face of this disc: pale golden with toasted blotches.
  ellipse(cx, topY + 2, rx, 44, (nx, ny, x, y) => {
    const d = Math.sqrt(nx * nx + ny * ny);
    let c = mix(GOLD_TOP, [244, 205, 120], Math.max(0, 1 - d) * 0.7);
    const n = smoothNoise(x, y) * 9;
    c = [clamp255(c[0] + n), clamp255(c[1] + n), clamp255(c[2] + n)];
    // Toasted blotch near the rim.
    if (d > 0.55 && smoothNoise(x * 2.3, y * 2.3) > 0.28) {
      c = mix(c, [168, 104, 30], 0.55);
    }
    return c;
  });
  // Rim highlight on the top face.
  ellipseBlend(cx, topY - 4, rx * 0.82, 30, 0.22, () => [255, 226, 150]);
}

// ---------------------------------------------------------------------------
// 4. Maple syrup: glossy pool on top + drips down the front of the stack.
// ---------------------------------------------------------------------------
const SYRUP: RGB = [196, 116, 18];
const SYRUP_DARK: RGB = [158, 88, 10];
const SYRUP_LIGHT: RGB = [232, 152, 40];
// Pool on the top pancake.
ellipse(STACK_CX, TOP_Y + 2, 205, 34, (nx, ny, x, y) => {
  const d = Math.sqrt(nx * nx + ny * ny);
  let c = mix(SYRUP_LIGHT, SYRUP, Math.min(1, d * 1.4));
  const n = smoothNoise(x, y) * 4;
  return [clamp255(c[0] + n), clamp255(c[1] + n), clamp255(c[2] + n)];
});
// Syrup shine.
ellipseBlend(STACK_CX - 60, TOP_Y - 6, 90, 14, 0.5, () => [255, 205, 110]);
// Drips: start at the pool rim, run down the stack face, end in a round drop.
const DRIPS: Array<[number, number, number]> = [
  // [x offset from centre, length, width]
  [-228, 150, 20],
  [-150, 235, 24],
  [-62, 120, 18],
  [28, 205, 22],
  [118, 150, 20],
  [196, 265, 24],
  [252, 130, 18],
];
for (const [off, len, w] of DRIPS) {
  const x = STACK_CX + off;
  const yStart = TOP_Y + 8;
  // Drip body: darker edge via two passes (wide dark, narrower light centre).
  thickLine(x, yStart, x + Math.sin(off) * 4, yStart + len, w, SYRUP_DARK);
  thickLine(x, yStart, x + Math.sin(off) * 4, yStart + len, w * 0.62, SYRUP);
  disc(x + Math.sin(off) * 4, yStart + len, w * 0.55, SYRUP, 0.08);
  // Gloss stripe on the left of the drip.
  thickLine(x - w * 0.22, yStart + 6, x - w * 0.22, yStart + len * 0.82, 3, [255, 214, 130]);
}
// Syrup sheet glossing the front of the stack between drips.
ellipseBlend(STACK_CX, TOP_Y + 120, 250, 150, 0.10, () => [230, 150, 40]);

// ---------------------------------------------------------------------------
// 5. Butter: melting golden square on top, tilted slightly, with gloss.
// ---------------------------------------------------------------------------
const BUTTER_TOP: RGB = [255, 222, 92];
const BUTTER_SIDE: RGB = [244, 196, 58];
roundRect(444, 348, 584, 424, 14, BUTTER_TOP, BUTTER_SIDE);
// Butter top highlight.
roundRect(458, 356, 572, 382, 10, [255, 240, 150], [255, 226, 110]);
// Melt blob sliding off the butter's front edge.
ellipse(512, 428, 46, 12, () => [250, 208, 80]);
ellipse(548, 430, 22, 8, () => [248, 202, 72]);

// ---------------------------------------------------------------------------
// 6. Berries on top + a few on the plate.
// ---------------------------------------------------------------------------
function blueberry(cx: number, cy: number, r: number): void {
  disc(cx, cy, r, [52, 44, 96], 0.35);
  disc(cx - r * 0.3, cy - r * 0.3, r * 0.62, [74, 66, 128], 0.1);
  // Crown star.
  disc(cx, cy - r * 0.55, r * 0.22, [30, 26, 64], 0);
  // Specular dot.
  disc(cx - r * 0.38, cy - r * 0.42, r * 0.18, [210, 210, 235], 0);
}
function raspberry(cx: number, cy: number, r: number): void {
  // Cluster of drupelets.
  const offs: Array<[number, number, number]> = [
    [0, -0.45, 0.42],
    [-0.45, -0.1, 0.4],
    [0.45, -0.1, 0.4],
    [-0.25, 0.35, 0.42],
    [0.28, 0.35, 0.42],
    [0, 0.05, 0.45],
  ];
  for (const [dx, dy, rr] of offs) {
    disc(cx + dx * r, cy + dy * r, r * rr, [198, 38, 62], 0.25);
    disc(cx + dx * r - r * 0.1, cy + dy * r - r * 0.12, r * rr * 0.45, [228, 80, 100], 0.05);
  }
  disc(cx - r * 0.3, cy - r * 0.35, r * 0.14, [255, 160, 170], 0);
}
blueberry(392, 424, 30);
blueberry(636, 420, 28);
blueberry(600, 448, 22);
raspberry(452, 440, 30);
raspberry(560, 452, 26);
// Berries resting on the plate.
blueberry(238, 806, 24);
raspberry(792, 812, 26);
blueberry(820, 786, 18);

// Mint leaf beside the butter.
ellipse(668, 448, 34, 14, (nx, ny) => {
  const g = 150 + Math.round(40 * (1 - Math.abs(nx)));
  return [52, g, 62];
});
thickLine(640, 452, 694, 444, 3, [40, 110, 52]);

// Powdered sugar dusting on the top pancake.
for (let s = 0; s < 90; s++) {
  const a = rand() * Math.PI * 2;
  const rr = 40 + rand() * 150;
  const sx = STACK_CX + Math.cos(a) * rr;
  const sy = TOP_Y + 2 + Math.sin(a) * rr * 0.22;
  disc(sx, sy, 1 + rand() * 1.6, [255, 250, 240], 0);
}

// ---------------------------------------------------------------------------
// 7. Steam: soft wavy white columns rising above the stack.
// ---------------------------------------------------------------------------
for (const [sx, phase, amp] of [
  [430, 0.0, 26],
  [512, 1.9, 32],
  [596, 3.6, 24],
] as Array<[number, number, number]>) {
  for (let y = 350; y > 110; y -= 3) {
    const t = (350 - y) / 240;
    const x = sx + Math.sin(t * 7 + phase) * amp * t;
    const fade = Math.sin(Math.min(1, t) * Math.PI) * 0.10;
    // Soft translucent wisp only — never a solid shape.
    ellipseBlend(x, y, 10 + t * 9, 10 + t * 9, fade, () => [255, 252, 246]);
  }
}

// ---------------------------------------------------------------------------
// 8. Warm gloss sweep across the left of the stack + gentle vignette.
// ---------------------------------------------------------------------------
ellipseBlend(330, 560, 130, 210, 0.10, () => [255, 240, 200]);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x - 512) / 512;
    const dy = (y - 512) / 512;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 0.92) {
      const a = (d - 0.92) * 1.6;
      blendPx(x, y, [150, 100, 50], Math.min(0.22, a));
    }
  }
}

// ---------------------------------------------------------------------------
// PNG encoder: 8-bit RGB, per-row best-of-5 filter, zlib level 9.
// ---------------------------------------------------------------------------
function crc32(buf: Buffer): number {
  let table = (crc32 as unknown as { t?: Int32Array }).t;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    (crc32 as unknown as { t: Int32Array }).t = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  const crc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

function filterRow(row: Uint8Array, prev: Uint8Array | null): Buffer {
  const bpp = 3;
  const filters: Buffer[] = [];
  // Filter 0: None
  filters.push(Buffer.from(row));
  // Filter 1: Sub
  {
    const f = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      f[i] = (row[i] - a) & 0xff;
    }
    filters.push(f);
  }
  if (prev) {
    // Filter 2: Up
    const f = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i++) f[i] = (row[i] - prev[i]) & 0xff;
    filters.push(f);
    // Filter 3: Average
    const g = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      g[i] = (row[i] - Math.floor((a + prev[i]) / 2)) & 0xff;
    }
    filters.push(g);
    // Filter 4: Paeth
    const h = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      h[i] = (row[i] - pr) & 0xff;
    }
    filters.push(h);
  }
  // Pick the filter with the smallest sum of |signed byte|.
  let best = filters[0];
  let bestScore = Infinity;
  for (const f of filters) {
    let s = 0;
    for (let i = 0; i < f.length; i++) {
      const v = f[i] > 127 ? f[i] - 256 : f[i];
      s += Math.abs(v);
    }
    if (s < bestScore) {
      bestScore = s;
      best = f;
    }
  }
  const idx = filters.indexOf(best);
  return Buffer.concat([Buffer.from([idx]), best]);
}

function encodePNG(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rows: Buffer[] = [];
  let prev: Uint8Array | null = null;
  for (let y = 0; y < H; y++) {
    const row = px.subarray(y * W * 3, (y + 1) * W * 3);
    rows.push(filterRow(row, prev));
    prev = row;
  }
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = process.env.OUTPUT_DIR || "/output";
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "entry.png");
const png = encodePNG();
fs.writeFileSync(outPath, png);
console.log(`wrote ${outPath} ${png.length} bytes ${W}x${H}`);
