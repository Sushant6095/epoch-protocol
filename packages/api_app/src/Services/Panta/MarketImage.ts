import { createHash } from 'crypto';
import { deflateSync } from 'zlib';

/**
 * The catalog image of Epoch's Panta markets (1024×1024 PNG, Panta's recommended size), drawn here and served at
 * GET /v1/predict/panta/market-image.png, the bot's default PANTA_MARKET_IMAGE_URL. No image library: a bar chart of
 * epochs, a dashed strike line and "FEE INDEX" in a 5×7 dot font, encoded with node:zlib. Same bytes every time.
 */

export const MARKET_IMAGE_SIZE = 1024;

type Rgb = readonly [number, number, number];

const INK: Rgb = [0xf8, 0xfa, 0xfc];
const MUTED: Rgb = [0x94, 0xa3, 0xb8];
const BAR_LOW: Rgb = [0x0e, 0xa5, 0xe9];
const BAR_HIGH: Rgb = [0x2d, 0xd4, 0xbf];
const STRIKE: Rgb = [0xf5, 0x9e, 0x0b];
const BG_TOP: Rgb = [0x0a, 0x0f, 0x1f];
const BG_BOTTOM: Rgb = [0x14, 0x1d, 0x3b];

/** 5×7 glyphs, rows top to bottom, bit 4 = leftmost column. */
const GLYPHS: Record<string, number[]> = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  C: [0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};

class Canvas {
  readonly pixels: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8Array(width * height * 3);
  }

  fill(x0: number, y0: number, w: number, h: number, color: Rgb): void {
    const x1 = Math.min(this.width, Math.max(0, Math.round(x0 + w)));
    const y1 = Math.min(this.height, Math.max(0, Math.round(y0 + h)));
    for (let y = Math.max(0, Math.round(y0)); y < y1; y++) {
      for (let x = Math.max(0, Math.round(x0)); x < x1; x++) {
        const i = (y * this.width + x) * 3;
        this.pixels[i] = color[0];
        this.pixels[i + 1] = color[1];
        this.pixels[i + 2] = color[2];
      }
    }
  }

  /** Text in the dot font, centred on `centerX`; each dot is `scale` px with a 1 px gap (an LED board). */
  text(value: string, centerX: number, top: number, scale: number, color: Rgb): void {
    const advance = 6 * scale;
    const width = value.length * advance - scale;
    let x = Math.round(centerX - width / 2);
    for (const char of value) {
      const rows = GLYPHS[char] ?? GLYPHS[' '];
      rows.forEach((bits, row) => {
        for (let col = 0; col < 5; col++) {
          if (bits & (1 << (4 - col))) this.fill(x + col * scale, top + row * scale, scale - 1, scale - 1, color);
        }
      });
      x += advance;
    }
  }
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** Raw RGB of the image. */
export function drawMarketImage(size = MARKET_IMAGE_SIZE): Canvas {
  const canvas = new Canvas(size, size);
  const unit = size / 1024;
  for (let y = 0; y < size; y++) canvas.fill(0, y, size, 1, mix(BG_TOP, BG_BOTTOM, y / (size - 1)));

  canvas.text('FEE INDEX', size / 2, 120 * unit, Math.max(2, Math.round(13 * unit)), INK);
  canvas.text('SOLANA  EPOCH', size / 2, 250 * unit, Math.max(2, Math.round(6 * unit)), MUTED);

  // Sixteen epochs of a fee index: a deterministic, plausible shape (not data).
  const bars = 16;
  const left = 96 * unit;
  const right = size - 96 * unit;
  const floor = 900 * unit;
  const tallest = 460 * unit;
  const slot = (right - left) / bars;
  const heights = Array.from(
    { length: bars },
    (_, i) => 0.55 + 0.25 * Math.sin(i / 2.2) + 0.15 * Math.sin(i * 1.7 + 1),
  );
  heights.forEach((h, i) => {
    const height = Math.max(0.15, Math.min(1, h)) * tallest;
    const top = floor - height;
    const x = left + i * slot + slot * 0.14;
    const width = slot * 0.72;
    for (let y = Math.round(top); y < floor; y++)
      canvas.fill(x, y, width, 1, mix(BAR_HIGH, BAR_LOW, (y - top) / height));
  });
  canvas.fill(left, floor + 6 * unit, right - left, Math.max(1, 4 * unit), MUTED);

  // The strike: a dashed line across the chart.
  const strikeY = floor - 0.62 * tallest;
  const dash = 30 * unit;
  for (let x = left - 24 * unit; x < right + 24 * unit; x += dash * 1.6) {
    canvas.fill(x, strikeY - 4 * unit, dash, Math.max(2, 8 * unit), STRIKE);
  }
  return canvas;
}

// ── PNG ─────────────────────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An 8-bit RGB PNG (filter 0 on every row, one IDAT). */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let cached: { png: Buffer; etag: string } | null = null;

/** The PNG and its ETag, drawn once per process. */
export function marketImage(): { png: Buffer; etag: string } {
  if (!cached) {
    const canvas = drawMarketImage();
    const png = encodePng(canvas.width, canvas.height, canvas.pixels);
    cached = { png, etag: `"${createHash('sha256').update(png).digest('hex').slice(0, 32)}"` };
  }
  return cached;
}
