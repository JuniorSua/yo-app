// Screenshots of the site, full page and per section, at desktop (1280) and mobile (375) widths.
// Serve site/ first (e.g. `python3 -m http.server 5471 -d site`), then from the repo root:
//   node site/scripts/shots.mjs http://localhost:5471 /tmp/site-shots
// Not deployed (.vercelignore drops scripts/).
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:5471";
const out = resolve(process.argv[3] ?? "/tmp/site-shots");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
for (const [label, width] of [
  ["desktop", 1280],
  ["mobile", 375],
]) {
  const page = await browser.newPage({
    viewport: { width, height: label === "desktop" ? 800 : 812 },
    reducedMotion: "reduce",
  });
  await page.goto(base, { waitUntil: "networkidle" });
  // Show everything the scroll reveal would.
  await page.addStyleTag({
    content: ".reveal{opacity:1!important;transform:none!important;transition:none!important}",
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${label}-full.png`, fullPage: true });
  // Per-section shots without the sticky nav on top of them.
  await page.addStyleTag({ content: ".nav{visibility:hidden!important}" });
  const ids = await page.$$eval("main > section[id], main > .providers, footer.footer", (els) =>
    els.map((e, i) => e.id || (e.classList.contains("providers") ? "providers" : `footer-${i}`)),
  );
  for (const id of ids) {
    const sel =
      id === "providers" ? "main > .providers" : id.startsWith("footer") ? "footer.footer" : `#${id}`;
    // Clip from a full-page capture: element screenshots can come out cut at the viewport's height.
    const box = await page.$eval(sel, (e) => {
      const r = e.getBoundingClientRect();
      return {
        x: 0,
        y: r.top + window.scrollY,
        width: document.documentElement.clientWidth,
        height: r.height,
      };
    });
    if (!box.height) continue;
    await page.screenshot({
      path: `${out}/${label}-${id.replace(/-\d+$/, "")}.png`,
      fullPage: true,
      clip: box,
    });
  }
  await states(page, label);
  await page.close();
}

// States worth a picture of their own. Skipped on a site that doesn't have them (the "before").
async function states(page, label) {
  const chip = page.locator("[data-setup-copy]");
  if (await chip.count()) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await chip.click();
    await page.locator("[data-setup-note]").filter({ hasText: "Copied" }).waitFor();
    await page.locator(".hero-copy").screenshot({ path: `${out}/${label}-state-copied.png` });
  }
  const demo = page.locator("[data-demo]");
  if (!(await demo.locator(".a-first").count())) return;
  const shot = (name) => demo.screenshot({ path: `${out}/${label}-state-demo-${name}.png` });
  await demo.scrollIntoViewIfNeeded();
  await shot("1-connect");
  await demo.locator('[data-pick="claude"]').click();
  await demo.locator("[data-connect]").click();
  await demo.getByText("Claude is connected").waitFor();
  await shot("2-claude-connected");
  await demo.getByRole("button", { name: "Continue" }).click();
  await shot("3-setup-chat");
  await demo.locator('[data-where="local"]').click();
  await demo.locator("[data-start]").click();
  await demo.getByRole("button", { name: "Start chatting →" }).waitFor();
  await page.waitForTimeout(300);
  await shot("4-computer-live");
}
await browser.close();
console.log(`Wrote shots to ${out}`);
