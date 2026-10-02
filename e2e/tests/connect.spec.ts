/**
 * "Connect your model" walkthrough (onboarding and Settings → Accounts), against the mock backend.
 * `&mockConnect=` picks what's already signed in (see apps/web/src/lib/mock/connect.ts). Tokens are fake.
 */
import { expect, type Page, test } from "@playwright/test";
import { openApp, openSettings } from "./helpers";

const FAKE_TOKEN = `sk-ant-oat01-${"FAKE_e2e_token-".repeat(7)}`;

async function firstRun(page: Page, scenario?: "cli" | "computer" | "codexError") {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto(`/?mock=1&fast=1${scenario ? `&mockConnect=${scenario}` : ""}`);
  await page.getByTestId("onboarding-start").click();
  await expect(page.getByTestId("connect-model")).toBeVisible();
}

const status = (page: Page) => page.getByTestId("connect-status");
const finishCodexLogin = (page: Page) =>
  page.evaluate(() => (window as any).__yoMock.connect.finishCodexLogin());

/** Count calls of a mock API method (to prove polling stops). */
async function countCalls(page: Page, method: string) {
  await page.evaluate((m) => {
    const mock = (window as any).__yoMock;
    const orig = mock.handlers[m];
    (window as any).__calls = 0;
    mock.handlers[m] = (p: unknown) => {
      (window as any).__calls++;
      return orig(p);
    };
  }, method);
  return () => page.evaluate(() => (window as any).__calls as number);
}

test.describe("connect your model: onboarding", () => {
  test("nothing signed in: offers Claude (recommended) and ChatGPT, or skip", async ({ page }) => {
    await firstRun(page);
    await expect(page.getByTestId("connect-found-none")).toBeVisible();
    await expect(page.getByTestId("connect-pick-claude")).toContainText("Recommended");
    await expect(page.getByTestId("connect-pick-codex")).toBeVisible();
    await expect(page.getByTestId("connect-model")).not.toContainText("Grok");
    await expect(page.getByTestId("onboarding-next")).toHaveText(/Skip for now/);
    await page.getByTestId("onboarding-next").click();
    await expect(page.getByTestId("onboarding-access")).toBeVisible();
  });

  test("already connected on Yo's computer: use it and continue", async ({ page }) => {
    await firstRun(page, "computer");
    const found = page.getByTestId("found-claude-ready");
    await expect(found).toContainText("Claude is connected");
    await expect(found).toContainText("Max plan, signed in on Yo's computer.");
    await expect(page.getByTestId("onboarding-next")).toHaveText(/Continue/);
    await page.getByTestId("found-claude-ready-use").click();
    await expect(page.getByTestId("onboarding-access")).toBeVisible();
  });

  test("signed in on this Mac: offers to use it, and skips what's installed", async ({ page }) => {
    await firstRun(page, "cli");
    await expect(page.getByTestId("found-claude-host")).toContainText("Claude Code is signed in");
    await expect(page.getByTestId("found-codex-host")).toContainText("Codex is signed in");
    await page.getByTestId("found-codex-host-use").click();
    const codex = page.getByTestId("connect-steps-codex");
    // Codex is installed: step 1 is done, the dedicated sign-in is next.
    await expect(codex.locator("li").first()).toHaveAttribute("data-done", "true");
    await expect(page.getByTestId("cmd-codex-install")).toHaveCount(0);
    await expect(page.getByTestId("cmd-codex-login")).toContainText(
      "mkdir -p ~/.yo/codex && CODEX_HOME=~/.yo/codex codex login",
    );
    await page.getByTestId("connect-back").click();
    await page.getByTestId("found-claude-host-use").click();
    await expect(page.getByTestId("connect-steps-claude").locator("li").first()).toHaveAttribute(
      "data-done",
      "true",
    );
  });

  test("connect Claude by pasting the token from Terminal", async ({ page }) => {
    await firstRun(page);
    await page.getByTestId("connect-pick-claude").click();
    await expect(page.getByTestId("cmd-claude-install")).toContainText(
      "curl -fsSL https://claude.ai/install.sh | bash",
    );
    await expect(page.getByTestId("cmd-claude-token")).toContainText("claude setup-token");
    await page.getByTestId("cmd-claude-token-copy").click();
    await expect(page.getByTestId("cmd-claude-token-copy")).toHaveText("Copied");
    await expect(status(page)).toHaveAttribute("data-state", "idle");
    await expect(page.getByTestId("claude-token-submit")).toBeDisabled();

    const input = page.getByTestId("claude-token-input");
    await expect(input).toHaveAttribute("type", "password");
    // A sloppy paste of Terminal's whole output works.
    await input.fill(
      `Your OAuth token (valid for 1 year):\n\nexport CLAUDE_CODE_OAUTH_TOKEN="${FAKE_TOKEN}"`,
    );
    await page.getByTestId("claude-token-submit").click();
    await expect(status(page)).toHaveAttribute("data-state", "connected");
    await expect(status(page)).toContainText("Claude is connected");
    await expect(status(page)).toContainText("Yo checks it when its computer starts.");
    expect(await page.evaluate(() => (window as any).__yoMock.connect.savedClaudeToken)).toBe(FAKE_TOKEN);
    // The token is gone from the page once saved.
    await expect(page.getByTestId("claude-token-input")).toHaveCount(0);
    expect(await page.content()).not.toContain(FAKE_TOKEN);

    // The overview now shows it as connected.
    await page.getByTestId("connect-back").click();
    await expect(page.getByTestId("found-claude-ready")).toBeVisible();
    await page.getByTestId("connect-pick-claude").click();
    await page.getByTestId("connect-claude-done").click();
    // The computer is set up later, in the first agent's chat: next is Mac access.
    await expect(page.getByTestId("onboarding-access")).toBeVisible();
  });

  test("Claude errors say what to do next", async ({ page }) => {
    await firstRun(page);
    await page.getByTestId("connect-pick-claude").click();
    const input = page.getByTestId("claude-token-input");
    const submit = page.getByTestId("claude-token-submit");

    await input.fill("sk-ant-api03-FAKEapiKeyFAKE");
    await submit.click();
    await expect(status(page)).toHaveAttribute("data-state", "error");
    await expect(status(page)).toContainText("That's an Anthropic API key");
    await expect(status(page)).toContainText("claude setup-token");
    // Never echoes what was pasted.
    await expect(status(page)).not.toContainText("FAKEapiKey");

    // Typing again clears the error.
    await input.fill("sk-ant-oat01-FAKEcutoff");
    await expect(status(page)).toHaveAttribute("data-state", "idle");
    await submit.click();
    await expect(status(page)).toContainText("looks cut off");

    await input.fill("https://claude.ai/oauth/code?FAKE");
    await submit.click();
    await expect(status(page)).toContainText("code from the browser");

    // Core unreachable: still a next step, and the token stays for another try.
    await page.evaluate(() => {
      (window as any).__yoMock.handlers["connect.claudeToken"] = () => {
        throw new Error("socket closed");
      };
    });
    await input.fill(FAKE_TOKEN);
    await submit.click();
    await expect(status(page)).toContainText("Yo couldn't reach its core");
    await expect(input).toHaveValue(FAKE_TOKEN);
    await expect(page.getByText("Skip for now")).toBeVisible();
  });

  test("connect ChatGPT: Yo detects the sign-in by polling", async ({ page }) => {
    await firstRun(page);
    await page.getByTestId("connect-pick-codex").click();
    await expect(page.getByTestId("cmd-codex-install")).toContainText("npm install -g @openai/codex");
    await expect(page.getByTestId("cmd-codex-login")).toContainText("CODEX_HOME=~/.yo/codex codex login");
    await expect(status(page)).toHaveAttribute("data-state", "waiting");
    await expect(status(page)).toContainText("Waiting for you to sign in");
    // Still waiting after a few polls...
    await page.waitForTimeout(1600);
    await expect(status(page)).toHaveAttribute("data-state", "waiting");
    // ...then the user finishes `codex login` in Terminal.
    await finishCodexLogin(page);
    await expect(status(page)).toHaveAttribute("data-state", "connected");
    await expect(status(page)).toContainText("ChatGPT is connected");
    await page.getByTestId("connect-codex-done").click();
    await expect(page.getByTestId("onboarding-access")).toBeVisible();
  });

  test("an unusable ChatGPT sign-in says what to do, and Try again watches again", async ({ page }) => {
    await firstRun(page, "codexError");
    await page.getByTestId("connect-pick-codex").click();
    await finishCodexLogin(page);
    await expect(status(page)).toHaveAttribute("data-state", "error");
    await expect(status(page)).toContainText("Run the sign-in command again");
    await page.getByTestId("codex-retry").click();
    await expect(status(page)).toHaveAttribute("data-state", "waiting");
  });

  test("polling stops when you leave the step", async ({ page }) => {
    await firstRun(page);
    await page.getByTestId("connect-pick-codex").click();
    const calls = await countCalls(page, "connect.codexImport");
    await expect.poll(calls).toBeGreaterThan(0);
    await page.getByTestId("connect-back").click();
    await expect(page.getByTestId("connect-pick-codex")).toBeVisible();
    const after = await calls();
    await page.waitForTimeout(3500);
    expect(await calls()).toBe(after);
  });
});

test.describe("connect your model: Settings → Accounts", () => {
  test("open the walkthrough and go back", async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await page.getByTestId("open-connect").click();
    await expect(page.getByTestId("found-claude-ready")).toContainText("Claude is connected");
    await page.getByTestId("connect-close").click();
    await expect(page.getByTestId("account-claude")).toBeVisible();
  });

  test("an account's Connect button opens its steps; ChatGPT turns green", async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await page.getByTestId("connect-codex").click();
    await expect(page.getByTestId("connect-steps-codex")).toBeVisible();
    await expect(status(page)).toHaveAttribute("data-state", "waiting");
    await finishCodexLogin(page);
    await expect(status(page)).toHaveAttribute("data-state", "connected");
    // Yo's computer is running here, so it's checked right away.
    await expect(status(page)).toContainText("Plus plan, signed in on Yo's computer.");
    await page.getByTestId("connect-codex-done").click();
    await expect(page.getByTestId("account-codex")).toContainText("Plus · Connected");
  });

  test("ChatGPT fallback: sign in on Yo's computer with a code", async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await page.getByTestId("connect-codex").click();
    await page.getByTestId("codex-via-computer").click();
    await expect(page.getByTestId("device-code")).toHaveText("K7QX-2MFD");
    // The mock keeps the code on screen for 5 s before the sign-in completes.
    await expect(status(page)).toHaveAttribute("data-state", "connected", { timeout: 10_000 });
    await page.getByTestId("connect-codex-done").click();
    await expect(page.getByTestId("account-codex")).toContainText("Plus · Connected");
  });

  test("connect a second Claude account with its own token", async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await page.getByTestId("add-account-claude").click();
    const cards = page.getByTestId("account-claude");
    await expect(cards).toHaveCount(2);
    await cards.nth(1).getByTestId("connect-claude").click();
    await page.getByTestId("claude-token-input").fill(FAKE_TOKEN);
    await page.getByTestId("claude-token-submit").click();
    await expect(status(page)).toHaveAttribute("data-state", "connected");
    await page.getByTestId("connect-claude-done").click();
    await expect(cards.nth(1)).toContainText("Max · Connected");
    await expect(cards.nth(0)).toContainText("Default");
  });
});
