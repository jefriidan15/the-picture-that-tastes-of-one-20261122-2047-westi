// Golden Pancake Stack — Maple, Butter & Berries
// Entry program for make.fun race "The picture that tastes of one ingredient".
// Node 22, ZERO dependencies — Node built-ins only (fs, path, zlib).
// Hand-written rasterizer: draws a 1024x1024 pancake-stack still life and
// encodes it as a PNG (per-scanline best-of-5 filter, zlib deflate).
// Output: $OUTPUT_DIR/entry.png (default /output/entry.png).

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — stable output across runs.
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
const rand = mulberry32(20261122);

// ---------------------------------------------------------------------------
// Canvas: RGB buffer + alpha-blend helpers.
// ---------------------------------------------------------------------------
const img = new Uint8Array(W * H * 3);

type RGB = [number, number, number];

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Blend src color over dst pixel at (x, y) with alpha 0..1.
function px(x: number, y: number, r: number, g: number, b: number, a = 1): void {
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || xi >= W || yi < 0 || yi >= H) return;
  const i = (yi * W + xi) * 3;
  if (a >= 1) {
    img[i] = r;
    img[i + 1] = g;
    img[i + 2] = b;
  } else if (a > 0) {
    img[i] = clamp255(img[i] * (1 - a) + r * a);
    img[i + 1] = clamp255(img[i + 1] * (1 - a) + g * a);
    img[i + 2] = clamp255(img[i + 2] * (1 - a) + b * a);
  }
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1): void {
  for (let y = Math.max(0, y0 | 0); y < Math.min(H, y1 | 0); y++) {
    for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1 | 0); x++) {
      px(x, y, c[0], c[1], c[2], a);
    }
  }
}

function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const dy = (y - cy) / ry;
    const dx = Math.sqrt(Math.max(0, 1 - dy * dy));
    const xa = Math.max(0, Math.ceil(cx - dx * rx));
    const xb = Math.min(W - 1, Math.floor(cx + dx * rx));
    for (let x = xa; x <= xb; x++) px(x, y, c[0], c[1], c[2], a);
  }
}

function fillCircle(cx: number, cy: number, r: number, c: RGB, a = 1): void {
  fillEllipse(cx, cy, r, r, c, a);
}

// Soft disc (radial falloff) — for steam, glows, soft shadows.
function softDisc(cx: number, cy: number, r: number, c: RGB, peakA: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d >= 1) continue;
      const a = peakA * (1 - d * d);
      px(x, y, c[0], c[1], c[2], a);
    }
  }
}

// Rounded rectangle via rect + 4 corner discs.
function fillRoundRect(x0: number, y0: number, x1: number, y1: number, rad: number, c: RGB, a = 1): void {
  fillRect(x0 + rad, y0, x1 - rad, y1, c, a);
  fillRect(x0, y0 + rad, x1, y1 - rad, c, a);
  fillCircle(x0 + rad, y0 + rad, rad, c, a);
  fillCircle(x1 - rad, y0 + rad, rad, c, a);
  fillCircle(x0 + rad, y1 - rad, rad, c, a);
  fillCircle(x1 - rad, y1 - rad, rad, c, a);
}

// Vertical linear gradient fill of a rect.
function vGradRect(x0: number, y0: number, x1: number, y1: number, top: RGB, bot: RGB): void {
  const h = Math.max(1, y1 - y0);
  for (let y = Math.max(0, y0 | 0); y < Math.min(H, y1 | 0); y++) {
    const t = (y - y0) / h;
    const r = top[0] + (bot[0] - top[0]) * t;
    const g = top[1] + (bot[1] - top[1]) * t;
    const b = top[2] + (bot[2] - top[2]) * t;
    for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1 | 0); x++) {
      px(x, y, r, g, b, 1);
    }
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const CREAM_HI: RGB = [253, 243, 222];
const CREAM_LO: RGB = [238, 205, 158];
const PLATE: RGB = [252, 252, 248];
const PLATE_SHADE: RGB = [226, 220, 205];
const PANCAKE_TOP: RGB = [232, 178, 90];
const PANCAKE_MID: RGB = [214, 150, 58];
const PANCAKE_BOT: RGB = [168, 106, 30];
const TOAST: RGB = [146, 88, 26];
const SYRUP: RGB = [176, 92, 12];
const SYRUP_DARK: RGB = [133, 64, 8];
const SYRUP_HI: RGB = [255, 196, 110];
const BUTTER: RGB = [255, 214, 90];
const BUTTER_DARK: RGB = [240, 178, 40];
const BLUEBERRY: RGB = [52, 66, 138];
const BLUEBERRY_HI: RGB = [120, 140, 210];
const RASPBERRY: RGB = [198, 32, 66];
const RASPBERRY_HI: RGB = [244, 110, 140];
const MINT: RGB = [58, 150, 82];
const MINT_DARK: RGB = [34, 110, 56];
const SUGAR: RGB = [255, 255, 255];

// ---------------------------------------------------------------------------
// 1. Warm cream radial background
// ---------------------------------------------------------------------------
{
  const cx = W / 2;
  const cy = H * 0.42;
  const maxD = Math.hypot(W / 2, H / 2) * 1.15;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy) / maxD;
      const t = Math.min(1, d);
      const c = mix(CREAM_HI, CREAM_LO, t * t);
      const i = (y * W + x) * 3;
      img[i] = c[0];
      img[i + 1] = c[1];
      img[i + 2] = c[2];
    }
  }
}

// Soft vignette shadow under the plate (drawn first, plate covers center).
softDisc(512, 880, 420, [120, 80, 40], 0.16);

// ---------------------------------------------------------------------------
// 2. White plate (big ellipse, slightly below center)
// ---------------------------------------------------------------------------
const PLATE_CX = 512;
const PLATE_CY = 800;
const PLATE_RX = 430;
const PLATE_RY = 118;
fillEllipse(PLATE_CX, PLATE_CY, PLATE_RX, PLATE_RY, PLATE_SHADE, 1);
fillEllipse(PLATE_CX, PLATE_CY - 8, PLATE_RX - 8, PLATE_RY - 10, PLATE, 1);
// Plate rim highlight
fillEllipse(PLATE_CX, PLATE_CY - 14, PLATE_RX - 60, PLATE_RY - 34, [255, 255, 255], 0.55);
// Plate shadow where the stack sits
fillEllipse(PLATE_CX, PLATE_CY - 30, 330, 62, [190, 180, 160], 0.5);

// ---------------------------------------------------------------------------
// 3. Five-layer golden pancake stack
// ---------------------------------------------------------------------------
const STACK_CX = 512;
const STACK_TOP = 300;
const LAYER_H = 92;
const LAYER_GAP = 3;
const LAYER_RX = [335, 342, 330, 318, 300]; // slight width variation per layer

function drawPancake(layer: number, topY: number, rx: number): void {
  const h = LAYER_H;
  const midY = topY + h / 2;
  // Body: vertical gradient golden -> toasted
  vGradRect(STACK_CX - rx, topY + 14, STACK_CX + rx, topY + h - 6, PANCAKE_MID, PANCAKE_BOT);
  // Top face (lighter golden ellipse)
  fillEllipse(STACK_CX, topY + 16, rx, 26, PANCAKE_TOP, 1);
  fillEllipse(STACK_CX, topY + 14, rx - 18, 20, [240, 192, 108], 0.9);
  // Bottom toasted rim
  fillEllipse(STACK_CX, topY + h - 8, rx - 4, 16, TOAST, 0.85);
  // Toasted speckles on the side + top edge
  const n = 90;
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    const rr = Math.sqrt(rand());
    const x = STACK_CX + Math.cos(a) * rr * (rx - 14);
    const y = topY + 16 + rand() * (h - 26);
    const r = 1.5 + rand() * 3.5;
    const shade = rand();
    const c: RGB =
      shade < 0.6 ? [150, 92, 28] : shade < 0.85 ? [120, 70, 20] : [235, 190, 110];
    fillCircle(x, y, r, c, 0.5 + rand() * 0.4);
  }
  // Top-face speckles (denser, lighter toast)
  for (let i = 0; i < 46; i++) {
    const a = rand() * Math.PI * 2;
    const rr = Math.sqrt(rand());
    const x = STACK_CX + Math.cos(a) * rr * (rx - 22);
    const y = topY + 16 + Math.sin(a) * rr * 20;
    const r = 1 + rand() * 2.6;
    fillCircle(x, y, r, [160, 100, 32], 0.45 + rand() * 0.35);
  }
  void midY;
}

for (let l = 0; l < 5; l++) {
  drawPancake(l, STACK_TOP + l * (LAYER_H + LAYER_GAP), LAYER_RX[l]);
}
const STACK_BOT = STACK_TOP + 5 * LAYER_H + 4 * LAYER_GAP; // ~786

// ---------------------------------------------------------------------------
// 4. Maple syrup pool on top + drips down the sides
// ---------------------------------------------------------------------------
const SYRUP_CY = STACK_TOP + 8;
// Glossy pool on the top pancake
fillEllipse(STACK_CX, SYRUP_CY, 268, 40, SYRUP, 1);
fillEllipse(STACK_CX, SYRUP_CY - 4, 250, 32, [198, 108, 20], 1);
fillEllipse(STACK_CX - 60, SYRUP_CY - 12, 130, 12, SYRUP_HI, 0.5); // gloss sheen
fillEllipse(STACK_CX + 90, SYRUP_CY + 4, 70, 8, SYRUP_HI, 0.3);

// Drips running down the stack sides
const DRIPS: Array<[number, number, number]> = [
  // [x offset from center, length, width]
  [-268, 150, 15],
  [-205, 235, 13],
  [-132, 120, 16],
  [-58, 285, 14],
  [28, 180, 15],
  [108, 250, 13],
  [182, 140, 16],
  [248, 210, 14],
];
for (const [dx, len, w] of DRIPS) {
  const x = STACK_CX + dx;
  const y0 = SYRUP_CY + 6;
  const y1 = y0 + len;
  // Drip body: rounded streak
  fillRect(x - w / 2, y0, x + w / 2, y1 - w / 2, SYRUP, 0.96);
  fillCircle(x, y1 - w / 2, w / 2 + 1, SYRUP, 0.96);
  // Dark edge + bright gloss line
  fillRect(x + w / 2 - 3, y0, x + w / 2, y1 - w / 2, SYRUP_DARK, 0.55);
  fillRect(x - w / 2 + 2, y0, x - w / 2 + 5, y1 - w / 2, SYRUP_HI, 0.65);
}
// Syrup pooling at the plate base
fillEllipse(STACK_CX + 40, STACK_BOT - 6, 300, 26, SYRUP, 0.9);
fillEllipse(STACK_CX + 40, STACK_BOT - 10, 280, 18, [198, 108, 20], 0.9);
fillEllipse(STACK_CX - 80, STACK_BOT - 16, 120, 7, SYRUP_HI, 0.45);

// ---------------------------------------------------------------------------
// 5. Melting butter pat on top
// ---------------------------------------------------------------------------
{
  const bx = STACK_CX - 82;
  const by = SYRUP_CY - 52;
  const bw = 164;
  const bh = 58;
  // Melted butter puddle under the pat
  fillEllipse(STACK_CX - 10, by + bh - 4, 128, 20, BUTTER, 0.95);
  fillEllipse(STACK_CX - 10, by + bh - 8, 100, 13, [255, 226, 120], 0.95);
  // The pat: soft golden rounded block, slightly tilted look via offset top
  fillRoundRect(bx, by, bx + bw, by + bh, 16, BUTTER_DARK, 1);
  fillRoundRect(bx + 4, by, bx + bw - 4, by + bh - 10, 14, BUTTER, 1);
  fillRect(bx + 14, by + 6, bx + bw - 26, by + 16, [255, 232, 140], 0.9); // top highlight
  fillRect(bx + 10, by + bh - 16, bx + bw - 10, by + bh - 10, [250, 196, 70], 0.8);
}

// ---------------------------------------------------------------------------
// 6. Blueberries, raspberries, mint leaves
// ---------------------------------------------------------------------------
function blueberry(cx: number, cy: number, r: number): void {
  fillCircle(cx, cy, r, BLUEBERRY, 1);
  fillCircle(cx - r * 0.35, cy - r * 0.35, r * 0.55, [70, 86, 165], 0.9);
  fillCircle(cx - r * 0.3, cy - r * 0.38, r * 0.28, BLUEBERRY_HI, 0.95);
  // Crown star
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 - Math.PI / 2;
    fillCircle(cx + Math.cos(a) * r * 0.42, cy + Math.sin(a) * r * 0.42, r * 0.12, [30, 38, 90], 0.9);
  }
  fillCircle(cx, cy, r * 0.16, [30, 38, 90], 0.9);
}

function raspberry(cx: number, cy: number, r: number): void {
  // Cluster of drupelets
  const offs: Array<[number, number, number]> = [
    [0, -0.42, 0.42],
    [-0.42, -0.1, 0.4],
    [0.42, -0.1, 0.4],
    [-0.2, 0.3, 0.42],
    [0.22, 0.3, 0.42],
    [0, 0.05, 0.45],
  ];
  for (const [ox, oy, orr] of offs) {
    fillCircle(cx + ox * r, cy + oy * r, orr * r, RASPBERRY, 1);
    fillCircle(cx + ox * r - orr * r * 0.3, cy + oy * r - orr * r * 0.3, orr * r * 0.35, RASPBERRY_HI, 0.8);
  }
  fillCircle(cx - r * 0.3, cy - r * 0.4, r * 0.18, [255, 170, 190], 0.9);
}

function mintLeaf(cx: number, cy: number, len: number, angDeg: number): void {
  const a = (angDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const rx = len / 2;
  const ry = len * 0.22;
  // Leaf body: rotated ellipse sampled point by point
  for (let u = -rx; u <= rx; u += 1) {
    const t = u / rx;
    const half = ry * Math.sqrt(Math.max(0, 1 - t * t));
    for (let v = -half; v <= half; v += 1) {
      const x = cx + u * ca - v * sa;
      const y = cy + u * sa + v * ca;
      const edge = Math.abs(v) / Math.max(1, half);
      const c = edge > 0.8 ? MINT_DARK : MINT;
      px(x, y, c[0], c[1], c[2], 0.95);
    }
  }
  // Center vein
  for (let u = -rx + 4; u <= rx - 4; u += 2) {
    const x = cx + u * ca;
    const y = cy + u * sa;
    px(x, y, 190, 235, 200, 0.85);
    px(x, y + 1, 190, 235, 200, 0.6);
  }
}

// Berries + mint arranged on the syrup pool
blueberry(660, 268, 34);
blueberry(712, 296, 28);
blueberry(392, 292, 26);
raspberry(600, 252, 36);
raspberry(438, 262, 30);
raspberry(700, 330, 26);
mintLeaf(648, 300, 78, -24);
mintLeaf(372, 322, 70, 32);
mintLeaf(560, 236, 66, -58);

// A few berries resting on the plate beside the stack
blueberry(196, 792, 24);
blueberry(238, 812, 20);
raspberry(828, 800, 24);
raspberry(788, 822, 19);
mintLeaf(820, 768, 64, -18);

// ---------------------------------------------------------------------------
// 7. Powdered-sugar specks (110)
// ---------------------------------------------------------------------------
for (let i = 0; i < 110; i++) {
  // Scatter mostly over the top pancake + upper layers
  const a = rand() * Math.PI * 2;
  const rr = Math.sqrt(rand());
  const cx = STACK_CX + Math.cos(a) * rr * 300;
  const cy = STACK_TOP + 10 + rand() * 300;
  const r = 0.8 + rand() * 1.8;
  px(cx, cy, 255, 255, 255, 0.55 + rand() * 0.4);
  if (rand() < 0.4) px(cx + 1, cy, 255, 255, 255, 0.5);
  void r;
}

// ---------------------------------------------------------------------------
// 8. Soft translucent steam wisps above the stack
// ---------------------------------------------------------------------------
function steamWisp(x0: number, yTop: number, yBot: number, phase: number, amp: number): void {
  const steps = 26;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const y = yBot - t * (yBot - yTop);
    const x = x0 + Math.sin(t * Math.PI * 2.2 + phase) * amp * t;
    const r = 12 + t * 30;
    const a = 0.10 * (1 - t) + 0.02;
    softDisc(x, y, r, [255, 255, 255], a);
  }
}
steamWisp(430, 96, 268, 0.4, 26);
steamWisp(512, 70, 262, 2.1, 30);
steamWisp(596, 100, 270, 4.0, 24);
steamWisp(470, 120, 272, 5.3, 18);

// ---------------------------------------------------------------------------
// PNG encoder — truecolor, 8-bit, per-scanline best-of-5 filter, zlib.
// ---------------------------------------------------------------------------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function encodePNG(): Buffer {
  const bpp = 3;
  const raw = Buffer.alloc(H * (1 + W * bpp));
  const prev = Buffer.alloc(W * bpp);
  const cur = Buffer.alloc(W * bpp);
  const filt = Buffer.alloc(W * bpp);
  for (let y = 0; y < H; y++) {
    cur.set(img.subarray(y * W * bpp, (y + 1) * W * bpp));
    // Try filters 0..4, keep the one with smallest sum of |signed byte|.
    let bestType = 0;
    let bestScore = Infinity;
    let bestBuf = Buffer.alloc(W * bpp);
    for (let ft = 0; ft <= 4; ft++) {
      let score = 0;
      for (let x = 0; x < W * bpp; x++) {
        const left = x >= bpp ? cur[x - bpp] : 0;
        const up = prev[x];
        const upLeft = x >= bpp ? prev[x - bpp] : 0;
        let v: number;
        switch (ft) {
          case 0:
            v = cur[x];
            break;
          case 1:
            v = cur[x] - left;
            break;
          case 2:
            v = cur[x] - up;
            break;
          case 3:
            v = cur[x] - ((left + up) >> 1);
            break;
          default:
            v = cur[x] - paeth(left, up, upLeft);
            break;
        }
        const b = v & 0xff;
        filt[x] = b;
        score += b < 128 ? b : 256 - b;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = ft;
        bestBuf = Buffer.from(filt);
      }
    }
    raw[y * (1 + W * bpp)] = bestType;
    bestBuf.copy(raw, y * (1 + W * bpp) + 1);
    prev.set(cur);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const outDir = process.env.OUTPUT_DIR || "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const png = encodePNG();
  const outPath = path.join(outDir, "entry.png");
  fs.writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes, ${W}x${H})`);
}

main();
