/**
 * Mac apps (R2): Calendar, Contacts and Reminders in Settings → Devices & access, and the exact-action
 * approval card for a Calendar change. Mock backend; browser mode unless `mockDesktop=1` fakes the desktop
 * app's device bridge (where macOS "denies" Contacts).
 */
import { expect, type Page, test } from "@playwright/test";
import { openApp, openSettings, send } from "./helpers";

async function openDevices(page: Page) {
  await openSettings(page);
  await page.getByTestId("settings-devices").click();
  await expect(page.getByTestId("devices-access")).toBeVisible();
}

const appRow = (page: Page, app: string) => page.locator(`[data-testid="app-row"][data-app="${app}"]`);

test("Apps rows show macOS status and sharing; folders list excludes apps (browser)", async ({ page }) => {
  await openApp(page);
  await openDevices(page);

  const apps = page.getByTestId("apps-list");
  await expect(apps.getByTestId("app-row")).toHaveCount(5);
  await expect(page.getByTestId("app-os-calendar")).toHaveText("macOS: allowed");
  await expect(page.getByTestId("app-os-contacts")).toHaveText("macOS: not asked yet");
  await expect(appRow(page, "calendar")).toContainText("Check events; add or change them with your OK");
  await expect(appRow(page, "calendar")).toContainText("Read and change");
  await expect(appRow(page, "contacts")).toContainText("Not shared");
  await expect(appRow(page, "reminders")).toContainText("Read only");
  await expect(page.getByTestId("apps-note")).toHaveText("Open the Yo app on your Mac to share apps.");

  // "Shared from your Macs" lists folders and files only.
  const folders = page.getByTestId("shared-list").getByTestId("grant-row");
  await expect(folders).toHaveCount(2);
  await expect(page.getByTestId("shared-list")).not.toContainText("Calendar");

  // App operations in recent activity.
  const activity = page.getByTestId("device-activity");
  await expect(activity).toContainText("Checked Calendar");
  await expect(activity).toContainText("Changed Calendar · Add “Dentist” to Home");

  // Stop sharing goes through core.
  await page.getByRole("button", { name: "Stop sharing Reminders" }).click();
  await expect(page.getByTestId("app-share-reminders")).toHaveText("Not shared");
  await expect(page.getByRole("button", { name: "Stop sharing Reminders" })).toHaveCount(0);
});

test("desktop app: Contacts blocked by macOS, Calendar read and change, allowing Reminders", async ({
  page,
}) => {
  await page.goto("/?mock=1&fast=1&onboarded=1&mockDesktop=1");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await openDevices(page);

  await expect(page.getByTestId("app-mode-calendar")).toContainText("Read and change");
  await expect(page.getByTestId("app-os-calendar")).toHaveText("macOS: allowed");
  await expect(page.getByTestId("shared-list").getByTestId("grant-row")).toHaveCount(2);
  await expect(page.getByTestId("apps-note")).toHaveCount(0);

  // Contacts: read only (no "change" choice); macOS says no → how to fix it.
  await page.getByTestId("app-allow-contacts").click();
  const blocked = page.getByTestId("app-blocked");
  await expect(blocked).toContainText(
    "macOS blocked Yo from Contacts. Open System Settings → Privacy & Security → Contacts and turn on Yo.",
  );
  await expect(page.getByTestId("app-os-contacts")).toHaveText("macOS: blocked");
  await expect(page.getByTestId("app-share-contacts")).toHaveText("Not shared");
  await blocked.getByRole("button", { name: "Open System Settings" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__yoMock.privacyOpened as string[]))
    .toEqual(["contacts"]);

  // Reminders: stop sharing, then allow again with "Read and change".
  await page.getByTestId("app-stop-reminders").click();
  await expect(page.getByTestId("app-share-reminders")).toHaveText("Not shared");
  await page.getByTestId("app-allow-reminders").click();
  await page.getByTestId("app-allow-read-write").click();
  await expect(page.getByTestId("app-mode-reminders")).toContainText("Read and change");
  await expect(page.getByTestId("app-blocked")).toHaveCount(1);
});

test("Calendar change approval lists the change, never 'Always allow', and saves", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => (window as any).__yoMock.call("settings.update", { macWrites: true }));
  await send(page, "Add a call with Alex to my calendar on Friday at 10");

  const card = page.getByTestId("device-action-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("wants to change Calendar on your Mac");
  await expect(card).toContainText("Add “Call Alex” to Home on Studio MacBook");
  const lines = page.getByTestId("device-action-lines");
  await expect(lines).toContainText("CalendarHome · iCloud");
  await expect(lines).toContainText("TitleCall Alex");
  await expect(lines).toContainText("WhenFri, Oct 2, 10:00 AM – 10:30 AM");
  await expect(lines).toContainText("InvitesNone (nobody is notified)");
  await expect(page.getByTestId("device-action-expiry")).toContainText(/Expires in \d+ min/);
  await expect(card.getByRole("button", { name: /always/i })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();

  await card.getByRole("button", { name: "Save to Calendar" }).click();
  await expect(page.getByTestId("device-action-result").last()).toHaveText("Saved");
  await expect(page.getByTestId("assistant-message").last()).toContainText("Added it.", { timeout: 15_000 });
  const rules = await page.evaluate(() => (window as any).__yoMock.call("rules.list", {}));
  expect(rules.some((r: { match: string }) => /calendar/.test(r.match))).toBe(false);
});
