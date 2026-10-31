// Settings → Computer offers Move only for a kept ~/.colima computer. The mock records the choice;
// stopping and restarting the VM is covered by the core tests.
import { expect, test } from "@playwright/test";
import { openSettings } from "./helpers";

test("Settings → Computer asks before moving an existing computer", async ({ page }) => {
  await page.goto("/?mock=1&fast=1&onboarded=1&mockVm=keep");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  // The onboarded mock seeds a helper that is still working. Settle it so Move can be offered.
  await page.evaluate(() => (window as any).__yoMock.markWorking(false));
  await openSettings(page);
  await page.getByTestId("settings-computer").click();
  const move = page.getByTestId("vm-home-move-settings");
  await expect(move).toBeEnabled();
  await move.click();
  await expect(page.getByText("This stops the computer and any work an agent is doing.")).toBeVisible();
  await expect(page.getByText("now lives in Yo's folder")).toHaveCount(0);
  await page.getByTestId("vm-home-move-cancel").click();
  await expect(move).toBeVisible();
  await expect(page.getByText("Yo didn't move or delete it.")).toBeVisible();
  await move.click();
  await page.getByTestId("vm-home-move-confirm").click();
  await expect(page.getByText("now lives in Yo's folder")).toBeVisible();
  await expect(page.getByTestId("vm-home-move-settings")).toHaveCount(0);
});

test("Move into Yo stays disabled while an agent is working", async ({ page }) => {
  await page.goto("/?mock=1&fast=1&onboarded=1&mockVm=keep");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await page.evaluate(() => (window as any).__yoMock.markWorking(false));
  await openSettings(page);
  await page.getByTestId("settings-computer").click();
  const move = page.getByTestId("vm-home-move-settings");
  await expect(move).toBeEnabled();
  await page.evaluate(() => (window as any).__yoMock.markWorking(true));
  await expect(move).toBeDisabled();
  await expect(page.getByText("An agent is working.")).toBeVisible();
  await expect(page.getByTestId("vm-home-move-confirm")).toHaveCount(0);
});
