import { expect, type Page, test } from "@playwright/test";
import { openSettings, openWorkspacePage, send } from "./helpers";

/** Open the app with a 1Password scenario (`&mockOnePassword=…`, see apps/web/src/lib/mock/onepassword.ts). */
async function openWith(page: Page, scenario?: "connected" | "error") {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto(`/?mock=1&fast=1&onboarded=1${scenario ? `&mockOnePassword=${scenario}` : ""}`);
  await expect(page.getByTestId("sidebar")).toBeVisible();
}

test("Settings → Accounts connects, tests and disconnects 1Password", async ({ page }) => {
  await openWith(page);
  await openSettings(page);
  const card = page.getByTestId("onepassword-card");
  await expect(page.getByTestId("settings-passwords")).toContainText("Yo never sees the passwords.");
  await expect(card).toContainText("Off");
  await expect(page.getByTestId("onepassword-status")).toHaveText("Not connected.");

  // Plain steps for making a service account limited to one vault.
  await page.getByTestId("onepassword-connect").click();
  const setup = page.getByTestId("onepassword-setup");
  await expect(setup).toContainText("make a vault just for Yo");
  await expect(setup).toContainText("Give it read access to the Yo vault only.");
  await expect(page.getByTestId("onepassword-open")).toHaveAttribute(
    "href",
    "https://my.1password.com/developer-tools/infrastructure-secrets/serviceaccount/",
  );
  const token = page.getByTestId("onepassword-token");
  await expect(token).toHaveAttribute("type", "password");
  await expect(page.getByTestId("onepassword-save")).toBeDisabled();

  // Wrong kind of token, then a revoked one: plain words, nothing saved.
  await token.fill("hunter2-not-a-token");
  await page.getByTestId("onepassword-save").click();
  await expect(page.getByTestId("onepassword-error")).toContainText("It starts with ops_");
  await token.fill("ops_bad_FAKE_token_for_the_mock");
  await page.getByTestId("onepassword-save").click();
  await expect(page.getByTestId("onepassword-error")).toContainText("1Password turned the token down.");
  await expect(page.getByTestId("onepassword-status")).toHaveText("Not connected.");

  await token.fill("ops_FAKE_token_for_the_mock_0123");
  await page.getByTestId("onepassword-save").click();
  await expect(page.getByTestId("onepassword-status")).toContainText("1 vault: Yo · checked");
  await expect(card).toContainText("Connected");
  // The token isn't shown anywhere once saved.
  await expect(page.getByTestId("onepassword-token")).toHaveCount(0);
  await expect(page.getByTestId("settings-dialog")).not.toContainText("ops_FAKE");

  await page.getByTestId("onepassword-test").click();
  await expect(page.getByText("1Password works")).toBeVisible();

  await page.getByTestId("onepassword-how-toggle").click();
  await expect(page.getByTestId("onepassword-how")).toContainText("never see a password, username or code");

  await page.getByTestId("onepassword-disconnect").click();
  await page.getByTestId("onepassword-disconnect-confirm").click();
  await expect(page.getByTestId("onepassword-status")).toHaveText("Not connected.");
});

test("a revoked token says what to do", async ({ page }) => {
  await openWith(page, "error");
  await openSettings(page);
  await expect(page.getByTestId("onepassword-card")).toContainText("Needs attention");
  await expect(page.getByTestId("onepassword-status")).toContainText("Make a new service account token");
  await page.getByTestId("onepassword-new-token").click();
  await expect(page.getByTestId("onepassword-setup")).toBeVisible();
});

test("Yo signs in with 1Password after the user's OK, and never shows the login", async ({ page }) => {
  await openWith(page, "connected");
  await send(page, "Sign in to github and check my notifications");
  const card = page.getByTestId("approval-card").last();
  await expect(card).toContainText("Sign in to github.com with 1Password?");
  await expect(card).toContainText('from your 1Password login "GitHub"');
  await expect(card).toContainText("Yo never sees them.");
  await card.getByTestId("approve-always").click();
  await expect(page.getByText("I'm signed in to github.com.")).toBeVisible();

  // The sign-in is in Settings, and "Always allow" is a rule for that one site.
  await openSettings(page);
  await expect(page.getByTestId("onepassword-recent")).toContainText("Yo used GitHub on github.com");
  await page.keyboard.press("Escape");
  await openWorkspacePage(page, "approvals");
  await expect(page.getByText("1Password sign-ins on github.com")).toBeVisible();
});

test("without 1Password, Yo asks the user to sign in instead", async ({ page }) => {
  await openWith(page);
  await send(page, "Log in to github");
  await expect(page.getByText("1Password isn't connected")).toBeVisible();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
});
