// Before/after screenshots of the creature avatars (round 2, milestone 2), mock data only.
//   node scripts/avatar-shots.mjs <baseUrl> <before|after> [outDir]   (default: avatar-shots/)
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const [base, mode, outDir] = process.argv.slice(2);
const DIR = outDir ?? "avatar-shots";
mkdirSync(DIR, { recursive: true });
const after = mode === "after";
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

async function newPage(theme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  return page;
}
const shot = (page, name, clip) =>
  page.screenshot({ path: `${DIR}/${mode}-${name}.png`, ...(clip ? { clip } : {}) });

for (const theme of ["light", "dark"]) {
  // Sidebar + chat header (every mock agent gets a creature in "after").
  let page = await newPage(theme);
  await page.goto(`${base}/?mock=1&fast=1&onboarded=1&theme=${theme}${after ? "&mockCreatures=1" : ""}`);
  await page.getByTestId("sidebar").waitFor();
  await page.waitForTimeout(5000);
  await shot(page, `${theme}-sidebar-chat`);
  // More states in the list: working, error.
  await page.evaluate(() => {
    window.__yoMock.patchAgent("agt_research", { activity: "working" });
    window.__yoMock.patchAgent("agt_cos", { activity: "error" });
  });
  await page.waitForTimeout(4000);
  await shot(page, `${theme}-sidebar-states`, { x: 0, y: 0, width: 640, height: 520 });

  // New agent + avatar studio picker.
  await page.getByTestId("new-agent").click();
  await page.getByTestId("template-builder").click();
  await page.waitForTimeout(4000);
  await shot(page, `${theme}-new-agent`);
  if (after) {
    await page.getByTestId("creature-sprout").click();
    await page.waitForTimeout(3000);
    await shot(page, `${theme}-studio-sprout`);
    await page.getByTestId("avatar-studio").getByRole("button", { name: "Thinking" }).click();
    await page.waitForTimeout(2000);
    await shot(page, `${theme}-studio-sprout-thinking`);
  }
  await page.getByTestId("agent-name").fill("Sprouty");
  await page.getByTestId("create-agent").click();
  await page.getByTestId("empty-state").waitFor();
  if (!(await page.getByTestId("toggle-workspace").getAttribute("aria-expanded")).includes("true"))
    await page.getByTestId("toggle-workspace").click();
  await page.waitForTimeout(4000);
  await shot(page, `${theme}-workspace`);
  await page.context().close();

  // Onboarding: Meet Yo.
  page = await newPage(theme);
  await page.goto(`${base}/?mock=1&fast=1&theme=${theme}`);
  await page.getByTestId("onboarding").waitFor();
  await page.getByTestId("onboarding-start").click();
  await page.getByTestId("connect-pick-claude").click();
  await page.getByTestId("claude-token-input").fill(`sk-ant-oat01-${"FAKE_e2e_token-".repeat(7)}`);
  await page.getByTestId("claude-token-submit").click();
  await page.getByTestId("connect-claude-done").click();
  await page.getByTestId("access-skip").click();
  await page.getByTestId("avatar-studio").waitFor();
  if (after) await page.getByTestId("creature-pebble").click();
  await page.waitForTimeout(4000);
  await shot(page, `${theme}-onboarding-meet`);
  await page.context().close();

  // Contact sheets: every pose of each creature.
  if (after)
    for (const kind of ["sprout", "pebble", "mimi"]) {
      page = await newPage(theme);
      await page.goto(`${base}/?gallery=1&creature=${kind}&theme=${theme}`);
      const sheet = page.getByTestId(`creature-sheet-${kind}`);
      await sheet.waitFor();
      await page.waitForFunction(
        () => document.querySelectorAll("[data-creature] > img").length === 7,
        null,
        { timeout: 60000 },
      );
      await page.waitForTimeout(500);
      await sheet.screenshot({ path: `${DIR}/sheet-${kind}-${theme}.png` });
      await page.context().close();
    }
}
await browser.close();
console.log("done");
