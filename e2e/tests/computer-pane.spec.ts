import { expect, test } from "@playwright/test";
import { openAgent, openProfile, openWorkspace } from "./helpers";

test("the profile popover: who the agent is, its computer, what it's doing, what's scheduled and what it made", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto("/?mock=1&fast=1&onboarded=1&theme=light&mockBusy=queue");
  await expect(page.getByTestId("composer-input")).toBeVisible();
  const inspector = await openProfile(page);
  await expect(inspector.getByRole("heading", { name: "Yo" })).toBeVisible();
  // Bring your own subscription: what it runs on, and whose plan that is.
  await expect(inspector.getByTestId("inspector-model")).toContainText("Claude");
  await expect(inspector.getByTestId("inspector-model")).toContainText("Uses your Claude subscription");
  await expect(inspector.getByTestId("computer-status")).toHaveText(/Ready|Busy/);
  // Activity: helpers at work and the messages waiting their turn; Scheduled: Yo's routines.
  const activity = inspector.getByTestId("pane-pending");
  await expect(activity.getByTestId("pane-helper").first()).toBeVisible();
  await expect(inspector.getByTestId("pane-routine").first()).toBeVisible();
  // A routine opens the Routines page (and closes the popover).
  await inspector.getByTestId("pane-routine").first().click();
  await expect(inspector).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /routines/i }).first()).toBeVisible();
  // Back in a chat, a teammate's profile shows what needs you from it.
  await openAgent(page, "Pico");
  await expect(page.getByTestId("profile-popover")).toHaveCount(0);
  await expect(page.getByTestId("presence-avatar")).toBeVisible();
  await expect((await openProfile(page)).getByTestId("pane-approval")).toHaveCount(1);
});

test("⌘\\ and the chat bar's button hide and show the workspace, and it stays the way you left it", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("workspace-e2e")) localStorage.removeItem("yo.ui");
    sessionStorage.setItem("workspace-e2e", "1");
  });
  await page.goto("/?mock=1&fast=1&onboarded=1");
  const workspace = page.getByTestId("workspace");
  const toggle = page.getByTestId("toggle-workspace");
  await expect(workspace).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(workspace).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(workspace).toHaveCount(0);
  await toggle.click();
  await expect(workspace).toBeVisible();
  // The computer tab's Watch button opens the computer full screen.
  await openWorkspace(page);
  await workspace.getByTestId("ws-watch").click();
  await expect(page.getByTestId("computer-overlay")).toBeVisible();
});
