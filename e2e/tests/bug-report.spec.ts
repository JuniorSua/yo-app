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
  await expect(page.getByTestId("status-pill").first()).toHaveText(/Done|Ready/, { timeout: 20_000 });
  return draft;
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`bug report (${theme})`, () => {
    test.use({ colorScheme: theme });

    test(`draft, Report it, what's sent, Send (${theme})`, async ({ page }) => {
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

      // "Report it" opens the send form: the user sees what's sent and decides about the chat.
      await page.getByTestId("bug-report-it").click();
      const dialog = page.getByTestId("bug-report-dialog");
      await expect(dialog).toContainText("Send this bug report");
      await expect(dialog).toContainText("Chat shows an old image after overwrite");
      // The chat stays private unless the user opts in.
      await expect(page.getByTestId("bug-include-chat")).not.toBeChecked();
      await page.getByTestId("bug-preview-toggle").click();
      const files = page.getByTestId("bug-preview-file");
      await expect(files).toHaveCount(3);
      await expect(page.getByTestId("bug-preview")).not.toContainText("chat-excerpt.json");
      await expect(page.getByTestId("bug-preview-report")).toContainText("## Suggested fix");
      await page.getByTestId("bug-include-chat").check();
      await expect(files).toHaveCount(4);
      await expect(page.getByTestId("bug-preview")).toContainText("chat-excerpt.json");
      await page.getByTestId("bug-send").click();
      await expect(page.getByTestId("bug-sent-message")).toHaveText(
        /^Thanks! Sent as YO-[A-Z0-9]+\. The Yo team will look at it\.$/,
      );
      await page.getByTestId("bug-sent-close").click();
      await expect(dialog).toHaveCount(0);
      // Nothing was typed into the chat: the click was the OK.
      await expect(page.getByTestId("user-message").last()).not.toHaveText("Report it");
      // The draft is answered: no more buttons, and it says where it went.
      await expect(page.getByTestId("bug-report-it")).toHaveCount(0);
      await expect(draft).toHaveAttribute("data-state", "sent");
      await expect(page.getByTestId("bug-draft-result")).toContainText(/Sent as YO-[A-Z0-9]+/);
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

test("Settings → Report a problem: the in-app form, no GitHub account needed", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await page.getByTestId("settings-bugs").click();
  const settings = page.getByTestId("bug-report-settings");
  await expect(settings).toContainText("Bug inbox");
  // GitHub's form stays, as a small secondary link that says it's public.
  await expect(page.getByTestId("bug-report-form")).toContainText("(public)");
  await expect(page.getByTestId("bug-report-form")).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\/JuniorSua\/yo-app\/issues\/new\?template=bug_report\.yml/,
  );
  await page.getByTestId("bug-report-open").click();
  const dialog = page.getByTestId("bug-report-dialog");
  await expect(dialog).toContainText("Report a problem");
  await expect(page.getByTestId("bug-send")).toBeDisabled();
  await page.getByTestId("bug-what").fill("The reminder I asked for never showed up.");
  await page.getByTestId("bug-expected").fill("A reminder at 5 PM");
  await page.getByTestId("bug-steps").fill("1. Ask Yo for a reminder\n- Wait until 5 PM");
  await expect(page.getByTestId("bug-include-chat")).not.toBeChecked();
  await page.getByTestId("bug-include-chat").check();
  await page.getByTestId("bug-preview-toggle").click();
  await expect(page.getByTestId("bug-preview-file")).toHaveText([
    /report\.md/,
    /environment\.json/,
    /core-log\.txt/,
    /chat-excerpt\.json/,
  ]);
  const md = page.getByTestId("bug-preview-report");
  await expect(md).toContainText("# Bug: The reminder I asked for never showed up.");
  await expect(md).toContainText("1. Ask Yo for a reminder\n2. Wait until 5 PM");
  await expect(md).toContainText("Reported by the user");
  await page.getByTestId("bug-include-chat").uncheck();
  await expect(page.getByTestId("bug-preview-file")).toHaveCount(3);
  await page.getByTestId("bug-send").click();
  await expect(page.getByTestId("bug-sent")).toHaveAttribute("data-status", "sent");
  await expect(page.getByTestId("bug-sent-message")).toContainText(/Thanks! Sent as YO-[A-Z0-9]+/);
  const sent = await page.evaluate(() =>
    (window as any).__yoMock.s.artifacts.find((a: any) => a.kind === "bug" && a.report),
  );
  expect(sent.report).toMatchObject({ status: "sent", includeChat: false });
});

test("inbox down: the report is saved and Yo retries", async ({ page }) => {
  test.slow();
  await openApp(page);
  await page.evaluate(() => {
    (window as any).__yoMock.bugInboxDown = true;
  });
  await draftBug(page);
  await page.getByTestId("bug-report-it").click();
  await page.getByTestId("bug-send").click();
  await expect(page.getByTestId("bug-sent")).toHaveAttribute("data-status", "pending");
  await expect(page.getByTestId("bug-sent-message")).toContainText("keep trying for up to a day");
  await page.getByTestId("bug-sent-close").click();
  await expect(page.getByTestId("bug-draft-card")).toContainText("saved, will retry");
  await expect(page.getByTestId("bug-draft-result")).toHaveAttribute("data-status", "pending");
});

test("a typed yes: the agent sends it to the inbox", async ({ page }) => {
  test.slow();
  await openApp(page);
  await draftBug(page);
  await send(page, "Yes, report it");
  const card = page.getByTestId("bug-report-card");
  await expect(card).toContainText(/Bug report · Sent as YO-[A-Z0-9]+/, { timeout: 20_000 });
  await expect(card).toHaveAttribute("data-state", "sent");
  await expect(page.getByTestId("bug-report-download")).toBeVisible();
  await expect(page.getByTestId("bug-report-github")).toHaveCount(0);
});

test("with the owner's GitHub token, a typed yes files an issue", async ({ page }) => {
  test.slow();
  await openApp(page);
  await openSettings(page);
  await page.getByTestId("settings-bugs").click();
  await page.getByTestId("bug-token-input").fill("github_pat_example");
  await page.getByTestId("bug-token-save").click();
  const settings = page.getByTestId("bug-report-settings");
  await expect(settings).toContainText("GitHub");
  // Write-only: the field never shows a saved token.
  await expect(page.getByTestId("bug-token-input")).toHaveValue("");
  await page.keyboard.press("Escape");

  await draftBug(page);
  await send(page, "Report it");
  const card = page.getByTestId("bug-report-card");
  await expect(card).toContainText(/Bug report · Filed as #\d+/, { timeout: 20_000 });
  await expect(page.getByTestId("bug-report-github")).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\/JuniorSua\/yo-app\/issues\/\d+$/,
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
