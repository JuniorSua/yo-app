import { expect, type Locator, type Page } from "@playwright/test";

/** Open the app against the mock backend. */
export async function openApp(page: Page, opts: { onboarded?: boolean; theme?: "dark" | "light" } = {}) {
  const { onboarded = true, theme } = opts;
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto(`/?mock=1&fast=1${onboarded ? "&onboarded=1" : ""}${theme ? `&theme=${theme}` : ""}`);
  if (onboarded) await expect(page.getByTestId("sidebar")).toBeVisible();
  else await expect(page.getByTestId("onboarding")).toBeVisible();
}

/** Open an agent's chat from the sidebar roster (the active space's main agent and every teammate). */
export async function openAgent(page: Page, name: string) {
  await page.getByTestId("roster").getByTestId(`agent-row-${name}`).click();
  await expect(page.getByTestId("agent-title")).toHaveText(name);
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

/** The sidebar's "New teammate" (+) button: opens the new-agent dialog. */
export async function newTeammate(page: Page) {
  await page.getByTestId("new-agent").click();
  await expect(page.getByTestId("new-agent-dialog")).toBeVisible();
}

/** The inspector beside the chat (open by default on a wide window; ⌘\ or the chat bar's button toggles it). */
export async function openInspector(page: Page) {
  const inspector = page.getByTestId("work-pane");
  if (!(await inspector.isVisible())) await page.getByTestId("toggle-workspace").click();
  await expect(inspector).toBeVisible();
  return inspector;
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
