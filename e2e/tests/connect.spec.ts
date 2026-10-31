/**
 * "Connect your model" walkthrough (onboarding and Settings → Accounts), against the mock backend.
 * `&mockConnect=` picks what's already signed in (see apps/web/src/lib/mock/connect.ts). Logins are fake.
 */
import { expect, type Page, test } from "@playwright/test";
import { MOCK_CODEX_CALLBACK, openApp, openSettings, signInChatGPT, signInClaude } from "./helpers";

async function firstRun(page: Page, scenario?: "cli" | "computer", extra = "") {
  await page.addInitScript(() => {
    localStorage.removeItem("yo.ui");
    // The tests are about a Mac user, whatever machine runs them.
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
  await page.goto(`/?mock=1&fast=1${scenario ? `&mockConnect=${scenario}` : ""}${extra}`);
  await page.getByTestId("onboarding-start").click();
  await expect(page.getByTestId("connect-model")).toBeVisible();
}

const status = (page: Page) => page.getByTestId("connect-status");
test.describe("connect your model: onboarding", () => {
  test("nothing signed in: offers Claude (recommended), ChatGPT and Grok, or skip", async ({ page }) => {
    await firstRun(page);
    await expect(page.getByTestId("connect-found-none")).toBeVisible();
    await expect(page.getByTestId("connect-pick-claude")).toContainText("Recommended");
    await expect(page.getByTestId("connect-pick-codex")).toBeVisible();
    await expect(page.getByTestId("connect-pick-grok")).toBeVisible();
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
    // Codex on this Mac doesn't sign Yo in either: ChatGPT signs in on Yo's computer, set up next.
    await expect(page.getByTestId("codex-after-setup")).toBeVisible();
    await expect(page.getByTestId("connect-steps-codex")).not.toContainText(
      /CODEX_HOME|codex login|Terminal/,
    );
    await page.getByTestId("connect-back").click();
    // Claude Code on this Mac doesn't sign Yo in: Claude signs in on Yo's computer, set up next.
    await page.getByTestId("found-claude-host-use").click();
    await expect(page.getByTestId("claude-after-setup")).toBeVisible();
  });

  test("Claude on a fresh Mac: no Terminal, no token; it signs in right after the computer setup", async ({
    page,
  }) => {
    await firstRun(page);
    await page.getByTestId("connect-pick-claude").click();
    const steps = page.getByTestId("connect-steps-claude");
    await expect(steps).toContainText(
      "Uses your Claude Pro or Max plan. You sign in on Claude's own page, so Yo never sees your password. Your sign-in stays inside Yo's computer.",
    );
    await expect(steps).not.toContainText(/setup-token|sk-ant|Terminal/);
    await expect(page.getByTestId("claude-code-input")).toHaveCount(0);
    await expect(status(page)).toContainText("Claude connects right after Yo's computer is set up.");
    await page.getByTestId("claude-after-setup").click();
    // The computer is set up later, in the first agent's chat: next is Mac access.
    await expect(page.getByTestId("onboarding-access")).toBeVisible();
  });

  test("connect Claude on Yo's computer: Claude's own page, then the code it shows", async ({ page }) => {
    // Yo's computer is already running (Claude was signed in on it): sign in again.
    await firstRun(page, "computer");
    await page.getByTestId("connect-pick-claude").click();
    await expect(status(page)).toHaveAttribute("data-state", "connected");
    await page.getByTestId("connect-again").click();
    await expect(page.getByTestId("claude-signin-hint")).toContainText(
      "nothing to install or type in Terminal",
    );
    await expect(page.getByTestId("claude-not-api-key")).toHaveText(
      "This is not an API key. It uses your Claude Pro or Max subscription, with no API charges.",
    );
    // Nothing to paste until Claude's link is there.
    await expect(page.getByTestId("claude-code-input")).toBeDisabled();
    await page.getByTestId("claude-start").click();
    await expect(page.getByTestId("claude-login-url")).toContainText(
      "https://claude.com/cai/oauth/authorize",
    );
    await expect(page.getByTestId("claude-open-url")).toBeVisible();
    await expect(status(page)).toContainText("Waiting for the code from Claude's page");
    await page.getByTestId("claude-code-input").fill("FAKEcode_e2e#mockstate");
    await page.getByTestId("claude-code-submit").click();
    await expect(status(page)).toHaveAttribute("data-state", "connected");
    await expect(status(page)).toContainText("Claude is connected");
    await expect(status(page)).toContainText("Max plan, signed in on Yo's computer.");
    // Nothing on the page is a Claude token.
    expect(await page.content()).not.toMatch(/sk-ant-o/);
    await page.getByTestId("connect-claude-done").click();
    await expect(page.getByTestId("onboarding-access")).toBeVisible();
  });

  test("Claude errors say what to do next", async ({ page }) => {
    await firstRun(page, "computer");
    await page.getByTestId("connect-pick-claude").click();
    await page.getByTestId("connect-again").click();
    await page.getByTestId("claude-start").click();
    await expect(page.getByTestId("claude-login-url")).toBeVisible();

    // A code Claude turns down: plain words, and Try again gets a fresh link.
    await page.getByTestId("claude-code-input").fill("wrong");
    await page.getByTestId("claude-code-submit").click();
    await expect(status(page)).toHaveAttribute("data-state", "error");
    await expect(status(page)).toContainText("Claude didn't accept that code");
    await expect(status(page)).not.toContainText(/\/login|setup-token/);
    await expect(page.getByTestId("claude-start")).toHaveText(/Try again/);
    await page.getByTestId("claude-start").click();
    await expect(page.getByTestId("claude-login-url")).toBeVisible();
    await expect(status(page)).toHaveAttribute("data-state", "waiting");

    // Core unreachable: still a next step.
    await page.evaluate(() => {
      (window as any).__yoMock.handlers["account.login.start"] = () => {
        throw new Error("socket closed");
      };
    });
    await page.getByTestId("connect-back").click();
    // The sign-in started above is still waiting on Yo's computer: the steps show straight away.
    await page.getByTestId("connect-pick-claude").click();
    await page.getByTestId("claude-start").click();
    await expect(status(page)).toContainText("Yo couldn't reach its core");
  });

  test("Yo on someone else's Home PC: Claude signs in on Yo's computer there, no Terminal anywhere", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.removeItem("yo.ui");
      Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    });
    await page.goto("/?mock=1&fast=1&mockHost=pc&mockConnect=cli");
    await page.getByTestId("onboarding-start").click();
    await expect(page.getByTestId("connect-model")).toBeVisible();
    await page.getByTestId("found-claude-host-use").click();
    const hint = page.getByTestId("claude-signin-hint");
    await expect(hint).toContainText("Yo runs Claude Code in a private workspace on ProDesktop");
    await expect(hint).toContainText("on this computer or your phone");
    await expect(page.getByTestId("connect-steps-claude")).not.toContainText(/setup-token|sk-ant/);
    await signInClaude(page);
    await expect(status(page)).toHaveAttribute("data-state", "connected");
  });

  test("ChatGPT on a fresh Mac: no Terminal; it signs in right after the computer setup", async ({
    page,
  }) => {
    await firstRun(page);
    await page.getByTestId("connect-pick-codex").click();
    const steps = page.getByTestId("connect-steps-codex");
    await expect(steps).toContainText(
      "You sign in on ChatGPT's own page; Yo never sees your password. Your sign-in stays inside Yo's computer.",
    );
    await expect(steps).not.toContainText(/Terminal|CODEX_HOME|codex login|install\.sh|npm|brew/);
    await expect(page.getByTestId("codex-address-input")).toHaveCount(0);
    await expect(status(page)).toContainText("ChatGPT connects right after Yo's computer is set up.");
    await page.getByTestId("codex-after-setup").click();
    await expect(page.getByTestId("onboarding-access")).toBeVisible();
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem("yo.ui") ?? "{}").signInAfterSetup),
    ).toBe("codex");
  });

  test("connect ChatGPT on Yo's computer: ChatGPT's page, then the address the browser lands on", async ({
    page,
  }) => {
    await firstRun(page, "computer");
    await page.getByTestId("connect-pick-codex").click();
    await expect(page.getByTestId("codex-signin-hint")).toContainText(
      "nothing to install or type in Terminal",
    );
    // Nothing to paste until ChatGPT's link is there.
    await expect(page.getByTestId("codex-address-input")).toBeDisabled();
    await page.getByTestId("codex-start").click();
    await expect(page.getByTestId("codex-login-url")).toContainText(
      "https://auth.openai.com/oauth/authorize",
    );
    await expect(page.getByTestId("codex-open-url")).toBeVisible();
    await expect(page.getByTestId("codex-callback-origin")).toHaveText("http://127.0.0.1:1455");
    await expect(status(page)).toContainText("Waiting for the address from your browser");

    // Not the address, cut short, or from another sign-in: a plain sentence, and the sign-in keeps waiting.
    const input = page.getByTestId("codex-address-input");
    const submit = page.getByTestId("codex-address-submit");
    const err = page.getByTestId("codex-address-error");
    await input.fill("https://chatgpt.com/");
    await submit.click();
    await expect(err).toContainText("That's the sign-in link itself");
    await input.fill("http://127.0.0.1:1455/auth/callback?code=x");
    await submit.click();
    await expect(err).toContainText("cut short");
    await input.fill(MOCK_CODEX_CALLBACK.replace("mockcodexstate", "older"));
    await submit.click();
    await expect(err).toContainText("from an earlier sign-in");
    await expect(status(page)).toHaveAttribute("data-state", "waiting");

    // The real one (with what copying adds around it).
    await input.fill(`  ${MOCK_CODEX_CALLBACK}\n`);
    await submit.click();
    await expect(status(page)).toHaveAttribute("data-state", "connected");
    await expect(status(page)).toContainText("ChatGPT is connected");
    await expect(status(page)).toContainText("Plus plan, signed in on Yo's computer.");
    await page.getByTestId("connect-codex-done").click();
    await expect(page.getByTestId("onboarding-access")).toBeVisible();
  });

  test("ChatGPT with a one-time code: turn on code sign-in first, and again if ChatGPT says it's off", async ({
    page,
  }) => {
    await firstRun(page, "computer", "&mockCodexCode=off");
    await page.getByTestId("connect-pick-codex").click();
    await page.getByTestId("codex-use-code").click();
    const security = page.getByTestId("codex-open-security");
    await expect(page.getByTestId("codex-code-step-1")).toContainText(
      "“Enable device code authorization for Codex”",
    );
    await expect(security).toBeVisible();
    await page.getByTestId("codex-code-start").click();
    await expect(page.getByTestId("codex-login-code")).toContainText("K7QX-2MFD");
    await expect(page.getByTestId("codex-login-url")).toContainText("https://auth.openai.com/codex/device");
    await expect(page.getByTestId("codex-code-off-help")).toContainText("code sign-in is turned off");
    // ChatGPT never confirms the code (the setting is off): the steps say so plainly, step 1 first.
    await expect(status(page)).toHaveAttribute("data-state", "error", { timeout: 10_000 });
    await expect(status(page)).toContainText("turn it on in ChatGPT's security settings first");
    await expect(page.getByTestId("codex-code-step-1")).toBeVisible();
    await expect(page.getByTestId("codex-code-start")).toHaveText(/Get a new code/);
    // Back to the sign-in page way, which needs no setting.
    await page.getByTestId("codex-use-page").click();
    await signInChatGPT(page);
    await expect(status(page)).toHaveAttribute("data-state", "connected");
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
    await expect(page.getByTestId("connect-steps-codex")).not.toContainText(/CODEX_HOME|codex login/);
    await expect(status(page)).toHaveAttribute("data-state", "idle");
    await signInChatGPT(page);
    await expect(status(page)).toHaveAttribute("data-state", "connected");
    // Yo's computer is running here, so it's checked right away.
    await expect(status(page)).toContainText("Plus plan, signed in on Yo's computer.");
    await page.getByTestId("connect-codex-done").click();
    await expect(page.getByTestId("account-codex")).toContainText("Plus · Connected");
  });

  test("ChatGPT with a one-time code from Settings", async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await page.getByTestId("connect-codex").click();
    await page.getByTestId("codex-use-code").click();
    await page.getByTestId("codex-code-start").click();
    await expect(page.getByTestId("codex-login-code")).toContainText("K7QX-2MFD");
    // The mock keeps the code on screen for 5 s before the sign-in completes.
    await expect(status(page)).toHaveAttribute("data-state", "connected", { timeout: 10_000 });
    await page.getByTestId("connect-codex-done").click();
    await expect(page.getByTestId("account-codex")).toContainText("Plus · Connected");
  });

  test("connect a second Claude account with its own Claude sign-in", async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await page.getByTestId("add-account-claude").click();
    const cards = page.getByTestId("account-claude");
    await expect(cards).toHaveCount(2);
    await cards.nth(1).getByTestId("connect-claude").click();
    await signInClaude(page);
    await expect(status(page)).toHaveAttribute("data-state", "connected");
    await page.getByTestId("connect-claude-done").click();
    await expect(cards.nth(1)).toContainText("Max · Connected");
    await expect(cards.nth(0)).toContainText("Default");
  });

  test("a Claude account on an old saved token: a calm one-time notice, then Claude keeps its own sign-in", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.removeItem("yo.ui"));
    await page.goto("/?mock=1&fast=1&onboarded=1&mockSignIn=legacy");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await openSettings(page);
    const card = page.getByTestId("account-claude");
    // It still works meanwhile.
    await expect(card).toContainText("Max · Connected");
    await expect(page.getByTestId("signin-notice-claude")).toHaveText(
      "Claude sign-in changed. Sign in again once so Claude keeps its own sign-in (Yo will forget the old token).Sign in",
    );
    await page.getByTestId("signin-again-claude").click();
    await expect(page.getByTestId("claude-signin-changed")).toBeVisible();
    await signInClaude(page);
    await expect(status(page)).toHaveAttribute("data-state", "connected");
    await page.getByTestId("connect-claude-done").click();
    await expect(card).toContainText("Max · Connected");
    await expect(page.getByTestId("signin-notice-claude")).toHaveCount(0);
  });
});
