/**
 * Devices & access (R1): Mac kill switches, shared folders, device activity, exact-file approvals for Mac
 * writes, the composer's route choice and the optional onboarding step. Mock backend; browser mode unless
 * `mockDesktop=1` fakes the desktop app's device bridge.
 */
import { expect, type Page, test } from "@playwright/test";
import { openApp, openSettings, send } from "./helpers";

async function openDevices(page: Page) {
  await openSettings(page);
  await page.getByTestId("settings-devices").click();
  await expect(page.getByTestId("devices-access")).toBeVisible();
}

const mockSettings = (page: Page) =>
  page.evaluate(() => (window as any).__yoMock.call("bootstrap", {}).then((b: any) => b.settings));

test("Devices & access shows switches, shared folders and Mac activity", async ({ page }) => {
  await openApp(page);
  await openDevices(page);
  const section = page.getByTestId("devices-access");

  await expect(page.getByTestId("where-yo-works")).toContainText("This Mac");
  await expect(page.getByTestId("where-yo-works")).toContainText("uses its memory and battery");
  await expect(page.getByTestId("mac-access")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("mac-writes")).toHaveAttribute("aria-checked", "false");

  // Browser: no pairing here, but the shared list and revoke work through core.
  await expect(page.getByTestId("pair-in-app")).toContainText("Open the Yo app on your Mac");
  const rows = page.getByTestId("grant-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("~/Documents/Taxes");
  await expect(rows.first()).toContainText("Read only");
  await expect(rows.nth(1)).toContainText("Read and change");
  await expect(section).toContainText("Shared content can be sent to your AI provider");

  await expect(page.getByTestId("device-row")).toContainText("Studio MacBook");
  await expect(page.getByTestId("device-row")).toContainText("Online");

  const ops = page.getByTestId("operation-row");
  await expect(ops.first()).toContainText("Outcome unknown — check the file");
  await expect(page.getByTestId("device-activity")).toContainText("Read ~/Documents/Taxes/2025-summary.csv");

  // Memory: the agent computer is measured; this Mac can't be measured from a browser.
  await expect(page.getByTestId("memory-agent-computer")).toContainText("1.8 GB");
  await expect(page.getByTestId("memory-this-mac")).toContainText("Unavailable");

  await page.getByRole("button", { name: "Remove Taxes" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("~/Projects/Site");
});

test("Mac access switch updates settings and gates changes", async ({ page }) => {
  await openApp(page);
  await openDevices(page);
  const access = page.getByTestId("mac-access");
  const writes = page.getByTestId("mac-writes");

  await writes.click();
  await expect(writes).toHaveAttribute("aria-checked", "true");
  expect((await mockSettings(page)).macWrites).toBe(true);

  await access.click();
  await expect(access).toHaveAttribute("aria-checked", "false");
  expect((await mockSettings(page)).macAccess).toBe(false);
  // Changes can't be on without access: shown off and disabled.
  await expect(writes).toHaveAttribute("aria-checked", "false");
  await expect(writes).toHaveAttribute("data-disabled", "");

  await access.click();
  await expect(access).toHaveAttribute("aria-checked", "true");
  await expect(writes).toHaveAttribute("aria-checked", "true");
});

test("Mac write approval shows the exact file, never 'Always allow', and saves", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => (window as any).__yoMock.call("settings.update", { macWrites: true }));
  await send(page, "Save my site notes to my Mac");

  const card = page.getByTestId("device-write-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("Replace “notes.md” on Studio MacBook");
  await expect(page.getByTestId("device-write-path")).toContainText("~/Projects/Site/notes.md");
  await expect(card).toContainText("Replaces a 2.0 KB file modified 2d ago");
  await expect(page.getByTestId("device-write-preview")).toContainText("Move pricing above the FAQ");
  await expect(page.getByTestId("device-write-expiry")).toContainText(/Expires in \d+ min/);
  await expect(card.getByRole("button", { name: /always/i })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Save file" })).toBeVisible();

  // The same card (and still no "Always allow") in the Approvals inbox.
  await page.getByTestId("profile-trigger").click();
  await page.getByTestId("nav-approvals").click();
  await expect(page.getByTestId("device-write-card")).toBeVisible();
  await expect(page.getByTestId("device-write-card").getByRole("button", { name: /always/i })).toHaveCount(0);
  await page.getByTestId("device-write-save").click();
  await expect(page.getByTestId("device-write-card")).toHaveCount(0);

  await page.getByTestId("agent-row-Yo").click();
  await expect(page.getByTestId("device-write-result").last()).toHaveText("Saved");
  await expect(page.getByTestId("assistant-message").last()).toContainText("now has the updated notes", {
    timeout: 15_000,
  });
  const rules = await page.evaluate(() => (window as any).__yoMock.call("rules.list", {}));
  expect(rules.some((r: { match: string }) => /mac/.test(r.match))).toBe(false);
});

test("Mac write with changes off explains instead of asking", async ({ page }) => {
  await openApp(page);
  await send(page, "Save my site notes to my Mac");
  await expect(page.getByTestId("assistant-message").last()).toContainText("Allow approved changes", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("device-write-card")).toHaveCount(0);
});

test("composer route choice is sent with the message", async ({ page }) => {
  await openApp(page);
  const trigger = page.getByTestId("route-trigger");
  await expect(trigger).toHaveText(/Auto/);

  await send(page, "Hello there");
  await expect.poll(() => page.evaluate(() => (window as any).__yoMock.sends.at(-1)?.route)).toBe("auto");
  await expect(page.getByTestId("status-pill").first()).toHaveText(/Done|Idle/, { timeout: 20_000 });

  await page.getByTestId("composer-input").click();
  await trigger.click();
  await expect(page.getByTestId("route-menu")).toContainText("Don't use this Mac for this message");
  await page.getByTestId("route-agent-computer").click();
  await expect(trigger).toHaveText(/Agent computer only/);
  await page.evaluate(() => (window as any).__yoMock.call("settings.update", { macWrites: true }));
  await send(page, "Save my site notes to my Mac");
  await expect
    .poll(() => page.evaluate(() => (window as any).__yoMock.sends.at(-1)?.route))
    .toBe("agent-computer");
  await expect(page.getByTestId("assistant-message").last()).toContainText("didn't touch your Mac", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("device-write-card")).toHaveCount(0);

  // Hidden once Mac access is off.
  await page.evaluate(() => (window as any).__yoMock.call("settings.update", { macAccess: false }));
  await expect(trigger).toHaveCount(0);
});

test("onboarding: Mac access can be skipped with 'Use agent computer only'", async ({ page }) => {
  await page.goto("/?mock=1&fast=1&mockDesktop=1");
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.getByTestId("onboarding-start").click();
  await page.getByTestId("onboarding-next").click();

  const step = page.getByTestId("onboarding-access");
  await expect(step).toContainText("Let Yo help on this Mac");
  await expect(step).toContainText("Yo asks before changing anything.");
  await page.getByRole("button", { name: "Use agent computer only" }).click();
  await expect(page.getByTestId("primary-name")).toBeVisible();

  const settings = await mockSettings(page);
  expect(settings.macAccess).toBe(false);
  const status = await page.evaluate(() => (window as any).yoDesktop.device.status());
  expect(status.paired).toBe(false);
  expect(status.grants).toHaveLength(0);
});

test("onboarding: share a folder pairs this Mac and turns on access", async ({ page }) => {
  await page.goto("/?mock=1&fast=1&mockDesktop=1");
  await page.getByTestId("onboarding-start").click();
  await page.getByTestId("onboarding-next").click();
  await page.getByTestId("access-share").click();
  await expect(page.getByTestId("access-shared")).toContainText("~/Desktop/Receipts");
  await expect(page.getByTestId("access-shared")).toContainText("Read only");
  expect((await mockSettings(page)).macAccess).toBe(true);
  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("primary-name")).toBeVisible();
});

test("desktop app: pause and change access from Settings", async ({ page }) => {
  await page.goto("/?mock=1&fast=1&onboarded=1&mockDesktop=1");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await openDevices(page);
  await expect(page.getByTestId("this-mac-state")).toContainText("connected to Yo");
  await page.getByTestId("pause-mac").click();
  await expect(page.getByTestId("this-mac-state")).toContainText("access paused");
  await expect(page.getByTestId("memory-this-mac")).toContainText("385 MB");

  await page.getByTestId("share-folder").click();
  await expect(page.getByTestId("grant-row")).toHaveCount(3);
  await page.getByTestId("grant-mode").first().click();
  await page.getByRole("option", { name: "Read and change" }).click();
  await expect(page.getByTestId("grant-mode").first()).toContainText("Read and change");
});
