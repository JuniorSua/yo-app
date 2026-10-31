import { expect, test } from "@playwright/test";
import { openApp, openSettings } from "./helpers";

/** Yo 2 is free and open source: no paywall anywhere, and Settings has Support Yo. */
test.describe("free and open source", () => {
  test("a fresh app goes straight to onboarding, with no paywall", async ({ page }) => {
    // mockLicense=locked used to stand in for a public build that hadn't paid. Yo 2 ignores it.
    await page.goto("/?mock=1&fast=1&mockLicense=locked");
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await expect(page.getByTestId("activate-yo")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/license key|\$10|Subscribe/i);
  });

  test("Settings → Support Yo: Chip in, Sponsor monthly and the code open in the browser", async ({
    page,
    context,
  }) => {
    await context.route("https://theyoapp.com/**", (r) => r.fulfill({ body: "theyoapp.com" }));
    await context.route("https://github.com/**", (r) => r.fulfill({ body: "GitHub" }));
    await openApp(page);
    await openSettings(page);
    await expect(page.getByTestId("settings-subscription")).toHaveCount(0);
    await page.getByTestId("settings-support").click();
    const support = page.getByTestId("support-settings");
    await expect(support).toContainText("Yo is free and open source. It always will be.");
    await expect(support).not.toContainText(/license key|\$10|subscribe/i);

    for (const [id, url] of [
      ["support-chip-in", "https://theyoapp.com/#support"],
      ["support-sponsor", "https://github.com/sponsors/JuniorSua"],
      ["support-source", "https://github.com/JuniorSua/yo-app"],
    ]) {
      const opened = context.waitForEvent("page");
      await page.getByTestId(id).click();
      const tab = await opened;
      await tab.waitForLoadState();
      expect(tab.url()).toBe(url);
      await tab.close();
    }

    await page.getByTestId("settings-about").click();
    await expect(page.getByTestId("about-license")).toHaveText("Free and open source · Apache-2.0");
  });
});
