/**
 * Captures hand-off screenshots of every key screen in dark and light themes into e2e/screenshots/.
 * Run: pnpm e2e --grep screenshots
 */
import { expect, type Page, test } from "@playwright/test";
import { newTeammate, openAgent, openApp, openSettings, openWorkspacePage, send } from "./helpers";

const DIR = process.env.YO_SHOTS_DIR || "e2e/screenshots";

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
      // Choose Claude: it signs in on Yo's computer, so right after the first agent sets that up.
      await page.getByTestId("connect-pick-claude").click();
      await shot(page, theme, "03-onboarding-claude");
      await page.getByTestId("claude-after-setup").click();
      await expect(page.getByTestId("onboarding-access")).toBeVisible();
      await page.getByTestId("access-skip").click();
      await shot(page, theme, "04-onboarding-meet");
      // The first agent then sets up its own computer in its chat.
      await page.getByTestId("onboarding-finish").click();
      await expect(page.getByTestId("setup-greeting")).toBeVisible();
      await shot(page, theme, "05-first-agent-setup");
    });

    test(`team chat (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await openAgent(page, "Pico");
      await expect(page.getByTestId("team-exchange").first()).toHaveAttribute("data-state", "replied");
      await shot(page, theme, "19-team-chat");
      // The quiet handoff row opened: the whole exchange with the teammate.
      await page.getByTestId("team-toggle").first().click();
      await shot(page, theme, "19a-team-handoff-open");
      await openAgent(page, "Dew");
      await expect(page.getByTestId("teammate-message")).toBeVisible();
      await shot(page, theme, "19b-team-chat-teammate");
    });

    test(`main screens (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await shot(page, theme, "10-agent-timeline");

      await page
        .getByText(/Worked for/)
        .first()
        .click();
      await shot(page, theme, "11-agent-steps-expanded");

      await openAgent(page, "Pico");
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
      await expect(page.getByTestId("status-pill").first()).toHaveText(/Done|Ready/, { timeout: 20_000 });

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
          avatar: {
            shape: "tablet",
            color: "#F4579F",
            eyes: "capsule",
            accessory: "none",
            softie: { kind: "kiki" },
          },
        });
      });
      await openAgent(page, "Scout");
      await shot(page, theme, "16-empty-state");

      await page.getByTestId("agent-options").click();

      await page.getByTestId("open-computer").click();
      await expect(page.getByTestId("computer-overlay")).toBeVisible();
    });

    test(`computer overlay (${theme})`, async ({ page }) => {
      await openApp(page, { theme });
      await page.getByTestId("agent-options").click();
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
        ["tasks", "29-tasks"],
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

    test(`phone (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openApp(page, { theme });
      await shot(page, theme, "50-phone-chat");
      await page.getByTestId("rail-tasks").click();
      await expect(page.getByTestId("rail-tasks")).toHaveAttribute("aria-current", "page");
      await shot(page, theme, "51-phone-tasks");
    });

    test(`browser sign-in (${theme})`, async ({ page }) => {
      // The sign-in screen shows before Yo loads its settings: the theme comes from the last one used.
      await page.addInitScript((t) => localStorage.setItem("yo.theme", t), theme);
      await page.goto(`/?mock=1&fast=1&onboarded=1&mockEdition=pc&mockAuth=signed-out&theme=${theme}`);
      await expect(page.getByTestId("sign-in")).toBeVisible();
      await shot(page, theme, "60-browser-sign-in");
      await page.getByTestId("sign-in-link").fill("http://localhost:7777/#signin=0123456789abcdef");
      await page.getByTestId("sign-in-submit").click();
      await expect(page.getByTestId("sidebar")).toBeVisible();
      await openSettings(page);
      await page.getByTestId("settings-browsers").click();
      await page.getByTestId("signin-link-create").click();
      await expect(page.getByTestId("signin-link-rules")).toBeVisible();
      await shot(page, theme, "61-settings-browsers");
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
      await page.getByTestId("settings-support").click();
      await shot(page, theme, "46-settings-support");
      await page.keyboard.press("Escape");

      await newTeammate(page);
      await expect(page.getByTestId("new-agent-dialog")).toBeVisible();
      await shot(page, theme, "43-new-teammate");
      await page.keyboard.press("Escape");

      // A teammate's look: Softie, colour, or a photo (Settings for the agent).
      await openAgent(page, "Dew");
      await page.getByTestId("agent-options").click();
      await page.getByTestId("open-agent-settings").click();
      await expect(page.getByTestId("avatar-studio")).toBeVisible();
      await shot(page, theme, "44-agent-look");
      await page.keyboard.press("Escape");

      await page.keyboard.press("Meta+k");
      await expect(page.getByTestId("command-palette")).toBeVisible();
      await shot(page, theme, "45-command-palette");
    });
  });
}
