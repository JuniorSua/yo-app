/**
 * Yo in a plain browser (the PC edition): the sign-in screen, Settings → Browsers & apps, model sign-in pages that
 * open in this browser, and the PC edition's update notice. Mock flags: lib/mock/auth.ts.
 */
import { expect, type Page, test } from "@playwright/test";
import { MOCK_CODEX_CALLBACK, openSettings, signInClaude } from "./helpers";

const PC = "/?mock=1&fast=1&onboarded=1&mockEdition=pc";
const TOKEN = "test-one-time-sign-in-code";

async function openSignedOut(page: Page, extra = "") {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto(`${PC}&mockAuth=signed-out${extra}`);
  await expect(page.getByTestId("sign-in")).toBeVisible();
}

async function openBrowsers(page: Page) {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto(PC);
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await openSettings(page);
  await page.getByTestId("settings-browsers").click();
  await expect(page.getByTestId("browsers-settings")).toBeVisible();
}

test.describe("browser sign-in", () => {
  test("signed out: the PC edition's sign-in screen, then a link opens Yo", async ({ page }) => {
    await openSignedOut(page);
    const screen = page.getByTestId("sign-in");
    await expect(screen).toHaveAttribute("data-variant", "signed-out");
    await expect(page.getByTestId("sign-in-title")).toHaveText("Sign in to Yo");
    await expect(screen).toContainText("This browser isn't signed in to Yo yet");
    await expect(page.getByTestId("sign-in-pc")).toContainText("Open the Start menu and choose Yo");
    await expect(page.getByTestId("sign-in-command")).toContainText("yo-app signin");
    await expect(page.getByTestId("sign-in-command-copy")).toBeVisible();
    await expect(page.getByTestId("sign-in-other-browser")).toContainText(
      "Settings → Browsers & apps → Sign in another browser",
    );
    // Nothing of the app shows (and nothing loads) until signed in.
    await expect(page.getByTestId("sidebar")).toHaveCount(0);
    await expect(page.getByTestId("sign-in-submit")).toBeDisabled();

    await page.getByTestId("sign-in-link").fill(`http://localhost:7777/#signin=${TOKEN}`);
    await page.getByTestId("sign-in-submit").click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("sign-in")).toHaveCount(0);
  });

  test("a used or expired link, or something that isn't a link, says what to do", async ({ page }) => {
    await openSignedOut(page);
    await page.getByTestId("sign-in-link").fill("http://localhost:7777/#signin=expired");
    await page.getByTestId("sign-in-submit").click();
    await expect(page.getByTestId("sign-in-error")).toHaveText(
      "That link was already used or has expired. Make a new one.",
    );
    await page.getByTestId("sign-in-link").fill("hello");
    await expect(page.getByTestId("sign-in-error")).toHaveCount(0);
    await page.getByTestId("sign-in-submit").click();
    await expect(page.getByTestId("sign-in-error")).toContainText("doesn't look like a sign-in link");
    await expect(page.getByTestId("sidebar")).toHaveCount(0);
    // A bare token works too.
    await page.getByTestId("sign-in-link").fill(TOKEN);
    await page.getByTestId("sign-in-submit").click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
  });

  test("a browser without Ed25519 is asked to update", async ({ page }) => {
    await page.goto("/?mock=1&fast=1&onboarded=1&mockAuth=unsupported");
    const screen = page.getByTestId("sign-in");
    await expect(screen).toHaveAttribute("data-variant", "unsupported");
    await expect(page.getByTestId("sign-in-title")).toHaveText("Update your browser");
    await expect(page.getByTestId("sign-in-unsupported")).toContainText("Update Chrome, Edge or Firefox");
    await expect(page.getByTestId("sign-in-link")).toHaveCount(0);
  });

  test("Settings → Browsers & apps: this browser, a link with a QR code, rename and sign out", async ({
    page,
  }) => {
    await openBrowsers(page);
    const self = page.getByTestId("client-ctl_this");
    await expect(self.getByTestId("client-self")).toHaveText("This browser");
    // Named after this browser ("Chrome on Windows" with Playwright's Desktop Chrome).
    await expect(self.getByTestId("client-label")).toHaveText(/^Chrome on \w+/);
    await expect(page.getByTestId("client-ctl_laptop")).toContainText("Edge on Windows");
    await expect(page.getByTestId("client-ctl_laptop")).toContainText("Last used 2d ago");
    await expect(page.getByTestId("client-ctl_tablet")).toContainText("Not used yet");

    // Sign in another browser: a one-time link (no QR code: a phone can't open this PC's localhost).
    await page.getByTestId("signin-link-create").click();
    await expect(page.getByTestId("signin-link")).toHaveValue(
      /^http:\/\/localhost:\d+\/#signin=[0-9a-f]{64}$/,
    );
    await expect(page.getByTestId("signin-link-qr")).toHaveCount(0);
    await expect(page.getByTestId("signin-link-rules")).toHaveText("Works once, for 10 minutes.");
    // The other browser uses it: it shows up on its own.
    const link = await page.getByTestId("signin-link").inputValue();
    await page.evaluate((t) => (window as any).__yoMock.auth.useLink(t), link.split("#signin=")[1]);
    await expect(page.getByTestId("clients")).toContainText("Chrome on Android", { timeout: 8_000 });

    // Rename one (an empty name is refused with core's words).
    await page.getByTestId("client-rename-ctl_tablet").click();
    await page.getByTestId("client-rename-input").fill(" ");
    await page.getByTestId("client-rename-save").click();
    await expect(page.getByTestId("client-error")).toHaveText("The name can't be empty.");
    await page.getByTestId("client-rename-input").fill("Firefox at work");
    await page.getByTestId("client-rename-save").click();
    await expect(page.getByTestId("client-ctl_tablet").getByTestId("client-label")).toHaveText(
      "Firefox at work",
    );

    // Sign out another browser, after a confirmation.
    await page.getByTestId("client-signout-ctl_laptop").click();
    await expect(page.getByTestId("client-signout-confirm-row")).toContainText("Sign out Edge on Windows?");
    await page.getByTestId("client-signout-confirm").click();
    await expect(page.getByTestId("client-ctl_laptop")).toHaveCount(0);

    // Signing out this browser goes back to the sign-in screen; a new link signs it in again.
    await page.getByTestId("signin-link-new").click();
    await expect(page.getByTestId("signin-link")).not.toHaveValue(link);
    const fresh = await page.getByTestId("signin-link").inputValue();
    await page.getByTestId("client-signout-ctl_this").click();
    await expect(page.getByTestId("client-signout-confirm-row")).toContainText("Sign out this browser?");
    await page.getByTestId("client-signout-confirm").click();
    await expect(page.getByTestId("sign-in")).toBeVisible();
    await page.getByTestId("sign-in-link").fill(fresh);
    await page.getByTestId("sign-in-submit").click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    // The link worked once.
    await openSettings(page);
    await page.getByTestId("settings-browsers").click();
    await expect(page.getByTestId("client-ctl_this").getByTestId("client-self")).toHaveText("This browser");
  });

  test("the Mac app's mock: the list shows This app, without signing itself out", async ({ page }) => {
    await page.goto("/?mock=1&fast=1&onboarded=1");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await openSettings(page);
    await page.getByTestId("settings-browsers").click();
    const self = page.getByTestId("client-ctl_this");
    await expect(self.getByTestId("client-self")).toHaveText("This app");
    await expect(page.getByTestId("client-signout-ctl_this")).toHaveCount(0);
    await page.getByTestId("signin-link-create").click();
    await expect(page.getByTestId("signin-link")).toHaveValue(/#signin=[0-9a-f]{64}$/);
  });

  test("a model's sign-in page opens in this browser, not on Yo's computer", async ({ page, context }) => {
    await context.route("https://accounts.x.ai/**", (r) => r.fulfill({ body: "x.ai sign-in" }));
    await page.goto(PC);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await openSettings(page);
    await page.getByTestId("connect-grok").click();
    await page.getByTestId("grok-start").click();
    const open = page.getByTestId("grok-open-url");
    await expect(open).toHaveAttribute("href", /accounts\.x\.ai/);
    await expect(open).toHaveAttribute("target", "_blank");
    const popup = page.waitForEvent("popup");
    await open.click();
    expect((await popup).url()).toContain("accounts.x.ai");
    expect(await page.evaluate(() => (window as any).__yoLastExternal)).toBeUndefined();
  });

  test("PC edition on Windows: Claude signs in on Yo's computer, nothing to type in PowerShell", async ({
    page,
  }) => {
    // Playwright's Desktop Chrome reports Windows.
    await page.goto(PC);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await openSettings(page);
    await page.getByTestId("open-connect").click();
    await page.getByTestId("connect-pick-claude").click();
    // Claude is connected in the lived-in mock: show the steps again.
    await page.getByTestId("connect-again").click();
    const steps = page.getByTestId("connect-steps-claude");
    await expect(page.getByTestId("claude-signin-hint")).toContainText(
      "nothing to install or type in Terminal",
    );
    await expect(steps).not.toContainText(/PowerShell|setup-token|install\.ps1/);
    await signInClaude(page);
    await expect(page.getByTestId("connect-status")).toHaveAttribute("data-state", "connected");
  });

  test("PC edition: ChatGPT signs in on Yo's computer, the same as on the Mac", async ({ page }) => {
    await page.goto(PC);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await openSettings(page);
    await page.getByTestId("connect-codex").click();
    await expect(page.getByTestId("codex-signin-hint")).toContainText("nothing to install or type");
    await expect(page.getByTestId("connect-steps-codex")).not.toContainText(/CODEX_HOME|codex login/);
    // A browser blocks pop-ups: the sign-in page is a real link there.
    await page.getByTestId("codex-start").click();
    await expect(page.getByTestId("codex-open-url")).toHaveAttribute(
      "href",
      /auth\.openai\.com\/oauth\/authorize/,
    );
    await page.getByTestId("codex-address-input").fill(MOCK_CODEX_CALLBACK);
    await page.getByTestId("codex-address-submit").click();
    await expect(page.getByTestId("connect-status")).toHaveAttribute("data-state", "connected", {
      timeout: 10_000,
    });
  });

  test("PC edition wording: This PC, and a new release says to run yo-app update", async ({ page }) => {
    await page.goto(`${PC}&mockRelease=1`);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await openSettings(page);
    await page.getByTestId("settings-devices").click();
    await expect(page.getByTestId("where-yo-works")).toContainText("This PC");
    await page.getByTestId("settings-about").click();
    const release = page.getByTestId("release-update");
    await expect(release).toContainText("Yo 1.4.0 is available");
    await expect(release).toContainText("To update, run yo-app update on the PC running Yo.");
    await expect(page.getByTestId("release-command")).toContainText("yo-app update");
    await expect(page.getByTestId("release-notes")).toHaveAttribute("href", /github\.com/);
  });

  test("the Mac app's mock has no release notice", async ({ page }) => {
    await page.goto("/?mock=1&fast=1&onboarded=1&mockRelease=1");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await openSettings(page);
    await page.getByTestId("settings-about").click();
    await expect(page.getByTestId("settings-updates")).toBeVisible();
    await expect(page.getByTestId("release-update")).toHaveCount(0);
  });

  test("in a browser, Alt+N starts a new request and the palette shows it", async ({ page }) => {
    await page.goto(PC);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toContainText("Alt+N");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Alt+n");
    await expect(page.getByTestId("composer-input")).toBeFocused();
  });
});

test.describe("PC edition wording by platform", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  });

  test("on Linux: run yo-app signin in a terminal, no Start menu", async ({ page }) => {
    await openSignedOut(page);
    await expect(page.getByTestId("sign-in-pc")).toContainText("Run yo-app signin in a terminal");
    await expect(page.getByTestId("sign-in-pc")).not.toContainText("Start menu");
    await expect(page.getByText("Have a link?")).toBeVisible();
  });

  test("first run on the PC: no Mac sharing step, no Mac in the welcome", async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem("yo.ui"));
    await page.goto("/?mock=1&fast=1&mockEdition=pc");
    await expect(page.getByTestId("onboarding")).toContainText(
      "Your files stay private unless you share them.",
    );
    await page.getByTestId("onboarding-start").click();
    await expect(page.getByTestId("connect-model")).toBeVisible();
    await page.getByTestId("onboarding-next").click();
    await expect(page.getByTestId("meet-intro")).toBeVisible();
    await expect(page.getByTestId("onboarding-access")).toHaveCount(0);
  });
});
