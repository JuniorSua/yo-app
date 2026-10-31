// Yo Phone app icons: one source of truth for the Yo mark, rasterized with Playwright's Chromium.
//
//   node scripts/brand/render-icons.mjs                 write phone/icons/* for the chosen direction
//   node scripts/brand/render-icons.mjs --preview [dir] same, plus a preview of the written files
//                                                       (default dir /tmp/yo-logo/final-preview.png)
//   node scripts/brand/render-icons.mjs --sheet [dir]   render all 3 directions + a comparison sheet
//                                                       (default dir /tmp/yo-logo), refresh
//                                                       docs/brand/options/*.svg and docs/brand/logo-options.png
//
// Needs `CI=true pnpm install --frozen-lockfile` once (for @playwright/test + its Chromium).
// See docs/brand/LOGO.md.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHOSEN = "b";
const S = 1024; // design grid; every icon is drawn on a 1024 x 1024 canvas

// ---------- geometry ----------
const r2 = (v) => Math.round(v * 100) / 100;

// Superellipse |x/a|^n + |y/b|^n = 1 as a smooth closed cubic path (Catmull-Rom through samples).
function superellipse(cx, cy, a, b, n, count = 72) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push([
      cx + a * Math.sign(c) * Math.abs(c) ** (2 / n),
      cy + b * Math.sign(s) * Math.abs(s) ** (2 / n),
    ]);
  }
  let d = `M${r2(pts[0][0])} ${r2(pts[0][1])}`;
  for (let i = 0; i < count; i++) {
    const p0 = pts[(i - 1 + count) % count];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % count];
    const p3 = pts[(i + 2) % count];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${r2(c1[0])} ${r2(c1[1])} ${r2(c2[0])} ${r2(c2[1])} ${r2(p2[0])} ${r2(p2[1])}`;
  }
  return { d: `${d}Z`, pts };
}

// Speech-bubble tail growing out of the body's lower-left, tip roughly under the left edge.
function tail(cx, cy, a, b, k) {
  const P = (x, y) => `${r2(cx + x * a)} ${r2(cy + y * b)}`;
  const d =
    `M${P(-0.78, 0.62)}` +
    `C${P(-0.77, 0.98)} ${P(-0.84 * k.reach, 1.2 * k.drop)} ${P(-0.98 * k.reach, 1.36 * k.drop)}` +
    `C${P(-0.62, 1.37 * k.drop)} ${P(-0.36, 1.25 * k.drop)} ${P(-0.2, 0.97)}Z`;
  return { d, tip: [cx - 0.98 * k.reach * a, cy + 1.36 * k.drop * b] };
}

// ---------- the three directions ----------
// Shared yellow: brand #FFD43B (apps/web --brand dark, the current mark's mid stop) as the centre of a
// short, bright-to-warm vertical ramp. Ink is a warm near-black so it never looks blue next to yellow.
const INK = "#16130E";
const YELLOW = [
  [0, "#FFEC85"],
  [0.42, "#FFD940"],
  [0.82, "#FBC12B"],
  [1, "#F4AE1C"],
];

export const OPTIONS = {
  a: {
    name: "Daylight",
    blurb: "Evolution of today's icon: warm paper tile, larger squircle bubble, soft lift.",
    tile: {
      kind: "linear",
      stops: [
        [0, "#FFFFFF"],
        [1, "#F2EEE4"],
      ],
    },
    body: { cx: 512, cy: 478, a: 322, b: 268, n: 4.2 },
    tail: { reach: 1, drop: 1 },
    eyes: { dx: 0.3, dy: -0.03, w: 0.255, h: 0.58 },
    shadow: { color: "#7A4D0A", opacity: 0.26, dy: 22, blur: 26 },
    glint: false,
    glow: null,
    smile: false,
  },
  b: {
    name: "Night Light",
    blurb: "Warm-ink tile with the yellow bubble glowing on it; eyes get a tiny catch-light.",
    tile: {
      kind: "radial",
      stops: [
        [0, "#2E2922"],
        [0.65, "#1A1713"],
        [1, "#100E0B"],
      ],
    },
    body: { cx: 512, cy: 478, a: 318, b: 266, n: 4.2 },
    tail: { reach: 1, drop: 1 },
    eyes: { dx: 0.3, dy: -0.03, w: 0.26, h: 0.59 },
    shadow: { color: "#000000", opacity: 0.45, dy: 20, blur: 24 },
    rim: true,
    glint: true,
    glow: { color: "#FFC93B", opacity: 0.28 },
    smile: false,
  },
  c: {
    name: "Sunshine",
    blurb: "Full-bleed amber tile, rounder bubble in bright yellow, eyes plus a small smile.",
    tile: {
      kind: "linear",
      stops: [
        [0, "#FFC52E"],
        [1, "#F39200"],
      ],
    },
    body: { cx: 512, cy: 470, a: 304, b: 280, n: 3 },
    tail: { reach: 1.04, drop: 1.02 },
    eyes: { dx: 0.3, dy: -0.12, w: 0.25, h: 0.5 },
    shadow: { color: "#8A4300", opacity: 0.34, dy: 20, blur: 24 },
    glint: false,
    glow: null,
    smile: true,
  },
};

// Points that the mark covers, for the maskable safe-zone check.
function markPoints(o) {
  const { cx, cy, a, b, n } = o.body;
  return [...superellipse(cx, cy, a, b, n).pts, tail(cx, cy, a, b, o.tail).tip];
}

/**
 * Build one SVG.
 *  frame: "square"  full-bleed tile (apple-touch, maskable)
 *         "rounded" iOS-like squircle tile with transparent corners (manifest "any", favicon)
 *         "none"    the bare mark on transparent (logo.svg, in-app avatar)
 *  small: optical size for <= 64 px (no shadow/gloss, bigger features)
 *  scale: shrink the mark around the centre (maskable safe zone)
 */
export function buildSvg(key, { frame = "square", small = false, scale = 1, size = S, idp = key } = {}) {
  const o = OPTIONS[key];
  const id = (s) => `${idp}-${s}`;
  const { cx, cy, a, b, n } = o.body;
  const body = superellipse(cx, cy, a, b, n).d;
  const t = tail(cx, cy, a, b, o.tail).d;
  const top = cy - b;
  const bottom = cy + b * 1.4;
  const ew = o.eyes.w * a * (small ? 1.16 : 1);
  const eh = o.eyes.h * b * (small ? 1.04 : 1);
  const ey = cy + o.eyes.dy * b;
  const ex = o.eyes.dx * a * (small ? 1.04 : 1);
  const eyes = [-1, 1]
    .map((s) => {
      const x = cx + s * ex - ew / 2;
      return `<rect x="${r2(x)}" y="${r2(ey - eh / 2)}" width="${r2(ew)}" height="${r2(eh)}" rx="${r2(ew / 2)}" fill="${INK}"/>`;
    })
    .join("");
  const glints =
    o.glint && !small
      ? [-1, 1]
          .map(
            (s) =>
              `<circle cx="${r2(cx + s * ex + ew * 0.14)}" cy="${r2(ey - eh * 0.27)}" r="${r2(ew * 0.17)}" fill="#fff" opacity=".92"/>`,
          )
          .join("")
      : "";
  const smile = o.smile
    ? `<path d="M${r2(cx - 0.2 * a)} ${r2(cy + 0.36 * b)}Q${cx} ${r2(cy + 0.62 * b)} ${r2(cx + 0.2 * a)} ${r2(cy + 0.36 * b)}" fill="none" stroke="${INK}" stroke-width="${r2(a * (small ? 0.12 : 0.095))}" stroke-linecap="round"/>`
    : "";

  const defs = [];
  defs.push(
    `<linearGradient id="${id("y")}" gradientUnits="userSpaceOnUse" x1="0" y1="${top}" x2="0" y2="${r2(bottom)}">${YELLOW.map(([p, c]) => `<stop offset="${p}" stop-color="${c}"/>`).join("")}</linearGradient>`,
  );
  defs.push(
    `<radialGradient id="${id("hl")}" gradientUnits="userSpaceOnUse" cx="${r2(cx - 0.45 * a)}" cy="${r2(top + 0.1 * b)}" r="${r2(1.15 * a)}"><stop stop-color="#fff" stop-opacity=".55"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></radialGradient>`,
  );
  defs.push(`<clipPath id="${id("bc")}"><path d="${body}"/></clipPath>`);
  if (!small) {
    const sh = o.shadow;
    defs.push(
      `<filter id="${id("sh")}" x="-30%" y="-30%" width="160%" height="170%" color-interpolation-filters="sRGB">` +
        `<feDropShadow dx="0" dy="${sh.dy}" stdDeviation="${sh.blur}" flood-color="${sh.color}" flood-opacity="${sh.opacity}"/>` +
        `<feDropShadow dx="0" dy="${r2(sh.dy / 5)}" stdDeviation="${r2(sh.blur / 6)}" flood-color="${sh.color}" flood-opacity="${r2(sh.opacity * 0.6)}"/></filter>`,
    );
  }
  let tileFill = "";
  if (frame !== "none") {
    const tg = o.tile;
    const stops = tg.stops.map(([p, c]) => `<stop offset="${p}" stop-color="${c}"/>`).join("");
    defs.push(
      tg.kind === "linear"
        ? `<linearGradient id="${id("t")}" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>`
        : `<radialGradient id="${id("t")}" cx=".5" cy=".3" r=".85">${stops}</radialGradient>`,
    );
    tileFill = `url(#${id("t")})`;
  }
  if (o.glow && frame !== "none") {
    defs.push(
      `<radialGradient id="${id("gl")}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy + 40}" r="${r2(a * 1.45)}"><stop stop-color="${o.glow.color}" stop-opacity="${o.glow.opacity}"/><stop offset="1" stop-color="${o.glow.color}" stop-opacity="0"/></radialGradient>`,
    );
  }
  let tileShape = "";
  if (frame === "rounded") {
    const tileD = superellipse(512, 512, 512, 512, 5, 96).d;
    defs.push(`<clipPath id="${id("tc")}"><path d="${tileD}"/></clipPath>`);
    tileShape = `<path d="${tileD}" fill="${tileFill}"/>`;
  } else if (frame === "square") {
    tileShape = `<rect width="${S}" height="${S}" fill="${tileFill}"/>`;
  }
  const glow =
    o.glow && frame !== "none" ? `<rect width="${S}" height="${S}" fill="url(#${id("gl")})"/>` : "";
  // Top sheen on the tile (light directions only) and a hairline inner edge so pale tiles hold their shape.
  // Pale tiles get a hairline dark edge; the dark tile gets a top-lit rim so it separates from dark wallpapers.
  if (o.rim && frame !== "none") {
    defs.push(
      `<linearGradient id="${id("rim")}" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff" stop-opacity=".16"/><stop offset=".35" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#fff" stop-opacity=".04"/></linearGradient>`,
    );
  }
  // Only on our own rounded tile: on full-bleed squares the OS mask would cut an edge line at the corners.
  const edgeShape = (w) => `<path d="${superellipse(512, 512, 512 - w / 2, 512 - w / 2, 5, 96).d}"`;
  const edge =
    frame !== "rounded"
      ? ""
      : o.rim
        ? `${edgeShape(small ? 40 : 6)} fill="none" stroke="url(#${id("rim")})" stroke-width="${small ? 40 : 6}"/>`
        : small
          ? ""
          : `${edgeShape(3)} fill="none" stroke="#000" stroke-opacity=".05" stroke-width="3"/>`;

  const mark =
    `<g${small ? "" : ` filter="url(#${id("sh")})"`}>` +
    `<path d="${t}" fill="url(#${id("y")})"/><path d="${body}" fill="url(#${id("y")})"/>` +
    `</g>` +
    (small
      ? ""
      : `<g clip-path="url(#${id("bc")})"><rect width="${S}" height="${S}" fill="url(#${id("hl")})"/></g>`) +
    eyes +
    glints +
    smile;

  const k = scale * (small ? 1.1 : 1);
  const transformed =
    k === 1
      ? mark
      : `<g transform="translate(512 ${small ? 500 : 512}) scale(${r2(k)}) translate(-512 -512)">${mark}</g>`;
  let content = `${tileShape}${glow}${transformed}`;
  if (frame === "rounded")
    content = `<g clip-path="url(#${id("tc")})">${tileShape}${glow}${edge}</g>${transformed}`;
  else if (frame === "square") content = `${tileShape}${glow}${edge}${transformed}`;

  const vb = frame === "none" ? "140 160 744 744" : `0 0 ${S} ${S}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${vb}" role="img" aria-label="Yo"><defs>${defs.join("")}</defs>${content}</svg>\n`;
}

// Biggest scale that keeps the mark inside the maskable safe zone (circle of radius 40% of the icon).
function maskableScale(key, radius = 0.4 * S * 0.96) {
  const far = Math.max(...markPoints(OPTIONS[key]).map(([x, y]) => Math.hypot(x - 512, y - 512)));
  return Math.min(1, radius / far);
}

// ---------- rasterizing ----------
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// Minimal PNG encoder so opaque icons are written as true RGB (iOS wants no alpha channel).
function encodePng(size, rgba, alpha) {
  const ch = alpha ? 4 : 3;
  const raw = Buffer.alloc(size * (size * ch + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      for (let c = 0; c < ch; c++) raw[o++] = rgba[i + c];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function rasterize(page, svg, size, alpha) {
  const b64 = await page.evaluate(
    async ({ svg, size }) => {
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, size, size);
      const px = ctx.getImageData(0, 0, size, size).data;
      let s = "";
      for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode(...px.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { svg, size },
  );
  return encodePng(size, Buffer.from(b64, "base64"), alpha);
}

// Every icon file for one direction. Small sizes use the optical-size variant.
function iconSet(key) {
  return [
    { file: "icon-512.png", size: 512, svg: buildSvg(key, { frame: "rounded", size: 512 }), alpha: true },
    { file: "icon-192.png", size: 192, svg: buildSvg(key, { frame: "rounded", size: 192 }), alpha: true },
    {
      file: "icon-maskable-512.png",
      size: 512,
      svg: buildSvg(key, { frame: "square", size: 512, scale: maskableScale(key) }),
      alpha: false,
    },
    {
      file: "apple-touch-icon.png",
      size: 180,
      svg: buildSvg(key, { frame: "square", size: 180 }),
      alpha: false,
    },
    {
      file: "favicon-32.png",
      size: 32,
      svg: buildSvg(key, { frame: "rounded", size: 32, small: true }),
      alpha: true,
    },
  ];
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<!doctype html><body></body>");

const args = process.argv.slice(2);
if (args[0] === "--sheet") {
  const out = args[1] ?? "/tmp/yo-logo";
  mkdirSync(out, { recursive: true });
  mkdirSync(join(ROOT, "docs/brand/options"), { recursive: true });
  const imgs = {};
  for (const key of Object.keys(OPTIONS)) {
    writeFileSync(
      join(ROOT, `docs/brand/options/option-${key}.svg`),
      buildSvg(key, { frame: "rounded", size: 512 }),
    );
    imgs[key] = {};
    for (const it of iconSet(key)) {
      const png = await rasterize(page, it.svg, it.size, it.alpha);
      writeFileSync(join(out, `option-${key}-${it.file}`), png);
      imgs[key][it.file] = `data:image/png;base64,${png.toString("base64")}`;
    }
  }
  const html = sheetHtml(imgs);
  writeFileSync(join(out, "sheet.html"), html);
  const sp = await browser.newPage({ viewport: { width: 2040, height: 800 } });
  await sp.setContent(html);
  await sp.screenshot({ path: join(out, "comparison-sheet.png"), fullPage: true });
  // Half-scale copy for the repo (kept small).
  const small = await browser.newPage({ viewport: { width: 2040, height: 800 }, deviceScaleFactor: 0.5 });
  await small.setContent(html);
  await small.screenshot({ path: join(ROOT, "docs/brand/logo-options.png"), fullPage: true });
  console.log(`sheet -> ${join(out, "comparison-sheet.png")}`);
} else {
  for (const it of iconSet(CHOSEN)) {
    writeFileSync(join(ROOT, "phone/icons", it.file), await rasterize(page, it.svg, it.size, it.alpha));
    console.log(`phone/icons/${it.file}`);
  }
  writeFileSync(join(ROOT, "phone/icons/logo.svg"), buildSvg(CHOSEN, { frame: "none", size: 64, idp: "yo" }));
  console.log("phone/icons/logo.svg");
  if (args[0] === "--preview") {
    const out = args[1] ?? "/tmp/yo-logo";
    mkdirSync(out, { recursive: true });
    const src = (f) =>
      `data:image/png;base64,${readFileSync(join(ROOT, "phone/icons", f)).toString("base64")}`;
    const logo = `data:image/svg+xml;base64,${readFileSync(join(ROOT, "phone/icons/logo.svg")).toString("base64")}`;
    const pp = await browser.newPage({ viewport: { width: 1400, height: 400 } });
    await pp.setContent(previewHtml(src, logo));
    await pp.screenshot({ path: join(out, "final-preview.png"), fullPage: true });
    console.log(`preview -> ${join(out, "final-preview.png")}`);
  }
}
await browser.close();

// ---------- previews ----------
function previewHtml(src, logo) {
  const cell = (label, inner, bg = "#F2F2F7", fg = "#555") =>
    `<figure style="background:${bg};color:${fg}">${inner}<figcaption>${label}</figcaption></figure>`;
  const mask = `<div style="position:relative;width:256px;height:256px"><img src="${src("icon-maskable-512.png")}" width="256" height="256" style="border-radius:50%">
    <div style="position:absolute;inset:25.6px;border:2px dashed #ff3b30;border-radius:50%"></div></div>`;
  return `<!doctype html><html><head><style>
  body{margin:0;padding:24px;font:14px -apple-system,system-ui,sans-serif;display:flex;flex-wrap:wrap;gap:16px;width:1350px}
  figure{margin:0;padding:20px;border-radius:16px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:10px}
  </style></head><body>
  ${cell("icon-512 (manifest any)", `<img src="${src("icon-512.png")}" width="256" height="256">`)}
  ${cell("icon-maskable-512, circle mask; red = 80% safe zone", mask)}
  ${cell("apple-touch-icon 180 (iOS masks corners)", `<img src="${src("apple-touch-icon.png")}" width="180" height="180" style="border-radius:22.4%">`)}
  ${cell("icon-192", `<img src="${src("icon-192.png")}" width="192" height="192">`, "#1C1C1E", "#aaa")}
  ${cell("favicon-32 (1x and 4x)", `<img src="${src("favicon-32.png")}" width="32"><img src="${src("favicon-32.png")}" width="128" style="image-rendering:pixelated">`)}
  ${cell("logo.svg in-app 40 / 96 (light)", `<div style="display:flex;gap:20px;align-items:center"><img src="${logo}" width="40"><img src="${logo}" width="96"></div>`, "#FAF9F6")}
  ${cell("logo.svg in-app 40 / 96 (dark)", `<div style="display:flex;gap:20px;align-items:center"><img src="${logo}" width="40"><img src="${logo}" width="96"></div>`, "#161513", "#aaa")}
  </body></html>`;
}

// ---------- comparison sheet ----------
function sheetHtml(imgs) {
  const keys = Object.keys(OPTIONS);
  const sizes = (key) =>
    `<img src="${imgs[key]["icon-512.png"]}" width="512" height="512">` +
    `<img src="${imgs[key]["apple-touch-icon.png"]}" width="180" height="180" class="ios">` +
    `<img src="${imgs[key]["favicon-32.png"]}" width="32" height="32">` +
    `<img src="${imgs[key]["favicon-32.png"]}" width="128" height="128" class="px" title="32 px, 4x zoom">`;
  const rows = keys
    .map(
      (
        k,
      ) => `<section><h2>Option ${k.toUpperCase()} &middot; ${OPTIONS[k].name}${k === CHOSEN ? ' <span class="pick">recommended</span>' : ""}</h2><p>${OPTIONS[k].blurb}</p>
      <div class="pair"><div class="panel light">${sizes(k)}</div><div class="panel dark">${sizes(k)}</div></div></section>`,
    )
    .join("");
  const generic = [
    ["#34C759", "#1FAE45"],
    ["#0A84FF", "#0060DF"],
    ["#FF9F0A", "#FF6B00"],
    ["#BF5AF2", "#8E3BD1"],
    ["#FF375F", "#D7193F"],
    ["#8E8E93", "#636366"],
  ];
  const app = (i, label) =>
    `<div class="app"><div class="g" style="background:linear-gradient(${generic[i][0]},${generic[i][1]})"><i></i></div><span>${label}</span></div>`;
  const yo = (k) =>
    `<div class="app"><img src="${imgs[k]["apple-touch-icon.png"]}" width="120" height="120" class="ios"><span>Yo ${k.toUpperCase()}</span></div>`;
  const screen = (cls) =>
    `<div class="phone ${cls}">${app(0, "Messages")}${yo("a")}${app(1, "Mail")}${yo("b")}${app(2, "Photos")}${yo("c")}${app(3, "Podcasts")}${app(4, "Music")}</div>`;
  return `<!doctype html><html><head><style>
  body{margin:0;padding:40px;background:#fff;font:16px/1.4 -apple-system,system-ui,sans-serif;color:#111;width:1960px}
  h1{margin:0 0 4px;font-size:28px} h2{margin:28px 0 2px;font-size:22px} p{margin:0 0 12px;color:#555}
  .pick{background:#16130E;color:#FFD940;border-radius:99px;padding:2px 10px;font-size:14px;vertical-align:middle}
  .pair{display:flex;gap:16px}
  .panel{display:flex;align-items:flex-end;gap:28px;padding:28px;border-radius:20px}
  .light{background:#F2F2F7} .dark{background:#1C1C1E}
  .ios{border-radius:22.4%} .px{image-rendering:pixelated;margin-left:auto}
  .phones{display:flex;gap:16px;margin-top:12px}
  .phone{display:grid;grid-template-columns:repeat(4,120px);gap:36px 56px;padding:48px 56px;border-radius:48px;width:648px}
  .phone.lw{background:linear-gradient(160deg,#F6E7D8,#E4E8F7 55%,#F2DDE8)}
  .phone.dw{background:linear-gradient(160deg,#0F1424,#2A1C3E 60%,#101826)}
  .app{display:flex;flex-direction:column;align-items:center;gap:10px}
  .app span{font-size:22px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.35)}
  .lw .app span{color:#1c1c1e;text-shadow:none}
  .g{width:120px;height:120px;border-radius:22.4%;display:grid;place-items:center}
  .g i{width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.9)}
  </style></head><body>
  <h1>Yo logo directions</h1><p>Each direction at 512, 180 (iOS, corner-masked) and 32 px, on light and dark. Bottom: iPhone home screens at 2x.</p>
  ${rows}
  <h2>iPhone home screen</h2><div class="phones">${screen("lw")}${screen("dw")}</div>
  </body></html>`;
}
