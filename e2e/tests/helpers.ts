import { expect, type Page } from "@playwright/test";

/** Open the app against the mock backend. */
export async function openApp(page: Page, opts: { onboarded?: boolean; theme?: "dark" | "light" } = {}) {
  const { onboarded = true, theme } = opts;
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto(`/?mock=1&fast=1${onboarded ? "&onboarded=1" : ""}${theme ? `&theme=${theme}` : ""}`);
  if (onboarded) await expect(page.getByTestId("sidebar")).toBeVisible();
  else await expect(page.getByTestId("onboarding")).toBeVisible();
}

export async function openAgent(page: Page, name: string) {
  await page.getByTestId(`agent-row-${name}`).click();
  await expect(page.getByTestId("agent-title")).toHaveText(name);
}

export async function send(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-input").press("Enter");
}

/** The five global pages live in the bottom-left profile/workspace menu. */
export async function openWorkspacePage(
  page: Page,
  name: "activity" | "approvals" | "routines" | "memory" | "artifacts",
) {
  await page.getByTestId("profile-trigger").click();
  await page.getByTestId(`nav-${name}`).click();
  await expect(page.getByTestId("profile-menu")).toHaveCount(0);
}

export async function openSettings(page: Page) {
  await page.getByTestId("profile-trigger").click();
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
}
