import { expect, type Page, test } from "@playwright/test";
import { openWorkspacePage } from "./helpers";

/** Settings → Work & Personal and the Memory page's spaces, against the mock. */

async function open(page: Page, space: "work" | "auto" = "work") {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto(`/?mock=1&fast=1&onboarded=1&space=${space}`);
  await expect(page.getByTestId("sidebar")).toBeVisible();
}

async function openSpacesSettings(page: Page) {
  await page.getByTestId("profile-trigger").click();
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-spaces").click();
  await expect(page.getByTestId("spaces-settings")).toBeVisible();
}

const mockSettings = (page: Page) => page.evaluate(() => (window as any).__yoMock.s.settings);

test("work hours default to Mon–Fri 11–7, and editing a day saves it", async ({ page }) => {
  await open(page);
  await openSpacesSettings(page);
  for (const d of ["mon", "tue", "wed", "thu", "fri"]) {
    await expect(page.getByTestId(`day-on-${d}`)).toBeChecked();
    await expect(page.getByTestId(`day-start-${d}`)).toHaveValue("11:00");
    await expect(page.getByTestId(`day-end-${d}`)).toHaveValue("19:00");
  }
  for (const d of ["sat", "sun"]) await expect(page.getByTestId(`day-on-${d}`)).not.toBeChecked();
  const summary = page.getByTestId("work-hours-summary");
  await expect(summary).toContainText("Mon–Fri 11:00 AM–7:00 PM.");
  await expect(summary).toContainText("Anything outside these hours is Personal.");
  await expect(page.getByRole("radio", { name: "11 – 7" })).toHaveAttribute("aria-checked", "true");

  // Saturday on, finishing at 6 PM.
  await page.getByTestId("day-on-sat").click();
  await page.getByTestId("day-end-sat").fill("18:00");
  await expect(summary).toContainText("Mon–Fri 11:00 AM–7:00 PM; Sat 11:00 AM–6:00 PM.");
  await expect(page.getByRole("radio", { name: "Custom" })).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => (await mockSettings(page)).workHours[6])
    .toEqual({ on: true, start: "11:00", end: "18:00" });

  // Overnight hours get a note.
  await page.getByTestId("day-end-sat").fill("02:00");
  await expect(page.getByTestId("day-sat").getByTestId("day-hint")).toHaveText("Ends 2:00 AM the next day");

  // A preset sets every day's hours.
  await page.getByRole("radio", { name: "9 – 5" }).click();
  await expect(summary).toContainText("Mon–Sat 9:00 AM–5:00 PM.");
  await expect
    .poll(async () => (await mockSettings(page)).workHours[1])
    .toEqual({
      on: true,
      start: "09:00",
      end: "17:00",
    });
});

test("switching automatically: off holds the current space, on follows the hours", async ({ page }) => {
  await open(page, "auto");
  await openSpacesSettings(page);
  const auto = page.getByTestId("space-auto");
  await expect(auto).toBeChecked();
  await expect(page.getByTestId("space-now-text")).toContainText(/^(Work|Personal) · until /);
  const space = await page.getByTestId("space-now").getAttribute("data-space");
  await auto.click();
  await expect(auto).not.toBeChecked();
  await expect(page.getByTestId("space-now-text")).toHaveText(
    `${space === "work" ? "Work" : "Personal"} · stays on`,
  );
  await expect.poll(async () => (await mockSettings(page)).spaceManual).toEqual({ space, until: null });
  await auto.click();
  await expect.poll(async () => (await mockSettings(page)).spaceManual).toBeNull();
});

test("the agents and the time zone show, and spaces can be turned off", async ({ page }) => {
  await open(page);
  await openSpacesSettings(page);
  await expect(page.getByTestId("space-agent-work")).toContainText("Yo");
  await expect(page.getByTestId("space-agent-personal")).toContainText("Pip");
  await expect(page.getByTestId("space-agent-personal").getByTestId("space-agent-model")).toContainText(
    "Claude",
  );
  await page.getByTestId("space-agent-edit-personal").click();
  await expect(page.getByTestId("agent-settings-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-settings-dialog")).toHaveCount(0);
  await expect(page.getByTestId("spaces-settings")).toBeVisible();

  await expect(page.getByTestId("timezone")).toContainText("New York");

  await page.getByTestId("spaces-on").click();
  await expect(page.getByTestId("space-now")).toHaveCount(0);
  await expect(page.getByTestId("work-hours")).toHaveCount(0);
  await expect.poll(async () => (await mockSettings(page)).spacesOn).toBe(false);
});

test("memory: filter by space and move a memory to Work", async ({ page }) => {
  await open(page);
  await openWorkspacePage(page, "memory");
  const rows = page.getByTestId("memory-row");
  await expect(rows).toHaveCount(6);
  await expect(page.getByTestId("memory-everywhere-hint")).toContainText("Everywhere (3)");

  await page.getByRole("radio", { name: /^Personal/ }).click();
  await expect(rows).toHaveCount(2);
  for (const badge of await page.getByTestId("memory-space-badge").all())
    await expect(badge).toHaveAttribute("data-space", "personal");

  await page.getByRole("radio", { name: /^All/ }).click();
  const seats = rows.filter({ hasText: "Prefers window seats" });
  await expect(seats.getByTestId("memory-space-badge")).toHaveAttribute("data-space", "everywhere");
  await seats.getByTestId("memory-space-badge").click();
  await page.getByTestId("memory-move-work").click();
  await expect(seats.getByTestId("memory-space-badge")).toHaveAttribute("data-space", "work");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__yoMock.s.memories.find((m: any) => m.id === "mem_1").space),
    )
    .toBe("work");
  await page.getByRole("radio", { name: /^Work/ }).click();
  await expect(rows.filter({ hasText: "Prefers window seats" })).toHaveCount(1);
  await expect(page.getByTestId("memory-everywhere-hint")).toHaveCount(0);

  // New memories go to the space you're in (the mock holds Work).
  await expect(page.getByTestId("memory-add-space")).toContainText("Work");
  await page.getByTestId("memory-input").fill("Standup is at 11:15");
  await page.getByTestId("memory-add").click();
  await expect(rows.filter({ hasText: "Standup is at 11:15" })).toHaveCount(1);
});
