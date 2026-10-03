/**
 * The first agent sets up its own computer: a scripted chat right after onboarding (mock backend, fake Macs
 * from `&mockMac=…`, see apps/web/src/lib/mock/setup.ts).
 */
import { expect, type Page, test } from "@playwright/test";
import { send } from "./helpers";

/** The "Connect your model" step (fresh mock: nothing signed in): connect Claude with a fake token. */
async function connectClaude(page: Page) {
  await page.getByTestId("connect-pick-claude").click();
  await page.getByTestId("claude-token-input").fill(`sk-ant-oat01-${"FAKE_e2e_token-".repeat(7)}`);
  await page.getByTestId("claude-token-submit").click();
  await expect(page.getByTestId("connect-status")).toHaveAttribute("data-state", "connected");
  await page.getByTestId("connect-claude-done").click();
}

/** Fresh install, through onboarding, into the first agent's chat. */
async function firstChat(page: Page, mockMac?: string) {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto(`/?mock=1&fast=1${mockMac ? `&mockMac=${mockMac}` : ""}`);
  await page.getByTestId("onboarding-start").click();
  await connectClaude(page);
  await page.getByTestId("access-skip").click();
  await page.getByTestId("onboarding-finish").click();
  await expect(page.getByTestId("setup-chat")).toBeVisible();
}

const mockSettings = (page: Page) => page.evaluate(() => (window as any).__yoMock.s.settings);
const req = (page: Page, id: string) => page.getByTestId(`req-${id}`);

test("onboarding no longer sets up the computer; the first agent's chat offers three places", async ({
  page,
}) => {
  await page.goto("/?mock=1&fast=1");
  await page.getByTestId("onboarding-start").click();
  await connectClaude(page);
  // Straight from the model to Mac access: no computer step.
  await expect(page.getByTestId("onboarding-access")).toBeVisible();
  await expect(page.getByTestId("computer-checklist")).toHaveCount(0);
  await page.getByTestId("access-skip").click();
  await page.getByTestId("onboarding-finish").click();

  await expect(page.getByTestId("setup-greeting")).toContainText(
    "Looks like we have a model connected. Let's set up my computer.",
  );
  await expect(page.getByTestId("setup-choice-local")).toContainText("This Mac");
  await expect(page.getByTestId("setup-choice-home")).toContainText("Advanced");
  const cloud = page.getByTestId("setup-choice-cloud");
  await expect(cloud).toContainText("Coming soon");
  await expect(cloud).toContainText("We'll let you know");
  await expect(cloud).toBeDisabled();
  // A scripted chat: no composer until the computer is live.
  await expect(page.getByTestId("composer-input")).toHaveCount(0);
  expect((await mockSettings(page)).computerSetup).toBe("pending");
});

test("this Mac: a strong Mac passes, the computer starts, and the model takes over", async ({ page }) => {
  await firstChat(page);
  await page.getByTestId("setup-choice-local").click();
  await expect(page.getByTestId("setup-user-line")).toHaveText("This Mac");
  await expect(page.getByTestId("setup-requirements")).toHaveAttribute("data-verdict", "pass");
  for (const id of ["ram", "computerMemory", "cpu", "disk", "macos"])
    await expect(req(page, id)).toHaveAttribute("data-status", "pass");
  await expect(req(page, "ram")).toContainText("36 GB");
  await expect(req(page, "cpu")).toContainText("Apple M3 Pro, 12 cores");
  await expect(page.getByTestId("setup-ready")).toContainText("great fit");

  await page.getByTestId("computer-start").click();
  await expect(page.getByTestId("computer-checklist")).toBeVisible();
  await expect(page.getByTestId("setup-live")).toContainText("My computer is live", { timeout: 15_000 });
  await page.getByTestId("setup-finish").click();

  await expect(page.getByTestId("setup-chat")).toHaveCount(0);
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByTestId("setup-banner")).toHaveCount(0);
  expect((await mockSettings(page)).computerSetup).toBe("done");
  // The real (mock) model answers from here on.
  await send(page, "Research the history of the espresso machine");
  await expect(page.getByTestId("assistant-message").last()).toContainText("Here's what I found", {
    timeout: 15_000,
  });
});

test("this Mac: a 16 GB Intel Mac warns but can still start", async ({ page }) => {
  await firstChat(page, "intel16");
  await page.getByTestId("setup-choice-local").click();
  await expect(page.getByTestId("setup-requirements")).toHaveAttribute("data-verdict", "warn");
  await expect(req(page, "ram")).toHaveAttribute("data-status", "warn");
  await expect(req(page, "ram")).toContainText("32 GB gives your own apps more room");
  await expect(req(page, "cpu")).toHaveAttribute("data-status", "warn");
  await expect(req(page, "cpu")).toContainText("Intel Core i7-9750H, 6 cores");
  await expect(req(page, "macos")).toHaveAttribute("data-status", "warn");
  await expect(req(page, "computerMemory")).toHaveAttribute("data-status", "pass");
  await expect(req(page, "disk")).toHaveAttribute("data-status", "pass");
  await expect(page.getByTestId("setup-ready")).toContainText("could be better");
  await expect(page.getByTestId("computer-start")).toBeEnabled();
});

test("this Mac: an 8 GB Mac is blocked and can switch to a home server", async ({ page }) => {
  await firstChat(page, "small");
  await page.getByTestId("setup-choice-local").click();
  await expect(page.getByTestId("setup-requirements")).toHaveAttribute("data-verdict", "block");
  await expect(req(page, "ram")).toHaveAttribute("data-status", "block");
  await expect(req(page, "ram")).toContainText("I need at least 16 GB");
  await expect(req(page, "disk")).toHaveAttribute("data-status", "block");
  await expect(page.getByTestId("setup-blocked")).toContainText(
    "it needs more memory and more free disk space",
  );
  await expect(page.getByTestId("computer-start")).toHaveCount(0);
  await page.getByTestId("setup-use-home").click();
  await expect(page.getByTestId("setup-home-guide")).toBeVisible();
});

test("this Mac: missing tools get copy-paste steps and live re-checks", async ({ page }) => {
  await firstChat(page, "nobrew");
  await page.getByTestId("setup-choice-local").click();
  const install = page.getByTestId("setup-install");
  await expect(install).toBeVisible();
  await expect(page.getByTestId("install-homebrew")).toContainText(
    "raw.githubusercontent.com/Homebrew/install/HEAD/install.sh",
  );
  await expect(page.getByTestId("install-tools")).toContainText("brew install colima docker docker-compose");
  await expect(page.getByTestId("install-compose")).toContainText("~/.docker/cli-plugins/docker-compose");
  await expect(page.getByTestId("computer-start")).toHaveCount(0);

  // The user runs the steps; the next automatic re-check ticks them off.
  await page.evaluate(() => (window as any).__yoMock.installTools());
  await expect(page.getByTestId("install-tools")).toHaveAttribute("data-done", "true", { timeout: 10_000 });
  await expect(page.getByTestId("setup-ready")).toContainText("Everything's installed");
  await page.getByTestId("computer-start").click();
  await expect(page.getByTestId("setup-live")).toBeVisible({ timeout: 15_000 });
});

test("this Mac: Colima missing, Check again picks up the install", async ({ page }) => {
  await firstChat(page, "nocolima");
  await page.getByTestId("setup-choice-local").click();
  await expect(page.getByTestId("setup-install")).toBeVisible();
  // Homebrew is already there: no step for it.
  await expect(page.getByTestId("install-homebrew")).toHaveCount(0);
  await page.evaluate(() => (window as any).__yoMock.installTools());
  await page.getByTestId("setup-recheck").click();
  await expect(page.getByTestId("setup-ready")).toBeVisible();
});

test("home server: a complete guide with placeholders only", async ({ page }) => {
  await firstChat(page);
  await page.getByTestId("setup-choice-home").click();
  await expect(page.getByTestId("setup-user-line")).toHaveText("Home server");
  const guide = page.getByTestId("setup-home-guide");
  await expect(guide).toContainText("Advanced");
  for (let i = 1; i <= 6; i++) await expect(page.getByTestId(`home-step-${i}`)).toBeVisible();
  await expect(guide).toContainText("docker compose -f compose.server.yaml up -d");
  await expect(guide).toContainText("ssh -N -L 7777:127.0.0.1:7777 <you>@<your-server>");
  await expect(guide).toContainText("remote.json");
  await expect(guide).toContainText("enroll-token");
  const text = (await guide.textContent()) ?? "";
  // Never anyone's real addresses or paths.
  expect(text).not.toMatch(
    /\b100\.\d+\.\d+\.\d+\b|\.ts\.net|\/home\/[a-z]|\/Users\/[a-z]|@[a-z0-9-]+\.[a-z]{2,}/i,
  );
  // Switching back to this Mac still works.
  await page.getByTestId("setup-choice-local").click();
  await expect(page.getByTestId("setup-requirements")).toBeVisible();
});

test("Do this later: never stuck, and the banner brings the setup back", async ({ page }) => {
  await firstChat(page, "small");
  await page.getByTestId("setup-choice-local").click();
  await expect(page.getByTestId("setup-blocked")).toBeVisible();
  await page.getByTestId("setup-later").click();

  await expect(page.getByTestId("setup-chat")).toHaveCount(0);
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(page.getByTestId("setup-banner")).toContainText("isn't set up yet");
  expect((await mockSettings(page)).computerSetup).toBe("later");

  await page.getByTestId("setup-resume").click();
  await expect(page.getByTestId("setup-greeting")).toBeVisible();
  expect((await mockSettings(page)).computerSetup).toBe("pending");
});

test("an existing install never sees the setup chat", async ({ page }) => {
  await page.goto("/?mock=1&fast=1&onboarded=1");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("timeline")).toBeVisible();
  await expect(page.getByTestId("setup-chat")).toHaveCount(0);
  await expect(page.getByTestId("setup-banner")).toHaveCount(0);
});

test("fresh user: connect Claude with a token, then the first agent offers to set up its computer", async ({
  page,
}) => {
  // Nothing signed in anywhere: the token is saved before the computer exists ("unverified").
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto("/?mock=1&fast=1&mockConnect=none");
  await page.getByTestId("onboarding-start").click();
  await connectClaude(page);
  await page.getByTestId("access-skip").click();
  await page.getByTestId("onboarding-finish").click();
  await expect(page.getByTestId("setup-greeting")).toContainText(
    "Looks like we have a model connected. Let's set up my computer.",
  );
});

test("skipped the model: the chat says so and points to Accounts; connecting one later leads to the setup", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto("/?mock=1&fast=1&mockConnect=none");
  await page.getByTestId("onboarding-start").click();
  await page.getByTestId("onboarding-next").click(); // Skip for now
  await page.getByTestId("access-skip").click();
  await page.getByTestId("onboarding-finish").click();
  await expect(page.getByTestId("setup-chat")).toHaveCount(0);
  await expect(page.getByTestId("composer-footer")).toContainText("no model connected");
  await expect(page.getByTestId("composer-footer")).not.toContainText("subscription");

  // Settings → Computer doesn't start a VM this Mac was never checked for.
  await page.getByTestId("profile-trigger").click();
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-computer").click();
  await expect(page.getByTestId("computer-setup")).toHaveText("Connect a model first");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);

  await send(page, "Find me a cheap flight");
  const error = page.getByTestId("error-row");
  await expect(error).toContainText("Settings → Accounts");
  const errorPill = page.getByTestId("status-pill").filter({ hasText: "Error" });
  await expect(errorPill.first()).toBeVisible();
  await error.getByTestId("error-connect").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await page.getByTestId("connect-claude").click();
  await page.getByTestId("claude-token-input").fill(`sk-ant-oat01-${"FAKE_e2e_token-".repeat(7)}`);
  await page.getByTestId("claude-token-submit").click();
  await page.getByTestId("connect-claude-done").click();
  await page.keyboard.press("Escape");

  // Connected: the error clears and the first agent offers to set up its computer.
  await expect(errorPill).toHaveCount(0);
  await expect(page.getByTestId("setup-greeting")).toContainText("Let's set up my computer");
});

test("Settings → Computer sends a Mac that was never set up through the setup chat", async ({ page }) => {
  await firstChat(page);
  await page.getByTestId("setup-later").click();
  await page.getByTestId("profile-trigger").click();
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-computer").click();
  await page.getByTestId("computer-setup").click();
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  await expect(page.getByTestId("setup-chat")).toBeVisible();
  expect((await mockSettings(page)).computerSetup).toBe("pending");
});

test.describe("a user outside New York", () => {
  test.use({ timezoneId: "Europe/Lisbon" });

  test("onboarding saves their own time zone (the agent's clock and routines use it)", async ({ page }) => {
    await firstChat(page);
    expect((await mockSettings(page)).timezone).toBe("Europe/Lisbon");
  });
});
