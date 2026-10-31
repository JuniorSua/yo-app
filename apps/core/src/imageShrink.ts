/**
 * Phone-sized pictures without an image library. Pictures go to the phone through a tiny encrypted relay where
 * every byte counts, so each one is shrunk to roughly <= 1280 px on its longest side and a few hundred KB.
 *
 * - PNG (mostly screenshots): decoded here (every color type and bit depth, PLTE/tRNS, Adam7), alpha composited
 *   onto white, box-filtered down, and re-encoded as a baseline 4:2:0 JPEG. If the original PNG already fits and
 *   is smaller than the JPEG, the PNG is kept as-is.
 * - JPEG / GIF / WebP: there is no decoder, so they pass through untouched when they already fit, else null.
 *
 * Pure TypeScript + node:zlib; never throws.
 */
import { inflateSync } from "node:zlib";

export interface ShrunkImage {
  bytes: Buffer;
  mime: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  width: number;
  height: number;
}

export interface ShrinkOptions {
  /** Longest side in pixels after shrinking (default 1280). Never upscales. */
  maxSide?: number;
  /** Byte budget for the result (default 300 000). */
  maxBytes?: number;
  /** Starting JPEG quality, 1-100 (default 80); lowered automatically when the picture doesn't fit. */
  quality?: number;
}

type ImageInfo = { mime: ShrunkImage["mime"]; width: number; height: number };

/** Decompression-bomb guard: refuse anything bigger than this many pixels. */
const MAX_PIXELS = 40_000_000;
/** Pictures we can't decode (JPEG/GIF/WebP) pass through only up to this longest side. */
const PASS_THROUGH_MAX_SIDE = 4096;
/** When shrinking further to fit the byte budget, stop at this longest side. */
const MIN_SIDE = 480;
const FALLBACK_QUALITIES = [65, 50];
const SIDE_STEP = 0.75;

// ---------------------------------------------------------------------------------------------------------------
// Sniffing

/** Sniff type by magic bytes and read width/height (PNG IHDR, JPEG SOFn, GIF logical screen, WebP VP8/VP8L/VP8X). null if unknown. */
export function imageInfo(buf: Buffer): ImageInfo | null {
  try {
    const b = asBuffer(buf);
    return b ? sniff(b) : null;
  } catch {
    return null;
  }
}

function asBuffer(buf: unknown): Buffer | null {
  if (Buffer.isBuffer(buf)) return buf;
  if (buf instanceof Uint8Array) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return null;
}

function dims(mime: ImageInfo["mime"], width: number, height: number): ImageInfo | null {
  return width > 0 && height > 0 ? { mime, width, height } : null;
}

function sniff(b: Buffer): ImageInfo | null {
  if (
    b.length >= 24 &&
    b.readUInt32BE(0) === 0x89504e47 &&
    b.readUInt32BE(4) === 0x0d0a1a0a &&
    b.toString("latin1", 12, 16) === "IHDR"
  ) {
    return dims("image/png", b.readUInt32BE(16), b.readUInt32BE(20));
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegInfo(b);
  if (b.length >= 10) {
    const sig = b.toString("latin1", 0, 6);
    if (sig === "GIF87a" || sig === "GIF89a") return dims("image/gif", b.readUInt16LE(6), b.readUInt16LE(8));
  }
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    return webpInfo(b);
  }
  return null;
}

function jpegInfo(b: Buffer): ImageInfo | null {
  let i = 2;
  while (i + 9 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xff) {
      i++; // fill byte
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2; // standalone markers
      continue;
    }
    if (m === 0xd9 || m === 0xda) return null; // end of image / scan before any frame header
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return dims("image/jpeg", b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
    }
    i += 2 + len;
  }
  return null;
}

function webpInfo(b: Buffer): ImageInfo | null {
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return dims("image/webp", b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return dims("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") return dims("image/webp", b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Shrinking

/** Returns a phone-sized picture, or null if it can't be made to fit (caller then says "N more pictures in Yo"). Never throws. */
export function shrinkImage(buf: Buffer, opts: ShrinkOptions = {}): ShrunkImage | null {
  try {
    const b = asBuffer(buf);
    return b ? shrink(b, opts ?? {}) : null;
  } catch {
    return null;
  }
}

function positive(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

function shrink(input: Buffer, opts: ShrinkOptions): ShrunkImage | null {
  const maxSide = positive(opts.maxSide, 1280);
  const maxBytes = positive(opts.maxBytes, 300_000);
  const quality = Math.min(100, positive(opts.quality, 80));
  const info = sniff(input);
  if (!info) return null;
  const longest = Math.max(info.width, info.height);
  if (info.mime !== "image/png") {
    return input.length <= maxBytes && longest <= PASS_THROUGH_MAX_SIDE ? { bytes: input, ...info } : null;
  }
  const img = decodePng(input);
  if (!img) return null;

  // A PNG that already fits is a valid answer; only swap it for a JPEG when that's smaller.
  const fitsAsIs = input.length <= maxBytes && longest <= maxSide;
  const qualities = [quality, ...FALLBACK_QUALITIES.filter((q) => q < quality)];
  let side = Math.min(maxSide, longest);
  const minSide = Math.min(MIN_SIDE, side);
  for (let round = 0; ; round++) {
    const scale = side / longest;
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const px = resize(img.rgb, img.width, img.height, w, h);
    for (const q of round === 0 ? qualities : qualities.slice(-1)) {
      const jpg = encodeJpeg(px, w, h, q, fitsAsIs ? input.length : maxBytes);
      if (jpg) return { bytes: jpg, mime: "image/jpeg", width: w, height: h };
      if (fitsAsIs) return { bytes: input, mime: "image/png", width: img.width, height: img.height };
    }
    if (side <= minSide) return null;
    side = Math.max(minSide, Math.round(side * SIDE_STEP));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// PNG decoding → 8-bit RGB (alpha composited onto white)

interface Raster {
  rgb: Uint8Array;
  width: number;
  height: number;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
/** [x0, y0, dx, dy] for each Adam7 pass. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;
const NO_INTERLACE = [[0, 0, 1, 1]] as const;

function decodePng(b: Buffer): Raster | null {
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString("latin1", pos + 4, pos + 8);
    const start = pos + 8;
    const end = start + len;
    if (end > b.length) return null; // truncated
    const data = b.subarray(start, end);
    if (pos === 8 && type !== "IHDR") return null;
    if (type === "IHDR") {
      if (len < 13) return null;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      colorType = data[9]!;
      if (data[10] !== 0 || data[11] !== 0) return null;
      interlace = data[12]!;
    } else if (type === "PLTE") {
      palette = new Uint8Array(768);
      palette.set(data.subarray(0, Math.min(768, len - (len % 3))));
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos = end + 4;
  }
  const channels = CHANNELS[colorType];
  if (!channels || !DEPTHS[colorType]!.includes(depth) || interlace > 1) return null;
  if (width < 1 || height < 1 || width * height > MAX_PIXELS) return null;
  if (colorType === 3 && !palette) return null;
  if (idat.length === 0) return null;

  const passes = interlace ? ADAM7 : NO_INTERLACE;
  const bitsPerPixel = channels * depth;
  let expected = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw > 0 && ph > 0) expected += ph * (1 + Math.ceil((pw * bitsPerPixel) / 8));
  }
  // maxOutputLength makes zlib refuse (throw) rather than inflate more than the image can hold.
  const raw = inflateSync(idat.length === 1 ? idat[0]! : Buffer.concat(idat), { maxOutputLength: expected });
  if (raw.length < expected) return null;

  const convert = rowConverter(colorType, depth, palette, trns);
  const rgb = new Uint8Array(width * height * 3);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  let off = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8);
    let prev: Uint8Array | null = null;
    for (let y = 0; y < ph; y++) {
      const filter = raw[off]!;
      const row = raw.subarray(off + 1, off + 1 + rowBytes);
      if (!unfilter(filter, row, prev, bpp)) return null;
      convert(row, pw, rgb, ((y0 + y * dy) * width + x0) * 3, dx * 3);
      prev = row;
      off += 1 + rowBytes;
    }
  }
  return { rgb, width, height };
}

function unfilter(filter: number, row: Uint8Array, prev: Uint8Array | null, bpp: number): boolean {
  const n = row.length;
  switch (filter) {
    case 0:
      return true;
    case 1:
      for (let i = bpp; i < n; i++) row[i] = row[i]! + row[i - bpp]!;
      return true;
    case 2:
      if (prev) for (let i = 0; i < n; i++) row[i] = row[i]! + prev[i]!;
      return true;
    case 3:
      if (prev) {
        for (let i = 0; i < bpp; i++) row[i] = row[i]! + (prev[i]! >> 1);
        for (let i = bpp; i < n; i++) row[i] = row[i]! + ((row[i - bpp]! + prev[i]!) >> 1);
      } else {
        for (let i = bpp; i < n; i++) row[i] = row[i]! + (row[i - bpp]! >> 1);
      }
      return true;
    case 4:
      if (prev) {
        for (let i = 0; i < bpp; i++) row[i] = row[i]! + prev[i]!;
        for (let i = bpp; i < n; i++) {
          const a = row[i - bpp]!;
          const b = prev[i]!;
          const c = prev[i - bpp]!;
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - c - c);
          row[i] = row[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
      } else {
        for (let i = bpp; i < n; i++) row[i] = row[i]! + row[i - bpp]!; // paeth with no row above = sub
      }
      return true;
    default:
      return false;
  }
}

/** Color channel `c` with alpha `a` composited onto white. */
function over(c: number, a: number): number {
  return 255 - ((((255 - c) * a + 127) / 255) | 0);
}

type RowConverter = (row: Uint8Array, n: number, out: Uint8Array, dst: number, step: number) => void;

function rowConverter(
  colorType: number,
  depth: number,
  palette: Uint8Array | null,
  trns: Buffer | null,
): RowConverter {
  if (depth === 8 && colorType === 6) {
    return (row, n, out, dst, step) => {
      for (let x = 0, s = 0; x < n; x++, s += 4, dst += step) {
        const a = row[s + 3]!;
        if (a === 255) {
          out[dst] = row[s]!;
          out[dst + 1] = row[s + 1]!;
          out[dst + 2] = row[s + 2]!;
        } else {
          out[dst] = over(row[s]!, a);
          out[dst + 1] = over(row[s + 1]!, a);
          out[dst + 2] = over(row[s + 2]!, a);
        }
      }
    };
  }
  if (depth === 8 && colorType === 2 && !trns) {
    return (row, n, out, dst, step) => {
      for (let x = 0, s = 0; x < n; x++, s += 3, dst += step) {
        out[dst] = row[s]!;
        out[dst + 1] = row[s + 1]!;
        out[dst + 2] = row[s + 2]!;
      }
    };
  }

  const maxv = depth === 16 ? 0xffff : (1 << depth) - 1;
  const sample = (row: Uint8Array, i: number): number => {
    if (depth === 8) return row[i]!;
    if (depth === 16) return (row[2 * i]! << 8) | row[2 * i + 1]!;
    const bit = i * depth;
    return (row[bit >> 3]! >> (8 - depth - (bit & 7))) & maxv;
  };
  const to8 = (v: number): number => (depth === 16 ? v >> 8 : depth === 8 ? v : ((v * 255) / maxv) | 0);
  const pal = palette ?? new Uint8Array(768);
  const palAlpha = new Uint8Array(256).fill(255);
  if (colorType === 3 && trns) palAlpha.set(trns.subarray(0, 256));
  const tGray = colorType === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
  const tRgb = colorType === 2 && trns && trns.length >= 6 ? trns : null;
  const tR = tRgb ? tRgb.readUInt16BE(0) : -1;
  const tG = tRgb ? tRgb.readUInt16BE(2) : -1;
  const tB = tRgb ? tRgb.readUInt16BE(4) : -1;

  return (row, n, out, dst, step) => {
    for (let x = 0; x < n; x++, dst += step) {
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      if (colorType === 0) {
        const v = sample(row, x);
        r = g = b = to8(v);
        if (v === tGray) a = 0;
      } else if (colorType === 2) {
        const rv = sample(row, 3 * x);
        const gv = sample(row, 3 * x + 1);
        const bv = sample(row, 3 * x + 2);
        r = to8(rv);
        g = to8(gv);
        b = to8(bv);
        if (rv === tR && gv === tG && bv === tB) a = 0;
      } else if (colorType === 3) {
        const i = sample(row, x);
        r = pal[3 * i]!;
        g = pal[3 * i + 1]!;
        b = pal[3 * i + 2]!;
        a = palAlpha[i]!;
      } else if (colorType === 4) {
        r = g = b = to8(sample(row, 2 * x));
        a = to8(sample(row, 2 * x + 1));
      } else {
        r = to8(sample(row, 4 * x));
        g = to8(sample(row, 4 * x + 1));
        b = to8(sample(row, 4 * x + 2));
        a = to8(sample(row, 4 * x + 3));
      }
      if (a === 255) {
        out[dst] = r;
        out[dst + 1] = g;
        out[dst + 2] = b;
      } else {
        out[dst] = over(r, a);
        out[dst + 1] = over(g, a);
        out[dst + 2] = over(b, a);
      }
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Area-average (box) downscale, separable

interface BoxWeights {
  first: Int32Array;
  count: Int32Array;
  weight: Float32Array;
  span: number;
}

function boxWeights(src: number, dst: number): BoxWeights {
  const scale = src / dst;
  const span = Math.ceil(scale) + 1;
  const first = new Int32Array(dst);
  const count = new Int32Array(dst);
  const weight = new Float32Array(dst * span);
  for (let o = 0; o < dst; o++) {
    const lo = o * scale;
    const hi = Math.min(src, (o + 1) * scale);
    const i0 = Math.min(src - 1, Math.floor(lo));
    const i1 = Math.max(i0 + 1, Math.min(src, Math.ceil(hi)));
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += Math.max(0, Math.min(hi, i + 1) - Math.max(lo, i));
    first[o] = i0;
    count[o] = i1 - i0;
    for (let i = i0; i < i1; i++) {
      const w = Math.max(0, Math.min(hi, i + 1) - Math.max(lo, i));
      weight[o * span + i - i0] = sum > 0 ? w / sum : 1 / (i1 - i0);
    }
  }
  return { first, count, weight, span };
}

function resize(src: Uint8Array, w: number, h: number, ow: number, oh: number): Uint8Array {
  if (ow === w && oh === h) return src;
  const hx = boxWeights(w, ow);
  const vy = boxWeights(h, oh);
  const tmp = new Float32Array(ow * h * 3);
  for (let y = 0; y < h; y++) {
    const s0 = y * w * 3;
    let t = y * ow * 3;
    for (let ox = 0; ox < ow; ox++, t += 3) {
      const f = hx.first[ox]!;
      const n = hx.count[ox]!;
      const wo = ox * hx.span;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < n; k++) {
        const wt = hx.weight[wo + k]!;
        const s = s0 + (f + k) * 3;
        r += wt * src[s]!;
        g += wt * src[s + 1]!;
        b += wt * src[s + 2]!;
      }
      tmp[t] = r;
      tmp[t + 1] = g;
      tmp[t + 2] = b;
    }
  }
  const rowLen = ow * 3;
  const out = new Uint8ClampedArray(rowLen * oh);
  const acc = new Float32Array(rowLen);
  for (let oy = 0; oy < oh; oy++) {
    acc.fill(0);
    const f = vy.first[oy]!;
    const n = vy.count[oy]!;
    const wo = oy * vy.span;
    for (let k = 0; k < n; k++) {
      const wt = vy.weight[wo + k]!;
      const r0 = (f + k) * rowLen;
      for (let i = 0; i < rowLen; i++) acc[i] = acc[i]! + wt * tmp[r0 + i]!;
    }
    out.set(acc, oy * rowLen); // clamped + rounded
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

// ---------------------------------------------------------------------------------------------------------------
// Baseline JPEG encoder (JFIF, YCbCr 4:2:0, IJG tables, standard Huffman tables, AAN float DCT)

/** ZIGZAG[k] = natural (row-major) index of the k-th coefficient in zigzag order. */
const ZIGZAG = (() => {
  const z = new Uint8Array(64);
  let k = 0;
  for (let s = 0; s < 15; s++) {
    const lo = Math.max(0, s - 7);
    const hi = Math.min(s, 7);
    if (s % 2 === 0) for (let r = hi; r >= lo; r--) z[k++] = r * 8 + (s - r);
    else for (let r = lo; r <= hi; r++) z[k++] = r * 8 + (s - r);
  }
  return z;
})();

const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22,
  29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103,
  121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71,
  0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37,
  0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83,
  0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
  0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22,
  0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1,
  0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36,
  0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a,
  0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a,
  0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba,
  0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

interface Huffman {
  code: Uint16Array;
  len: Uint8Array;
}

function huffman(bits: number[], vals: number[]): Huffman {
  const code = new Uint16Array(256);
  const len = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < bits[l - 1]!; i++, k++, c++) {
      code[vals[k]!] = c;
      len[vals[k]!] = l;
    }
    c <<= 1;
  }
  return { code, len };
}

const DC_LUMA = huffman(DC_LUMA_BITS, DC_VALS);
const DC_CHROMA = huffman(DC_CHROMA_BITS, DC_VALS);
const AC_LUMA = huffman(AC_LUMA_BITS, AC_LUMA_VALS);
const AC_CHROMA = huffman(AC_CHROMA_BITS, AC_CHROMA_VALS);

const AAN_SCALE = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

/** Quant table (natural order, IJG quality scaling) and the matching AAN divisors. */
function quantTables(base: number[], quality: number): { q: Uint8Array; div: Float32Array } {
  const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  const q = new Uint8Array(64);
  const div = new Float32Array(64);
  for (let i = 0; i < 64; i++) {
    q[i] = Math.min(255, Math.max(1, Math.floor((base[i]! * scale + 50) / 100)));
    div[i] = 1 / (q[i]! * AAN_SCALE[i >> 3]! * AAN_SCALE[i & 7]! * 8);
  }
  return { q, div };
}

/** Growable byte sink with a JPEG entropy-coded bit writer (0xFF byte stuffing). */
class JpegWriter {
  buf: Uint8Array;
  pos = 0;
  private acc = 0;
  private nbits = 0;

  constructor(size: number) {
    this.buf = new Uint8Array(size);
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  bytes(arr: ArrayLike<number>): void {
    this.ensure(arr.length);
    for (let i = 0; i < arr.length; i++) this.buf[this.pos++] = arr[i]!;
  }

  u16(v: number): void {
    this.bytes([(v >> 8) & 0xff, v & 0xff]);
  }

  bits(code: number, len: number): void {
    this.acc = (this.acc << len) | code;
    this.nbits += len;
    if (this.nbits < 8) return;
    this.ensure(8);
    while (this.nbits >= 8) {
      this.nbits -= 8;
      const byte = (this.acc >>> this.nbits) & 0xff;
      this.buf[this.pos++] = byte;
      if (byte === 0xff) this.buf[this.pos++] = 0;
    }
    this.acc &= (1 << this.nbits) - 1;
  }

  flushBits(): void {
    if (this.nbits > 0) this.bits((1 << (8 - this.nbits)) - 1, 8 - this.nbits);
  }
}

/** In-place AAN forward DCT on an 8×8 block (IJG jfdctflt); output is scaled by AAN_SCALE[r]*AAN_SCALE[c]*8. */
function fdct(d: Float32Array): void {
  for (let pass = 0; pass < 2; pass++) {
    const stride = pass === 0 ? 1 : 8; // rows, then columns
    const next = pass === 0 ? 8 : 1;
    for (let line = 0, o = 0; line < 8; line++, o += next) {
      const i0 = o;
      const i1 = o + stride;
      const i2 = o + 2 * stride;
      const i3 = o + 3 * stride;
      const i4 = o + 4 * stride;
      const i5 = o + 5 * stride;
      const i6 = o + 6 * stride;
      const i7 = o + 7 * stride;
      const tmp0 = d[i0]! + d[i7]!;
      const tmp7 = d[i0]! - d[i7]!;
      const tmp1 = d[i1]! + d[i6]!;
      const tmp6 = d[i1]! - d[i6]!;
      const tmp2 = d[i2]! + d[i5]!;
      const tmp5 = d[i2]! - d[i5]!;
      const tmp3 = d[i3]! + d[i4]!;
      const tmp4 = d[i3]! - d[i4]!;

      let tmp10 = tmp0 + tmp3;
      const tmp13 = tmp0 - tmp3;
      let tmp11 = tmp1 + tmp2;
      let tmp12 = tmp1 - tmp2;
      d[i0] = tmp10 + tmp11;
      d[i4] = tmp10 - tmp11;
      const z1 = (tmp12 + tmp13) * Math.SQRT1_2;
      d[i2] = tmp13 + z1;
      d[i6] = tmp13 - z1;

      tmp10 = tmp4 + tmp5;
      tmp11 = tmp5 + tmp6;
      tmp12 = tmp6 + tmp7;
      const z5 = (tmp10 - tmp12) * 0.382683433;
      const z2 = 0.5411961 * tmp10 + z5;
      const z4 = 1.306562965 * tmp12 + z5;
      const z3 = tmp11 * Math.SQRT1_2;
      const z11 = tmp7 + z3;
      const z13 = tmp7 - z3;
      d[i5] = z13 + z2;
      d[i3] = z13 - z2;
      d[i1] = z11 + z4;
      d[i7] = z11 - z4;
    }
  }
}

const block = new Float32Array(64);
const coefs = new Int32Array(64);

function encodeBlock(
  out: JpegWriter,
  plane: Float32Array,
  stride: number,
  x0: number,
  y0: number,
  div: Float32Array,
  prevDc: number,
  dc: Huffman,
  ac: Huffman,
): number {
  for (let y = 0, k = 0; y < 8; y++) {
    const s = (y0 + y) * stride + x0;
    for (let x = 0; x < 8; x++, k++) block[k] = plane[s + x]!;
  }
  fdct(block);
  for (let k = 0; k < 64; k++) {
    const n = ZIGZAG[k]!;
    coefs[k] = Math.round(block[n]! * div[n]!);
  }

  const dcValue = coefs[0]!;
  writeValue(out, dc, 0, Math.max(-2047, Math.min(2047, dcValue - prevDc)));
  let last = 63;
  while (last > 0 && coefs[last] === 0) last--;
  let run = 0;
  for (let k = 1; k <= last; k++) {
    const v = coefs[k]!;
    if (v === 0) {
      run++;
      continue;
    }
    while (run >= 16) {
      out.bits(ac.code[0xf0]!, ac.len[0xf0]!);
      run -= 16;
    }
    writeValue(out, ac, run << 4, Math.max(-1023, Math.min(1023, v)));
    run = 0;
  }
  if (last < 63) out.bits(ac.code[0]!, ac.len[0]!); // EOB
  return dcValue;
}

/** Huffman symbol (run << 4 | size) followed by the value's `size` extra bits. */
function writeValue(out: JpegWriter, table: Huffman, runBits: number, v: number): void {
  if (v === 0) {
    out.bits(table.code[runBits]!, table.len[runBits]!);
    return;
  }
  const size = 32 - Math.clz32(v < 0 ? -v : v);
  const sym = runBits | size;
  out.bits(table.code[sym]!, table.len[sym]!);
  out.bits(v < 0 ? v + (1 << size) - 1 : v, size);
}

function writeHeaders(out: JpegWriter, w: number, h: number, lq: Uint8Array, cq: Uint8Array): void {
  out.bytes([0xff, 0xd8]); // SOI
  // APP0 JFIF 1.1, no density units, no thumbnail
  out.bytes([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  // DQT: table 0 (luma), table 1 (chroma), zigzag order
  out.bytes([0xff, 0xdb]);
  out.u16(2 + 2 * 65);
  for (const [id, q] of [[0, lq] as const, [1, cq] as const]) {
    out.bytes([id]);
    for (let k = 0; k < 64; k++) out.bytes([q[ZIGZAG[k]!]!]);
  }
  // SOF0: 8-bit, 3 components; Y 2×2 sampled with table 0, Cb/Cr 1×1 with table 1
  out.bytes([0xff, 0xc0]);
  out.u16(17);
  out.bytes([8]);
  out.u16(h);
  out.u16(w);
  out.bytes([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  // DHT
  const tables = [
    [0x00, DC_LUMA_BITS, DC_VALS],
    [0x10, AC_LUMA_BITS, AC_LUMA_VALS],
    [0x01, DC_CHROMA_BITS, DC_VALS],
    [0x11, AC_CHROMA_BITS, AC_CHROMA_VALS],
  ] as const;
  out.bytes([0xff, 0xc4]);
  out.u16(2 + tables.reduce((n, [, , vals]) => n + 17 + vals.length, 0));
  for (const [cls, bits, vals] of tables) {
    out.bytes([cls]);
    out.bytes(bits);
    out.bytes(vals);
  }
  // SOS: Y uses DC0/AC0, Cb and Cr use DC1/AC1; full spectral range, no approximation
  out.bytes([0xff, 0xda]);
  out.u16(12);
  out.bytes([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
}

/** Baseline JPEG of an 8-bit RGB raster, or null if it would exceed `limit` bytes. */
function encodeJpeg(rgb: Uint8Array, w: number, h: number, quality: number, limit: number): Buffer | null {
  const luma = quantTables(LUMA_Q, quality);
  const chroma = quantTables(CHROMA_Q, quality);
  const mcuX = Math.ceil(w / 16);
  const mcuY = Math.ceil(h / 16);
  const pw = mcuX * 16;
  const ph = mcuY * 16;
  const cw = pw / 2;
  const ch = ph / 2;

  // Level-shifted planes, edges replicated into the padding. Chroma is averaged over 2×2 (4:2:0).
  const Y = new Float32Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    const sRow = Math.min(y, h - 1) * w;
    for (let x = 0; x < pw; x++) {
      const s = (sRow + Math.min(x, w - 1)) * 3;
      Y[y * pw + x] = 0.299 * rgb[s]! + 0.587 * rgb[s + 1]! + 0.114 * rgb[s + 2]! - 128;
    }
  }
  const Cb = new Float32Array(cw * ch);
  const Cr = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    const ra = Math.min(2 * cy, h - 1) * w;
    const rb = Math.min(2 * cy + 1, h - 1) * w;
    for (let cx = 0; cx < cw; cx++) {
      const xa = Math.min(2 * cx, w - 1);
      const xb = Math.min(2 * cx + 1, w - 1);
      const p0 = (ra + xa) * 3;
      const p1 = (ra + xb) * 3;
      const p2 = (rb + xa) * 3;
      const p3 = (rb + xb) * 3;
      const r = (rgb[p0]! + rgb[p1]! + rgb[p2]! + rgb[p3]!) / 4;
      const g = (rgb[p0 + 1]! + rgb[p1 + 1]! + rgb[p2 + 1]! + rgb[p3 + 1]!) / 4;
      const b = (rgb[p0 + 2]! + rgb[p1 + 2]! + rgb[p2 + 2]! + rgb[p3 + 2]!) / 4;
      Cb[cy * cw + cx] = -0.168736 * r - 0.331264 * g + 0.5 * b;
      Cr[cy * cw + cx] = 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
  }

  const out = new JpegWriter(Math.min(limit + 1024, 1 << 20));
  writeHeaders(out, w, h, luma.q, chroma.q);
  let dcY = 0;
  let dcCb = 0;
  let dcCr = 0;
  for (let my = 0; my < mcuY; my++) {
    for (let mx = 0; mx < mcuX; mx++) {
      const x = mx * 16;
      const y = my * 16;
      dcY = encodeBlock(out, Y, pw, x, y, luma.div, dcY, DC_LUMA, AC_LUMA);
      dcY = encodeBlock(out, Y, pw, x + 8, y, luma.div, dcY, DC_LUMA, AC_LUMA);
      dcY = encodeBlock(out, Y, pw, x, y + 8, luma.div, dcY, DC_LUMA, AC_LUMA);
      dcY = encodeBlock(out, Y, pw, x + 8, y + 8, luma.div, dcY, DC_LUMA, AC_LUMA);
      dcCb = encodeBlock(out, Cb, cw, mx * 8, my * 8, chroma.div, dcCb, DC_CHROMA, AC_CHROMA);
      dcCr = encodeBlock(out, Cr, cw, mx * 8, my * 8, chroma.div, dcCr, DC_CHROMA, AC_CHROMA);
    }
    if (out.pos > limit) return null; // give up early; the caller retries smaller
  }
  out.flushBits();
  out.bytes([0xff, 0xd9]); // EOI
  if (out.pos > limit) return null;
  return Buffer.from(out.buf.subarray(0, out.pos)); // copy, so the oversized work buffer can be freed
}
