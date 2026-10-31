/**
 * Yo's one-off helpers: their cards in Yo's chat, hidden from the roster,
 * and the watch / take over / stop controls, against the mock's two seeded helpers.
 */
import { expect, type Page, test } from "@playwright/test";
import { openApp } from "./helpers";

const GIFT = "agt_hlp_gift";
const TABLE = "agt_hlp_table";

const card = (page: Page, id: string) => page.locator(`[data-testid="helper-card"][data-helper="${id}"]`);

test.describe("helpers", () => {
  test("show as cards in Yo's chat, with their state and result", async ({ page }) => {
    await openApp(page);
    const gift = card(page, GIFT);
    const table = card(page, TABLE);
    await expect(gift).toHaveAttribute("data-state", "done");
    await expect(gift.getByTestId("helper-title")).toHaveText("Find a birthday gift for Maria under $50");
    await expect(gift.getByTestId("helper-status")).toContainText(/Done\s*· 2m 5\ds/);
    // A compact row: a long result folds behind "Show result".
    await expect(gift.getByTestId("helper-summary")).toHaveCount(0);
    await gift.getByTestId("helper-result-toggle").click();
    await expect(gift.getByTestId("helper-summary")).toContainText("Le Creuset mini cocotte");
    // A finished helper has nothing left to control.
    await expect(gift.getByTestId("helper-watch")).toHaveCount(0);
    await expect(gift.getByTestId("helper-stop")).toHaveCount(0);
    // Its avatar is a small Softie.
    await expect(gift.locator("[data-softie]")).toHaveCount(1);

    await expect(table).toHaveAttribute("data-state", "working");
    await expect(table.getByTestId("helper-status")).toContainText("Working");
    await expect(table.getByTestId("helper-status")).toContainText("Checking times at Joe's Stone Crab");
    await expect(table.getByTestId("helper-summary")).toHaveCount(0);
    // The elapsed time keeps counting while it works.
    const before = await table.getByTestId("helper-status").textContent();
    await expect.poll(() => table.getByTestId("helper-status").textContent()).not.toBe(before);
  });

  test("never appear in the sidebar or the command palette", async ({ page }) => {
    await openApp(page);
    await expect(card(page, TABLE)).toBeVisible();
    // The rail and Yo's presence header never list a helper.
    for (const area of [page.getByTestId("sidebar"), page.getByTestId("presence-header")]) {
      await expect(area).toBeVisible();
      await expect(area).not.toContainText("Book a table for 4 on Friday at 8 PM");
      await expect(area).not.toContainText("Find a birthday gift for Maria under $50");
    }
    // The team in the sidebar shows Yo, never its helpers.
    const roster = page.getByTestId("roster");
    await expect(roster.getByTestId("agent-row-Yo")).toBeVisible();
    await expect(roster).not.toContainText("Book a table");
    await expect(roster).not.toContainText("birthday gift");
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    await expect(palette).toContainText("Yo");
    await expect(palette).not.toContainText("Book a table");
  });

  test("watch the helper's screen, take over and hand back", async ({ page }) => {
    await openApp(page);
    const table = card(page, TABLE);
    await expect(table.getByTestId("helper-screen")).toHaveCount(0);
    await table.getByTestId("helper-watch").click();
    await expect(table.getByTestId("helper-screen").getByTestId("mock-desktop")).toBeVisible();
    await expect(table.getByTestId("helper-watch")).toHaveText("Hide screen");
    await table.getByTestId("helper-watch").click();
    await expect(table.getByTestId("helper-screen")).toHaveCount(0);

    await table.getByTestId("helper-takeover").click();
    await expect(table.getByTestId("helper-status")).toContainText("You have control");
    await expect(table.getByTestId("helper-takeover")).toHaveText("Hand back");
    // Taking over shows the screen.
    await expect(table.getByTestId("helper-screen")).toBeVisible();
    await table.getByTestId("helper-takeover").click();
    await expect(table.getByTestId("helper-status")).toContainText("Working");
    await expect(table.getByTestId("helper-takeover")).toHaveText("Take over");
  });

  test("show the helper's questions inline, and stop it", async ({ page }) => {
    await openApp(page);
    const table = card(page, TABLE);
    await expect(table).toBeVisible();
    await page.evaluate((helperId) => {
      const m = (window as any).__yoMock;
      m.upsert(
        m.entry(
          helperId,
          { id: "hl_req1", kind: "tool", status: "running", toolName: "ask_user", title: "A quick question" },
          {
            request: {
              requestId: "req_hl1",
              kind: "user_input",
              toolName: "ask_user",
              title: "A quick question",
              questions: [
                {
                  question: "8 PM is full. Is 8:30 PM OK?",
                  header: "Time",
                  options: [{ label: "8:30 PM" }, { label: "7 PM" }],
                  multiSelect: false,
                },
              ],
              status: "pending",
            },
          },
        ),
      );
    }, TABLE);
    await expect(table.getByTestId("helper-requests").getByTestId("ask-card")).toContainText("8 PM is full");

    await table.getByTestId("helper-stop").click();
    await expect(table).toHaveAttribute("data-state", "stopped");
    await expect(table.getByTestId("helper-status")).toContainText("Stopped");
    await expect(table.getByTestId("helper-summary")).toContainText("You stopped this helper");
    await expect(table.getByTestId("helper-stop")).toHaveCount(0);
    await expect(table.getByTestId("helper-requests")).toHaveCount(0);
    // The elapsed time stops.
    const after = await table.getByTestId("helper-status").textContent();
    await page.waitForTimeout(1500);
    await expect(table.getByTestId("helper-status")).toHaveText(after ?? "");
  });

  for (const theme of ["dark", "light"] as const) {
    test(`screenshot (${theme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, { theme });
      const table = card(page, TABLE);
      await table.getByTestId("helper-watch").click();
      await expect(table.getByTestId("helper-screen").getByTestId("mock-desktop")).toBeVisible();
      await table.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `e2e/screenshots/${theme}-22-helper-cards.png` });
    });
  }
});
