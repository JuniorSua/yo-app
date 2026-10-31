// Screenshots of the site in light and dark: the first screen and the full page at desktop (1440) and mobile
// (390) widths, plus the other pages at desktop. Serve site/ first (e.g. `npx -y serve -l 5190 site`), then from
// the repo root:
//   node site/scripts/shots.mjs http://localhost:5190 /tmp/site-shots
// Files are named light-NN-what.png / dark-NN-what.png. Not deployed (.vercelignore drops scripts/).
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:5190";
const out = resolve(process.argv[3] ?? "/tmp/site-shots");
const only = process.argv[4]; // optional: "home" or "pages"
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  let n = 1;
  const name = (what) => `${out}/${scheme}-${String(n++).padStart(2, "0")}-${what}.png`;
  if (only !== "pages") {
    for (const [label, width, height] of [
      ["desktop", 1440, 900],
      ["mobile", 390, 844],
    ]) {
      const page = await browser.newPage({
        viewport: { width, height },
        colorScheme: scheme,
        reducedMotion: "reduce",
        deviceScaleFactor: label === "mobile" ? 2 : 1,
      });
      await page.goto(base, { waitUntil: "networkidle" });
      await page.waitForTimeout(500);
      await page.screenshot({ path: name(`${label}-top`) });
      await page.screenshot({ path: name(`${label}-full`), fullPage: true });
      if (label === "desktop") {
        // Each section on its own, without the sticky nav over it.
        await page.addStyleTag({ content: ".nav{visibility:hidden!important}" });
        for (const id of [
          "team",
          "models",
          "computer",
          "phone",
          "open-source",
          "support",
          "faq",
          "download",
        ]) {
          const el = page.locator(`#${id}`);
          if (!(await el.count())) continue;
          await el.scrollIntoViewIfNeeded();
          await el.screenshot({ path: name(`section-${id}`) });
        }
      }
      await page.close();
    }
    // Support Yo once the owner has set a Chip in link (config.js ships with it empty, so the button is hidden).
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await page.route("**/config.js", (r) =>
      r.fulfill({
        contentType: "text/javascript",
        body: 'window.YO_SITE = Object.freeze({ SUPPORT_EMAIL: "support@theyoapp.com", DOWNLOAD_TAG: "", SUPPORT_ONCE_LINK: "https://buy.stripe.com/test_example", SPONSOR_LINK: "https://github.com/sponsors/JuniorSua" });',
      }),
    );
    await page.goto(`${base}/#support`, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: ".nav{visibility:hidden!important}" });
    await page.locator("#support").screenshot({ path: name("section-support-chip-in") });
    await page.close();
  }
  if (only !== "home") {
    for (const p of ["support", "terms", "privacy", "thanks", "404"]) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      await page.goto(`${base}/${p}.html`, { waitUntil: "networkidle" });
      await page.screenshot({ path: name(`page-${p}`) });
      await page.close();
    }
  }
}
await browser.close();
console.log(`Wrote shots to ${out}`);
