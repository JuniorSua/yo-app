/**
 * "Yo was updated": the Refresh card for a server deploy and the Restart card for a downloaded Yo.app,
 * against the mock backend (`?mockUpdate=…`, see apps/web/src/lib/mock/updates.ts).
 * Screenshots: pnpm e2e --grep "screenshots updates"
 */
import { expect, type Page, test } from "@playwright/test";
import { openSettings } from "./helpers";

async function openWith(page: Page, mockUpdate: string | null, theme?: "dark" | "light") {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto(
    `/?mock=1&fast=1&onboarded=1${mockUpdate ? `&mockUpdate=${mockUpdate}` : ""}${theme ? `&theme=${theme}` : ""}`,
  );
  await expect(page.getByTestId("sidebar")).toBeVisible();
}

const mock = (page: Page, fn: string) => page.evaluate(`window.__yoMock.${fn}`);

test.describe("update notices", () => {
  test("a server deploy shows Refresh after the socket reconnects; Later leaves a dot on the update button", async ({
    page,
  }) => {
    await openWith(page, null);
    await page.waitForTimeout(300);
    await expect(page.getByTestId("update-card")).toHaveCount(0);

    // A core swap restarts the server: the reconnect is the first sign of the new build.
    await mock(page, "updates.deploy()");
    await mock(page, "simulateReconnect()");
    const card = page.getByTestId("update-card");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-kind", "refresh");
    await expect(card).toContainText("Yo was updated");
    await expect(card).toContainText("Refresh to load the new version.");

    await page.getByTestId("update-later").click();
    await expect(card).toHaveCount(0);
    const button = page.getByTestId("update-button");
    await expect(button).toHaveAttribute("data-state", "refresh");
    await expect(page.getByTestId("update-dot")).toBeVisible();

    // Never reloads by itself; the button's Refresh does.
    await page.evaluate(() => {
      (window as any).__stillHere = true;
    });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as any).__stillHere)).toBe(true);
    await button.click();
    await expect(page.getByTestId("update-panel")).toContainText("Yo was updated");
    await Promise.all([page.waitForEvent("framenavigated"), page.getByTestId("update-refresh").click()]);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__stillHere ?? false)).toBe(false);
  });

  test("Refresh on the card reloads the page", async ({ page }) => {
    await openWith(page, "web");
    await expect(page.getByTestId("update-card")).toHaveAttribute("data-kind", "refresh");
    await Promise.all([page.waitForEvent("framenavigated"), page.getByTestId("update-primary").click()]);
    await expect(page.getByTestId("sidebar")).toBeVisible();
  });

  test("a downloaded Yo.app asks to restart, and Restart installs it", async ({ page }) => {
    await openWith(page, "ready");
    const card = page.getByTestId("update-card");
    await expect(card).toHaveAttribute("data-kind", "restart");
    await expect(card).toContainText("Yo 0.1.313 is ready");
    await expect(card).toContainText("Restart to update.");
    await page.getByTestId("update-primary").click();
    // It shows the install for a couple of seconds (a real update is already downloaded, so it'd be a blink),
    // then restarts.
    await expect(card).toContainText("Installing Yo 0.1.313…");
    await expect(card.getByTestId("update-progress")).toBeVisible();
    await expect(page.getByTestId("update-primary")).toHaveCount(0);
    const clicked = Date.now();
    await expect(card).toContainText("Restarting Yo…");
    await expect.poll(() => mock(page, "updates.installs"), { timeout: 8000 }).toBe(1);
    expect(Date.now() - clicked).toBeGreaterThan(1500);
    // The update button shows it too.
    await expect(page.getByTestId("update-button")).toHaveAttribute("data-state", "applying");
  });

  test("Refresh from the update button shows progress before it reloads", async ({ page }) => {
    await openWith(page, "web");
    await page.getByTestId("update-later").click();
    await page.evaluate(() => {
      (window as any).__stillHere = true;
    });
    await page.getByTestId("update-button").click();
    await page.getByTestId("update-refresh").click();
    const panel = page.getByTestId("update-panel");
    await expect(panel).toContainText("Updating Yo…");
    await expect(panel.getByTestId("update-progress")).toBeVisible();
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => (window as any).__stillHere)).toBe(true);
    await page.waitForEvent("framenavigated", { timeout: 8000 });
    await expect(page.getByTestId("sidebar")).toBeVisible();
  });

  test("Restart asks first while an agent is working on this Mac", async ({ page }) => {
    const holdWorking = () =>
      page.evaluate(async () => {
        const m = (window as any).__yoMock;
        const yo = (await m.call("bootstrap", {})).agents.find((a: any) => a.isPrimary);
        m.emit("agent.updated", { ...yo, activity: "working" });
      });
    // From the update button.
    await openWith(page, "ready");
    await page.getByTestId("update-later").click();
    await holdWorking();
    await page.getByTestId("update-button").click();
    await page.getByTestId("update-restart").click();
    await expect(page.getByTestId("update-panel")).toContainText("Agents are still working");
    expect(await mock(page, "updates.installs")).toBe(0);
    await expect(page.getByTestId("update-restart")).toHaveText("Restart anyway");
    await page.keyboard.press("Escape");

    // From the card.
    await openWith(page, "ready");
    await holdWorking();
    const card = page.getByTestId("update-card");
    await page.getByTestId("update-primary").click();
    await expect(card).toContainText("Agents are still working");
    expect(await mock(page, "updates.installs")).toBe(0);
    await page.getByTestId("update-later").click(); // "Wait"
    await expect(card).toContainText("Yo 0.1.313 is ready");
    await page.getByTestId("update-primary").click();
    await expect(page.getByTestId("update-primary")).toHaveText("Restart anyway");
    await page.getByTestId("update-primary").click();
    await expect.poll(() => mock(page, "updates.installs"), { timeout: 8000 }).toBe(1);
  });

  test("download progress and a failed download stay quiet on the button; a click recovers", async ({
    page,
  }) => {
    await openWith(page, "downloading");
    await expect(page.getByTestId("update-card")).toHaveCount(0);
    const button = page.getByTestId("update-button");
    await expect(button).toHaveAttribute("data-state", "downloading");
    await button.click();
    await expect(page.getByTestId("update-panel")).toContainText("Downloading Yo 0.1.313");
    await expect(page.getByTestId("update-panel")).toContainText("42%");

    await openWith(page, "error");
    await expect(button).toHaveAttribute("data-state", "error");
    // Clicking it checks again: the download finishes and the card asks to restart.
    await button.click();
    await expect(page.getByTestId("update-card")).toHaveAttribute("data-kind", "restart");
    await expect(button).toHaveAttribute("data-state", "ready");
  });

  test("a public build offers Download for a newer GitHub release, which opens its page", async ({
    page,
  }) => {
    await openWith(page, "github");
    // Nothing to restart into: no card, just the dot on the button.
    await expect(page.getByTestId("update-card")).toHaveCount(0);
    const button = page.getByTestId("update-button");
    await expect(button).toHaveAttribute("data-state", "available");
    await expect(page.getByTestId("update-dot")).toBeVisible();
    await button.click();
    const panel = page.getByTestId("update-panel");
    await expect(panel).toContainText("Yo 0.1.313 is available");
    await expect(panel).toContainText("Download the new version from GitHub");
    // Ad-hoc builds: the Keychain asks again after each update (#74).
    await expect(panel.getByTestId("update-note")).toContainText("Yo Safe Storage");
    await expect(panel.getByRole("button", { name: "Restart" })).toHaveCount(0);
    await page.getByTestId("update-download").click();
    await expect.poll(() => mock(page, "updates.downloads")).toBe(1);
    await expect(panel).toHaveCount(0);
    expect(await mock(page, "updates.installs")).toBe(0);

    // Checking again keeps it: nothing downloads in the app.
    await page.evaluate(() => (window as any).yoDesktop.updates.check());
    await expect(button).toHaveAttribute("data-state", "available");

    // Settings → About says the same, with Download in place of "Check for updates".
    await openSettings(page);
    await page.getByTestId("settings-about").click();
    await expect(page.getByTestId("desktop-update-status")).toHaveText(
      "Yo 0.1.313 is available. Download it from GitHub.",
    );
    await expect(page.getByTestId("check-updates")).toHaveCount(0);
    await page.getByTestId("settings-update-download").click();
    await expect.poll(() => mock(page, "updates.downloads")).toBe(2);
  });

  test("with nothing new, a click checks and says it's up to date", async ({ page }) => {
    await openWith(page, null);
    const button = page.getByTestId("update-button");
    await expect(button).toHaveAttribute("data-state", "idle");
    await button.click();
    await expect(page.getByTestId("update-panel")).toContainText("Yo is up to date");
    await expect(page.getByTestId("update-dot")).toHaveCount(0);
  });

  test("Settings shows the versions and checks on demand", async ({ page }) => {
    await openWith(page, "error");
    await openSettings(page);
    await page.getByTestId("settings-about").click();
    const group = page.getByTestId("settings-updates");
    await expect(group).toContainText("Yo app 0.1.312");
    await expect(page.getByTestId("desktop-update-status")).toHaveText(/download was interrupted/);
    await expect(page.getByTestId("web-update-status")).toHaveText("Up to date");
    await page.getByTestId("check-updates").click();
    await expect(page.getByTestId("desktop-update-status")).toHaveText(
      "Yo 0.1.313 is ready. Restart to update.",
    );
    await expect(group.getByRole("button", { name: "Restart to update" })).toBeVisible();
  });

  test("the notice floats bottom-left when the sidebar is hidden", async ({ page }) => {
    await openWith(page, "web");
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    const card = page.getByTestId("update-card");
    await expect(card).toBeVisible();
    const box = (await card.boundingBox())!;
    expect(box.x).toBeLessThan(40);
    expect(box.y + box.height).toBeGreaterThan(820);
  });
});

for (const theme of ["dark", "light"] as const) {
  test.describe(`screenshots updates ${theme}`, () => {
    test.use({ colorScheme: theme });
    const shot = async (page: Page, name: string) => {
      await page.waitForTimeout(400);
      await page.screenshot({ path: `e2e/screenshots/${theme}-${name}.png` });
    };

    test(`update notices (${theme})`, async ({ page }) => {
      await openWith(page, "web", theme);
      await expect(page.getByTestId("update-card")).toBeVisible();
      await shot(page, "50-update-refresh");
      await openWith(page, "ready", theme);
      await expect(page.getByTestId("update-card")).toBeVisible();
      await shot(page, "51-update-ready");
      await page.getByTestId("update-later").click();
      await openWith(page, "downloading", theme);
      await expect(page.getByTestId("update-button")).toHaveAttribute("data-state", "downloading");
      await page.getByTestId("update-button").click();
      await expect(page.getByTestId("update-panel")).toBeVisible();
      await shot(page, "52-update-downloading");
      await page.keyboard.press("Escape");
      await openSettings(page);
      await page.getByTestId("settings-about").click();
      await expect(page.getByTestId("settings-updates")).toBeVisible();
      await shot(page, "53-settings-updates");
    });
  });
}
