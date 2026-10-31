// Re-renders the social preview (assets/og.png, 1200x630) from the live hero headline and the Softies, plus the
// PNG icons (assets/apple-touch-icon.png 180x180, assets/favicon-32.png) from assets/logo.svg. Run it after
// changing the hero's words, so link previews in Messages, Slack or X never show old copy.
// Serve site/ first, then from the repo root:
//   python3 -m http.server 5190 -d site &
//   node site/scripts/export-og.mjs http://localhost:5190
// Not deployed (.vercelignore drops scripts/).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:5190";
const assets = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const browser = await chromium.launch();

// ------------------------------------------------------------ og.png
{
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await page.goto(base, { waitUntil: "networkidle" });
  // The page's own headline and subline, set on a plain card with the team: nothing a preview can't click.
  const title = (await page.locator(".hero-title").innerText())
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim();
  const [first, second] = title.split(/,\s*/);
  await page.evaluate(
    ({ first, second }) => {
      const team = ["dew", "mochi", "yo", "pico", "clove", "kiki"]
        .map(
          (id) =>
            `<img src="/assets/softies/${id}.svg" style="width:${id === "yo" ? 150 : 112}px;height:${id === "yo" ? 150 : 112}px;margin:0 -8px ${id === "yo" ? -9 : -14}px" alt="">`,
        )
        .join("");
      document.body.innerHTML = `
        <div style="position:fixed;inset:0;padding:60px 72px 0;background:#fff;overflow:hidden;font-family:var(--font)">
          <div>
            <div style="display:flex;align-items:center;gap:10px;color:#6b6b6b;font-size:24px;font-weight:500">
              <img src="/assets/logo.svg" style="width:40px;height:40px" alt="">Yo 2 · Free and open source
            </div>
            <h1 class="hero-title" style="margin-top:28px;font-size:104px">${first},<br>${second}<span class="dot">.</span></h1>
            <p style="max-width:470px;margin:28px 0 0;color:#3b3b3b;font-size:27px;line-height:1.4;letter-spacing:-0.01em">Free, open-source AI agents on the subscriptions you already have.</p>
          </div>
          <div style="position:absolute;right:64px;bottom:22px;display:flex;align-items:flex-end">
            ${team}
          </div>
          <div style="position:absolute;left:0;right:0;bottom:0;height:22px;background:#f4f4f3;box-shadow:0 -1px 0 #e8e8e6"></div>
        </div>`;
    },
    { first, second },
  );
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(assets, "og.png"), clip: { x: 0, y: 0, width: 1200, height: 630 } });
  await page.close();
}

// ------------------------------------------------------------ icons
const svg = readFileSync(resolve(assets, "logo.svg"), "utf8");
for (const [file, size, pad, bg] of [
  ["apple-touch-icon.png", 180, 22, "#ffffff"],
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
