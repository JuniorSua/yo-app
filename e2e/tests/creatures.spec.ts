/**
 * Creature avatars (Sprout, Pebble, Mimi): picked in the avatar studio, shown in the sidebar (cached still
 * picture) and the chat header (the one live canvas), posed from the agent's activity.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { openApp, send } from "./helpers";

/** Number of visibly painted pixels in an <img> or <canvas> (0 if not drawn yet). */
async function painted(el: Locator) {
  return el.evaluate((node) => {
    const src = node as HTMLImageElement | HTMLCanvasElement;
    const w = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
    const h = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
    if (!w || !h) return 0;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 20) n++;
    return n;
  });
}

/** Pixels of an element's screenshot that differ from its corner (the background): the WebGL canvas
 * doesn't keep its drawing buffer, so it's read from the screen. */
async function drawnOnScreen(page: Page, el: Locator) {
  const png = (await el.screenshot()).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (Math.abs(d[i]! - d[0]!) + Math.abs(d[i + 1]! - d[1]!) + Math.abs(d[i + 2]! - d[2]!) > 40) n++;
    return n;
  }, png);
}

const header = (page: Page) => page.locator("header").filter({ has: page.getByTestId("agent-title") });

test("creatures: pick Sprout in the studio, see it in the sidebar and the chat header", async ({ page }) => {
  // A new agent boots its computer and runs a research turn: room for slow (2-core, no GPU) runners.
  test.slow();
  await openApp(page);
  await page.getByTestId("new-agent").click();
  await page.getByTestId("template-builder").click();
  const studio = page.getByTestId("avatar-studio");
  await page.getByTestId("creature-sprout").click();
  await expect(page.getByTestId("creature-sprout")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("creature-card")).toContainText("Sprout");
  // A creature isn't shaped or recoloured: the drawn editors are hidden.
  await expect(page.getByTestId("shape-hex")).toHaveCount(0);
  // The studio preview is live and offers the Thinking pose.
  await expect(studio.locator('[data-creature="sprout"] canvas[data-creature-live]')).toHaveCount(1);
  await studio.getByRole("button", { name: "Thinking" }).click();
  await expect(studio.locator('[data-creature="sprout"][data-pose="thinking"]').first()).toBeVisible();

  // Picking a drawn style clears the creature; picking it again brings it back.
  await page.getByTestId("preset-violet-copilot").click();
  await expect(page.getByTestId("creature-sprout")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("shape-hex")).toBeVisible();
  await page.getByTestId("creature-sprout").click();

  await page.getByTestId("agent-name").fill("Sprouty");
  await page.getByTestId("create-agent").click();
  await expect(page.getByTestId("new-agent-dialog")).toHaveCount(0);

  // Sidebar: a cached still picture, painted.
  const row = page.getByTestId("agent-row-Sprouty");
  const still = row.locator('[data-creature="sprout"] img');
  await expect(still).toBeVisible();
  await expect.poll(() => painted(still)).toBeGreaterThan(200);

  // Chat header + empty-state hero: the creature, and exactly one live canvas on the page (the hero, the
  // largest live avatar; the header shows the still picture meanwhile).
  await expect(header(page).locator('[data-creature="sprout"]')).toBeVisible();
  await expect(page.locator("canvas[data-creature-live]")).toHaveCount(1);
  const live = page.getByTestId("empty-state").locator("canvas[data-creature-live]");
  await expect.poll(() => drawnOnScreen(page, live)).toBeGreaterThan(500);

  // Once the chat has messages the header holds the live canvas, and it follows the turn:
  // thinking while the agent reasons, the laptop while it uses tools.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as any).__poses = seen;
    new MutationObserver(() => {
      const el = document.querySelector('header [data-creature="sprout"]');
      const pose = el?.getAttribute("data-pose");
      if (pose && seen.at(-1) !== pose) seen.push(pose);
    }).observe(document.body, { subtree: true, attributes: true, childList: true });
  });
  await send(page, "Research the history of the espresso machine");
  await expect(header(page).locator("canvas[data-creature-live]")).toHaveCount(1);
  await expect
    .poll(() => drawnOnScreen(page, header(page).locator("canvas[data-creature-live]")))
    .toBeGreaterThan(100);
  await expect
    .poll(() => page.evaluate(() => (window as any).__poses as string[]), { timeout: 30_000 })
    .toEqual(expect.arrayContaining(["thinking", "working"]));
  const poses: string[] = await page.evaluate(() => (window as any).__poses);
  expect(poses.indexOf("thinking")).toBeLessThan(poses.indexOf("working"));
  await expect(page.locator("canvas[data-creature-live]")).toHaveCount(1);
});

test("creatures: a waiting agent glows, and every creature in the list shares cached pictures", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto("/?mock=1&fast=1&onboarded=1&mockCreatures=1");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  // Shopper needs you: question pose with the yellow glow.
  const shopper = page.getByTestId("agent-row-Shopper").locator("[data-creature]");
  await expect(shopper).toHaveAttribute("data-pose", "question");
  await expect(shopper).toHaveAttribute("data-glow", "");
  // Every row is a picture, never its own WebGL canvas: one live canvas on the whole page at most.
  const rows = page.getByTestId("sidebar").locator("[data-creature] img");
  await expect(rows).toHaveCount(5);
  await expect(page.getByTestId("sidebar").locator("canvas")).toHaveCount(0);
  await expect(page.locator("canvas[data-creature-live]")).toHaveCount(1);
  // Same creature + pose + size bucket → one shared picture (Yo's sidebar row and its timeline replies).
  const idle = page.locator('[data-creature="sprout"][data-pose="idle"] > img');
  await expect.poll(() => idle.count()).toBeGreaterThan(1);
  const srcs = await idle.evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
  expect(new Set(srcs).size).toBe(1);
});
