/**
 * imageShrink: PNG decoding (every color type / bit depth, tRNS, filters, Adam7), box downscale, the baseline JPEG
 * encoder (checked with a tiny independent decoder below), byte budgets, pass-through and the refusals.
 */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { imageInfo, shrinkImage } from "../src/imageShrink";
import { crc32 } from "../src/zipWriter";

// ---------------------------------------------------------------------------------------------------------------
// A tiny PNG encoder (every filter type, Adam7, sub-byte depths)

type Samples = (x: number, y: number) => number[];

interface PngSpec {
  width: number;
  height: number;
  colorType: 0 | 2 | 3 | 4 | 6;
  depth: 1 | 2 | 4 | 8 | 16;
  /** Raw samples (at `depth`) for pixel x,y. */
  pixel: Samples;
  palette?: [number, number, number][];
  trns?: number[];
  interlace?: boolean;
  /** Filter for each row; default cycles through all five. */
  filter?: (y: number) => number;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as const;
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function packRow(samples: number[], depth: number): Uint8Array {
  if (depth === 8) return Uint8Array.from(samples);
  if (depth === 16) return Uint8Array.from(samples.flatMap((s) => [s >> 8, s & 0xff]));
  const out = new Uint8Array(Math.ceil((samples.length * depth) / 8));
  samples.forEach((s, i) => {
    const bit = i * depth;
    out[bit >> 3] = out[bit >> 3]! | (s << (8 - depth - (bit & 7)));
  });
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function filterRow(type: number, row: Uint8Array, prev: Uint8Array | null, bpp: number): Uint8Array {
  const out = new Uint8Array(row.length + 1);
  out[0] = type;
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp]! : 0;
    const b = prev ? prev[i]! : 0;
    const c = prev && i >= bpp ? prev[i - bpp]! : 0;
    const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type]!;
    out[i + 1] = (row[i]! - pred) & 0xff;
  }
  return out;
}

function ihdr(width: number, height: number, depth: number, colorType: number, interlace = 0): Buffer {
  const h = Buffer.alloc(13);
  h.writeUInt32BE(width, 0);
  h.writeUInt32BE(height, 4);
  h.set([depth, colorType, 0, 0, interlace], 8);
  return h;
}

function assemble(head: Buffer, zdata: Buffer, extra: Buffer[] = []): Buffer {
  const half = zdata.length >> 1; // two IDAT chunks, to exercise concatenation
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    ...extra,
    chunk("IDAT", zdata.subarray(0, half)),
    chunk("IDAT", zdata.subarray(half)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function encodePng(spec: PngSpec): Buffer {
  const { width, height, colorType, depth, pixel } = spec;
  const bpp = Math.max(1, (CHANNELS[colorType] * depth) >> 3);
  const passes = spec.interlace ? ADAM7 : [[0, 0, 1, 1]];
  const rows: Uint8Array[] = [];
  passes.forEach(([x0, y0, dx, dy], p) => {
    const pw = Math.ceil((width - x0!) / dx!);
    const ph = Math.ceil((height - y0!) / dy!);
    if (pw <= 0 || ph <= 0) return;
    let prev: Uint8Array | null = null;
    for (let y = 0; y < ph; y++) {
      const samples: number[] = [];
      for (let x = 0; x < pw; x++) samples.push(...pixel(x0! + x * dx!, y0! + y * dy!));
      const row = packRow(samples, depth);
      rows.push(filterRow(spec.filter ? spec.filter(y) : (y + p) % 5, row, prev, bpp));
      prev = row;
    }
  });
  const extra: Buffer[] = [];
  if (spec.palette) extra.push(chunk("PLTE", Uint8Array.from(spec.palette.flat())));
  if (spec.trns) {
    const t =
      colorType === 3
        ? Uint8Array.from(spec.trns)
        : Uint8Array.from(spec.trns.flatMap((v) => [v >> 8, v & 0xff]));
    extra.push(chunk("tRNS", t));
  }
  return assemble(
    ihdr(width, height, depth, colorType, spec.interlace ? 1 : 0),
    deflateSync(Buffer.concat(rows)),
    extra,
  );
}

/** Fast path for big 8-bit RGB/RGBA images: packed pixels, every row "sub"-filtered. */
function encodeBigPng(width: number, height: number, channels: 3 | 4, data: Uint8Array): Buffer {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    const s = y * stride;
    raw[o] = 1;
    for (let i = 0; i < stride; i++)
      raw[o + 1 + i] = data[s + i]! - (i >= channels ? data[s + i - channels]! : 0);
  }
  return assemble(ihdr(width, height, 8, channels === 4 ? 6 : 2), deflateSync(raw, { level: 1 }));
}

/** A 2560×1600-ish "screenshot": white page, a sidebar, colored cards, rows of dark text-like dashes, a gradient. */
function screenshot(width: number, height: number): Uint8Array {
  const d = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r = 255;
      let g = 255;
      let b = 255;
      if (x < width * 0.18) [r, g, b] = [32, 34, 40];
      else if (y < 120) [r, g, b] = [Math.round((x / width) * 255), 90, 200];
      else if (x > width * 0.6 && y > 300 && y < 700) [r, g, b] = [220, 60, 50];
      const lineY = y % 40;
      if (
        y >= 160 &&
        x > width * 0.22 &&
        x < width * 0.56 &&
        lineY > 10 &&
        lineY < 24 &&
        (x >> 3) % 7 !== 0
      ) {
        [r, g, b] = [20, 20, 20];
      }
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = y > height - 100 ? 128 : 255; // a translucent strip at the bottom
    }
  }
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// A tiny, independent baseline JPEG decoder (Huffman, any sampling up to 2×2) to check what the encoder wrote.

// biome-ignore format: the standard zigzag table reads best as a block
const ZZ = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
];

interface Table {
  maxcode: number[];
  mincode: number[];
  valptr: number[];
  vals: number[];
}

interface Decoded {
  width: number;
  height: number;
  rgb: Uint8Array;
  markers: number[];
  quant: number[][];
}

function decodeJpeg(buf: Buffer): Decoded {
  expect([buf[0], buf[1]]).toEqual([0xff, 0xd8]);
  expect([buf.at(-2), buf.at(-1)]).toEqual([0xff, 0xd9]);
  const markers: number[] = [];
  const quant: number[][] = [];
  const dcT: Table[] = [];
  const acT: Table[] = [];
  let width = 0;
  let height = 0;
  let comps: { id: number; h: number; v: number; tq: number; td: number; ta: number }[] = [];
  let pos = 2;
  for (;;) {
    expect(buf[pos]).toBe(0xff);
    const m = buf[pos + 1]!;
    const len = buf.readUInt16BE(pos + 2);
    const seg = buf.subarray(pos + 4, pos + 2 + len);
    markers.push(m);
    if (m === 0xdb) {
      for (let i = 0; i < seg.length; i += 65) {
        const q = new Array<number>(64);
        for (let k = 0; k < 64; k++) q[ZZ[k]!] = seg[i + 1 + k]!;
        quant[seg[i]! & 15] = q;
      }
    } else if (m === 0xc0) {
      height = seg.readUInt16BE(1);
      width = seg.readUInt16BE(3);
      comps = Array.from({ length: seg[5]! }, (_, c) => ({
        id: seg[6 + c * 3]!,
        h: seg[7 + c * 3]! >> 4,
        v: seg[7 + c * 3]! & 15,
        tq: seg[8 + c * 3]!,
        td: 0,
        ta: 0,
      }));
    } else if (m === 0xc4) {
      for (let i = 0; i < seg.length; ) {
        const cls = seg[i]! >> 4;
        const id = seg[i]! & 15;
        const bits = Array.from(seg.subarray(i + 1, i + 17));
        const n = bits.reduce((a, b) => a + b, 0);
        const vals = Array.from(seg.subarray(i + 17, i + 17 + n));
        const t: Table = { maxcode: [], mincode: [], valptr: [], vals };
        let code = 0;
        let k = 0;
        for (let l = 1; l <= 16; l++) {
          t.valptr[l] = k;
          t.mincode[l] = code;
          code += bits[l - 1]!;
          k += bits[l - 1]!;
          t.maxcode[l] = bits[l - 1] ? code - 1 : -1;
          code <<= 1;
        }
        (cls === 0 ? dcT : acT)[id] = t;
        i += 17 + n;
      }
    } else if (m === 0xda) {
      for (let c = 0; c < seg[0]!; c++) {
        const comp = comps.find((x) => x.id === seg[1 + c * 2])!;
        comp.td = seg[2 + c * 2]! >> 4;
        comp.ta = seg[2 + c * 2]! & 15;
      }
      pos += 2 + len;
      break;
    }
    pos += 2 + len;
  }

  // Entropy-coded data, with 0xFF00 unstuffing.
  let bitBuf = 0;
  let bitCnt = 0;
  const bit = (): number => {
    if (bitCnt === 0) {
      const byte = buf[pos++]!;
      if (byte === 0xff) expect(buf[pos++]).toBe(0x00);
      bitBuf = byte;
      bitCnt = 8;
    }
    bitCnt--;
    return (bitBuf >> bitCnt) & 1;
  };
  const receive = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bit();
    return v;
  };
  const extend = (v: number, n: number): number => (n && v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const huff = (t: Table): number => {
    let code = 0;
    for (let l = 1; l <= 16; l++) {
      code = (code << 1) | bit();
      if (code <= t.maxcode[l]!) return t.vals[t.valptr[l]! + code - t.mincode[l]!]!;
    }
    throw new Error("bad huffman code");
  };

  const C = Array.from({ length: 8 }, (_, x) =>
    Array.from(
      { length: 8 },
      (_, u) => ((u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2,
    ),
  );
  const hmax = Math.max(...comps.map((c) => c.h));
  const vmax = Math.max(...comps.map((c) => c.v));
  const mcuX = Math.ceil(width / (8 * hmax));
  const mcuY = Math.ceil(height / (8 * vmax));
  const planes = comps.map((c) => ({
    stride: mcuX * c.h * 8,
    data: new Float32Array(mcuX * c.h * 8 * mcuY * c.v * 8),
  }));
  const pred = comps.map(() => 0);
  for (let my = 0; my < mcuY; my++) {
    for (let mx = 0; mx < mcuX; mx++) {
      comps.forEach((c, ci) => {
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            const coef = new Float32Array(64);
            const q = quant[c.tq]!;
            const t = huff(dcT[c.td]!);
            pred[ci] = pred[ci]! + extend(receive(t), t);
            coef[0] = pred[ci]! * q[0]!;
            for (let k = 1; k < 64; ) {
              const rs = huff(acT[c.ta]!);
              const r = rs >> 4;
              const s = rs & 15;
              if (s === 0) {
                if (r !== 15) break;
                k += 16;
                continue;
              }
              k += r;
              coef[ZZ[k]!] = extend(receive(s), s) * q[ZZ[k]!]!;
              k++;
            }
            const plane = planes[ci]!;
            const x0 = (mx * c.h + bx) * 8;
            const y0 = (my * c.v + by) * 8;
            const tmp = new Float32Array(64); // separable IDCT: rows, then columns
            for (let v = 0; v < 8; v++) {
              for (let x = 0; x < 8; x++) {
                let s = 0;
                for (let u = 0; u < 8; u++) s += C[x]![u]! * coef[v * 8 + u]!;
                tmp[v * 8 + x] = s;
              }
            }
            for (let y = 0; y < 8; y++) {
              for (let x = 0; x < 8; x++) {
                let s = 0;
                for (let v = 0; v < 8; v++) s += C[y]![v]! * tmp[v * 8 + x]!;
                plane.data[(y0 + y) * plane.stride + x0 + x] = s + 128;
              }
            }
          }
        }
      });
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [Y, Cb, Cr] = comps.map((c, ci) => {
        const p = planes[ci]!;
        return p.data[Math.floor((y * c.v) / vmax) * p.stride + Math.floor((x * c.h) / hmax)]!;
      });
      const o = (y * width + x) * 3;
      rgb[o] = clamp(Y! + 1.402 * (Cr! - 128));
      rgb[o + 1] = clamp(Y! - 0.344136 * (Cb! - 128) - 0.714136 * (Cr! - 128));
      rgb[o + 2] = clamp(Y! + 1.772 * (Cb! - 128));
    }
  }
  return { width, height, rgb, markers, quant };
}

function pixelAt(d: Decoded, x: number, y: number): number[] {
  const o = (y * d.width + x) * 3;
  return [d.rgb[o]!, d.rgb[o + 1]!, d.rgb[o + 2]!];
}

function expectColor(actual: number[], expected: number[], tolerance = 8): void {
  actual.forEach((v, i) => {
    expect(Math.abs(v - expected[i]!), `${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
  });
}

/** 64×64 test card: four solid 32×32 quadrants. Shrunk to 32 px each quadrant is a solid 16×16 MCU. */
function quadrants(q: [number[], number[], number[], number[]]): Samples {
  return (x, y) => q[(y < 32 ? 0 : 2) + (x < 32 ? 0 : 1)]!;
}

function shrinkQuadrants(png: Buffer): Decoded {
  const out = shrinkImage(png, { maxSide: 32 });
  expect(out?.mime).toBe("image/jpeg");
  expect([out!.width, out!.height]).toEqual([32, 32]);
  return decodeJpeg(out!.bytes);
}

const CENTERS = [
  [8, 8],
  [24, 8],
  [8, 24],
  [24, 24],
] as const;

function expectQuadrants(d: Decoded, colors: number[][], tolerance = 8): void {
  CENTERS.forEach(([x, y], i) => {
    expectColor(pixelAt(d, x, y), colors[i]!, tolerance);
  });
}

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

// ---------------------------------------------------------------------------------------------------------------

describe("imageInfo", () => {
  it("reads PNG, JPEG, GIF and WebP dimensions", () => {
    const png = encodePng({ width: 7, height: 3, colorType: 2, depth: 8, pixel: () => RED });
    expect(imageInfo(png)).toEqual({ mime: "image/png", width: 7, height: 3 });

    const gif = Buffer.concat([
      Buffer.from("GIF89a", "latin1"),
      Buffer.from([0x40, 0x01, 0xf0, 0x00, 0, 0, 0]),
    ]);
    expect(imageInfo(gif)).toEqual({ mime: "image/gif", width: 320, height: 240 });

    const webp = (fourcc: string, body: number[]) => {
      const b = Buffer.alloc(40);
      b.write("RIFF", 0, "latin1");
      b.writeUInt32LE(32, 4);
      b.write("WEBP", 8, "latin1");
      b.write(fourcc, 12, "latin1");
      b.set(body, 20);
      return b;
    };
    // VP8 (lossy): frame tag, start code 9d 01 2a, 14-bit width/height
    expect(imageInfo(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]))).toEqual({
      mime: "image/webp",
      width: 640,
      height: 480,
    });
    // VP8L (lossless): 0x2f, then (w-1) and (h-1) in 14 bits each
    const bits = (100 - 1) | ((50 - 1) << 14);
    expect(
      imageInfo(webp("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24])),
    ).toEqual({ mime: "image/webp", width: 100, height: 50 });
    // VP8X (extended): 24-bit canvas (w-1), (h-1)
    expect(imageInfo(webp("VP8X", [0, 0, 0, 0, 0xff, 0x0f, 0, 0x37, 0x04, 0]))).toEqual({
      mime: "image/webp",
      width: 4096,
      height: 1080,
    });

    const jpeg = shrinkImage(
      encodeBigPng(
        40,
        30,
        3,
        Uint8Array.from({ length: 3600 }, (_, i) => (i * 37) & 255),
      ),
      { maxSide: 20 },
    )!;
    expect(imageInfo(jpeg.bytes)).toEqual({ mime: "image/jpeg", width: 20, height: 15 });
  });

  it("returns null for unknown, empty or truncated headers", () => {
    expect(imageInfo(Buffer.alloc(0))).toBeNull();
    expect(imageInfo(Buffer.from("hello, this is not a picture at all"))).toBeNull();
    expect(imageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeNull();
    expect(imageInfo(Buffer.from("GIF89a"))).toBeNull();
  });
});

describe("shrinkImage: PNG → JPEG", () => {
  it("shrinks a 2560×1600 RGBA screenshot to 1280×800 quickly, within the budget, with the right colors", () => {
    const W = 2560;
    const H = 1600;
    const src = screenshot(W, H);
    const png = encodeBigPng(W, H, 4, src);
    const t0 = performance.now();
    const out = shrinkImage(png);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(3000);
    expect(out).not.toBeNull();
    expect(out!.mime).toBe("image/jpeg");
    expect([out!.width, out!.height]).toEqual([1280, 800]);
    expect(out!.bytes.length).toBeLessThanOrEqual(300_000);
    expect(imageInfo(out!.bytes)).toEqual({ mime: "image/jpeg", width: 1280, height: 800 });

    const d = decodeJpeg(out!.bytes);
    expect(d.markers).toEqual([0xe0, 0xdb, 0xc0, 0xc4, 0xda]);
    expect([d.width, d.height]).toEqual([1280, 800]);
    expectColor(pixelAt(d, 100, 400), [32, 34, 40]); // sidebar
    expectColor(pixelAt(d, 1000, 250), [220, 60, 50]); // red card
    expectColor(pixelAt(d, 1000, 600), WHITE); // page
    expectColor(pixelAt(d, 1000, 780), WHITE); // 50% white over white stays white
    expectColor(pixelAt(d, 100, 780), [143, 144, 147]); // 50% sidebar over white
    expectColor(pixelAt(d, 300, 30), [60, 90, 200]); // header gradient, left...
    expectColor(pixelAt(d, 1200, 30), [239, 90, 200]); // ...to right
  });

  it("keeps the size of pictures already small enough (never upscales)", () => {
    const W = 800;
    const H = 600;
    let seed = 1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const src = new Uint8Array(W * H * 3);
    for (let i = 0; i < src.length; i++) src[i] = Math.min(255, ((i / 3) % W) / 4 + rand() * 24);
    const out = shrinkImage(encodeBigPng(W, H, 3, src));
    expect(out?.mime).toBe("image/jpeg");
    expect([out!.width, out!.height]).toEqual([800, 600]);
    expect(decodeJpeg(out!.bytes).width).toBe(800);
  });

  it("decodes RGBA, composites alpha onto white", () => {
    const png = encodePng({
      width: 64,
      height: 64,
      colorType: 6,
      depth: 8,
      pixel: quadrants([
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 128],
        [0, 0, 0, 0],
      ]),
    });
    expectQuadrants(shrinkQuadrants(png), [RED, GREEN, [127, 127, 255], WHITE]);
  });

  it("decodes RGB 8- and 16-bit, with a tRNS color key", () => {
    const q = quadrants([RED, GREEN, BLUE, [10, 20, 30]]);
    const rgb8 = encodePng({ width: 64, height: 64, colorType: 2, depth: 8, pixel: q, trns: [10, 20, 30] });
    expectQuadrants(shrinkQuadrants(rgb8), [RED, GREEN, BLUE, WHITE]);
    const rgb16 = encodePng({
      width: 64,
      height: 64,
      colorType: 2,
      depth: 16,
      pixel: (x, y) => q(x, y).map((v) => v * 257),
      trns: [10 * 257, 20 * 257, 30 * 257],
    });
    expect(shrinkImage(rgb16, { maxSide: 32 })!.bytes).toEqual(shrinkImage(rgb8, { maxSide: 32 })!.bytes);
  });

  it("decodes palette images at 1, 2, 4 and 8 bits with tRNS alpha", () => {
    const palette: [number, number, number][] = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [0, 0, 0],
    ];
    for (const depth of [2, 4, 8] as const) {
      const png = encodePng({
        width: 64,
        height: 64,
        colorType: 3,
        depth,
        palette,
        trns: [255, 255, 128, 0],
        pixel: quadrants([[0], [1], [2], [3]]),
      });
      expectQuadrants(shrinkQuadrants(png), [RED, GREEN, [127, 127, 255], WHITE]);
    }
    const mono = encodePng({
      width: 64,
      height: 64,
      colorType: 3,
      depth: 1,
      palette: [
        [255, 0, 0],
        [0, 0, 255],
      ],
      pixel: quadrants([[0], [1], [1], [0]]),
    });
    expectQuadrants(shrinkQuadrants(mono), [RED, BLUE, BLUE, RED]);
  });

  it("decodes grayscale at every depth, gray+alpha, and a gray tRNS key", () => {
    const levels = { 1: [0, 1, 1, 0], 2: [0, 1, 2, 3], 4: [0, 5, 10, 15], 8: [0, 85, 170, 255] } as const;
    for (const depth of [1, 2, 4, 8] as const) {
      const l = levels[depth];
      const png = encodePng({
        width: 64,
        height: 64,
        colorType: 0,
        depth,
        pixel: quadrants([[l[0]], [l[1]], [l[2]], [l[3]]]),
      });
      const max = (1 << depth) - 1;
      expectQuadrants(
        shrinkQuadrants(png),
        l.map((v) => {
          const g = Math.round((v * 255) / max);
          return [g, g, g];
        }),
      );
    }
    const g16 = encodePng({
      width: 64,
      height: 64,
      colorType: 0,
      depth: 16,
      pixel: quadrants([[0], [0x5555], [0xaaaa], [0xffff]]),
      trns: [0],
    });
    expectQuadrants(shrinkQuadrants(g16), [WHITE, [85, 85, 85], [170, 170, 170], WHITE]);

    const ga8 = encodePng({
      width: 64,
      height: 64,
      colorType: 4,
      depth: 8,
      pixel: quadrants([
        [0, 255],
        [0, 128],
        [200, 255],
        [0, 0],
      ]),
    });
    expectQuadrants(shrinkQuadrants(ga8), [BLACK, [127, 127, 127], [200, 200, 200], WHITE]);
    const ga16 = encodePng({
      width: 64,
      height: 64,
      colorType: 4,
      depth: 16,
      pixel: quadrants([
        [0, 65535],
        [0, 128 * 257],
        [200 * 257, 65535],
        [0, 0],
      ]),
    });
    expect(shrinkImage(ga16, { maxSide: 32 })!.bytes).toEqual(shrinkImage(ga8, { maxSide: 32 })!.bytes);
  });

  it("gives identical output for every filter choice and for Adam7-interlaced files", () => {
    const pixel: Samples = (x, y) => [
      (x * 7 + y * 3) & 255,
      (x * y) & 255,
      (255 - x * 2) & 255,
      255 - (y & 63),
    ];
    const base = { width: 77, height: 53, colorType: 6 as const, depth: 8 as const, pixel };
    const reference = shrinkImage(encodePng({ ...base, filter: () => 0 }), { maxSide: 40 })!;
    expect([reference.width, reference.height]).toEqual([40, 28]);
    for (const f of [1, 2, 3, 4]) {
      expect(shrinkImage(encodePng({ ...base, filter: () => f }), { maxSide: 40 })!.bytes).toEqual(
        reference.bytes,
      );
    }
    expect(shrinkImage(encodePng({ ...base, interlace: true }), { maxSide: 40 })!.bytes).toEqual(
      reference.bytes,
    );

    // sub-byte interlaced: odd sizes so some passes are tiny or empty
    const gray: Samples = (x, y) => [(x + y) % 4];
    const g = { width: 13, height: 5, colorType: 0 as const, depth: 2 as const, pixel: gray };
    const flat = shrinkImage(encodePng(g), { maxSide: 7 })!;
    expect(shrinkImage(encodePng({ ...g, interlace: true }), { maxSide: 7 })!.bytes).toEqual(flat.bytes);
  });

  it("keeps a small PNG that already fits when it is smaller than the JPEG would be", () => {
    const png = encodePng({
      width: 16,
      height: 16,
      colorType: 3,
      depth: 1,
      palette: [[255, 255, 255]],
      pixel: () => [0],
    });
    const out = shrinkImage(png);
    expect(out).toEqual({ bytes: png, mime: "image/png", width: 16, height: 16 });
  });
});

describe("shrinkImage: budgets", () => {
  const W = 2560;
  const H = 1600;
  let seed = 7;
  const noise = new Uint8Array(W * H * 3);
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    noise[i] = seed >>> 24;
  }
  const noisyPng = encodeBigPng(W, H, 3, noise);

  it("lowers quality and size until a noisy picture fits, or gives up", () => {
    const out = shrinkImage(noisyPng);
    expect(out).not.toBeNull();
    expect(out!.bytes.length).toBeLessThanOrEqual(300_000);
    expect(Math.max(out!.width, out!.height)).toBeLessThanOrEqual(1280);
    expect(Math.max(out!.width, out!.height)).toBeGreaterThanOrEqual(480);
    expect(out!.width / out!.height).toBeCloseTo(W / H, 1);
    expect(decodeJpeg(out!.bytes).width).toBe(out!.width);

    expect(shrinkImage(noisyPng, { maxBytes: 5_000 })).toBeNull();
  });

  it("honors maxSide and quality options", () => {
    const small = shrinkImage(noisyPng, { maxSide: 400, quality: 90 })!;
    expect([small.width, small.height]).toEqual([400, 250]);
    const smaller = shrinkImage(noisyPng, { maxSide: 400, quality: 30 })!;
    expect(smaller.bytes.length).toBeLessThan(small.bytes.length);
    expect(decodeJpeg(smaller.bytes).quant[0]![0]).toBeGreaterThan(decodeJpeg(small.bytes).quant[0]![0]!);
  });
});

describe("shrinkImage: pass-through and refusals", () => {
  const jpegHeader = (w: number, h: number, size: number) => {
    const b = Buffer.alloc(size);
    b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08]);
    b.writeUInt16BE(h, 13);
    b.writeUInt16BE(w, 15);
    return b;
  };

  it("passes small JPEG, GIF and WebP through untouched", () => {
    const jpg = jpegHeader(1024, 768, 50_000);
    expect(shrinkImage(jpg)).toEqual({ bytes: jpg, mime: "image/jpeg", width: 1024, height: 768 });
    const gif = Buffer.concat([
      Buffer.from("GIF87a", "latin1"),
      Buffer.from([10, 0, 20, 0]),
      Buffer.alloc(100),
    ]);
    expect(shrinkImage(gif)).toEqual({ bytes: gif, mime: "image/gif", width: 10, height: 20 });
    const webp = Buffer.alloc(64);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBPVP8X", 8, "latin1");
    webp.writeUIntLE(1999, 24, 3);
    webp.writeUIntLE(999, 27, 3);
    expect(shrinkImage(webp)).toEqual({ bytes: webp, mime: "image/webp", width: 2000, height: 1000 });
  });

  it("refuses JPEG/GIF/WebP that are too big in bytes or pixels", () => {
    expect(shrinkImage(jpegHeader(1024, 768, 400_000))).toBeNull();
    expect(shrinkImage(jpegHeader(6000, 4000, 50_000))).toBeNull();
    expect(shrinkImage(jpegHeader(1024, 768, 50_000), { maxBytes: 10_000 })).toBeNull();
  });

  it("returns null for garbage, truncated and corrupt PNGs", () => {
    expect(shrinkImage(Buffer.alloc(0))).toBeNull();
    expect(shrinkImage(Buffer.from("definitely not an image"))).toBeNull();
    expect(shrinkImage(undefined as unknown as Buffer)).toBeNull();
    const png = encodePng({
      width: 64,
      height: 64,
      colorType: 2,
      depth: 8,
      pixel: (x, y) => [x * 4, y * 4, (x * y) & 255],
    });
    expect(shrinkImage(png, { maxSide: 32 })).not.toBeNull();
    for (const cut of [20, 40, 100, png.length >> 1, png.length - 40]) {
      expect(shrinkImage(png.subarray(0, cut), { maxSide: 32 })).toBeNull();
    }
    const flipped = Buffer.from(png);
    flipped[60] = flipped[60]! ^ 0xff; // inside the zlib stream
    expect(shrinkImage(flipped, { maxSide: 32 })).toBeNull();
    // an unknown filter type
    const badFilter = assemble(ihdr(2, 1, 8, 2), deflateSync(Buffer.from([9, 1, 2, 3, 4, 5, 6])));
    expect(shrinkImage(badFilter)).toBeNull();
    // invalid depth / color type combination
    expect(shrinkImage(assemble(ihdr(2, 1, 4, 2), deflateSync(Buffer.from([0, 1, 2, 3]))))).toBeNull();
    // palette image without a palette
    expect(shrinkImage(assemble(ihdr(2, 1, 8, 3), deflateSync(Buffer.from([0, 0, 0]))))).toBeNull();
  });

  it("refuses decompression bombs", () => {
    // huge declared dimensions
    expect(shrinkImage(assemble(ihdr(100_000, 100_000, 8, 6), deflateSync(Buffer.alloc(16))))).toBeNull();
    expect(shrinkImage(assemble(ihdr(8000, 6000, 8, 2), deflateSync(Buffer.alloc(16))))).toBeNull();
    // small declared image whose data inflates to far more than it can hold
    expect(shrinkImage(assemble(ihdr(10, 10, 8, 6), deflateSync(Buffer.alloc(50_000_000))))).toBeNull();
  });
});
