// Golden Pancake Stack — Maple, Butter & Berries
// A program that paints one delicious food picture and saves it as PNG.
// Pure TypeScript, Node 22, zero dependencies: a small software rasterizer
// draws the scene pixel by pixel, then Node's built-in zlib encodes the PNG.
// Run:  node main.ts        ->  writes /output/entry.png (1024 x 1024)
// Local test: OUTPUT_DIR=/tmp/out node main.ts

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;
const CX = 512;

// --- deterministic random + smooth texture noise ---------------------------
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
const rnd = mulberry32(7711);

// Value-noise grid (64x64) for a soft, photographic grain that still
// compresses well: low frequency, small amplitude.
const GN = 64;
const gvals: number[] = [];
for (let i = 0; i < (GN + 1) * (GN + 1); i++) gvals.push(rnd());

function grain(x: number, y: number): number {
  const gx = (x / W) * GN;
  const gy = (y / H) * GN;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const w = GN + 1;
  const a = gvals[y0 * w + x0];
  const b = gvals[y0 * w + x0 + 1];
  const c = gvals[(y0 + 1) * w + x0];
  const d = gvals[(y0 + 1) * w + x0 + 1];
  const top = a + (b - a) * sx;
  const bot = c + (d - c) * sx;
  return (top + (bot - top) * sy) * 2 - 1; // [-1, 1]
}

// --- framebuffer ------------------------------------------------------------
const buf = new Uint8Array(W * H * 3);
type C = [number, number, number];

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
function put(x: number, y: number, c: C): void {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
}
function over(x: number, y: number, c: C, a: number): void {
  if (x < 0 || x >= W || y < 0 || y >= H || a <= 0) return;
  if (a >= 1) return put(x, y, c);
  const i = (y * W + x) * 3;
  buf[i] = clamp(buf[i] * (1 - a) + c[0] * a);
  buf[i + 1] = clamp(buf[i + 1] * (1 - a) + c[1] * a);
  buf[i + 2] = clamp(buf[i + 2] * (1 - a) + c[2] * a);
}
function blend(c1: C, c2: C, t: number): C {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}
function noisy(c: C, x: number, y: number, amt: number): C {
  const n = grain(x, y) * amt;
  return [clamp(c[0] + n), clamp(c[1] + n), clamp(c[2] + n)];
}

// --- shape helpers ----------------------------------------------------------
function hline(y: number, xa: number, xb: number, paint: (x: number) => C): void {
  if (y < 0 || y >= H) return;
  const a = Math.max(0, Math.ceil(xa));
  const b = Math.min(W - 1, Math.floor(xb));
  for (let x = a; x <= b; x++) put(x, y, paint(x));
}
function hlineA(y: number, xa: number, xb: number, a: number, paint: (x: number) => C): void {
  if (y < 0 || y >= H) return;
  const lo = Math.max(0, Math.ceil(xa));
  const hi = Math.min(W - 1, Math.floor(xb));
  for (let x = lo; x <= hi; x++) over(x, y, paint(x), a);
}

// Ellipse fill; paint receives normalized coords (nx, ny) in [-1, 1].
function fillEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  paint: (nx: number, ny: number, x: number, y: number) => C,
): void {
  const y0 = Math.max(0, Math.ceil(cy - ry));
  const y1 = Math.min(H - 1, Math.floor(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const ny = (y - cy) / ry;
    const half = Math.sqrt(Math.max(0, 1 - ny * ny));
    hline(y, cx - rx * half, cx + rx * half, (x) => paint((x - cx) / rx, ny, x, y));
  }
}
function fillEllipseA(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  alpha: number,
  paint: (nx: number, ny: number, x: number, y: number) => C,
): void {
  const y0 = Math.max(0, Math.ceil(cy - ry));
  const y1 = Math.min(H - 1, Math.floor(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const ny = (y - cy) / ry;
    const half = Math.sqrt(Math.max(0, 1 - ny * ny));
    hlineA(y, cx - rx * half, cx + rx * half, alpha, (x) => paint((x - cx) / rx, ny, x, y));
  }
}

// Disc with a soft radial falloff toward the rim.
function ball(cx: number, cy: number, r: number, c: C, rim: number): void {
  fillEllipse(cx, cy, r, r, (nx, ny) => {
    const d = Math.sqrt(nx * nx + ny * ny);
    const s = 1 - rim * Math.max(0, d);
    return [clamp(c[0] * s), clamp(c[1] * s), clamp(c[2] * s)];
  });
}

// Thick round-capped stroke, for syrup drips and veins.
function stroke(x0: number, y0: number, x1: number, y1: number, w: number, c: C): void {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    ball(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, c, 0.1);
  }
}

// Vertical-gradient rounded bar (pancake sides, butter).
function bar(x0: number, y0: number, x1: number, y1: number, r: number, top: C, bot: C): void {
  const ya = Math.max(0, Math.ceil(y0));
  const yb = Math.min(H - 1, Math.floor(y1));
  for (let y = ya; y <= yb; y++) {
    const t = (y - y0) / Math.max(1, y1 - y0);
    const base = blend(top, bot, t);
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
    hline(y, a, b, (x) => noisy(base, x, y, 5));
  }
}

// --- scene ------------------------------------------------------------------
const CREAM: C = [252, 238, 205];
const TAN: C = [228, 186, 130];
const PLATE: C = [250, 244, 230];
const PLATE_RIM: C = [226, 205, 170];
const GOLD_TOP: C = [238, 183, 92];
const GOLD_MID: C = [214, 148, 52];
const GOLD_LOW: C = [176, 112, 32];
const SYRUP: C = [196, 116, 18];
const SYRUP_DK: C = [158, 88, 10];
const SYRUP_LT: C = [232, 152, 40];

function drawBackground(): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - CX) / 720;
      const dy = (y - 430) / 720;
      const d = Math.min(1, Math.hypot(dx, dy));
      const t = d * d * (3 - 2 * d);
      put(x, y, noisy(blend(CREAM, TAN, t), x, y, 3));
    }
  }
  // Warm light pool behind the dish.
  fillEllipseA(CX, 560, 470, 380, 0.35, () => [255, 246, 220]);
}

function drawPlate(): void {
  fillEllipseA(CX, 838, 400, 72, 0.28, () => [120, 70, 30]);
  fillEllipseA(CX, 830, 385, 66, 0.18, () => [120, 70, 30]);
  fillEllipse(CX, 800, 392, 118, (nx, ny, x, y) => {
    const d = Math.hypot(nx, ny);
    return noisy(d > 0.86 ? PLATE_RIM : PLATE, x, y, 2);
  });
  fillEllipseA(CX, 800, 330, 92, 0.25, () => [210, 185, 145]);
}

const STACK_TOP = 452;
const STACK_LAYERS = 5;
const LAYER_H = 66;

function drawStack(): void {
  for (let i = 0; i < STACK_LAYERS; i++) {
    const topY = STACK_TOP + i * LAYER_H;
    const rx = 282 - i * 7;
    const cx = CX + Math.sin(i * 1.7) * 6;
    // Golden side, darkening toward the base.
    bar(cx - rx, topY, cx + rx, topY + LAYER_H + 26, 22, GOLD_MID, GOLD_LOW);
    // Toasted freckles on the side.
    for (let s = 0; s < 46; s++) {
      ball(
        cx - rx + 18 + rnd() * (2 * rx - 36),
        topY + 8 + rnd() * (LAYER_H + 6),
        1.5 + rnd() * 3.5,
        [150, 92, 26],
        0.1,
      );
    }
    // Pale top face with toasted blotches near the rim.
    fillEllipse(cx, topY + 2, rx, 44, (nx, ny, x, y) => {
      const d = Math.hypot(nx, ny);
      let c = blend(GOLD_TOP, [244, 205, 120], Math.max(0, 1 - d) * 0.7);
      c = noisy(c, x, y, 9);
      if (d > 0.55 && grain(x * 2.3, y * 2.3) > 0.28) c = blend(c, [168, 104, 30], 0.55);
      return c;
    });
    fillEllipseA(cx, topY - 4, rx * 0.82, 30, 0.22, () => [255, 226, 150]);
  }
}

function drawSyrup(): void {
  // Glossy pool on the top pancake.
  fillEllipse(CX, STACK_TOP + 2, 205, 34, (nx, ny, x, y) => {
    const d = Math.hypot(nx, ny);
    return noisy(blend(SYRUP_LT, SYRUP, Math.min(1, d * 1.4)), x, y, 4);
  });
  fillEllipseA(CX - 60, STACK_TOP - 6, 90, 14, 0.5, () => [255, 205, 110]);
  // Drips down the front of the stack.
  const drips: Array<[number, number, number]> = [
    [-228, 150, 20],
    [-150, 235, 24],
    [-62, 120, 18],
    [28, 205, 22],
    [118, 150, 20],
    [196, 265, 24],
    [252, 130, 18],
  ];
  for (const [off, len, w] of drips) {
    const x = CX + off;
    const y0 = STACK_TOP + 8;
    const sway = Math.sin(off) * 4;
    stroke(x, y0, x + sway, y0 + len, w, SYRUP_DK);
    stroke(x, y0, x + sway, y0 + len, w * 0.62, SYRUP);
    ball(x + sway, y0 + len, w * 0.55, SYRUP, 0.08);
    stroke(x - w * 0.22, y0 + 6, x - w * 0.22, y0 + len * 0.82, 3, [255, 214, 130]);
  }
  // Faint syrup sheen across the stack front.
  fillEllipseA(CX, STACK_TOP + 120, 250, 150, 0.1, () => [230, 150, 40]);
}

function drawButter(): void {
  bar(444, 348, 584, 424, 14, [255, 222, 92], [244, 196, 58]);
  bar(458, 356, 572, 382, 10, [255, 240, 150], [255, 226, 110]);
  // Melt sliding off the front edge.
  fillEllipse(CX, 428, 46, 12, () => [250, 208, 80]);
  fillEllipse(548, 430, 22, 8, () => [248, 202, 72]);
}

function drawBlueberry(cx: number, cy: number, r: number): void {
  ball(cx, cy, r, [52, 44, 96], 0.35);
  ball(cx - r * 0.3, cy - r * 0.3, r * 0.62, [74, 66, 128], 0.1);
  ball(cx, cy - r * 0.55, r * 0.22, [30, 26, 64], 0);
  ball(cx - r * 0.38, cy - r * 0.42, r * 0.18, [210, 210, 235], 0);
}

function drawRaspberry(cx: number, cy: number, r: number): void {
  const drupelets: Array<[number, number, number]> = [
    [0, -0.45, 0.42],
    [-0.45, -0.1, 0.4],
    [0.45, -0.1, 0.4],
    [-0.25, 0.35, 0.42],
    [0.28, 0.35, 0.42],
    [0, 0.05, 0.45],
  ];
  for (const [dx, dy, rr] of drupelets) {
    ball(cx + dx * r, cy + dy * r, r * rr, [198, 38, 62], 0.25);
    ball(cx + dx * r - r * 0.1, cy + dy * r - r * 0.12, r * rr * 0.45, [228, 80, 100], 0.05);
  }
  ball(cx - r * 0.3, cy - r * 0.35, r * 0.14, [255, 160, 170], 0);
}

function drawToppings(): void {
  drawBlueberry(392, 424, 30);
  drawBlueberry(636, 420, 28);
  drawBlueberry(600, 448, 22);
  drawRaspberry(452, 440, 30);
  drawRaspberry(560, 452, 26);
  drawBlueberry(238, 806, 24);
  drawRaspberry(792, 812, 26);
  drawBlueberry(820, 786, 18);
  // Mint leaf.
  fillEllipse(668, 448, 34, 14, (nx) => [52, 150 + Math.round(40 * (1 - Math.abs(nx))), 62]);
  stroke(640, 452, 694, 444, 3, [40, 110, 52]);
  // Powdered sugar dusting.
  for (let s = 0; s < 90; s++) {
    const a = rnd() * Math.PI * 2;
    const rr = 40 + rnd() * 150;
    ball(CX + Math.cos(a) * rr, STACK_TOP + 2 + Math.sin(a) * rr * 0.22, 1 + rnd() * 1.6, [255, 250, 240], 0);
  }
}

function drawSteam(): void {
  // Soft translucent wisps only — never solid shapes.
  const columns: Array<[number, number, number]> = [
    [430, 0.0, 26],
    [512, 1.9, 32],
    [596, 3.6, 24],
  ];
  for (const [sx, phase, amp] of columns) {
    for (let y = 350; y > 110; y -= 3) {
      const t = (350 - y) / 240;
      const x = sx + Math.sin(t * 7 + phase) * amp * t;
      const fade = Math.sin(Math.min(1, t) * Math.PI) * 0.1;
      fillEllipseA(x, y, 10 + t * 9, 10 + t * 9, fade, () => [255, 252, 246]);
    }
  }
}

function drawFinish(): void {
  // Warm gloss sweep on the left of the stack.
  fillEllipseA(330, 560, 130, 210, 0.1, () => [255, 240, 200]);
  // Gentle vignette.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot((x - CX) / 512, (y - 512) / 512);
      if (d > 0.92) over(x, y, [150, 100, 50], Math.min(0.22, (d - 0.92) * 1.6));
    }
  }
}

drawBackground();
drawPlate();
drawStack();
drawSyrup();
drawButter();
drawToppings();
drawSteam();
drawFinish();

// --- PNG encoder: 8-bit RGB, per-row best-of-5 filter, zlib level 9 ---------
function crc32(data: Buffer): number {
  const tbl = (crc32 as unknown as { t?: Int32Array }).t ?? buildCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = tbl[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function buildCrcTable(): Int32Array {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  (crc32 as unknown as { t: Int32Array }).t = t;
  return t;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function filterRow(row: Uint8Array, prev: Uint8Array | null): Buffer {
  const bpp = 3;
  const cands: Buffer[] = [Buffer.from(row)];
  const sub = Buffer.alloc(row.length);
  for (let i = 0; i < row.length; i++) sub[i] = (row[i] - (i >= bpp ? row[i - bpp] : 0)) & 0xff;
  cands.push(sub);
  if (prev) {
    const up = Buffer.alloc(row.length);
    const avg = Buffer.alloc(row.length);
    const pth = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const cc = i >= bpp ? prev[i - bpp] : 0;
      up[i] = (row[i] - b) & 0xff;
      avg[i] = (row[i] - Math.floor((a + b) / 2)) & 0xff;
      pth[i] = (row[i] - paeth(a, b, cc)) & 0xff;
    }
    cands.push(up, avg, pth);
  }
  let best = cands[0];
  let bestScore = Infinity;
  for (const f of cands) {
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
  return Buffer.concat([Buffer.from([cands.indexOf(best)]), best]);
}
function encodePNG(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  let prev: Uint8Array | null = null;
  for (let y = 0; y < H; y++) {
    const row = buf.subarray(y * W * 3, (y + 1) * W * 3);
    rows.push(filterRow(row, prev));
    prev = row;
  }
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = process.env.OUTPUT_DIR || "/output";
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "entry.png");
const png = encodePNG();
fs.writeFileSync(outPath, png);
console.log(`wrote ${outPath} ${png.length} bytes ${W}x${H}`);
