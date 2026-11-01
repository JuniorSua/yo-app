import { expect, type Locator, type Page } from "@playwright/test";

/** Open the app against the mock backend. */
export async function openApp(
  page: Page,
  opts: { onboarded?: boolean; theme?: "dark" | "light"; query?: string } = {},
) {
  const { onboarded = true, theme, query } = opts;
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto(
    `/?mock=1&fast=1${onboarded ? "&onboarded=1" : ""}${theme ? `&theme=${theme}` : ""}${query ? `&${query.replace(/^&/, "")}` : ""}`,
  );
  if (onboarded) await expect(page.getByTestId("sidebar")).toBeVisible();
  else await expect(page.getByTestId("onboarding")).toBeVisible();
}

/**
 * Open the Team popover: every one of Yo's specialists (View and Edit each), the new-specialist button and "Ask Yo
 * to add a specialist". From the rail's Team icon on a wide window, else the faces by Yo's head.
 */
export async function openTeam(page: Page) {
  const roster = page.getByTestId("roster");
  if (!(await roster.isVisible())) {
    const rail = page.getByTestId("rail-team");
    await ((await rail.isVisible()) ? rail : page.getByTestId("chat-team")).click();
  }
  await expect(roster).toBeVisible();
  return roster;
}

/** Back to Yo's chat (home): the rail's Chat. */
export async function openYo(page: Page) {
  await page.getByTestId("rail-chat").click();
  await expect(page.getByTestId("agent-title")).toHaveText("Yo");
}

/**
 * Yo's chat ("Yo"), or a specialist's read-only view from the Team popover's View: its work and its exchanges with
 * Yo, with Ask Yo in place of a message box.
 */
export async function openAgent(page: Page, name: string) {
  if (name === "Yo") return openYo(page);
  const roster = await openTeam(page);
  await roster.getByTestId(`agent-row-${name}`).getByTestId("agent-view").click();
  await expect(page.getByTestId("agent-title")).toHaveText(name);
  await expect(page.getByTestId("roster")).toHaveCount(0);
  await expect(page.getByTestId("specialist-bar")).toBeVisible();
}

export async function send(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-input").press("Enter");
}

/** The global pages are also in the profile (workspace) menu at the foot of the rail. */
export async function openWorkspacePage(
  page: Page,
  name: "tasks" | "activity" | "approvals" | "routines" | "memory" | "artifacts",
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

/** The Team popover's "New specialist" (+) button: opens the new-agent dialog. */
export async function newTeammate(page: Page) {
  await openTeam(page);
  await page.getByTestId("new-agent").click();
  await expect(page.getByTestId("new-agent-dialog")).toBeVisible();
}

/** The agent's profile popover (click its big head): the model, computer, work, schedule and Options. */
export async function openProfile(page: Page) {
  const profile = page.getByTestId("profile-popover");
  if (!(await profile.isVisible())) await page.getByTestId("presence-avatar").click();
  await expect(profile).toBeVisible();
  return profile;
}

/** The workspace beside the chat (open by default on a wide window; ⌘\ or the chat's button toggles it). */
export async function openWorkspace(page: Page) {
  const workspace = page.getByTestId("workspace");
  if (!(await workspace.isVisible())) await page.getByTestId("toggle-workspace").click();
  await expect(workspace).toBeVisible();
  return workspace;
}

/**
 * Claude's own sign-in on Yo's computer (mock): start it, Claude's link shows, paste the code Claude's page shows.
 * Yo never sees a Claude token: nothing here is one.
 */
export async function signInClaude(scope: Page | Locator) {
  await scope.getByTestId("claude-start").click();
  await expect(scope.getByTestId("claude-login-url")).toContainText("https://claude.com/cai/oauth/authorize");
  await scope.getByTestId("claude-code-input").fill("FAKEcode_e2e#mockstate");
  await scope.getByTestId("claude-code-submit").click();
}

/** The address ChatGPT's page sends the browser to in the mock (what the person pastes back). */
export const MOCK_CODEX_CALLBACK =
  "http://127.0.0.1:1455/auth/callback?code=mock_code&scope=openid&state=mockcodexstate";

/**
 * ChatGPT's own sign-in on Yo's computer (mock): start it, ChatGPT's link shows, paste the address the browser lands
 * on. Nothing here is a ChatGPT token.
 */
export async function signInChatGPT(scope: Page | Locator) {
  await scope.getByTestId("codex-start").click();
  await expect(scope.getByTestId("codex-login-url")).toContainText("https://auth.openai.com/oauth/authorize");
  await scope.getByTestId("codex-address-input").fill(MOCK_CODEX_CALLBACK);
  await scope.getByTestId("codex-address-submit").click();
}

/**
 * First run on a fresh Mac: choose Claude. Its computer isn't set up yet, so Claude signs in right after the setup
 * chat; onboarding goes on.
 */
export async function chooseClaudeFirstRun(page: Page) {
  await page.getByTestId("connect-pick-claude").click();
  await page.getByTestId("claude-after-setup").click();
}
