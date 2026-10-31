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

  test("a downloaded Yo.app asks to restart, confirms with what's new, and Restart installs it", async ({
    page,
  }) => {
    await openWith(page, "ready");
    // The mock's seeded helper is still working: let it finish, so no agent is busy here.
    await mock(page, 'retireHelper("agt_hlp_table", "done", "Booked.")');
    const card = page.getByTestId("update-card");
    await expect(card).toHaveAttribute("data-kind", "restart");
    await expect(card).toContainText("Yo 0.1.313 is ready");
    await expect(card).toContainText("Restart to update.");
    await page.getByTestId("update-primary").click();
    // A confirmation first, with the notes published with the build.
    const dialog = page.getByTestId("restart-confirm");
    await expect(dialog).toContainText("Install Yo 0.1.313 and restart?");
    await expect(dialog).toContainText("Yo closes for a few seconds and opens again by itself.");
    await expect(page.getByTestId("restart-confirm-notes")).toContainText("What's new");
    await expect(page.getByTestId("restart-confirm-notes")).toContainText(
      "Restart now asks first and shows what's new",
    );
    await expect(page.getByTestId("restart-confirm-busy")).toHaveCount(0);
    // Cancel is the safe default: it has the focus, so a stray Enter doesn't restart.
    await expect(page.getByTestId("restart-confirm-cancel")).toBeFocused();
    await page.waitForTimeout(300);
    expect(await mock(page, "updates.installs")).toBe(0);
    const clicked = Date.now();
    await page.getByTestId("restart-confirm-ok").click();
    // It shows the install for a couple of seconds (a real update is already downloaded, so it'd be a blink),
    // then restarts. The dialog stays, with the same progress.
    await expect(dialog).toContainText("Installing Yo 0.1.313…");
    await expect(dialog.getByTestId("update-progress")).toBeVisible();
    await expect(page.getByTestId("restart-confirm-ok")).toHaveCount(0);
    await page.keyboard.press("Escape"); // can't be dismissed mid-install
    await expect(dialog).toBeVisible();
    await expect(card).toContainText("Installing Yo 0.1.313…");
    await expect(card.getByTestId("update-progress")).toBeVisible();
    await expect(page.getByTestId("update-primary")).toHaveCount(0);
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

  test("Cancel, Escape or a click outside closes the confirmation without restarting", async ({ page }) => {
    await openWith(page, "ready");
    const dialog = page.getByTestId("restart-confirm");
    await page.getByTestId("update-primary").click();
    await expect(dialog).toBeVisible();
    await page.getByTestId("restart-confirm-cancel").click();
    await expect(dialog).toHaveCount(0);
    await page.getByTestId("update-primary").click();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByTestId("update-primary").click();
    await page.mouse.click(1300, 120);
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await mock(page, "updates.installs")).toBe(0);
    // Nothing changed: the card still offers Restart.
    await expect(page.getByTestId("update-card")).toContainText("Yo 0.1.313 is ready");

    // The quiet pill (floating, after Later) asks too.
    await page.getByTestId("update-later").click();
    await page.getByTestId("update-pill").click();
    await expect(dialog).toContainText("Install Yo 0.1.313 and restart?");
    await page.getByTestId("restart-confirm-ok").click();
    await expect.poll(() => mock(page, "updates.installs"), { timeout: 8000 }).toBe(1);
  });

  test("without published notes the confirmation still asks, minus What's new", async ({ page }) => {
    await openWith(page, "ready");
    // An older core (or a build published with --no-notes) sends no notes.
    await page.evaluate(() => {
      const m = (window as any).__yoMock.updates;
      const version = m.version.bind(m);
      m.version = () => ({ ...version(), desktop: { version: "0.1.313" } });
    });
    await mock(page, "simulateReconnect()");
    await page.waitForTimeout(300);
    await page.getByTestId("update-primary").click();
    await expect(page.getByTestId("restart-confirm")).toContainText("Install Yo 0.1.313 and restart?");
    await expect(page.getByTestId("restart-confirm-notes")).toHaveCount(0);
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
    await expect(page.getByTestId("update-panel")).toHaveCount(0);
    await expect(page.getByTestId("restart-confirm-busy")).toContainText("Your agents are still working.");
    await expect(page.getByTestId("restart-confirm-ok")).toHaveText("Restart anyway");
    expect(await mock(page, "updates.installs")).toBe(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("restart-confirm")).toHaveCount(0);

    // From the card.
    await openWith(page, "ready");
    await holdWorking();
    await page.getByTestId("update-primary").click();
    await expect(page.getByTestId("restart-confirm-busy")).toBeVisible();
    await page.getByTestId("restart-confirm-cancel").click();
    expect(await mock(page, "updates.installs")).toBe(0);
    await expect(page.getByTestId("update-card")).toContainText("Yo 0.1.313 is ready");
    await page.getByTestId("update-primary").click();
    await page.getByTestId("restart-confirm-ok").click();
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
    // macOS won't replace an app that's still open, and closing the window keeps Yo running in the menu bar.
    await expect(panel).toContainText("Quit Yo first (⌘Q)");
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
      "Yo 0.1.313 is available. Download it from GitHub, quit Yo first (⌘Q), then replace Yo in Applications.",
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
    // Its Restart asks too, on top of Settings; Cancel goes back to Settings.
    await group.getByRole("button", { name: "Restart to update" }).click();
    await expect(page.getByTestId("restart-confirm")).toContainText("Install Yo 0.1.313 and restart?");
    await page.getByTestId("restart-confirm-cancel").click();
    await expect(page.getByTestId("restart-confirm")).toHaveCount(0);
    await expect(group).toBeVisible();
    await group.getByRole("button", { name: "Restart to update" }).click();
    await page.getByTestId("restart-confirm-ok").click();
    await expect(page.getByTestId("restart-confirm")).toContainText("Installing Yo 0.1.313…");
    await expect.poll(() => mock(page, "updates.installs"), { timeout: 8000 }).toBe(1);
  });

  test("the notice floats bottom-left, just right of the rail", async ({ page }) => {
    await openWith(page, "web");
    const card = page.getByTestId("update-card");
    await expect(card).toBeVisible();
    const box = (await card.boundingBox())!;
    // Bottom-left, just right of the always-visible rail (never covering Settings or the profile).
    const rail = (await page.getByTestId("sidebar").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(rail.x + rail.width);
    expect(box.x).toBeLessThan(rail.x + rail.width + 40);
    expect(box.y + box.height).toBeGreaterThan(820);
  });
});

test.describe("server updates the user restarts", () => {
  test("Update ready → confirm → Updating… → Yo comes back on the new version and says so", async ({
    page,
  }) => {
    await openWith(page, "server");
    // The seeded helper is busy: let it finish so nobody is in the middle of a task.
    await mock(page, 'retireHelper("agt_hlp_table", "done", "Booked.")');
    const card = page.getByTestId("update-card");
    await expect(card).toHaveAttribute("data-kind", "restart");
    await expect(card).toContainText("Update ready");
    await expect(card).toContainText("Restart to update.");
    await expect(page.getByTestId("update-button")).toHaveAttribute("data-state", "ready");

    // Nothing restarts until the user says so.
    await page.waitForTimeout(500);
    expect(await mock(page, "updates.serverApplies")).toBe(0);

    await page.getByTestId("update-primary").click();
    const dialog = page.getByTestId("restart-confirm");
    await expect(dialog).toContainText("Restart Yo to update?");
    await expect(dialog).toContainText("Yo will restart and be back in about 30 seconds.");
    await expect(page.getByTestId("restart-confirm-notes")).toContainText("Updates wait for you");
    await expect(page.getByTestId("restart-confirm-busy")).toHaveCount(0);
    await expect(page.getByTestId("restart-confirm-browser")).toHaveCount(0);
    await expect(page.getByTestId("restart-confirm-cancel")).toBeFocused();

    // Core goes away for the swap, comes back on the new build, and the page reloads into it.
    const reloaded = page.waitForEvent("framenavigated", { timeout: 15_000 });
    await page.getByTestId("restart-confirm-ok").click();
    await expect(dialog).toContainText("Updating Yo…");
    await expect(dialog.getByTestId("update-progress")).toBeVisible();
    await expect(page.getByTestId("restart-confirm-ok")).toHaveCount(0);
    await reloaded;
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(card).toHaveAttribute("data-kind", "updated");
    await expect(card).toContainText("Yo was updated");
    await expect(page.getByTestId("update-button")).toHaveAttribute("data-state", "idle");
    await page.getByTestId("update-result-ok").click();
    await expect(card).toHaveCount(0);
  });

  test("the confirmation warns who will stop and that the browser reloads", async ({ page }) => {
    await openWith(page, "server-browser");
    await page.evaluate(async () => {
      const m = (window as any).__yoMock;
      const yo = (await m.call("bootstrap", {})).agents.find((a: any) => a.isPrimary);
      m.emit("agent.updated", { ...yo, activity: "working" });
    });
    await page.getByTestId("update-primary").click();
    await expect(page.getByTestId("restart-confirm-busy")).toContainText("in the middle of");
    await expect(page.getByTestId("restart-confirm-busy")).toContainText("Yo");
    await expect(page.getByTestId("restart-confirm-busy")).toContainText("will stop");
    await expect(page.getByTestId("restart-confirm-browser")).toContainText(
      "Yo's browser will reload; you may need to sign in to some sites again.",
    );
    await expect(page.getByTestId("restart-confirm-ok")).toHaveText("Restart anyway");
    // Cancel changes nothing.
    await page.getByTestId("restart-confirm-cancel").click();
    await expect(page.getByTestId("restart-confirm")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await mock(page, "updates.serverApplies")).toBe(0);
    // Later keeps a quiet pill that asks the same way.
    await page.getByTestId("update-later").click();
    await expect(page.getByTestId("update-card")).toHaveCount(0);
    await expect(page.getByTestId("update-dot")).toBeVisible();
  });

  test("a failed update says so and Yo stays as it was", async ({ page }) => {
    await openWith(page, "server-fail");
    await mock(page, 'retireHelper("agt_hlp_table", "done", "Booked.")');
    await page.evaluate(() => {
      (window as any).__stillHere = true;
    });
    await page.getByTestId("update-primary").click();
    await page.getByTestId("restart-confirm-ok").click();
    await expect(page.getByTestId("restart-confirm")).toContainText("Updating Yo…");
    const card = page.getByTestId("update-card");
    await expect(card).toHaveAttribute("data-kind", "update-failed", { timeout: 15_000 });
    await expect(page.getByTestId("restart-confirm")).toHaveCount(0);
    await expect(card).toContainText("The update didn't finish");
    await expect(card).toContainText("Yo is back on the previous version.");
    expect(await page.evaluate(() => (window as any).__stillHere)).toBe(true);
    await page.getByTestId("update-result-ok").click();
    await expect(card).toHaveCount(0);
  });

  test("with a Yo.app downloaded too, one Restart updates the server first, then the app", async ({
    page,
  }) => {
    await openWith(page, "server-ready");
    await mock(page, 'retireHelper("agt_hlp_table", "done", "Booked.")');
    await expect(page.getByTestId("update-card")).toContainText("Update ready");
    await page.getByTestId("update-primary").click();
    const notes = page.getByTestId("restart-confirm-notes");
    await expect(notes).toContainText("Updates wait for you"); // the server's notes
    await expect(notes).toContainText("Restart now asks first"); // and the app's
    await page.getByTestId("restart-confirm-ok").click();
    await expect(page.getByTestId("restart-confirm")).toContainText("Updating Yo…");
    expect(await mock(page, "updates.installs")).toBe(0);
    await expect.poll(() => mock(page, "updates.serverApplies")).toBe(1);
    await expect.poll(() => mock(page, "updates.installs"), { timeout: 15_000 }).toBe(1);
    expect(await mock(page, "updates.serverApplies")).toBe(1);
  });

  test("Settings offers the same Restart", async ({ page }) => {
    await openWith(page, "server");
    await page.getByTestId("update-later").click();
    await openSettings(page);
    await page.getByTestId("settings-about").click();
    await expect(page.getByTestId("web-update-status")).toHaveText(
      "An update is ready. Restart to update when it suits you.",
    );
    await page.getByTestId("settings-server-restart").click();
    await expect(page.getByTestId("restart-confirm")).toContainText("Restart Yo to update?");
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
      await page.getByTestId("update-primary").click();
      await expect(page.getByTestId("restart-confirm-notes")).toBeVisible();
      await shot(page, "54-update-confirm");
      await page.getByTestId("restart-confirm-cancel").click();
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
