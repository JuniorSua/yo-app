import { expect, type Locator, type Page, test } from "@playwright/test";
import { openSettings, openWorkspacePage } from "./helpers";

async function capture(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}

/**
 * Open the mock app. `native` (the default) is the Mac app: index.html sets `data-native-glass` when the preload
 * reports macOS vibrancy, and only then do the side columns let the desktop's frost through.
 */
async function open(page: Page, { native = true } = {}) {
  await page.addInitScript((native) => {
    localStorage.removeItem("yo.ui");
    if (!sessionStorage.getItem("keepGlass")) localStorage.removeItem("yo.airGlass");
    sessionStorage.setItem("keepGlass", "1");
    if (native)
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.dataset.nativeGlass = "true";
      });
  }, native);
  await page.goto("/?mock=1&fast=1&onboarded=1&theme=light");
  await expect(page.getByTestId("sidebar")).toBeVisible();
}

/** Read the composited RGBA of a computed surface (also understands CSS color(srgb …)). */
async function fill(locator: Locator) {
  return locator.evaluate((el) => {
    const color = getComputedStyle(el).backgroundColor;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  });
}

test("Air Glass in the Mac app: see-through side columns, a solid canvas and big dialogs, on every page", async ({
  page,
}) => {
  await open(page);
  for (const id of ["sidebar", "roster"]) {
    const side = await fill(page.getByTestId(id));
    expect(side[3]).toBeGreaterThan(0);
    expect(side[3]).toBeLessThan(255);
  }
  expect((await fill(page.locator("main.shell-main")))[3]).toBe(255);
  await capture(page, "chat");
  await openSettings(page);
  const dialog = page.getByTestId("settings-dialog");
  // Big dialogs aren't blurred: re-blurring a streaming chat behind them every frame costs too much.
  await expect(dialog).toHaveCSS("backdrop-filter", "none");
  await capture(page, "settings");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  for (const name of ["activity", "approvals", "routines", "memory", "artifacts"] as const) {
    await openWorkspacePage(page, name);
    await expect(page.locator("main > .air-page")).toBeVisible();
  }
});

test("In a browser everything is solid: Dots' flat white canvas and light grey columns", async ({ page }) => {
  await open(page, { native: false });
  expect((await fill(page.getByTestId("sidebar")))[3]).toBe(255);
  expect((await fill(page.getByTestId("roster")))[3]).toBe(255);
  expect((await fill(page.locator("main.shell-main")))[3]).toBe(255);
});

test("Reduce Transparency makes panes and dialogs solid and removes blur", async ({ page }) => {
  await open(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  await expect.poll(async () => (await fill(page.getByTestId("sidebar")))[3]).toBe(255);
  await openSettings(page);
  const dialog = page.getByTestId("settings-dialog");
  await expect(dialog).toHaveCSS("backdrop-filter", "none");
  expect((await fill(dialog))[3]).toBe(255);
  await page.getByTestId("settings-appearance").click();
  await page.getByTestId("theme-dark").click();
  expect((await fill(page.getByTestId("sidebar")))[3]).toBe(255);
  expect((await fill(dialog))[3]).toBe(255);
  await capture(page, "dark-solid-settings");
  await cdp.detach();
});

test("the computer keeps its dark material in light mode", async ({ page }) => {
  await open(page);
  await page.getByTestId("agent-options").click();
  await page.getByTestId("open-computer").click();
  const computer = page.getByTestId("computer-overlay");
  await expect(computer).toBeVisible();
  await page.getByTestId("dock-files").click();
  const window = page.getByTestId("files-window");
  await expect(window).toBeVisible();
  const rgba = await fill(window);
  expect(Math.max(...rgba.slice(0, 3))).toBeLessThan(65);
  await expect(window).toHaveCSS("backdrop-filter", "blur(20px) saturate(1.05)");
});

test("the Air Glass switch turns the glass off and on, and remembers it", async ({ page }) => {
  await open(page);
  const sidebar = page.getByTestId("sidebar");
  expect((await fill(sidebar))[3]).toBeLessThan(255);
  await openSettings(page);
  await page.getByTestId("settings-appearance").click();
  const toggle = page.getByTestId("air-glass");
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-glass", "off");
  expect((await fill(sidebar))[3]).toBe(255);
  await capture(page, "air-glass-off");
  // Applied before first paint on the next launch.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-glass", "off");
  expect((await fill(page.getByTestId("sidebar")))[3]).toBe(255);
  await openSettings(page);
  await page.getByTestId("settings-appearance").click();
  await page.getByTestId("air-glass").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-glass");
  expect((await fill(page.getByTestId("sidebar")))[3]).toBeLessThan(255);
});

test("the Mac app lets a little of the desktop through the side columns, never the reading canvas", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator("html")).toHaveAttribute("data-native-glass", "true");
  // A soft frost through the rail and roster (text stays AA: lib/tokens.test.ts). No web blur: macOS does it.
  const side = (await fill(page.getByTestId("sidebar")))[3];
  expect(side).toBeGreaterThan(170);
  expect(side).toBeLessThan(230);
  expect((await fill(page.locator("main.shell-main")))[3]).toBe(255);
  await expect(page.locator("#root")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.locator("#root")).toHaveCSS("backdrop-filter", "none");
});

test("Air Glass yields to system accessibility preferences", async ({ page }) => {
  await open(page);
  const cdp = await page.context().newCDPSession(page);
  for (const [name, value] of [
    ["prefers-reduced-transparency", "reduce"],
    ["prefers-contrast", "more"],
    ["forced-colors", "active"],
  ]) {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name, value }] });
    expect((await fill(page.getByTestId("sidebar")))[3]).toBe(255);
    await expect(page.getByTestId("composer-input")).toBeVisible();
  }
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  expect((await fill(page.getByTestId("sidebar")))[3]).toBeLessThan(255);
  await cdp.detach();
});
