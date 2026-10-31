/**
 * Grok (xAI) as the third provider: connect it with a device code that Yo's computer gets (mock), pick a Grok
 * model, and the xAI API key fallback. Also saves light/dark screenshots of the flow to /tmp/grok/ for the PR
 * (outside the repo, so nothing regenerated gets committed).
 */
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { openApp, openSettings } from "./helpers";

const SHOTS = "/tmp/grok";
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, theme: string, name: string) => {
  await page.waitForTimeout(600); // let entrance animations settle
  await page.screenshot({ path: `${SHOTS}/${theme}-${name}.png` });
};

for (const theme of ["light", "dark"] as const) {
  test(`connect Grok with a code, then run Yo on a Grok model (${theme})`, async ({ page }) => {
    // The first-run walkthrough offers all three subscriptions.
    await openApp(page, { onboarded: false, theme });
    await page.getByTestId("onboarding-start").click();
    await expect(page.getByTestId("connect-pick-grok")).toContainText("SuperGrok or X Premium");
    await expect(page.getByTestId("connect-model")).toContainText("Claude, ChatGPT or Grok plan");
    await shot(page, theme, "01-connect-pick");

    await openApp(page, { theme });
    await openSettings(page);
    await expect(page.getByTestId("account-grok")).toContainText("Not connected");
    await page.getByTestId("connect-grok").click();

    // Numbered steps; nothing to run in Terminal, on any computer.
    const steps = page.getByTestId("connect-steps-grok");
    await expect(steps).toContainText("Connect Grok");
    await expect(page.getByTestId("grok-signin-hint")).toContainText(
      "nothing to install or type in Terminal",
    );
    await expect(page.getByTestId("connect-status")).toHaveAttribute("data-state", "idle");
    await shot(page, theme, "02-grok-steps");

    // Yo's computer gets a code: the link and the code show up in copy boxes, and Yo opens the link.
    await page.getByTestId("grok-start").click();
    await expect(page.getByTestId("grok-login-code")).toContainText("WXYZ-1234");
    await expect(page.getByTestId("grok-login-url")).toContainText("https://accounts.x.ai/oauth2/device");
    await expect(page.getByTestId("grok-step-1")).toHaveAttribute("data-done", "true");
    await expect(page.getByTestId("connect-status")).toContainText("Waiting for you to confirm the code");
    expect(await page.evaluate(() => (window as any).__yoLastExternal)).toContain("accounts.x.ai");
    await shot(page, theme, "03-grok-code");

    // The user approves in the browser (the mock does after 5 s): it turns green on its own.
    await expect(page.getByTestId("connect-status")).toHaveAttribute("data-state", "connected", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("connect-status")).toContainText("Grok is connected");
    await shot(page, theme, "04-grok-connected");
    await page.getByTestId("connect-grok-done").click();
    await expect(page.getByTestId("account-grok")).toContainText("Connected");
    await shot(page, theme, "05-settings-accounts");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toHaveCount(0);

    // Pick a Grok model: a fresh session on Grok, memory kept.
    const trigger = page.getByTestId("model-picker-trigger");
    await trigger.click();
    await page.getByTestId("picker-account-Grok").click();
    await expect(page.getByTestId("switch-note")).toContainText("a fresh session starts on Grok");
    await expect(page.getByTestId("picker-model-grok-4.5")).toBeVisible();
    await shot(page, theme, "06-model-picker");
    await page.getByTestId("picker-model-grok-4.6").click();
    await expect(trigger).toContainText("Grok 4.6");
    await expect(page.getByTestId("notice-row").last()).toContainText("Switched to Grok");

    // Its reasoning efforts, lowest first.
    await trigger.click();
    await expect(page.getByTestId("model-picker")).toContainText("X-High");
    await shot(page, theme, "07-model-picker-grok");
    await page.keyboard.press("Escape");
  });
}

test("Grok: an xAI API key is the fallback", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await page.getByTestId("connect-grok").click();
  await page.getByTestId("grok-use-api-key").click();
  await expect(page.getByTestId("connect-steps-grok")).toContainText(
    "billed by xAI per use, separately from your Grok plan. Yo keeps this key in its secret storage (the Keychain on a Mac).",
  );
  await page.getByTestId("grok-api-key-input").fill("xai-FAKE-e2e-key");
  await page.getByTestId("grok-api-key-save").click();
  await expect(page.getByTestId("connect-status")).toHaveAttribute("data-state", "connected");
  await page.getByTestId("connect-grok-done").click();
  await expect(page.getByTestId("account-grok")).toContainText("API access · Connected");
});
