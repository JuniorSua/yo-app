/**
 * No more Work & Personal spaces: every agent is a teammate in the Team popover, the window reopens the last chat,
 * nothing changes with the time of day, and the work hours live in Settings → Profile as context for every agent.
 * Against the mock; `&mockTeam=owner` adds Pepe (no memory focus) to Yo, Pip and the usual teammates. The e2e
 * browser runs in America/New_York, like the mock's settings.
 */
import { expect, type Page, test } from "@playwright/test";
import { openAgent, openSettings, openTeam, openWorkspacePage } from "./helpers";

/** Open the mock. The saved chat (yo.ui) is cleared on the first load only, so a reload keeps it. */
async function open(page: Page, opts: { at?: Date; query?: string } = {}) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("work-hours-e2e")) return;
    sessionStorage.setItem("work-hours-e2e", "1");
    localStorage.removeItem("yo.ui");
  });
  if (opts.at) await page.clock.install({ time: opts.at });
  await page.goto(`/?mock=1&fast=1&onboarded=1${opts.query ? `&${opts.query}` : ""}`);
  await expect(page.getByTestId("sidebar")).toBeVisible();
}

const title = (page: Page) => page.getByTestId("agent-title");
const mockSettings = (page: Page) => page.evaluate(() => (window as any).__yoMock.s.settings);
const palette = (page: Page) => page.getByTestId("command-palette");

test("no space switch anywhere: rail, Team popover, shortcut, palette, settings, shortcuts sheet", async ({
  page,
}) => {
  await open(page);
  await expect(title(page)).toHaveText("Yo");
  await expect(page.getByTestId("rail-space")).toHaveCount(0);
  await expect(page.getByTestId("space-intro")).toHaveCount(0);
  const roster = await openTeam(page);
  await expect(roster.locator(".shell-sidebar-title")).toHaveText("Team");
  await expect(roster.getByTestId("space-rail")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // ⌘⇧M does nothing now.
  await page.keyboard.press("ControlOrMeta+Shift+KeyM");
  await expect(title(page)).toHaveText("Yo");
  // The palette has no space actions; Pip is listed as a teammate.
  await page.keyboard.press("ControlOrMeta+k");
  await palette(page).getByRole("textbox").fill("personal");
  await expect(palette(page)).not.toContainText("Switch to Personal");
  await palette(page).getByRole("textbox").fill("work hours");
  await expect(palette(page)).not.toContainText("Follow my work hours");
  await expect(palette(page)).toContainText("Your work hours");
  await palette(page).getByRole("textbox").fill("pip");
  await expect(palette(page)).toContainText("Teammates");
  await page.keyboard.press("Escape");
  // Settings: Profile instead of Work & Personal.
  await openSettings(page);
  await expect(page.getByTestId("settings-spaces")).toHaveCount(0);
  await expect(page.getByTestId("settings-dialog")).not.toContainText("Work & Personal");
  await expect(page.getByTestId("settings-profile")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("shortcuts-dialog")).toBeVisible();
  await expect(page.getByTestId("shortcuts-dialog")).not.toContainText("Personal");
});

test("nothing changes at the end of work hours: no switch, no toast", async ({ page }) => {
  // Tue Oct 13 2026, 30 seconds before the default work hours end (7 PM).
  await open(page, { at: new Date("2026-10-13T18:59:30-04:00") });
  const spaceToast = page.locator("[data-sonner-toast]").filter({ hasText: /Personal|Pip/ });
  await expect(title(page)).toHaveText("Yo");
  await page.clock.runFor(61_000);
  await expect(title(page)).toHaveText("Yo");
  await expect(spaceToast).toHaveCount(0);
  await page.getByTestId("rail-tasks").click();
  await page.clock.runFor(61_000);
  await expect(spaceToast).toHaveCount(0);
  await expect(page.getByTestId("rail-tasks")).toHaveAttribute("aria-current", "page");
});

test("Pip and Pepe are teammates in the Team popover, Yo first; Pip can be archived like anyone", async ({
  page,
}) => {
  await open(page, { query: "mockTeam=owner" });
  const roster = await openTeam(page);
  const rows = roster.locator('[data-testid^="agent-row-"]');
  await expect(rows.first()).toHaveAttribute("data-testid", "agent-row-Yo");
  await expect(rows.first().getByLabel("Main agent")).toBeVisible();
  await expect(roster.getByTestId("agent-row-Pip")).toBeVisible();
  await expect(roster.getByTestId("agent-row-Pepe")).toBeVisible();
  await expect(roster.getByTestId("agent-row-Pip").getByLabel("Main agent")).toHaveCount(0);
  await roster.getByTestId("agent-row-Pip").hover();
  await roster.getByRole("button", { name: "Pip options", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Archive" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Each opens its own chat.
  await openAgent(page, "Pepe");
  await openAgent(page, "Pip");
  await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", "Message Pip…");
});

test("the app reopens the last agent the user had open, else Yo", async ({ page }) => {
  await open(page, { query: "mockTeam=owner" });
  await expect(title(page)).toHaveText("Yo");
  await openAgent(page, "Pip");
  await page.reload();
  await expect(title(page)).toHaveText("Pip");
  await openAgent(page, "Pepe");
  await page.reload();
  await expect(title(page)).toHaveText("Pepe");
  // The saved chat's agent is gone (archived or deleted elsewhere): back to Yo.
  await page.evaluate(() => localStorage.setItem("yo.ui", JSON.stringify({ agentId: "agt_gone" })));
  await page.reload();
  await expect(title(page)).toHaveText("Yo");
});

test("Settings → Profile: your work hours, per day, and the time zone", async ({ page }) => {
  await open(page);
  await openSettings(page);
  await page.getByTestId("settings-profile").click();
  const profile = page.getByTestId("profile-settings");
  await expect(profile).toBeVisible();
  await expect(profile.getByRole("textbox", { name: "Your name" })).toHaveValue("Sam");
  const hours = profile.getByTestId("work-hours");
  await expect(hours).toContainText("Your work hours");
  await expect(hours).toContainText("Every agent knows your hours");
  // None until the user sets them (no agent is told hours the user never gave); 11–7 is filled in for when a day
  // is turned on.
  const summary = page.getByTestId("work-hours-summary");
  await expect(summary).toHaveText("No work hours");
  for (const d of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
    await expect(page.getByTestId(`day-on-${d}`)).not.toBeChecked();
    await expect(page.getByTestId(`day-${d}`)).toContainText("Off");
  }
  for (const d of ["mon", "tue", "wed", "thu", "fri"]) {
    await page.getByTestId(`day-on-${d}`).click();
    await expect(page.getByTestId(`day-on-${d}`)).toBeChecked();
    await expect(page.getByTestId(`day-start-${d}`)).toHaveValue("11:00");
    await expect(page.getByTestId(`day-end-${d}`)).toHaveValue("19:00");
  }
  await expect(summary).toHaveText("Mon–Fri 11:00 AM–7:00 PM");

  // Saturday on, finishing at 6 PM.
  await page.getByTestId("day-on-sat").click();
  await page.getByTestId("day-end-sat").fill("18:00");
  await expect(summary).toHaveText("Mon–Fri 11:00 AM–7:00 PM; Sat 11:00 AM–6:00 PM");
  await expect
    .poll(async () => (await mockSettings(page)).workHours[6])
    .toEqual({ on: true, start: "11:00", end: "18:00" });
  // Overnight hours get a note.
  await page.getByTestId("day-end-sat").fill("02:00");
  await expect(page.getByTestId("day-sat").getByTestId("day-hint")).toHaveText("Ends 2:00 AM the next day");
  // Sunday too, all seven days the same: "Every day".
  await page.getByTestId("day-end-sat").fill("19:00");
  await page.getByTestId("day-on-sun").click();
  await expect(summary).toHaveText("Every day 11:00 AM–7:00 PM");

  // The time zone sits with them.
  await expect(profile.getByTestId("timezone")).toBeVisible();
  const settings = await mockSettings(page);
  expect(settings.timezone).toBe("America/New_York");
  expect(settings).not.toHaveProperty("spacesOn");
  expect(settings).not.toHaveProperty("spaceManual");
  // Appearance no longer has the name, nor a warm Personal look.
  await page.getByTestId("settings-appearance").click();
  await expect(page.getByTestId("settings-dialog")).not.toContainText("Your name");
  await expect(page.getByTestId("settings-dialog")).not.toContainText("Personal");
});

test("the palette's Your work hours opens Settings → Profile", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+k");
  await palette(page).getByRole("textbox").fill("work hours");
  await palette(page).getByText("Your work hours").click();
  await expect(page.getByTestId("profile-settings")).toBeVisible();
});

test("memory labels: filter by label and label a memory Work; who sees it is spelled out", async ({
  page,
}) => {
  await open(page, { query: "mockTeam=owner" });
  await openWorkspacePage(page, "memory");
  const rows = page.getByTestId("memory-row");
  await expect(rows).toHaveCount(6);
  await expect(page.getByTestId("memory-everywhere-hint")).toContainText(
    "A memory's label decides who sees it",
  );
  await expect(page.getByTestId("memory-everywhere-hint")).toContainText("3 labelled Everywhere");
  await expect(page.getByTestId("memory-everywhere-hint")).toContainText("facts every agent sees");

  // Labels are a quiet filter in the toolbar, not a switch that reads like a mode.
  await expect(page.getByRole("radio")).toHaveCount(0);
  const filter = page.getByTestId("memory-label-filter");
  await expect(filter).toHaveText("All labels");
  await filter.click();
  await expect(page.getByTestId("memory-label-filter-menu")).toContainText("Show memories labelled");
  await expect(page.getByTestId("memory-filter-personal")).toContainText("Pip");
  await page.getByTestId("memory-filter-personal").click();
  await expect(filter).toHaveText("Personal");
  await expect(rows).toHaveCount(2);
  for (const badge of await page.getByTestId("memory-label-badge").all())
    await expect(badge).toHaveAttribute("data-label", "personal");

  await filter.click();
  await page.getByTestId("memory-filter-all").click();
  const seats = rows.filter({ hasText: "Prefers window seats" });
  await expect(seats.getByTestId("memory-label-badge")).toHaveAttribute("data-label", "everywhere");
  await seats.getByTestId("memory-label-badge").click();
  const menu = page.getByTestId("memory-move-menu");
  await expect(menu).toContainText("Label as…");
  await expect(page.getByTestId("memory-move-everywhere")).toContainText("Every agent sees it");
  // Pip's focus is Personal: a Work memory is shown to everyone else.
  await expect(page.getByTestId("memory-move-work")).not.toContainText("Pip");
  await expect(page.getByTestId("memory-move-personal")).toContainText("Pip");
  await page.getByTestId("memory-move-work").click();
  await expect(seats.getByTestId("memory-label-badge")).toHaveAttribute("data-label", "work");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__yoMock.s.memories.find((m: any) => m.id === "mem_1").space),
    )
    .toBe("work");

  // A new memory is Everywhere unless labelled.
  await expect(page.getByTestId("memory-add-label")).toContainText("Everywhere");
  await page.getByTestId("memory-input").fill("Standup is at 11:15");
  await page.getByTestId("memory-add").click();
  await expect(
    rows.filter({ hasText: "Standup is at 11:15" }).getByTestId("memory-label-badge"),
  ).toHaveAttribute("data-label", "everywhere");
});

test("phone width: no space button, and the Team opens from the chat with Pip in it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(page.getByTestId("rail-space")).toHaveCount(0);
  await page.getByTestId("chat-team").click();
  await expect(page.getByTestId("roster")).toBeVisible();
  await expect(page.getByTestId("roster").getByTestId("agent-row-Pip")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
