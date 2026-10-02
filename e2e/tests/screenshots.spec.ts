/**
 * Captures hand-off screenshots of every key screen in dark and light themes into e2e/screenshots/.
 * Run: pnpm e2e --grep screenshots
 */
import { expect, type Page, test } from "@playwright/test";
import { openAgent, openApp, openSettings, openWorkspacePage, send } from "./helpers";

const DIR = "e2e/screenshots";

async function shot(page: Page, theme: string, name: string) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${DIR}/${theme}-${name}.png` });
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`screenshots ${theme}`, () => {
    test.use({ colorScheme: theme });

    test(`onboarding (${theme})`, async ({ page }) => {
      await openApp(page, { onboarded: false, theme });
      await page.waitForTimeout(600);
      await shot(page, theme, "01-onboarding-welcome");
      await page.getByTestId("onboarding-start").click();
      await expect(page.getByTestId("connect-found-none")).toBeVisible();
      await shot(page, theme, "02-onboarding-subscriptions");
      // Connect Claude (fake token), so the first agent has a model to set up its computer with.
      await page.getByTestId("connect-pick-claude").click();
      await page.getByTestId("claude-token-input").fill(`sk-ant-oat01-${"FAKE_e2e_token-".repeat(7)}`);
      await page.getByTestId("claude-token-submit").click();
      await expect(page.getByTestId("connect-status")).toHaveAttribute("data-state", "connected");
      await page.getByTestId("connect-claude-done").click();
      await expect(page.getByTestId("onboarding-access")).toBeVisible();
      await page.getByTestId("access-skip").click();
      await shot(page, theme, "04-onboarding-meet");
      // The first agent then sets up its own computer in its chat.
      await page.getByTestId("onboarding-finish").click();
      await expect(page.getByTestId("setup-greeting")).toBeVisible();
      await shot(page, theme, "05-first-agent-setup");
    });

    test(`main screens (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await shot(page, theme, "10-agent-timeline");

      await page
        .getByText(/Worked for/)
        .first()
        .click();
      await shot(page, theme, "11-agent-steps-expanded");

      await openAgent(page, "Shopper");
      await shot(page, theme, "12-approval-card");

      await openAgent(page, "Yo");
      await page.getByTestId("model-picker-trigger").click();
      await expect(page.getByTestId("model-picker")).toBeVisible();
      await shot(page, theme, "13-model-picker");
      await page.keyboard.press("Escape");

      await send(page, "Research the history of the espresso machine");
      await expect(page.getByTestId("todo-card").last()).toBeVisible();
      await page.waitForTimeout(700);
      await shot(page, theme, "14-agent-working");
      await expect(page.getByTestId("status-pill").first()).toHaveText(/Done|Idle/, { timeout: 20_000 });

      await send(page, "Find me a flight to Lisbon");
      await expect(page.getByTestId("ask-card")).toBeVisible();
      await shot(page, theme, "15-ask-user-card");

      // Empty state on a fresh agent
      await page.evaluate(async () => {
        const m = (window as any).__yoMock;
        await m.call("agent.create", {
          name: "Scout",
          role: "Explores ideas",
          instructions: "",
          avatar: { shape: "cupcat", color: "yo", eyes: "capsule", accessory: "headset", variant: "niji" },
        });
      });
      await openAgent(page, "Scout");
      await shot(page, theme, "16-empty-state");

      await page.getByTestId("open-computer").click();
      await expect(page.getByTestId("computer-overlay")).toBeVisible();
    });

    test(`computer overlay (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await page.getByTestId("open-computer").click();
      await expect(page.getByTestId("computer-overlay").getByTestId("mock-desktop")).toBeVisible();
      await shot(page, theme, "20-computer-overlay");
      await page.getByTestId("take-over").click();
      await expect(page.getByTestId("give-back")).toBeVisible();
      await page.getByTestId("dock-terminal").click();
      await page.getByTestId("dock-files").click();
      await expect(page.getByTestId("files")).toContainText("Documents");
      await page.waitForTimeout(500);
      await shot(page, theme, "21-computer-takeover-windows");
    });

    test(`pages (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      for (const [nav, name] of [
        ["activity", "30-activity"],
        ["approvals", "31-approvals"],
        ["routines", "32-routines"],
        ["memory", "34-memory"],
        ["artifacts", "35-artifacts"],
      ] as const) {
        await openWorkspacePage(page, nav);
        await page.waitForTimeout(250);
        await shot(page, theme, name);
        if (nav === "routines") {
          await page.getByTestId("new-routine").click();
          await expect(page.getByTestId("routine-dialog")).toBeVisible();
          await shot(page, theme, "33-routine-dialog");
          await page.keyboard.press("Escape");
        }
      }
    });

    test(`dialogs (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await openSettings(page);
      await expect(page.getByTestId("settings-dialog")).toBeVisible();
      await shot(page, theme, "40-settings-accounts");
      await page.getByTestId("settings-computer").click();
      await shot(page, theme, "41-settings-computer");
      await page.getByTestId("settings-appearance").click();
      await shot(page, theme, "42-settings-appearance");
      await page.keyboard.press("Escape");

      await page.getByTestId("new-agent").click();
      await expect(page.getByTestId("new-agent-dialog")).toBeVisible();
      await shot(page, theme, "43-new-agent-templates");
      await page.getByTestId("template-researcher").click();
      await expect(page.getByTestId("avatar-studio")).toBeVisible();
      await shot(page, theme, "44-new-agent-studio");
      // CupCat: roll once (deterministic for screenshots), then open the odds.
      await page.evaluate(() => {
        let n = 0;
        Math.random = () => [0.3, 0.8, 0.1, 0.55, 0.995][n++ % 5]!;
      });
      await page.getByTestId("preset-cupcat").click();
      await expect(page.getByTestId("cupcat-rarity")).toBeVisible();
      await page.getByTestId("cupcat-odds-toggle").click();
      await page.waitForTimeout(400);
      await shot(page, theme, "46-cupcat-roll");
      await page.keyboard.press("Escape");

      await page.keyboard.press("Meta+k");
      await expect(page.getByTestId("command-palette")).toBeVisible();
      await shot(page, theme, "45-command-palette");
    });
  });
}
