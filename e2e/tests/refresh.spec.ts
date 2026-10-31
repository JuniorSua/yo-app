/**
 * The "Duet" refresh: light and dark screenshots of the main screens for review (chat, empty state, approval and
 * question cards, Tasks, Make, and the phone tab bar). Saved outside the repo, to /tmp/duet-shots/design/.
 */
import { expect, type Page, test } from "@playwright/test";
import { openAgent, openApp, send } from "./helpers";

const DIR = "/tmp/duet-shots/design";

async function shot(page: Page, theme: string, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${theme}-${name}.png` });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`refresh ${theme}`, () => {
    test.use({ colorScheme: theme });

    test(`desktop (${theme})`, async ({ page }) => {
      test.slow();
      await openApp(page, { theme });
      await expect(page.getByTestId("rail-chat")).toHaveAttribute("aria-current", "page");
      await shot(page, theme, "01-chat");

      await send(page, "Buy me a USB-C cable");
      await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("approve-deny")).toHaveText("Refuse");
      await page.getByTestId("approval-card").scrollIntoViewIfNeeded();
      await shot(page, theme, "03-approval-card");
      await page.getByTestId("approve-deny").click();
      await expect(page.getByTestId("approval-card")).toHaveCount(0);

      await send(page, "Find me a flight to Lisbon");
      await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("ask-card").scrollIntoViewIfNeeded();
      await shot(page, theme, "04-question-card");

      await page.getByTestId("rail-tasks").click();
      await expect(page.getByTestId("rail-tasks")).toHaveAttribute("aria-current", "page");
      await shot(page, theme, "05-tasks");
      await page.getByTestId("tab-approvals").click();
      await shot(page, theme, "06-needs-you");

      await page.getByTestId("rail-make").click();
      await expect(page.getByTestId("rail-make")).toHaveAttribute("aria-current", "page");
      await shot(page, theme, "07-make");

      await page.getByTestId("rail-memory").click();
      await shot(page, theme, "08-memory");
    });

    test(`empty state (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      // A fresh assistant's first screen (Yo's chat already has history in the mock).
      await page.evaluate(async () => {
        const m = (window as any).__yoMock;
        await m.call("agent.create", {
          name: "Scout",
          role: "Explores ideas",
          instructions: "",
          avatar: {
            shape: "tablet",
            color: "#F4579F",
            eyes: "capsule",
            accessory: "none",
            softie: { kind: "kiki" },
          },
        });
      });
      await page.waitForTimeout(600);
      await openAgent(page, "Scout");
      await expect(page.getByTestId("empty-state")).toBeVisible();
      await shot(page, theme, "02-empty-state");
    });

    test(`phone (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openApp(page, { theme });
      await shot(page, theme, "09-phone-chat");
      await page.getByTestId("rail-tasks").click();
      await expect(page.getByTestId("rail-tasks")).toHaveAttribute("aria-current", "page");
      await shot(page, theme, "10-phone-tasks");
      await page.getByTestId("rail-make").click();
      await shot(page, theme, "11-phone-make");
    });
  });
}
