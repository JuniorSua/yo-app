/**
 * The morning brief (post_brief) and quick replies (suggest_replies). Saves light/dark screenshots, desktop and
 * phone, to /tmp/duet-shots/brief/ (outside the repo, so nothing regenerated gets committed).
 */
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { openSettings, send } from "./helpers";

const SHOTS = "/tmp/duet-shots/brief";
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, theme: string, name: string, settle = 600) => {
  await page.waitForTimeout(settle); // let entrance animations settle
  await page.screenshot({ path: `${SHOTS}/${theme}-${name}.png` });
};

async function open(page: Page, theme: "light" | "dark", brief: boolean) {
  await page.addInitScript(() => {
    localStorage.removeItem("yo.ui");
    localStorage.removeItem("yo.briefClaim");
  });
  await page.goto(`/?mock=1&fast=1&onboarded=1&theme=${theme}${brief ? "&mockBrief=1" : ""}`);
  await expect(page.getByTestId("sidebar")).toBeVisible();
}

for (const theme of ["light", "dark"] as const) {
  test(`the morning brief posts once when the chat opens, and Start hands a row to Yo (${theme})`, async ({
    page,
  }) => {
    await open(page, theme, true);
    const card = page.getByTestId("brief-card");
    await expect(card).toBeVisible();
    // A quiet line where the request sits: nobody typed it, so there's no bubble from the user.
    await expect(page.getByTestId("notice-row").filter({ hasText: "Morning brief" })).toBeVisible();
    await expect(page.getByTestId("user-message").filter({ hasText: "Nobody typed" })).toHaveCount(0);
    await expect(card).toContainText(/(Morning|Afternoon|Evening), \w+\./);
    const needs = card.getByTestId("brief-section-needs");
    await expect(needs.getByTestId("brief-start")).toHaveCount(2);
    await expect(card.getByTestId("brief-section-wait")).toContainText("3 newsletters");
    await expect(card.getByTestId("brief-section-today")).toContainText("Lunch with Priya");
    await expect(card.getByTestId("brief-could-not-check")).toContainText(
      "Couldn't check Slack: it isn't connected yet",
    );
    await expect(page.getByText("it lapses at 6 PM")).toBeVisible();
    await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shot(page, theme, "01-brief");

    // Only once: opening the chat again doesn't post a second one.
    const claims = await page.evaluate(() =>
      (window as any).__yoMock.call("brief.claim", { localDate: "x" }),
    );
    expect(claims).toEqual({ posted: false });

    // Start: "Take care of: <the row>" goes to Yo as the user's message, and the row says Started.
    await needs.getByTestId("brief-start").first().click();
    await expect(
      page
        .getByTestId("user-message")
        .filter({ hasText: "Take care of: Reply to Dana about the launch date" }),
    ).toBeVisible();
    await expect(needs.getByTestId("brief-started")).toHaveCount(1);
    await expect(needs.getByTestId("brief-start")).toHaveCount(1);
    await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shot(page, theme, "02-brief-started");
    // Saved per brief, so a reload of the same chat still says Started.
    const saved = await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith("yo.briefStarted.")),
    );
    expect(saved).toHaveLength(1);
  });

  test(`quick replies show under the question and a tap answers it (${theme})`, async ({ page }) => {
    await open(page, theme, false);
    await send(page, "Which one should I choose for dinner tonight?");
    const chips = page.getByTestId("reply-chips");
    await expect(chips).toBeVisible();
    await expect(chips.getByTestId("reply-chip")).toHaveText([
      "Book the 8 PM",
      "Show other times",
      "Not this week",
    ]);
    await expect(page.getByText("Want me to book it?")).toBeVisible();
    // Only the latest turn has them, and the step isn't listed as a tool call.
    await expect(chips).toHaveCount(1);
    await shot(page, theme, "03-chips");

    await chips.getByTestId("reply-chip").first().click();
    await expect(page.getByTestId("user-message").filter({ hasText: "Book the 8 PM" })).toBeVisible();
    const chosen = page.locator('[data-testid="reply-chip"][data-chosen]');
    await expect(chosen).toHaveText("Book the 8 PM");
    await expect(page.getByTestId("reply-chip").nth(1)).toBeDisabled();
    await shot(page, theme, "04-chip-chosen", 150);
    // Once Yo answers, the old chips are gone.
    await expect(page.getByTestId("reply-chips")).toHaveCount(0, { timeout: 15_000 });
  });

  test(`on a phone: the brief card and quick replies fit (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, theme, true);
    const card = page.getByTestId("brief-card");
    await expect(card).toBeVisible();
    await expect(page.getByText("it lapses at 6 PM")).toBeVisible();
    await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
    const box = (await card.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(390);
    // Start is a 44px target.
    const start = (await card.getByTestId("brief-start").first().boundingBox())!;
    expect(start.height).toBeGreaterThanOrEqual(44);
    await shot(page, theme, "05-phone-brief");

    await send(page, "Which one should I choose?");
    const chips = page.getByTestId("reply-chips");
    await expect(chips).toBeVisible();
    await expect(page.getByText("Want me to book it?")).toBeVisible();
    const chip = (await chips.getByTestId("reply-chip").first().boundingBox())!;
    expect(chip.height).toBeGreaterThanOrEqual(44);
    await page.getByText("Want me to book it?").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shot(page, theme, "06-phone-chips");
  });
}

test("the morning brief can be turned off in Settings → Notifications", async ({ page }) => {
  await open(page, "light", false);
  await openSettings(page);
  await page.getByTestId("settings-notifications").click();
  const toggle = page.getByTestId("setting-morning-brief");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Post a short brief the first time you open Yo each day.")).toBeVisible();
  await shot(page, "light", "07-setting");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => (window as any).__yoMock.s.settings.morningBrief)).toBe(false);
});

test("with the brief off, opening the chat doesn't ask for it", async ({ page }) => {
  await open(page, "dark", false);
  await openSettings(page);
  await page.getByTestId("settings-notifications").click();
  await page.getByTestId("setting-morning-brief").click();
  await expect(page.getByTestId("setting-morning-brief")).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  // A brief would be ready to post, and this browser hasn't asked today.
  await page.evaluate(() => {
    (window as any).__yoMock.briefPending = true;
    localStorage.removeItem("yo.briefClaim");
  });
  await page.getByTestId("rail-tasks").click();
  await page.getByTestId("rail-chat").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByTestId("brief-card")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__yoMock.briefPending)).toBe(true);
});
