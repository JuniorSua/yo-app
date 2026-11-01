/**
 * Updates: one small notice in the update button's place in the rail (on phones, a strip of its own above the tab
 * bar), one window to decide and watch it happen, and a short "Updated to Yo 2.0.N" afterwards, against the mock backend (`?mockUpdate=…&mockHold=1`, see
 * apps/web/src/lib/mock/updates.ts). Screenshots: pnpm e2e --grep "screenshots updates"
 */
import { expect, type Page, test } from "@playwright/test";
import { openSettings } from "./helpers";

async function openWith(
  page: Page,
  mockUpdate: string | null,
  opts: { theme?: "dark" | "light"; hold?: boolean } = {},
) {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto(
    `/?mock=1&fast=1&onboarded=1${mockUpdate ? `&mockUpdate=${mockUpdate}` : ""}${opts.theme ? `&theme=${opts.theme}` : ""}${opts.hold ? "&mockHold=1" : ""}`,
  );
  await expect(page.getByTestId("sidebar")).toBeVisible();
}

const mock = (page: Page, fn: string) => page.evaluate(`window.__yoMock.${fn}`);
/** The mock's seeded helper is still working: let it finish, so no agent is busy. */
const nobodyBusy = (page: Page) => mock(page, 'retireHelper("agt_hlp_table", "done", "Booked.")');
const holdWorking = (page: Page) =>
  page.evaluate(async () => {
    const m = (window as any).__yoMock;
    const yo = (await m.call("bootstrap", {})).agents.find((a: any) => a.isPrimary);
    m.emit("agent.updated", { ...yo, activity: "working" });
  });

const notice = (page: Page) => page.getByTestId("update-notice");
/** The rail tile's one control: its accessible name is the whole sentence ("Update ready"). */
const tile = (page: Page) => notice(page).getByRole("button");
const dialog = (page: Page) => page.getByTestId("update-dialog");
const view = (page: Page) => page.getByTestId("update-dialog-body");
const step = (page: Page, id: string) => page.getByTestId(`update-step-${id}`);

/** Everything that can say "there's an update": the owner wants exactly one at a time. */
async function announcers(page: Page) {
  let n = 0;
  for (const id of ["update-notice", "update-dot", "update-dialog", "update-panel"])
    n += await page.getByTestId(id).filter({ visible: true }).count();
  n += await page.getByText("Reconnecting to Yo").count();
  n += await page.locator("[data-sonner-toast]").count();
  return n;
}

test.describe("one surface at a time", () => {
  test("a ready update shows one small notice in the rail, in the update button's place; Later leaves just the dot", async ({
    page,
  }) => {
    await openWith(page, "server");
    await nobodyBusy(page);
    await expect(notice(page)).toHaveAttribute("data-kind", "ready");
    await expect(tile(page)).toHaveAccessibleName("Update ready");
    await expect(notice(page)).toHaveText("Update");
    expect(await announcers(page)).toBe(1);
    await expect(page.getByTestId("update-dot")).toHaveCount(0);
    await expect(page.getByTestId("update-button")).toHaveCount(0);

    // Inside the rail, over nothing: the chat column starts right of it.
    const rail = (await page.getByTestId("sidebar").boundingBox())!;
    const pill = (await notice(page).boundingBox())!;
    const chat = (await page.locator(".chat-column").boundingBox())!;
    expect(pill.x).toBeGreaterThanOrEqual(rail.x);
    expect(pill.x + pill.width).toBeLessThanOrEqual(rail.x + rail.width);
    expect(pill.x + pill.width).toBeLessThanOrEqual(chat.x);
    // Above Settings, where the update button was.
    const settings = (await page.getByTestId("rail-settings").boundingBox())!;
    expect(pill.y + pill.height).toBeLessThanOrEqual(settings.y);

    // Nothing restarts by itself.
    await page.waitForTimeout(500);
    expect(await mock(page, "updates.serverApplies")).toBe(0);

    // The notice opens the one window; while it's open, it's the only thing saying so.
    await page.getByTestId("update-notice-open").click();
    await expect(view(page)).toHaveAttribute("data-view", "decide");
    await expect(notice(page)).toHaveCount(0);
    expect(await announcers(page)).toBe(1);

    await page.getByTestId("update-later").click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0);
    await expect(page.getByTestId("update-dot")).toBeVisible();
    expect(await announcers(page)).toBe(1);

    // The button opens the same window (not a second panel saying the same thing).
    await page.getByTestId("update-button").click();
    await expect(view(page)).toHaveAttribute("data-view", "decide");
    await expect(page.getByTestId("update-panel")).toHaveCount(0);
  });

  test("Restart now: the window shows the real steps, alone, then Yo comes back and says Updated", async ({
    page,
  }) => {
    await openWith(page, "server", { hold: true });
    await nobodyBusy(page);
    await page.getByTestId("update-notice-open").click();
    await page.getByTestId("update-confirm").click();
    await expect(page.getByTestId("update-dialog-title")).toHaveText("Updating Yo");
    await expect(page.getByTestId("update-dialog-line")).toHaveText(
      "Usually about a minute. This window reloads when Yo is back.",
    );
    await expect(step(page, "save")).toHaveAttribute("data-state", "active");
    await expect(step(page, "install")).toHaveAttribute("data-state", "todo");
    expect(await announcers(page)).toBe(1);
    // It can't be dismissed while it runs.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeVisible();

    // Core goes away for the swap: the step says so, and no "Reconnecting" banner joins in.
    await expect.poll(() => mock(page, "updates.serverApplies")).toBe(1);
    await mock(page, "updates.next()");
    await expect(step(page, "save")).toHaveAttribute("data-state", "done");
    await expect(step(page, "install")).toHaveAttribute("data-state", "active");
    await expect(step(page, "install")).toContainText("Yo is offline for this part.");
    await page.waitForTimeout(400);
    expect(await announcers(page)).toBe(1);

    // Core answers again while the updater checks it.
    await mock(page, "updates.next()");
    await expect(step(page, "start")).toHaveAttribute("data-state", "active", { timeout: 10_000 });
    expect(await announcers(page)).toBe(1);

    const reloaded = page.waitForEvent("framenavigated", { timeout: 15_000 });
    await mock(page, "updates.next()");
    await expect(page.getByTestId("update-dialog-title")).toHaveText("Done", { timeout: 10_000 });
    await reloaded;
    await expect(page.getByTestId("sidebar")).toBeVisible();
    expect(await mock(page, "updates.serverApplies")).toBe(0); // a new page (the mock forgot the count)

    // After: one short confirmation, no leftover refresh or card.
    await expect(notice(page)).toHaveAttribute("data-kind", "done");
    await expect(tile(page)).toHaveAccessibleName("Updated to Yo 2.0.791 · What's new");
    await expect(page.getByTestId("update-done-text")).toHaveAttribute("data-version", "2.0.791");
    expect(await announcers(page)).toBe(1);
    await page.getByTestId("update-whatsnew").click();
    await expect(view(page)).toHaveAttribute("data-view", "whatsnew");
    await expect(page.getByTestId("update-dialog-notes")).toContainText("Updates wait for you");
    await page.getByTestId("update-ok").click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0);
    // The update button is back in its place, with nothing pending.
    await expect(page.getByTestId("update-button")).toHaveAttribute("data-state", "idle");
  });

  test("the Updated confirmation goes away by itself", async ({ page }) => {
    await page.clock.install();
    await openWith(page, "web");
    await page.getByTestId("update-notice-open").click();
    await Promise.all([page.waitForEvent("framenavigated"), page.getByTestId("update-confirm").click()]);
    await expect(notice(page)).toHaveAttribute("data-kind", "done");
    await expect(tile(page)).toHaveAccessibleName("Updated to Yo 2.0.791");
    await expect(page.getByTestId("update-whatsnew")).toHaveCount(0); // nothing published with a deploy
    await page.clock.fastForward("00:10");
    await expect(notice(page)).toHaveCount(0);
  });

  test("on a phone the notice gets its own strip above the tab bar, and opens the same window", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWith(page, "server");
    await expect(page.getByTestId("update-button")).toBeHidden();
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toHaveText("Update ready");
    expect(await announcers(page)).toBe(1);
    const box = (await notice(page).boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 195)).toBeLessThan(2); // centred
    // Between the message box and the tab bar, touching neither: the chat made room for it.
    const tabs = (await page.getByTestId("sidebar").boundingBox())!;
    const composer = (await page.locator(".composer-dock").boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(tabs.y - 4);
    expect(box.y).toBeGreaterThanOrEqual(composer.y + composer.height);
    // And clear of the head zone and the agent's status line.
    const status = (await page.getByTestId("presence-line").boundingBox())!;
    expect(box.y).toBeGreaterThan(status.y + status.height + 200);
    await page.getByTestId("update-notice-open").click();
    await expect(view(page)).toHaveAttribute("data-view", "decide");
    await page.getByTestId("update-later").click();
    await expect(notice(page)).toHaveCount(0);
  });
});

test.describe("decide", () => {
  test("says what's new and what happens; Later is focused first, and Escape is Later", async ({ page }) => {
    await openWith(page, "server");
    await nobodyBusy(page);
    await page.getByTestId("update-notice-open").click();
    await expect(page.getByTestId("update-dialog-title")).toHaveText("Update ready");
    await expect(page.getByTestId("update-dialog-line")).toHaveText(
      "Yo restarts for about a minute. Your chats are safe.",
    );
    await expect(page.getByTestId("update-dialog-notes")).toContainText("Updates wait for you");
    await expect(page.getByTestId("update-dialog-busy")).toHaveCount(0);
    await expect(page.getByTestId("update-dialog-browser")).toHaveCount(0);
    await expect(page.getByTestId("update-confirm")).toHaveText("Restart now");
    // A stray Enter never restarts.
    await expect(page.getByTestId("update-later")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId("update-dot")).toBeVisible();
    await page.waitForTimeout(300);
    expect(await mock(page, "updates.serverApplies")).toBe(0);
  });

  test("warns who will stop and that the browser restarts", async ({ page }) => {
    await openWith(page, "server-browser");
    await holdWorking(page);
    await page.getByTestId("update-notice-open").click();
    await expect(page.getByTestId("update-dialog-line")).toHaveText(
      "Yo and its browser restart for 1–2 minutes. Your chats are safe.",
    );
    await expect(page.getByTestId("update-dialog-busy")).toContainText("in the middle of");
    await expect(page.getByTestId("update-dialog-busy")).toContainText("will stop");
    await expect(page.getByTestId("update-dialog-browser")).toContainText(
      "You may need to sign in to some sites again",
    );
    await expect(page.getByTestId("update-confirm")).toHaveText("Restart anyway");
    await page.getByTestId("update-later").click();
    await page.waitForTimeout(300);
    expect(await mock(page, "updates.serverApplies")).toBe(0);
  });

  test("a downloaded Yo.app: its version, notes, and the agents working on this Mac", async ({ page }) => {
    await openWith(page, "ready");
    await holdWorking(page);
    await page.getByTestId("update-notice-open").click();
    await expect(page.getByTestId("update-dialog-title")).toHaveText("Yo 2.0.791 is ready");
    await expect(page.getByTestId("update-dialog-line")).toHaveText(
      "Yo closes and opens again in about 10 seconds. Your chats are safe.",
    );
    await expect(page.getByTestId("update-dialog-notes")).toContainText("Restart now asks first");
    await expect(page.getByTestId("update-dialog-busy")).toContainText("Your agents are still working.");
    await expect(page.getByTestId("update-confirm")).toHaveText("Restart anyway");
    expect(await mock(page, "updates.installs")).toBe(0);
  });

  test("without published notes it still asks, minus What's new", async ({ page }) => {
    await openWith(page, "ready");
    // An older core (or a build published with --no-notes) sends no notes.
    await page.evaluate(() => {
      const m = (window as any).__yoMock.updates;
      const version = m.version.bind(m);
      m.version = () => ({ ...version(), desktop: { version: "2.0.791" } });
    });
    await mock(page, "simulateReconnect()");
    await page.waitForTimeout(300);
    await page.getByTestId("update-notice-open").click();
    await expect(page.getByTestId("update-dialog-title")).toHaveText("Yo 2.0.791 is ready");
    await expect(page.getByTestId("update-dialog-notes")).toHaveCount(0);
  });

  test("a server deploy asks to reload this window; agents keep working", async ({ page }) => {
    await openWith(page, null);
    await page.waitForTimeout(300);
    await expect(notice(page)).toHaveCount(0);
    // A core swap restarts the server: the reconnect is the first sign of the new build.
    await mock(page, "updates.deploy()");
    await mock(page, "simulateReconnect()");
    await expect(notice(page)).toHaveAttribute("data-kind", "ready");
    // Never reloads by itself.
    await page.evaluate(() => {
      (window as any).__stillHere = true;
    });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as any).__stillHere)).toBe(true);
    await page.getByTestId("update-notice-open").click();
    await expect(page.getByTestId("update-dialog-line")).toHaveText(
      "Reload this window to use the new version. It takes a second.",
    );
    await expect(page.getByTestId("update-dialog-safe")).toContainText("agents keep working");
    await expect(page.getByTestId("update-confirm")).toHaveText("Reload now");
    await Promise.all([page.waitForEvent("framenavigated"), page.getByTestId("update-confirm").click()]);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__stillHere ?? false)).toBe(false);
  });
});

test.describe("apply", () => {
  test("Yo.app: Closing Yo, it relaunches on the new version and says Updated", async ({ page }) => {
    await openWith(page, "ready");
    await nobodyBusy(page);
    await page.getByTestId("update-notice-open").click();
    await page.getByTestId("update-confirm").click();
    await expect(page.getByTestId("update-dialog-title")).toHaveText("Restarting Yo");
    await expect(step(page, "close")).toHaveAttribute("data-state", "active");
    await expect(step(page, "open")).toHaveAttribute("data-state", "todo");
    expect(await announcers(page)).toBe(1);
    await expect(notice(page)).toHaveAttribute("data-kind", "done", { timeout: 10_000 });
    expect(await mock(page, "updates.installs")).toBe(1);
    await expect(tile(page)).toHaveAccessibleName("Updated to Yo 2.0.791 · What's new");
    await page.getByTestId("update-whatsnew").click();
    await expect(page.getByTestId("update-dialog-title")).toHaveText("Updated to Yo 2.0.791");
    await expect(page.getByTestId("update-dialog-notes")).toContainText("Restart now asks first");
  });

  test("a server update and a downloaded Yo.app: one Restart does both, server first", async ({ page }) => {
    await openWith(page, "server-ready");
    await nobodyBusy(page);
    await page.getByTestId("update-notice-open").click();
    const notes = page.getByTestId("update-dialog-notes");
    await expect(notes).toContainText("Updates wait for you"); // the server's notes
    await expect(notes).toContainText("Restart now asks first"); // and the app's
    await page.getByTestId("update-confirm").click();
    await expect(step(page, "app")).toHaveText("Restarting the Yo app");
    await expect.poll(() => mock(page, "updates.serverApplies")).toBe(1);
    expect(await mock(page, "updates.installs")).toBe(0);
    await expect(notice(page)).toHaveAttribute("data-kind", "done", { timeout: 15_000 });
    expect(await mock(page, "updates.installs")).toBe(1);
  });

  test("slow says so and can be hidden; stuck says how to get Yo back; it still finishes", async ({
    page,
  }) => {
    await page.clock.install();
    await openWith(page, "server-slow");
    await nobodyBusy(page);
    await page.getByTestId("update-notice-open").click();
    await page.getByTestId("update-confirm").click();
    await expect(step(page, "install")).toHaveAttribute("data-state", "active", { timeout: 10_000 });
    await expect(page.getByTestId("update-dialog-slow")).toHaveCount(0);
    await expect(page.getByTestId("update-hide")).toHaveCount(0);

    await page.clock.fastForward("02:05");
    await expect(page.getByTestId("update-dialog-slow")).toContainText("taking longer than usual");
    await expect(page.getByTestId("update-dialog-slow")).toContainText("Installing the update");
    await page.getByTestId("update-hide").click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(notice(page)).toHaveAttribute("data-kind", "updating");
    // The tile counts the time; its whole sentence is in its name (and its tip).
    await expect(tile(page)).toHaveAccessibleName(/^Updating Yo… \d+:\d\d$/);
    await expect(notice(page)).toHaveText(/^\d+:\d\d$/);
    expect(await announcers(page)).toBe(1);

    await page.getByTestId("update-notice-open").click();
    await page.clock.fastForward("04:30");
    await expect(page.getByTestId("update-dialog-title")).toHaveText("Yo hasn't come back yet");
    await expect(page.getByTestId("update-dialog-stuck")).toContainText("restart the PC that runs Yo");

    // Yo comes back after all: back to the steps, then the reload.
    const reloaded = page.waitForEvent("framenavigated", { timeout: 20_000 });
    await mock(page, "updates.next()");
    await expect(step(page, "start")).toHaveAttribute("data-state", "active", { timeout: 10_000 });
    await expect(page.getByTestId("update-dialog-title")).toHaveText("Updating Yo");
    await reloaded;
    await expect(notice(page)).toHaveAttribute("data-kind", "done", { timeout: 10_000 });
  });

  test("a failed update says what happened and what to do; other windows hear it until OK", async ({
    page,
  }) => {
    await openWith(page, "server-fail");
    await nobodyBusy(page);
    await page.evaluate(() => {
      (window as any).__stillHere = true;
    });
    await page.getByTestId("update-notice-open").click();
    await page.getByTestId("update-confirm").click();
    await expect(view(page)).toHaveAttribute("data-view", "failed", { timeout: 15_000 });
    await expect(page.getByTestId("update-dialog-title")).toHaveText("The update didn't finish");
    await expect(page.getByTestId("update-dialog-line")).toContainText("Yo is back on the previous version.");
    await expect(page.getByTestId("update-dialog-advice")).toHaveText(
      "Nothing to do now: Yo works as before.",
    );
    expect(await page.evaluate(() => (window as any).__stillHere)).toBe(true);

    // Another window (here: this one reloaded) gets the notice, once.
    await page.reload();
    await expect(notice(page)).toHaveAttribute("data-kind", "failed");
    await expect(tile(page)).toHaveAccessibleName("Update didn't finish");
    await page.getByTestId("update-notice-open").click();
    await expect(view(page)).toHaveAttribute("data-view", "failed");
    await page.getByTestId("update-ok").click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(notice(page)).toHaveCount(0);
  });

  test("Yo.app that can't restart says to quit and reopen", async ({ page }) => {
    await openWith(page, "ready-fail");
    await nobodyBusy(page);
    await page.getByTestId("update-notice-open").click();
    await page.getByTestId("update-confirm").click();
    await expect(view(page)).toHaveAttribute("data-view", "failed", { timeout: 10_000 });
    await expect(page.getByTestId("update-dialog-title")).toHaveText("Yo couldn't restart to update");
    await expect(page.getByTestId("update-dialog-line")).toHaveText("Yo didn't quit to install the update.");
    await expect(page.getByTestId("update-dialog-advice")).toContainText("Quit Yo (⌘Q) and open it again");
    await page.getByTestId("update-ok").click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId("update-button")).toHaveAttribute("data-state", "error");
  });

  test("an update started on another device: Updating Yo…, then a reload, then Updated", async ({ page }) => {
    await openWith(page, "server-other");
    await expect(notice(page)).toHaveAttribute("data-kind", "updating");
    await page.getByTestId("update-notice-open").click();
    await expect(page.getByTestId("update-dialog-title")).toHaveText("Yo is updating");
    await page.getByTestId("update-hide").click();
    // Never reloads by itself: it offers the reload when the other device's update is done.
    await expect(notice(page)).toHaveAttribute("data-kind", "ready", { timeout: 10_000 });
    await page.getByTestId("update-notice-open").click();
    await expect(page.getByTestId("update-confirm")).toHaveText("Reload now");
    await Promise.all([page.waitForEvent("framenavigated"), page.getByTestId("update-confirm").click()]);
    await expect(notice(page)).toHaveAttribute("data-kind", "done");
    await expect(tile(page)).toHaveAccessibleName(/^Updated to Yo 2\.0\.791/);
  });
});

test.describe("the free download (github channel)", () => {
  test("a guide with the version, Download and three plain steps; normal for the free download", async ({
    page,
  }) => {
    await openWith(page, "github");
    await expect(tile(page)).toHaveAccessibleName("Update available");
    expect(await announcers(page)).toBe(1);
    await page.getByTestId("update-notice-open").click();
    await expect(view(page)).toHaveAttribute("data-view", "download");
    await expect(page.getByTestId("update-dialog-title")).toHaveText("Yo 2.0.791 is out");
    const steps = page.getByTestId("update-download-steps");
    await expect(steps).toContainText("Download Yo 2.0.791");
    await expect(steps).toContainText("Quit Yo");
    await expect(steps).toContainText("Press ⌘Q");
    await expect(steps).toContainText("Drag the new Yo into Applications");
    await expect(steps).toContainText("Choose Replace");
    await expect(page.getByTestId("update-note")).toContainText("This is normal for the free download");
    // Ad-hoc builds: the Keychain asks again after each update (#74).
    await expect(page.getByTestId("update-note")).toContainText("Yo Safe Storage");
    await expect(page.getByTestId("update-confirm")).toHaveCount(0); // nothing restarts in the app
    await page.getByTestId("update-download").click();
    await expect.poll(() => mock(page, "updates.downloads")).toBe(1);
    await expect(steps).toContainText("It's downloading in your browser.");
    await page.getByTestId("update-done").click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await mock(page, "updates.installs")).toBe(0);
    await expect(page.getByTestId("update-dot")).toBeVisible();

    // Checking again keeps it: nothing downloads in the app.
    await page.evaluate(() => (window as any).yoDesktop.updates.check());
    await expect(page.getByTestId("update-button")).toHaveAttribute("data-state", "ready");

    // Settings says the same, and its Download opens the same steps.
    await openSettings(page);
    await page.getByTestId("settings-about").click();
    await expect(page.getByTestId("desktop-update-status")).toHaveText(
      "Yo 2.0.791 is out. Download it, quit Yo (⌘Q), then drag the new Yo into Applications.",
    );
    await expect(page.getByTestId("check-updates")).toHaveCount(0);
    await page.getByTestId("settings-update-download").click();
    await expect(view(page)).toHaveAttribute("data-view", "download");
  });
});

test.describe("quiet states", () => {
  test("a background download stays on the button; a failed one recovers with a click", async ({ page }) => {
    await openWith(page, "downloading");
    await expect(notice(page)).toHaveCount(0);
    const button = page.getByTestId("update-button");
    await expect(button).toHaveAttribute("data-state", "downloading");
    await button.click();
    await expect(page.getByTestId("update-panel")).toContainText("Downloading Yo 2.0.791");
    await expect(page.getByTestId("update-panel")).toContainText("42%");

    await openWith(page, "error");
    await expect(button).toHaveAttribute("data-state", "error");
    await expect(notice(page)).toHaveCount(0);
    // Clicking it checks again: the download finishes and the notice says Update ready.
    await button.click();
    await expect(notice(page)).toHaveAttribute("data-kind", "ready");
    await expect(button).toHaveCount(0); // the notice takes the button's place
  });

  test("with nothing new, a click checks and says it's up to date", async ({ page }) => {
    await openWith(page, null);
    const button = page.getByTestId("update-button");
    await expect(button).toHaveAttribute("data-state", "idle");
    await button.click();
    await expect(page.getByTestId("update-panel")).toContainText("Yo is up to date");
    await expect(page.getByTestId("update-dot")).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0);
  });

  test("Settings shows the versions; its Restart opens the same window", async ({ page }) => {
    await openWith(page, "error");
    await openSettings(page);
    await page.getByTestId("settings-about").click();
    const group = page.getByTestId("settings-updates");
    await expect(group).toContainText("Yo app 2.0.790");
    await expect(page.getByTestId("desktop-update-status")).toHaveText(/download was interrupted/);
    await expect(page.getByTestId("web-update-status")).toHaveText("Up to date");
    await page.getByTestId("check-updates").click();
    await expect(page.getByTestId("desktop-update-status")).toHaveText(
      "Yo 2.0.791 is ready. Restart to update.",
    );
    await page.getByTestId("settings-app-restart").click();
    await expect(page.getByTestId("update-dialog-title")).toHaveText("Yo 2.0.791 is ready");
    await page.getByTestId("update-later").click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(group).toBeVisible();
  });

  test("Settings offers the server update's Restart too", async ({ page }) => {
    await openWith(page, "server");
    await openSettings(page);
    await page.getByTestId("settings-about").click();
    await expect(page.getByTestId("web-update-status")).toHaveText(
      "An update is ready. Restart when it suits you.",
    );
    await page.getByTestId("settings-server-restart").click();
    await expect(page.getByTestId("update-dialog-line")).toHaveText(
      "Yo restarts for about a minute. Your chats are safe.",
    );
  });
});

const SHOTS = process.env.YO_SHOTS_DIR || "e2e/screenshots";

for (const theme of ["dark", "light"] as const) {
  test.describe(`screenshots updates ${theme}`, () => {
    test.use({ colorScheme: theme });
    const shot = async (page: Page, name: string) => {
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/updates-${theme}-${name}.png` });
    };

    test(`screenshots updates (${theme})`, async ({ page }) => {
      // Ready: the tile in the rail, then its sentence on hover.
      await openWith(page, "server", { theme, hold: true });
      await nobodyBusy(page);
      await expect(notice(page)).toBeVisible();
      await shot(page, "01-ready");
      await tile(page).hover();
      await expect(page.getByText("Update ready", { exact: true })).toBeVisible();
      await shot(page, "02-ready-hover");
      await page.mouse.move(700, 450);
      await page.getByTestId("update-notice-open").click();
      await expect(page.getByTestId("update-dialog-notes")).toBeVisible();
      await shot(page, "03-decide");
      await page.getByTestId("update-confirm").click();
      await expect.poll(() => mock(page, "updates.serverApplies")).toBe(1);
      await mock(page, "updates.next()");
      await expect(step(page, "install")).toHaveAttribute("data-state", "active");
      await shot(page, "04-applying");

      // Updating (started on another device): the tile counts the time.
      await openWith(page, "server-other", { theme });
      await expect(notice(page)).toHaveAttribute("data-kind", "updating");
      await shot(page, "05-updating");

      // Didn't finish: heard by another window.
      await openWith(page, "server-fail", { theme });
      await nobodyBusy(page);
      await page.getByTestId("update-notice-open").click();
      await page.getByTestId("update-confirm").click();
      await expect(view(page)).toHaveAttribute("data-view", "failed", { timeout: 15_000 });
      await page.reload();
      await expect(notice(page)).toHaveAttribute("data-kind", "failed");
      await shot(page, "06-failed");

      // Done: a calm "Updated" for a few seconds.
      await openWith(page, "server", { theme, hold: true });
      await nobodyBusy(page);
      await page.getByTestId("update-notice-open").click();
      await page.getByTestId("update-confirm").click();
      await expect.poll(() => mock(page, "updates.serverApplies")).toBe(1);
      await mock(page, "updates.next()");
      await expect(step(page, "install")).toHaveAttribute("data-state", "active");
      await mock(page, "updates.next()");
      await expect(step(page, "start")).toHaveAttribute("data-state", "active", { timeout: 10_000 });
      const reloaded = page.waitForEvent("framenavigated", { timeout: 15_000 });
      await mock(page, "updates.next()");
      await reloaded;
      await expect(notice(page)).toHaveAttribute("data-kind", "done", { timeout: 15_000 });
      await shot(page, "07-done");
      await tile(page).hover();
      await expect(page.getByText("Updated to Yo 2.0.791 · What's new", { exact: true })).toBeVisible();
      await shot(page, "08-done-hover");

      await openWith(page, "ready", { theme });
      await openSettings(page);
      await page.getByTestId("settings-about").click();
      await expect(page.getByTestId("settings-updates")).toBeVisible();
      await shot(page, "09-settings");
    });

    test(`screenshots updates phone (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openWith(page, "server", { theme });
      await expect(notice(page)).toBeVisible();
      await shot(page, "10-phone-ready");
    });
  });
}
