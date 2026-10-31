/**
 * Work & Personal spaces, the shell: the sidebar's title (the space, which opens the space menu), one calm look in
 * both spaces, switching on the work-hours schedule, the palette and shortcut, the one-time intro, and Pip staying
 * the Personal lead. The mock holds Work by default; `&space=work|personal|auto|old` changes it
 * (lib/mock/index.ts). The e2e browser runs in America/New_York, like the mock's settings.
 */
import { expect, type Page, test } from "@playwright/test";

// Tue Oct 13 2026: work hours are Mon–Fri 11:00–19:00.
const TUE_3PM = new Date("2026-10-13T15:00:00-04:00");
const TUE_BEFORE_7PM = new Date("2026-10-13T18:59:30-04:00");

async function open(
  page: Page,
  opts: {
    space?: "work" | "personal" | "auto" | "old";
    theme?: "light" | "dark";
    at?: Date;
    extra?: string;
  } = {},
) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("spaces-e2e")) return;
    sessionStorage.setItem("spaces-e2e", "1");
    for (const k of ["yo.ui", "yo.theme"]) localStorage.removeItem(k);
  });
  if (opts.at) await page.clock.install({ time: opts.at });
  await page.goto(
    `/?mock=1&fast=1&onboarded=1&theme=${opts.theme ?? "dark"}${opts.space ? `&space=${opts.space}` : ""}${opts.extra ?? ""}`,
  );
  await expect(page.getByTestId("sidebar")).toBeVisible();
}

const html = (page: Page) => page.locator("html");
/** Pick a space from the menu under the sidebar's title. */
async function pick(page: Page, space: "work" | "personal" | "auto") {
  await page.getByTestId("space-rail").click();
  await page.getByTestId(`space-menu-${space}`).click();
}
const title = (page: Page) => page.getByTestId("agent-title");
const token = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test("Personal time: Pip leads the roster, the sidebar's title says Personal, and the look stays calm", async ({
  page,
}) => {
  await open(page, { space: "personal" });
  await expect(title(page)).toHaveText("Pip");
  await expect(page.getByTestId("space-rail")).toContainText("Personal");
  await expect(page.getByTestId("space-status")).toHaveText("Personal · stays on");
  const rows = page.getByTestId("roster").locator('[data-testid^="agent-row-"]');
  await expect(rows.first()).toHaveAttribute("data-testid", "agent-row-Pip");
  await expect(page.getByTestId("roster").getByTestId("agent-row-Yo")).toHaveCount(0);
  // No warm re-skin: the same dark tokens as Work.
  await expect(html(page)).not.toHaveAttribute("data-space");
  await expect.poll(() => token(page, "--bg")).toBe("#171717");
  // The composer and the empty-state talk to Pip.
  await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", "Message Pip…");
});

test("Personal time, light: switching to Work brings Yo back to the top of the roster", async ({ page }) => {
  await open(page, { space: "personal", theme: "light" });
  await expect(title(page)).toHaveText("Pip");
  await expect.poll(() => token(page, "--bg")).toBe("#ffffff");
  await pick(page, "work");
  await expect(title(page)).toHaveText("Yo");
  await expect(page.getByTestId("space-rail")).toContainText("Work");
  await expect(page.getByTestId("roster").locator('[data-testid^="agent-row-"]').first()).toHaveAttribute(
    "data-testid",
    "agent-row-Yo",
  );
  await expect.poll(() => token(page, "--bg")).toBe("#ffffff");
  // Saved in Settings, so phone, Telegram and other windows agree.
  const manual = await page.evaluate(() => (window as any).__yoMock.s.settings.spaceManual);
  expect(manual).toEqual({ space: "work", until: null });
});

test("Work is the default: Yo's chat, the dark theme unchanged", async ({ page }) => {
  await open(page);
  await expect(title(page)).toHaveText("Yo");
  await expect(html(page)).not.toHaveAttribute("data-space");
  await expect.poll(() => token(page, "--bg")).toBe("#171717");
  await expect(page.getByTestId("space-rail")).toContainText("Work");
});

test("the menu: Auto follows the work hours; picking a space holds it until the schedule catches up", async ({
  page,
}) => {
  await open(page, { space: "auto", at: TUE_3PM });
  await expect(page.getByTestId("space-status")).toHaveText("Auto · until 7 PM");
  await page.getByTestId("space-status").click();
  const menu = page.getByTestId("space-menu");
  await expect(menu).toContainText("Work hours: Mon–Fri 11 AM–7 PM");
  await expect(page.getByTestId("space-menu-auto")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("space-menu-personal").click();
  await expect(title(page)).toHaveText("Pip");
  await expect(page.getByTestId("space-status")).toHaveText("Personal until 7 PM");
  await page.getByTestId("space-status").click();
  await expect(page.getByTestId("space-menu-personal")).toContainText("Until 7 PM, then back to Auto");
  await page.getByTestId("space-menu-auto").click();
  await expect(page.getByTestId("space-status")).toHaveText("Auto · until 7 PM");
  await expect(title(page)).toHaveText("Yo");
});

test("the sidebar's title opens the same menu from any page", async ({ page }) => {
  await open(page, { space: "personal" });
  await page.getByTestId("rail-tasks").click();
  await expect(page.getByTestId("rail-tasks")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("space-rail").click();
  await page.getByTestId("space-menu-work").click();
  await expect(title(page)).toHaveText("Yo");
});

test("at 7 PM the chat moves from Yo to Pip on its own", async ({ page }) => {
  await open(page, { space: "auto", at: TUE_BEFORE_7PM });
  await expect(title(page)).toHaveText("Yo");
  await page.clock.runFor(31_000);
  await expect(title(page)).toHaveText("Pip");
  await expect(page.getByTestId("space-rail")).toContainText("Personal");
  await expect(page.getByTestId("space-status")).toHaveText("Auto · until 11 AM");
});

test("at 7 PM on another page, a toast offers Pip instead of pulling you away", async ({ page }) => {
  await open(page, { space: "auto", at: TUE_BEFORE_7PM });
  await page.getByTestId("rail-tasks").click();
  await page.clock.runFor(31_000);
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Personal time" });
  await expect(toast).toContainText("It's 7 PM. Pip is with you until 11 AM.");
  await expect(page.getByTestId("rail-tasks")).toHaveAttribute("aria-current", "page");
  await toast.getByRole("button", { name: "Open Pip" }).click();
  await expect(title(page)).toHaveText("Pip");
});

test("'Stay in Work' in the toast keeps Work until the next change", async ({ page }) => {
  await open(page, { space: "auto", at: TUE_BEFORE_7PM });
  await page.getByTestId("rail-tasks").click();
  await page.clock.runFor(31_000);
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Personal time" });
  await toast.getByRole("button", { name: "Stay in Work" }).click();
  await expect(page.getByTestId("space-rail")).toContainText("Work");
  const manual = await page.evaluate(() => (window as any).__yoMock.s.settings.spaceManual);
  expect(manual.space).toBe("work");
  expect(manual.until).toBe(Date.parse("2026-10-14T11:00:00-04:00"));
});

test("the palette and ⌘⇧M switch spaces; ⌘N writes to the active space's agent", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette").getByRole("textbox").fill("switch to");
  await page.getByTestId("command-palette").getByText("Switch to Personal").click();
  await expect(title(page)).toHaveText("Pip");
  await page.getByTestId("rail-tasks").click();
  await page.keyboard.press("ControlOrMeta+Shift+KeyM");
  await expect(title(page)).toHaveText("Yo");
  await page.keyboard.press("ControlOrMeta+Shift+KeyM");
  await expect(title(page)).toHaveText("Pip");
  await page.getByTestId("rail-tasks").click();
  await page.keyboard.press("ControlOrMeta+n");
  await expect(title(page)).toHaveText("Pip");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  // Both assistants are listed together; "work" finds Yo.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette").getByRole("textbox").fill("work");
  await expect(page.getByTestId("command-palette")).toContainText("Your assistants");
  await expect(page.getByTestId("command-palette")).toContainText("Work · ");
});

test("the one-time intro introduces Pip and stays dismissed", async ({ page }) => {
  await open(page, { extra: "&spacesIntro=1" });
  const intro = page.getByTestId("space-intro");
  await expect(intro).toContainText("Meet Pip, your personal-time agent");
  await expect(intro).toContainText("Mon–Fri 11 AM–7 PM");
  await page.getByTestId("space-intro-ok").click();
  await expect(intro).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("yo.spacesIntro"))).toBe("1");
});

test("an older core without spaces: no switch, no badge, no warm look", async ({ page }) => {
  await open(page, { space: "old" });
  await expect(title(page)).toHaveText("Yo");
  await expect(page.getByTestId("space-switch")).toHaveCount(0);
  await expect(page.getByTestId("space-rail")).toHaveCount(0);
  await expect(html(page)).not.toHaveAttribute("data-space");
});

test("Pip can't be archived", async ({ page }) => {
  await open(page);
  await pick(page, "personal");
  await expect(title(page)).toHaveText("Pip");
  await page.getByTestId("agent-options").click();
  await page.getByTestId("open-agent-settings").click();
  const settings = page.getByTestId("agent-settings-dialog");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("button", { name: "Archive" })).toHaveCount(0);
});

test("phone width: no roster, and the palette still switches spaces", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(page.getByTestId("roster")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette").getByRole("textbox").fill("switch to");
  await page.getByTestId("command-palette").getByText("Switch to Personal").click();
  await expect(title(page)).toHaveText("Pip");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
