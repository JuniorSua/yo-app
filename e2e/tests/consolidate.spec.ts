/**
 * The memory page's life-map areas, and the retired "Yo is now one assistant with helpers" offer, against the mock
 * backend. `&mockConsolidate=1` gives core a team it would have offered to fold into Yo (apps/web/src/lib/mock/team.ts).
 */
import { expect, type Page, test } from "@playwright/test";
import { openWorkspacePage } from "./helpers";

async function open(page: Page, scenario?: "1" | "solo" | "fail") {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto(`/?mock=1&fast=1&onboarded=1${scenario ? `&mockConsolidate=${scenario}` : ""}`);
  await expect(page.getByTestId("sidebar")).toBeVisible();
}

const dialog = (page: Page) => page.getByTestId("consolidate-dialog");

test("memory page groups life-map memories by area", async ({ page }) => {
  await open(page);
  await openWorkspacePage(page, "memory");
  // Nothing tagged: no area headings, the page is as before.
  await expect(page.getByTestId("memory-list").locator("h2")).toHaveCount(0);
  await page.getByTestId("memory-input").fill("[area:work] Desk quotes go out by Friday");
  await page.getByTestId("memory-add").click();
  await expect(page.getByTestId("memory-area-work")).toBeVisible();
  await page.getByTestId("memory-input").fill("[area:personal] Gym on Tuesdays");
  await page.getByTestId("memory-add").click();
  const work = page.getByTestId("memory-area-work");
  await expect(work).toContainText("Desk quotes go out by Friday");
  // The tag is shown as the heading, not repeated in the row.
  await expect(work).not.toContainText("[area:");
  await expect(page.getByTestId("memory-area-personal")).toContainText("Gym on Tuesdays");
  await expect(page.getByTestId("memory-list")).toContainText("General");
  await expect(page.getByTestId("memory-list")).toContainText("Prefers window seats");
});

// Yo 2: teammates are first-class again, so the old "Yo is now one assistant" offer never shows.
test("never offers to fold teammates into Yo; they stay in the sidebar roster", async ({ page }) => {
  await open(page, "1");
  const roster = page.getByTestId("roster");
  await expect(roster.locator('[data-testid^="agent-row-"]').nth(1)).toBeVisible();
  const rows = await roster.locator('[data-testid^="agent-row-"]').count();
  await page.waitForTimeout(500);
  await expect(dialog(page)).toHaveCount(0);
  await expect(roster.locator('[data-testid^="agent-row-"]')).toHaveCount(rows);
});
