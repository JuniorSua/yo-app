// What a brand-new customer sees in the everyday app right after setup: nothing left over from the owner's own
// setup (a home PC, ideas for Yo). In-memory backend only.
import { expect, type Page, test } from "@playwright/test";
import { chooseClaudeFirstRun, openApp, openProfile, openSettings, openTeam } from "./helpers";

/** First run with Claude chosen (it signs in after the computer setup), Mac access skipped, the setup "later". */
async function newCustomer(page: Page) {
  await openApp(page, { onboarded: false });
  await page.getByTestId("onboarding-start").click();
  await chooseClaudeFirstRun(page);
  await page.getByTestId("access-skip").click();
  await page.getByTestId("user-name").fill("Sam");
  await page.getByTestId("onboarding-finish").click();
  await page.getByTestId("setup-later").click();
  await expect(page.getByTestId("empty-state")).toContainText(/(Morning|Afternoon|Evening|Hi), Sam\./);
  await expect(page.getByTestId("empty-state")).toContainText("I'm Yo.");
}

// One walk through first run (it's the slow part) covers everything a new customer sees afterwards.
test("a new customer: just Yo in the team, and the profile says how to set up its computer", async ({
  page,
}) => {
  await newCustomer(page);

  const inspector = await openProfile(page);
  await expect(inspector.getByTestId("screen-off-hint")).toHaveText(
    "Yo's computer isn't set up yet. You can set it up in Settings → Computer.",
  );
  await expect(inspector.getByTestId("computer-status")).toHaveText("Not set up yet");
  await page.keyboard.press("Escape");
  // A team of one to start with; the + in the Team popover adds teammates.
  await openTeam(page);
  await expect(page.getByTestId("roster").locator('[data-testid^="agent-row-"]')).toHaveCount(1);
  await expect(page.getByTestId("new-agent")).toBeVisible();

  await page.keyboard.press("Escape");
  await page.getByTestId("profile-trigger").click();
  await expect(page.getByTestId("nav-activity")).toBeVisible();
  await page.keyboard.press("Escape");
  await openSettings(page);
  await expect(page.getByTestId("settings-accounts")).toBeVisible();
  await page.getByTestId("settings-rules").click();
  await expect(page.getByTestId("settings-dialog")).not.toContainText("Legacy");
});

test("a dropped connection on a Mac-only setup never mentions a home PC", async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await page.evaluate(() => (window as any).__yoMock.simulateDisconnect());
  await page.clock.runFor(15_000);
  const banner = page.getByRole("status").filter({ hasText: "Can't reach Yo" });
  await expect(banner).toContainText("quit Yo and open it again");
  await expect(banner).not.toContainText("PC");
});
