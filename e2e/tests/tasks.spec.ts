/**
 * Tasks: the page (Active | Up next), checking tasks off, Yo's suggestions (Hide / Start) on the page and above
 * the message box, and the + dialog. Saves light/dark screenshots (desktop and phone) to /tmp/duet-shots/tasks/
 * (outside the repo, so nothing regenerated gets committed).
 */
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { openApp, send } from "./helpers";

const SHOTS = "/tmp/duet-shots/tasks";
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(600); // let entrance animations settle
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

async function openTasks(page: Page) {
  await page.getByTestId("rail-tasks").click();
  await expect(page.getByTestId("tasks-page")).toBeVisible();
}

const group = (page: Page, id: string) => page.getByTestId(`task-group-${id}`);

test("Active groups what needs you, and a checked-off task moves to Resolved", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => localStorage.removeItem("yo.tasksView"));
  await openTasks(page);
  await expect(page.getByTestId("tasks-view-active")).toHaveAttribute("aria-selected", "true");

  // In order: Ready for review, Needs input, Working, Yo's own To do, then Resolved (folded).
  const ids = await page
    .locator('section[data-testid^="task-group-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(ids).toEqual([
    "task-group-review",
    "task-group-waiting",
    "task-group-in_progress",
    "task-group-todo",
    "task-group-done",
  ]);
  await expect(group(page, "todo")).toContainText("To do1");
  await expect(group(page, "todo").getByTestId("task-row")).toContainText(
    "Follow up on the bike repair quoteTo do · The shop said they'd call back today.",
  );
  await expect(group(page, "review").getByTestId("task-row")).toHaveCount(2);
  await expect(group(page, "review")).toContainText("Ready for review2");
  await expect(group(page, "waiting")).toContainText("Needs input · Tuesday 9:30 or Thursday 2:00?");
  await expect(group(page, "in_progress").locator('[data-glyph="working"]')).toBeVisible();
  await expect(group(page, "done").getByTestId("task-row")).toHaveCount(0);

  // Check one off: the check lands, then it moves under Resolved.
  const row = group(page, "review").getByTestId("task-row").filter({ hasText: "MacBook Air" });
  await row.getByTestId("task-check").click();
  await expect(group(page, "review").getByTestId("task-row")).toHaveCount(1);
  await expect(group(page, "done")).toContainText("Resolved2");
  await group(page, "done").getByTestId("task-group-toggle").click();
  await expect(group(page, "done").getByTestId("task-row")).toHaveCount(2);
  await expect(group(page, "done")).toContainText("Compare the M4 MacBook Air deals");

  // A row opens Yo's chat.
  await group(page, "waiting").getByTestId("task-row").getByText("Book the dentist").click();
  await expect(page.getByTestId("composer")).toBeVisible();
});

test("Up next: Hide and Start a suggestion, Start a saved task; the view is remembered", async ({ page }) => {
  await openApp(page);
  await openTasks(page);
  await page.getByTestId("tasks-view-upnext").click();
  const cards = page.getByTestId("suggestion-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Yo could take this on");
  await expect(cards.first()).toContainText("Watch the price of the Sony WH-1000XM5");

  await cards.first().getByTestId("suggestion-hide").click();
  await expect(cards).toHaveCount(1);
  await cards.first().getByTestId("suggestion-start").click();
  await expect(page.getByTestId("suggestion-started")).toHaveText("Started. Yo is on it.");
  await expect(cards).toHaveCount(0);

  // The task the user saved starts too (Yo's own to-do isn't here); then Up next is empty.
  await expect(page.getByTestId("saved-task")).toHaveCount(1);
  await expect(page.getByTestId("tasks-page")).not.toContainText("bike repair");
  await page.getByTestId("saved-task").getByTestId("saved-start").click();
  await expect(page.getByTestId("tasks-empty")).toHaveText("Nothing new right now. I'll keep checking.");

  await page.getByTestId("tasks-view-active").click();
  await expect(group(page, "in_progress")).toContainText("Send Sam the notes from Tuesday's call");
  // Starting posts what the user saw (the title) into Yo's chat as their message; Yo's plan is the task's note.
  await expect(group(page, "in_progress")).toContainText(
    "Working · Draft a short email to Sam with the notes from Tuesday's call.",
  );
  await page.getByTestId("rail-chat").click();
  const userMessages = page.getByTestId("user-message");
  await expect(userMessages.filter({ hasText: "Send Sam the notes from Tuesday's call" })).toBeVisible();
  await expect(userMessages.filter({ hasText: "Draft a short email to Sam" })).toHaveCount(0);

  // The last view comes back next time.
  await page.getByTestId("rail-tasks").click();
  await page.getByTestId("tasks-view-upnext").click();
  await page.reload();
  await openTasks(page);
  await expect(page.getByTestId("tasks-view-upnext")).toHaveAttribute("aria-selected", "true");
});

test("+ saves a task for Up next, or starts it now", async ({ page }) => {
  await openApp(page);
  await openTasks(page);
  await page.getByTestId("fab").click();
  const dialog = page.getByTestId("new-task-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("new-task-save")).toBeDisabled();
  await page.getByTestId("new-task-title").fill("Look up train times to Porto");
  await page.getByTestId("new-task-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("tasks-view-upnext")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("saved-task").first()).toContainText("Look up train times to Porto");

  await page.getByTestId("fab").click();
  await page.getByTestId("new-task-title").fill("Compare phone plans");
  await page.getByTestId("new-task-start").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("tasks-view-active")).toHaveAttribute("aria-selected", "true");
  await expect(group(page, "in_progress")).toContainText("Compare phone plans");
});

test("the newest suggestion shows above the message box with Hide and Start", async ({ page }) => {
  await openApp(page);
  const card = page.getByTestId("task-suggestion");
  await expect(card).toContainText("Yo could take this on");
  await expect(card).toContainText("Watch the price of the Sony WH-1000XM5");
  await card.getByTestId("suggestion-hide").click();
  await expect(card).toContainText("Send Sam the notes from Tuesday's call");

  // Asked for ideas, Yo suggests something (suggest_task): it's the newest, so it shows.
  await send(page, "Anything you'd suggest I hand off?");
  await expect(card).toContainText("Check the gym membership renewal");
  await expect(card).toContainText("It renews on the 1st at the old price unless you cancel.");
  await card.getByTestId("suggestion-start").click();
  await expect(page.getByTestId("suggestion-started")).toHaveText("Started. Yo is on it.");
  await expect(
    page.getByTestId("user-message").filter({ hasText: "Check the gym membership renewal" }),
  ).toBeVisible();
  await expect(page.getByTestId("user-message").filter({ hasText: "Check when my gym" })).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  for (const [size, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    test(`screenshots: Tasks and suggestions (${theme}, ${size})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openApp(page, { theme });
      const n = size === "desktop" ? 0 : 4;
      const name = (i: number, what: string) => `${theme}-${String(n + i).padStart(2, "0")}-${what}-${size}`;
      await expect(page.getByTestId("task-suggestion")).toBeVisible();
      await shot(page, name(1, "chat-suggestion"));

      await page.evaluate(() => localStorage.removeItem("yo.tasksView"));
      await openTasks(page);
      await expect(group(page, "review")).toBeVisible();
      await shot(page, name(2, "tasks-active"));
      await page.getByTestId("tasks-view-upnext").click();
      await expect(page.getByTestId("suggestion-card").first()).toBeVisible();
      await shot(page, name(3, "tasks-upnext"));
      await page.getByTestId("fab").click();
      await page.getByTestId("new-task-title").fill("Find a quiet cafe near the office");
      await shot(page, name(4, "new-task"));
    });
  }
}
