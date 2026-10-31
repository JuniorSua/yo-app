/**
 * The first agent sets up its own computer: a scripted chat right after onboarding (mock backend, fake Macs
 * from `&mockMac=…`, see apps/web/src/lib/mock/setup.ts).
 */
import { expect, type Page, test } from "@playwright/test";
import { chooseClaudeFirstRun, send, signInChatGPT, signInClaude } from "./helpers";

/**
 * The "Connect your model" step (fresh mock Mac: nothing signed in, computer not set up): choose Claude. It signs
 * in on Yo's computer, so that happens at the end of the setup chat.
 */
const connectClaude = chooseClaudeFirstRun;
const CLAUDE_FIRST = "Let's set up my computer first. You sign in to Claude on it right after.";

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

/** The mock's settings; waits for the mock to exist (right after goto it may not yet). */
const mockSettings = async (page: Page) => {
  await page.waitForFunction(() => (window as any).__yoMock?.s);
  return page.evaluate(() => (window as any).__yoMock.s.settings);
};
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

  await expect(page.getByTestId("setup-greeting")).toContainText(CLAUDE_FIRST);
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
  // Live: now Claude signs in on it (Claude's own page, then the code it shows).
  const claude = page.getByTestId("setup-claude");
  await expect(claude).toContainText("My computer is live. Now sign in to Claude", { timeout: 15_000 });
  await expect(page.getByTestId("setup-finish")).toHaveCount(0);
  await signInClaude(claude);
  await expect(page.getByTestId("setup-live")).toContainText("My computer is live");
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
  await expect(page.getByTestId("setup-missing")).toContainText("A few free tools are missing");

  // The user runs the steps; the next automatic re-check ticks them off.
  await page.evaluate(() => (window as any).__yoMock.installTools());
  await expect(page.getByTestId("install-tools")).toHaveAttribute("data-done", "true", { timeout: 10_000 });
  await expect(page.getByTestId("setup-ready")).toContainText("Everything's installed");
  // The ticked-off list stays, but no longer says anything is missing.
  await expect(page.getByTestId("setup-missing")).not.toContainText("missing");
  await expect(page.getByTestId("setup-missing")).not.toContainText("Open Terminal");
  await page.getByTestId("computer-start").click();
  await expect(page.getByTestId("setup-claude")).toBeVisible({ timeout: 15_000 });
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
  await expect(guide).toContainText("Advanced · Beta");
  await expect(page.getByTestId("setup-home-beta")).toContainText("beta for technical users");
  // The computer comes ready-made for the app's version (no 20-minute build), and the guide says how to update.
  await expect(guide).toContainText("docker pull ghcr.io/juniorsua/yo-computer:<version>");
  await expect(guide).toContainText("YO_COMPUTER_IMAGE");
  await expect(guide).not.toContainText("docker build -t yo-computer");
  await expect(page.getByTestId("home-update")).toContainText("Keep Yo up to date");
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

test("fresh user: choose Claude, and the first agent sets up its computer first, then Claude", async ({
  page,
}) => {
  // Nothing signed in anywhere, and no computer yet: Claude signs in on Yo's computer, so that comes first.
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto("/?mock=1&fast=1&mockConnect=none");
  await page.getByTestId("onboarding-start").click();
  await page.getByTestId("connect-pick-claude").click();
  const steps = page.getByTestId("connect-steps-claude");
  await expect(steps).toContainText("Claude signs in inside Yo's private workspace");
  // No Terminal, no token to paste.
  await expect(steps).not.toContainText(/setup-token|sk-ant|Terminal/);
  await page.getByTestId("claude-after-setup").click();
  await page.getByTestId("access-skip").click();
  await page.getByTestId("onboarding-finish").click();
  await expect(page.getByTestId("setup-greeting")).toContainText(CLAUDE_FIRST);
  // Remembered across restarts (the mock backend itself starts over on a reload, so only the app's side here).
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("yo.ui") ?? "{}").signInAfterSetup)).toBe(
    "claude",
  );
});

test("fresh user: choose ChatGPT, and the setup chat ends with ChatGPT's sign-in (no Terminal)", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto("/?mock=1&fast=1&mockConnect=none");
  await page.getByTestId("onboarding-start").click();
  await page.getByTestId("connect-pick-codex").click();
  const steps = page.getByTestId("connect-steps-codex");
  await expect(steps).toContainText("ChatGPT signs in inside Yo's private workspace");
  await expect(steps).not.toContainText(/Terminal|CODEX_HOME|codex login/);
  await page.getByTestId("codex-after-setup").click();
  await page.getByTestId("access-skip").click();
  await page.getByTestId("onboarding-finish").click();
  await expect(page.getByTestId("setup-greeting")).toContainText(
    "Let's set up my computer first. You sign in to ChatGPT on it right after.",
  );
  await page.getByTestId("setup-choice-local").click();
  await page.getByTestId("computer-start").click();
  const codex = page.getByTestId("setup-codex");
  await expect(codex).toContainText("My computer is live. Now sign in to ChatGPT", { timeout: 15_000 });
  await expect(page.getByTestId("setup-claude")).toHaveCount(0);
  await expect(page.getByTestId("setup-finish")).toHaveCount(0);
  await signInChatGPT(codex);
  await expect(page.getByTestId("setup-live")).toContainText("My computer is live");
  await page.getByTestId("setup-finish").click();
  await expect(page.getByTestId("setup-chat")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("yo.ui") ?? "{}").signInAfterSetup)).toBe(
    null,
  );
});

test("an older Yo's remembered Claude choice still ends the setup chat with Claude", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("yo.ui", JSON.stringify({ claudeAfterSetup: true })));
  await page.goto("/?mock=1&fast=1&mockConnect=none");
  await page.getByTestId("onboarding-start").click();
  await page.getByTestId("onboarding-next").click();
  await page.getByTestId("access-skip").click();
  await page.getByTestId("onboarding-finish").click();
  await expect(page.getByTestId("setup-greeting")).toContainText(CLAUDE_FIRST);
});

test("a model connected in onboarding (a Grok API key): the chat says so, then sets up the computer", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto("/?mock=1&fast=1");
  await page.getByTestId("onboarding-start").click();
  await page.getByTestId("connect-pick-grok").click();
  await page.getByTestId("grok-use-api-key").click();
  await page.getByTestId("grok-api-key-input").fill("xai-FAKE_e2e");
  await page.getByTestId("grok-api-key-save").click();
  await expect(page.getByTestId("connect-status")).toHaveAttribute("data-state", "connected");
  await page.getByTestId("connect-grok-done").click();
  await page.getByTestId("access-skip").click();
  await page.getByTestId("onboarding-finish").click();
  await expect(page.getByTestId("setup-greeting")).toContainText(
    "Looks like we have a model connected. Let's set up my computer.",
  );
});

test("a new user starts with one assistant: Work & Personal spaces stay off, even in the evening", async ({
  page,
}) => {
  // Saturday night: outside the default work hours, when Pip would otherwise lead the chat.
  await page.clock.install({ time: new Date("2026-10-17T21:00:00-04:00") });
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto("/?mock=1&fast=1&space=auto");
  expect((await mockSettings(page)).spacesOn).toBe(true);
  await page.getByTestId("onboarding-start").click();
  await connectClaude(page);
  await page.getByTestId("access-skip").click();
  await page.getByTestId("primary-name").fill("Jarvis");
  await page.getByTestId("onboarding-finish").click();
  // The assistant they just named, setting up its computer; no second agent, no space switch.
  await expect(page.getByTestId("agent-title")).toHaveText("Jarvis");
  await expect(page.getByTestId("setup-greeting")).toBeVisible();
  expect((await mockSettings(page)).spacesOn).toBe(false);
  await expect(page.getByTestId("space-intro")).toHaveCount(0);
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
  // Claude signs in on Yo's computer, which this Mac doesn't have yet: the setup chat first, then Claude.
  await page.getByTestId("claude-after-setup").click();
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  await expect(page.getByTestId("setup-greeting")).toContainText(CLAUDE_FIRST);
  expect((await mockSettings(page)).computerSetup).toBe("pending");
});

test("Settings → Computer sends a Mac that was never set up through the setup chat", async ({ page }) => {
  await firstChat(page);
  await page.getByTestId("setup-later").click();
  // The profile menu re-renders while account status settles, and Settings detaches mid-click.
  // This test is about Settings → Computer, so open Settings with ⌘, / Ctrl+, instead of the menu.
  await page.keyboard.press("ControlOrMeta+Comma");
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
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
