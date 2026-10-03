import { expect, type Page, test } from "@playwright/test";
import { openApp, openSettings, openWorkspacePage, send } from "./helpers";

/** "Report this bug" → investigation → red draft that waits for the user's OK. */
async function draftBug(page: Page) {
  await send(page, "Report this bug for me: the chat shows the old desk picture");
  const draft = page.getByTestId("bug-draft-card");
  await expect(draft).toBeVisible({ timeout: 20_000 });
  await expect(draft).toContainText("Bug report · Draft");
  await expect(draft).toContainText("waiting for your OK");
  await expect(draft).toContainText("Suspected cause");
  await expect(draft).toContainText("Suggested fix");
  await expect(page.getByTestId("timeline").getByText("Would you like me to report it?")).toBeVisible();
  // Answer once the turn is over (the mock treats a message sent mid-turn as steering, not a new turn).
  await expect(page.getByTestId("status-pill").first()).toHaveText(/Done|Idle/, { timeout: 20_000 });
  return draft;
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`bug report (${theme})`, () => {
    test.use({ colorScheme: theme });

    test(`draft, quick reply, filed card (${theme})`, async ({ page }) => {
      // Two full agent turns plus screenshots: give it room on a busy machine.
      test.slow();
      await openApp(page, { theme });
      const draft = await draftBug(page);
      await expect(draft).toHaveClass(/border-danger/);
      // The whole response is marked as a bug report, not regular chat.
      await expect(page.getByTestId("bug-turn-badge").first()).toBeVisible();
      await expect(page.locator("[data-bug-turn]").first()).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `e2e/screenshots/${theme}-17-bug-report-draft.png` });

      await page.getByTestId("bug-report-it").click();
      // The quick reply is sent as the user's own message.
      await expect(page.getByTestId("user-message").last()).toHaveText("Report it");
      const filed = page.getByTestId("bug-report-card");
      await expect(filed).toContainText(/Bug report · Filed as #\d+/, { timeout: 20_000 });
      await expect(page.getByTestId("bug-report-github")).toHaveAttribute(
        "href",
        /^https:\/\/github\.com\/JuniorSua\/yo-app\/issues\/\d+$/,
      );
      await expect(page.getByTestId("bug-report-download")).toBeVisible();
      // The draft is answered: no more buttons, and it says it was reported.
      await expect(page.getByTestId("bug-report-it")).toHaveCount(0);
      await expect(draft).toHaveAttribute("data-state", "sent");
      await expect(page.getByTestId("bug-turn-badge")).toHaveCount(2);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `e2e/screenshots/${theme}-18-bug-report-filed.png` });

      await openWorkspacePage(page, "artifacts");
      await expect(page.locator('[data-kind="bug"]').first()).toBeVisible();
    });
  });
}

test("Not now: nothing is filed", async ({ page }) => {
  test.slow();
  await openApp(page);
  await draftBug(page);
  await page.getByTestId("bug-not-now").click();
  await expect(page.getByTestId("timeline").getByText("Okay, I won't report it.")).toBeVisible();
  await expect(page.getByTestId("bug-report-card")).toHaveCount(0);
  await expect(page.getByTestId("bug-draft-card")).toHaveAttribute("data-state", "answered");
  await expect(page.getByTestId("bug-report-it")).toHaveCount(0);
});

test("without a GitHub token the report is saved with an Open on GitHub link", async ({ page }) => {
  test.slow();
  await openApp(page);
  await openSettings(page);
  await page.getByTestId("settings-bugs").click();
  const settings = page.getByTestId("bug-report-settings");
  await expect(settings).toContainText("Set up");
  await page.getByTestId("bug-token-clear").click();
  await expect(settings).toContainText("Not set up");
  // Write-only: the field never shows a saved token.
  await expect(page.getByTestId("bug-token-input")).toHaveValue("");
  // Reporting by hand, without the agent: GitHub's bug form on the same repo.
  await expect(page.getByTestId("bug-report-form")).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\/JuniorSua\/yo-app\/issues\/new\?template=bug_report\.yml/,
  );
  await page.keyboard.press("Escape");

  await draftBug(page);
  await page.getByTestId("bug-report-it").click();
  const card = page.getByTestId("bug-report-card");
  await expect(card).toContainText("Bug report · Saved", { timeout: 20_000 });
  const link = page.getByTestId("bug-report-github");
  await expect(link).toHaveText(/Open on GitHub/);
  await expect(link).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\/JuniorSua\/yo-app\/issues\/new\?title=/,
  );
});

test("malformed report_bug items never blank the app", async ({ page }) => {
  await openApp(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluate(() => {
    const m = (window as any).__yoMock;
    const agentId = m.s.agents.find((a: { isPrimary: boolean }) => a.isPrimary).id;
    const add = (item: Record<string, unknown>) =>
      m.upsert(
        m.entry(agentId, {
          id: `it_${Math.random()}`,
          kind: "tool",
          toolName: "mcp__yo__report_bug",
          ...item,
        }),
      );
    // A draft whose fields have the wrong types.
    add({
      status: "completed",
      input: {
        stage: "draft",
        title: { text: "x" },
        steps: "one\ntwo",
        what_happened: 42,
        severity: ["high"],
      },
      output: "Draft saved [bug-draft:bdr_bad1].",
    });
    // A submit with no input object and a non-text result.
    add({ status: "completed", input: "oops", output: { text: "not a string" } });
    // A stage that doesn't exist, null input.
    add({ status: "failed", input: null, output: 7 });
    // Left running by a turn that ended: no endless pulse.
    add({ status: "running", input: { stage: "submit", draft_id: { id: 1 } } });
  });
  await expect(page.getByTestId("sidebar")).toBeVisible();
  const draft = page.getByTestId("bug-draft-card").first();
  await expect(draft).toContainText("Bug report · Draft");
  await expect(draft).toContainText("42");
  await expect(page.getByTestId("bug-draft-card").nth(1)).toContainText("not saved");
  await expect(page.getByTestId("bug-report-card").first()).toBeVisible();
  await expect(page.getByTestId("bug-report-unfinished")).toContainText("didn't finish");
  await expect(page.getByTestId("bug-report-running")).toHaveCount(0);
  // The app still works afterwards.
  await send(page, "hello there");
  await expect(page.getByTestId("user-message").last()).toHaveText("hello there");
  expect(errors).toEqual([]);
});
