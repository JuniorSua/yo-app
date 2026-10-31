/**
 * Notes and Mail (R4) and window control (R3) in Settings → Devices & access, the window-session approval
 * card and the session banner with Stop. Mock backend; browser mode unless `mockDesktop=1` fakes the
 * desktop app's device bridge (where window control needs System Settings the first time).
 */
import { expect, type Page, test } from "@playwright/test";
import { openApp, openSettings, send } from "./helpers";

async function openDevices(page: Page) {
  await openSettings(page);
  await page.getByTestId("settings-devices").click();
  await expect(page.getByTestId("devices-access")).toBeVisible();
}

const appRow = (page: Page, app: string) => page.locator(`[data-testid="app-row"][data-app="${app}"]`);

test("browser: Notes and Mail rows; window control is only a switch here", async ({ page }) => {
  await openApp(page);
  await openDevices(page);

  await expect(appRow(page, "notes")).toContainText("Search and read notes; add new ones with your OK");
  await expect(appRow(page, "notes")).toContainText("Read and change");
  await expect(page.getByTestId("app-share-notes")).toHaveText("Shared · changes are off");
  await expect(appRow(page, "mail")).toContainText(
    "Search and read recent mail; prepare drafts with your OK — Yo never sends",
  );
  await expect(page.getByTestId("app-share-mail")).toHaveText("Not shared");
  await expect(page.getByTestId("app-os-mail")).toHaveText("macOS: asks on first use");
  await expect(page.getByTestId("device-activity")).toContainText("Checked Notes");

  const group = page.getByTestId("window-control");
  await expect(group).toContainText("Let Yo use a window you approve");
  await expect(group).toContainText("Last resort for tasks no other tool can do.");
  await expect(page.getByTestId("window-control-note")).toHaveText(
    "Open the Yo app on your Mac to set up window control.",
  );
  await expect(page.getByTestId("window-control-mac")).toHaveCount(0);

  const sw = page.getByTestId("mac-control");
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  const settings = await page.evaluate(() =>
    (window as any).__yoMock.call("bootstrap", {}).then((b: any) => b.settings),
  );
  expect(settings.macControl).toBe(true);
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
});

test("desktop app: Mail read and draft, window control setup, approval, session banner and Stop", async ({
  page,
}) => {
  await page.goto("/?mock=1&fast=1&onboarded=1&mockDesktop=1");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await openDevices(page);

  // Notes is shared; Mail asks macOS on first use and offers "Read and draft".
  await expect(page.getByTestId("app-mode-notes")).toContainText("Read and change");
  await expect(page.getByTestId("app-os-mail")).toHaveText("macOS: asks on first use");
  await page.getByTestId("app-allow-mail").click();
  await expect(page.getByTestId("app-allow-read-write")).toHaveText("Read and draft");
  await page.getByTestId("app-allow-read-write").click();
  await expect(page.getByTestId("app-mode-mail")).toContainText("Read and draft");
  await expect(page.getByTestId("app-os-mail")).toHaveText("macOS: allowed");

  // Window control: switch on, then the Mac side.
  const sw = page.getByTestId("mac-control");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("screen-recording-status")).toHaveText("Screen Recording: off");
  await expect(page.getByTestId("accessibility-status")).toHaveText("Accessibility: off");
  await expect(page.getByTestId("window-control-share")).toHaveText("Not shared");

  // First Allow: macOS needs System Settings → step-by-step guidance; nothing is shared.
  await page.getByTestId("window-control-allow-read-write").click();
  const guide = page.getByTestId("window-control-guidance");
  await expect(guide).toContainText(
    "Turn on Yo in System Settings → Privacy & Security → Screen Recording (and Accessibility to click/type).",
  );
  await expect(guide).toContainText("You may need to quit and reopen Yo.");
  await expect(guide).toContainText("Then click Allow again.");
  await expect(page.getByTestId("window-control-share")).toHaveText("Not shared");
  await guide.getByRole("button", { name: "Open System Settings" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__yoMock.privacyOpened as string[]))
    .toEqual(["screen"]);

  // Second Allow: shared, look and click.
  await page.getByTestId("window-control-allow-read-write").click();
  await expect(page.getByTestId("window-control-share")).toHaveText("Shared · Look and click");
  await expect(page.getByTestId("window-control-mode")).toContainText("Look and click");
  await expect(page.getByTestId("screen-recording-status")).toHaveText("Screen Recording: on");
  await expect(page.getByTestId("accessibility-status")).toHaveText("Accessibility: on");
  await expect(page.getByTestId("window-control-guidance")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);

  // The approval: one window, a few minutes, never "Always allow".
  await send(page, "Fill in the quote in the desk screen window");
  const card = page.getByTestId("device-action-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("device-action-heading")).toHaveText("Yo wants to use a window on your Mac");
  const lines = page.getByTestId("device-action-lines");
  await expect(lines).toContainText("AppChrome");
  await expect(lines).toContainText("WindowCDK Desking");
  await expect(lines).toContainText("TimeUp to 10 min");
  await expect(card.getByRole("button", { name: /always/i })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Don't allow" })).toBeVisible();
  await expect(page.getByTestId("window-session-banner")).toHaveCount(0);

  await card.getByRole("button", { name: "Allow for 10 min" }).click();
  await expect(page.getByTestId("device-action-result").last()).toHaveText("Allowed");
  const banner = page.getByTestId("window-session-banner");
  await expect(banner).toContainText("Yo is using “CDK Desking”");
  await expect(banner).toContainText(/ends in (10|9) min/);
  await expect(banner).toContainText("⌃⌥⌘.");
  await expect(page.getByTestId("assistant-message").last()).toContainText("Using the window now.", {
    timeout: 15_000,
  });

  await banner.getByRole("button", { name: "Stop Yo using “CDK Desking”" }).click();
  await expect(page.getByTestId("window-session-banner")).toHaveCount(0);
});
