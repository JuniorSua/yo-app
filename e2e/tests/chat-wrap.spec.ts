import { expect, test } from "@playwright/test";
import { openApp, send } from "./helpers";

const LONG_URL =
  "https://www.polestar.com/us/stock-cars/polestar-4-coupe/814PAPB0E13137300P04300%20%20%20%20%20%2000000221001XCBL11XPILOT/?year=2026&structureweek=202617&partnerid=6US8902";

test("a pasted long link wraps inside the user's bubble and opens as a link", async ({ page }) => {
  await openApp(page);
  await send(page, `Send him the quote:\n\n${LONG_URL}\n\nThanks.`);
  const bubble = page.getByTestId("user-message").last().locator("> div").last();
  await expect(bubble).toContainText("partnerid=6US8902");
  const { sw, cw } = await bubble.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
  const link = bubble.getByRole("link");
  await expect(link).toHaveAttribute("href", LONG_URL);
  await expect(link).toHaveAttribute("target", "_blank");
});

test("the / menu works from the keyboard: arrows move, Escape closes, Tab completes", async ({ page }) => {
  await openApp(page);
  const input = page.getByTestId("composer-input");
  await input.fill("/");
  const menu = page.getByTestId("slash-menu");
  await expect(menu).toBeVisible();
  const options = menu.getByRole("option");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await input.press("Escape");
  await expect(menu).toHaveCount(0);
  // Typing opens it again; Tab completes the highlighted command.
  await input.fill("/c");
  await expect(menu).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue("/compact ");
});
