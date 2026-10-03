// Re-renders the social preview (assets/og.png, 1200x630) from the live hero copy, plus the PNG icons
// (assets/apple-touch-icon.png 180x180, assets/favicon-32.png) from assets/logo.svg. Run it after changing the
// hero's words, so link previews in Messages, Slack or X never show old copy.
// Serve site/ first, then from the repo root:
//   python3 -m http.server 5471 -d site &
//   node site/scripts/export-og.mjs http://localhost:5471
// Not deployed (.vercelignore drops scripts/).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:5471";
const assets = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const browser = await chromium.launch();

// ------------------------------------------------------------ og.png
{
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, reducedMotion: "reduce" });
  await page.goto(base, { waitUntil: "networkidle" });
  // Just the pitch and the mascot: no nav, buttons, copy chip or fine print (they aren't clickable in a preview).
  await page.addStyleTag({
    content: `
      .reveal{opacity:1!important;transform:none!important;transition:none!important}
      .nav,.skip,.hero-actions,.setup-copy-wrap,.hero-meta,.providers{display:none!important}
      html,body{overflow:hidden!important}
      .hero{width:1080px!important;grid-template-columns:minmax(0,1.2fr) minmax(0,.8fr)!important;gap:24px!important;min-height:630px;padding:0!important;box-sizing:border-box}
    `,
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(assets, "og.png"), clip: { x: 0, y: 0, width: 1200, height: 630 } });
  await page.close();
}

// ------------------------------------------------------------ icons
const svg = readFileSync(resolve(assets, "logo.svg"), "utf8");
for (const [file, size, pad, bg] of [
  ["apple-touch-icon.png", 180, 22, "#faf9f6"],
  ["favicon-32.png", 32, 0, "transparent"],
]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<html><body style="margin:0;background:${bg};width:${size}px;height:${size}px;display:grid;place-items:center">
      <div style="width:${size - pad * 2}px;height:${size - pad * 2}px">${svg.replace("<svg", '<svg width="100%" height="100%"')}</div>
    </body></html>`,
  );
  await page.screenshot({ path: resolve(assets, file), omitBackground: bg === "transparent" });
  await page.close();
}

await browser.close();
console.log(`Wrote og.png, apple-touch-icon.png and favicon-32.png to ${assets}`);
