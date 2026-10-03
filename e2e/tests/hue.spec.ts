/**
 * Light-mode hue from Yo's character (round 2, milestone 3): Yo's creature tints the light theme, dark mode is
 * untouched, and Settings → Appearance can turn it off.
 */
import { expect, type Page, test } from "@playwright/test";
import { openSettings } from "./helpers";

const TOKENS = [
  "--bg",
  "--sidebar",
  "--card",
  "--bubble",
  "--border",
  "--fg",
  "--muted",
  "--brand",
  "--link",
];

/** Open the mock app; `&hue=` makes the mock's Yo that creature. Local prefs reset once per test, not per load. */
async function open(page: Page, opts: { theme: "light" | "dark"; hue?: string }) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("hue-e2e")) return;
    sessionStorage.setItem("hue-e2e", "1");
    for (const k of ["yo.ui", "yo.matchHue", "yo.hue", "yo.theme"]) localStorage.removeItem(k);
  });
  await page.goto(`/?mock=1&fast=1&onboarded=1&theme=${opts.theme}${opts.hue ? `&hue=${opts.hue}` : ""}`);
  await expect(page.getByTestId("sidebar")).toBeVisible();
}

function tokens(page: Page) {
  return page.evaluate((names) => {
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
  }, TOKENS);
}

const html = (page: Page) => page.locator("html");

test.describe("light-mode hue", () => {
  test("Yo's creature tints light mode", async ({ page }) => {
    await open(page, { theme: "light", hue: "sprout" });
    await expect(html(page)).toHaveClass("light");
    await expect(html(page)).toHaveAttribute("data-hue", "sprout");
    await expect.poll(async () => (await tokens(page))["--bg"]).toBe("#fafbf5");
    expect((await tokens(page))["--brand"]).toBe("#779554");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(250, 251, 245)");
  });

  test("each creature has its own hue, and changing Yo's creature updates it live", async ({ page }) => {
    await open(page, { theme: "light", hue: "pebble" });
    await expect(html(page)).toHaveAttribute("data-hue", "pebble");
    await expect.poll(async () => (await tokens(page))["--bg"]).toBe("#fffaf7");
    await page.evaluate(async () => {
      const m = (window as any).__yoMock;
      const yo = m.s.agents.find((a: any) => a.isPrimary);
      await m.call("agent.update", {
        id: yo.id,
        patch: { avatar: { ...yo.avatar, creature: { kind: "mimi" } } },
      });
    });
    await expect(html(page)).toHaveAttribute("data-hue", "mimi");
    await expect.poll(async () => (await tokens(page))["--bg"]).toBe("#fcfaff");
  });

  test("no creature, or an unknown one, means no hue", async ({ page }) => {
    await open(page, { theme: "light" });
    await expect(html(page)).not.toHaveAttribute("data-hue");
    expect((await tokens(page))["--bg"]).toBe("#faf9f6");
    await page.goto("/?mock=1&fast=1&onboarded=1&theme=light&hue=dragon");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(html(page)).not.toHaveAttribute("data-hue");
    expect((await tokens(page))["--bg"]).toBe("#faf9f6");
  });

  test("dark mode is unchanged by a creature", async ({ browser }) => {
    // Four pages, each drawing a creature with software WebGL: past 45s on a busy CI runner.
    test.slow();
    const plain = await browser.newPage();
    await open(plain, { theme: "dark" });
    const base = await tokens(plain);
    expect(base["--bg"]).toBe("#1c1d20");
    for (const hue of ["sprout", "pebble", "mimi"]) {
      const page = await browser.newPage();
      await open(page, { theme: "dark", hue });
      await expect(html(page)).toHaveClass("dark");
      await expect(html(page)).not.toHaveAttribute("data-hue");
      expect(await tokens(page)).toEqual(base);
      // Switching to light shows the hue; back to dark restores the exact dark tokens.
      await openSettings(page);
      await page.getByTestId("settings-appearance").click();
      await page.getByTestId("theme-light").click();
      await expect(html(page)).toHaveAttribute("data-hue", hue);
      await page.getByTestId("theme-dark").click();
      await expect(html(page)).toHaveClass("dark");
      await expect(html(page)).not.toHaveAttribute("data-hue");
      expect(await tokens(page)).toEqual(base);
      await page.close();
    }
    await plain.close();
  });

  test("the Appearance toggle turns the hue off, and the choice sticks", async ({ page }) => {
    await open(page, { theme: "light", hue: "sprout" });
    await expect(html(page)).toHaveAttribute("data-hue", "sprout");
    await openSettings(page);
    await page.getByTestId("settings-appearance").click();
    const toggle = page.getByTestId("match-hue");
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(html(page)).not.toHaveAttribute("data-hue");
    expect((await tokens(page))["--bg"]).toBe("#faf9f6");

    await page.reload();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(html(page)).not.toHaveAttribute("data-hue");

    await openSettings(page);
    await page.getByTestId("settings-appearance").click();
    await page.getByTestId("match-hue").click();
    await expect(html(page)).toHaveAttribute("data-hue", "sprout");
    await expect.poll(async () => (await tokens(page))["--bg"]).toBe("#fafbf5");
  });
});
