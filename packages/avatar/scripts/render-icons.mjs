#!/usr/bin/env node
/**
 * Renders Yo's brand assets from SVG:
 *   apps/web/public/favicon.svg          the Yo bubble mark
 *   apps/desktop/build/icon.svg          1024x1024 macOS-grid app icon source
 *   apps/desktop/build/icon.png          1024x1024 PNG (rendered with Playwright's Chromium)
 *   apps/desktop/build/icon.icns         via `sips` + `iconutil` (macOS only)
 *
 * Geometry mirrors packages/avatar/src/geometry.ts + Logo.tsx (kept dependency-free so it runs with plain node).
 * Usage: pnpm --filter @yo/avatar icons
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const webPublic = join(root, "apps/web/public");
const buildDir = join(root, "apps/desktop/build");

const f = (n) => (Math.round(n * 100) / 100).toString();

function smoothClosedPath(points) {
  const n = points.length;
  const p = (i) => points[((i % n) + n) % n];
  let d = `M${f(p(0)[0])} ${f(p(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(
      p2[1] - (p3[1] - p1[1]) / 6,
    )} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

function superellipsePath(cx, cy, a, b, n = 4, steps = 40) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push([
      cx + a * Math.sign(c) * Math.abs(c) ** (2 / n),
      cy + b * Math.sign(s) * Math.abs(s) ** (2 / n),
    ]);
  }
  return smoothClosedPath(pts);
}

const YELLOW = "#FFD43B";
const EYE = "#0B0C0E";
const BODY = superellipsePath(50, 47, 37, 33, 4.2, 44);
const TAIL = "M20.5 66C21.5 77 18.5 85 12.5 91.5C23 91.5 33.5 86.5 40 77.5Z";

/**
 * 04 Sunlit Satin (approved brand mark): golden radial shading + broad soft highlight + warm shadow over the
 * exact original bubble/eye geometry. Mirrors packages/avatar/src/Logo.tsx.
 */
const satinDefs = (p) => `
  <radialGradient id="${p}f" gradientUnits="userSpaceOnUse" cx="28" cy="15" r="85">
    <stop stop-color="#FFF19A"/><stop offset=".38" stop-color="#FFD43B"/><stop offset=".75" stop-color="#F9BD24"/><stop offset="1" stop-color="#CF8615"/>
  </radialGradient>
  <radialGradient id="${p}s" gradientUnits="userSpaceOnUse" cx="30" cy="5" r="70">
    <stop stop-color="#fff" stop-opacity=".75"/><stop offset=".65" stop-color="#fff" stop-opacity="0"/>
  </radialGradient>
  <clipPath id="${p}c"><path d="${BODY}"/><path d="${TAIL}"/></clipPath>
  <filter id="${p}h" x="-30%" y="-25%" width="170%" height="170%">
    <feDropShadow dx="1" dy="3" stdDeviation="2" flood-color="#754516" flood-opacity=".24"/>
  </filter>`;

/** The mark in a 100x100 box (satin). */
const mark = (p = "m", eye = EYE) => `
  <g filter="url(#${p}h)">
    <path d="${BODY}" fill="url(#${p}f)"/>
    <path d="${TAIL}" fill="url(#${p}f)"/>
    <g clip-path="url(#${p}c)" opacity=".55"><rect width="100" height="100" fill="url(#${p}s)"/></g>
  </g>
  <rect x="35.2" y="37.6" width="9.2" height="17" rx="4.6" fill="${eye}"/>
  <rect x="57.6" y="37.6" width="9.2" height="17" rx="4.6" fill="${eye}"/>`;

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 4 92 94"><defs>${satinDefs("m")}</defs>${mark("m")}</svg>\n`;

// macOS icon grid: 1024 canvas, 824x824 body at (100,100), continuous-corner squircle.
const bodySquircle = superellipsePath(512, 512, 412, 412, 5, 96);
// App icon v2: the satin Yo bubble, BIG (bleeds off the bottom edge like a sticker), tilted, glancing to the
// side and wearing Yo's midnight headset — more character, still calm and serious.
const HS = { ink: "#202338", hi: "#494763", deep: "#141627", rim: "#6B6A8C" };
const E = { l: 13.5, r: 86.5, y: 47 }; // bubble ear anchors (packages/avatar/src/shapes.ts)
const bandTop = 14 - 26;
const cw = 11.5;
const ch = 24;
const cy = E.y - 1;
const mx = 62;
const my = 65;
const headsetBack = `
    <path d="M${E.l + 0.5} ${E.y - 9}C${E.l - 2} ${bandTop} ${E.r + 2} ${bandTop} ${E.r - 0.5} ${E.y - 9}" stroke="${HS.ink}" stroke-width="5.4" fill="none" stroke-linecap="round"/>
    <path d="M${E.l + 1.2} ${E.y - 17}C${E.l - 0.4} ${bandTop + 2.6} ${E.r + 0.4} ${bandTop + 2.6} ${E.r - 1.2} ${E.y - 17}" stroke="${HS.hi}" stroke-width="1.3" fill="none" stroke-linecap="round" opacity=".9"/>`;
const cup = (cx, side) => `
    <rect x="${cx - cw / 2}" y="${cy - ch / 2}" width="${cw}" height="${ch}" rx="${cw / 2}" fill="url(#ic)" stroke="${HS.rim}" stroke-opacity=".55" stroke-width=".8"/>
    <rect x="${side < 0 ? cx + cw / 2 - 3.6 : cx - cw / 2 + 0.6}" y="${cy - ch / 2 + 2.5}" width="3" height="${ch - 5}" rx="1.5" fill="${HS.deep}" opacity=".85"/>
    <rect x="${cx - cw / 2 + (side < 0 ? 1.8 : 3.4)}" y="${cy - ch / 2 + 3}" width="2.2" height="${ch * 0.42}" rx="1.1" fill="${HS.hi}" opacity=".95"/>`;
const headsetFront = `
    <g clip-path="url(#mc)">
      <ellipse cx="${E.l + 6}" cy="${cy + 1}" rx="8" ry="14" fill="url(#io)"/>
      <ellipse cx="${E.r - 6}" cy="${cy + 1}" rx="8" ry="14" fill="url(#io)"/>
      <ellipse cx="${mx + 1}" cy="${my + 3}" rx="7" ry="3.2" fill="url(#io)" opacity=".8"/>
    </g>
    ${cup(E.l, -1)}
    ${cup(E.r, 1)}
    <path d="M${E.r - 1} ${cy + ch / 2 - 4}C${E.r - 1} ${my + 1} ${mx + 12} ${my + 1} ${mx + 5} ${my}" stroke="${HS.ink}" stroke-width="2.9" fill="none" stroke-linecap="round"/>
    <g transform="rotate(-8 ${mx} ${my})">
      <rect x="${mx - 6.5}" y="${my - 3.4}" width="12.5" height="6.8" rx="3.4" fill="url(#ic)"/>
      <rect x="${mx - 4.6}" y="${my - 2.3}" width="4.6" height="1.7" rx=".85" fill="${HS.hi}"/>
    </g>`;
// Eyes glance to the side (same capsules as the logo, shifted right), with a small catch-light.
const glance = 4;
const eyes = [35.2, 57.6]
  .map(
    (x) => `
    <rect x="${x + glance}" y="37" width="9.2" height="17" rx="4.6" fill="${EYE}"/>
    <rect x="${x + glance + 5}" y="39.5" width="2.2" height="4.2" rx="1.1" fill="#fff" opacity=".35"/>`,
  )
  .join("");
const S = 9.4;
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#26272F"/>
      <stop offset="1" stop-color="#0B0C0E"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="62%" r="58%">
      <stop offset="0" stop-color="${YELLOW}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${YELLOW}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.16"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0.03"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.06"/>
    </linearGradient>
    <linearGradient id="ic" x1="0" y1="0" x2=".8" y2="1">
      <stop offset="0" stop-color="${HS.hi}"/><stop offset=".45" stop-color="${HS.ink}"/><stop offset="1" stop-color="${HS.deep}"/>
    </linearGradient>
    <radialGradient id="io" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#5A3A08" stop-opacity=".4"/><stop offset="1" stop-color="#5A3A08" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="sq"><path d="${bodySquircle}"/></clipPath>
    <clipPath id="mc"><path d="${BODY}"/><path d="${TAIL}"/></clipPath>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.35"/>
    </filter>
    <filter id="markShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2.2" stdDeviation="2.6" flood-color="#000" flood-opacity="0.45"/>
    </filter>
    ${satinDefs("m")}
  </defs>
  <g filter="url(#shadow)">
    <path d="${bodySquircle}" fill="url(#bg)"/>
  </g>
  <g clip-path="url(#sq)">
    <path d="${bodySquircle}" fill="url(#glow)"/>
    <g transform="translate(528 588) rotate(-8) scale(${S}) translate(-50 -50)" filter="url(#markShadow)">
      ${headsetBack}
      ${mark("m", "transparent")}
      ${eyes}
      ${headsetFront}
    </g>
  </g>
  <path d="${bodySquircle}" fill="none" stroke="url(#rim)" stroke-width="3"/>
</svg>
`;

mkdirSync(webPublic, { recursive: true });
mkdirSync(buildDir, { recursive: true });
writeFileSync(join(webPublic, "favicon.svg"), favicon);
writeFileSync(join(buildDir, "icon.svg"), icon);
console.log("wrote favicon.svg and icon.svg");

const { chromium } = await import("@playwright/test");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${icon}</body></html>`);
const pngPath = join(buildDir, "icon.png");
await page.locator("svg").screenshot({ path: pngPath, omitBackground: true });
// Web app icon for PWA/touch.
await page.setViewportSize({ width: 512, height: 512 });
await page.setContent(
  `<html><body style="margin:0;background:transparent"><div style="width:512px;height:512px">${icon.replace('width="1024" height="1024"', 'width="512" height="512"')}</div></body></html>`,
);
await page.locator("svg").screenshot({ path: join(webPublic, "icon-512.png"), omitBackground: true });
await browser.close();
console.log("wrote icon.png");

if (process.platform === "darwin") {
  const iconset = join(buildDir, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  for (const s of [16, 32, 128, 256, 512]) {
    execFileSync(
      "sips",
      ["-z", String(s), String(s), pngPath, "--out", join(iconset, `icon_${s}x${s}.png`)],
      { stdio: "ignore" },
    );
    execFileSync(
      "sips",
      ["-z", String(s * 2), String(s * 2), pngPath, "--out", join(iconset, `icon_${s}x${s}@2x.png`)],
      {
        stdio: "ignore",
      },
    );
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")]);
  rmSync(iconset, { recursive: true, force: true });
  console.log("wrote icon.icns");
}
