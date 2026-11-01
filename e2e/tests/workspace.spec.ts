import { expect, type Page, test } from "@playwright/test";
import { openAgent, openApp, openProfile, openTeam, openWorkspace } from "./helpers";

test("⌘N brings you to Yo's message box without creating an assistant or losing its draft/history", async ({
  page,
}) => {
  await openApp(page);
  await page.getByTestId("composer-input").fill("A draft worth keeping");
  const before = await page.evaluate(() => {
    const m = (window as any).__yoMock;
    return { count: m.s.agents.length, messages: m.s.timelines.agt_yo.length };
  });
  await openAgent(page, "Dew");
  await page.getByTestId("composer-input").blur();
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByTestId("agent-title")).toHaveText("Yo");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(page.getByTestId("composer-input")).toHaveValue("A draft worth keeping");
  expect(
    await page.evaluate(() => {
      const m = (window as any).__yoMock;
      return { count: m.s.agents.length, messages: m.s.timelines.agt_yo.length };
    }),
  ).toEqual(before);
});

test("Search opens messages, routines, memories, and files at their source", async ({ page }) => {
  await openApp(page);
  const memory = await page.evaluate(
    async () =>
      await (window as any).__yoMock.call("memory.add", { content: "Needle weekend memory", agentId: null }),
  );
  for (const [query, kind] of [
    ["MacBook", "Messages"],
    ["price watch", "Routines"],
    ["Needle weekend", "Memory"],
    ["price comparison", "Files"],
  ]) {
    await page.getByTestId("rail-search").click();
    const palette = page.getByTestId("command-palette");
    await palette.getByRole("textbox").fill(query!);
    const result = palette
      .getByRole("button")
      .filter({
        hasText:
          kind === "Messages"
            ? "Find me the best deal"
            : kind === "Routines"
              ? "MacBook price watch"
              : kind === "Memory"
                ? "Needle weekend"
                : "MacBook price comparison",
      })
      .first();
    await result.click();
    await expect(palette).toHaveCount(0);
    if (kind === "Messages")
      await expect(page.locator(".workspace-highlight")).toContainText("Find me the best deal");
    else
      await expect(
        page.locator(kind === "Memory" ? `[data-record-id="${memory.id}"]` : ".workspace-highlight"),
      ).toBeVisible();
  }
});

test("The Team popover is the team: the main agent first, every teammate (Pip too) with a live line, never a helper", async ({
  page,
}) => {
  await openApp(page);
  const { names, helpers } = await page.evaluate(() => {
    const agents = (window as any).__yoMock.s.agents;
    return {
      names: agents.filter((a: any) => a.kind !== "helper" && !a.archivedAt).map((a: any) => a.name),
      helpers: agents.filter((a: any) => a.kind === "helper").map((a: any) => a.name),
    };
  });
  const roster = await openTeam(page);
  const rows = roster.locator('[data-testid^="agent-row-"]');
  await expect(rows).toHaveCount(names.length);
  await expect(rows.first()).toHaveAttribute("data-testid", "agent-row-Yo");
  await expect(rows.first().getByLabel("Main agent")).toBeVisible();
  for (const name of names) await expect(roster.getByTestId(`agent-row-${name}`)).toBeVisible();
  // Each row says what the agent is doing now, in a few plain words.
  await expect(roster.getByTestId("agent-row-Pico").getByTestId("agent-state")).toHaveText("Waiting for you");
  await page.evaluate(() =>
    (window as any).__yoMock.patchAgent("agt_research", {
      activity: "working",
      todos: [{ text: "Compare three venues", status: "in_progress" }],
    }),
  );
  await expect(roster.getByTestId("agent-row-Dew").getByTestId("agent-state")).toHaveText(
    "Working on compare three venues",
  );
  // Yo's one-off helpers are not agents of their own: never listed here (or in the rail).
  expect(helpers.length).toBeGreaterThan(0);
  for (const name of helpers) await expect(page.getByTestId(`agent-row-${name}`)).toHaveCount(0);
  for (const name of helpers) await expect(page.getByTestId("sidebar")).not.toContainText(name);
  for (const name of helpers) await expect(roster).not.toContainText(name);
  // The faces are the navigation: a row opens that agent's chat, and stays marked as open.
  await openAgent(page, "Pico");
  await expect(roster).toHaveCount(0);
  await openTeam(page);
  await expect(roster.getByTestId("agent-row-Pico")).toHaveAttribute("aria-current", "page");
  // Its quiet "messages with Dew" row: the full exchange is behind a click (team-chat.spec).
  await expect(page.getByTestId("team-exchange").first()).toContainText("Dew");
});

test("Phone navigation: a floating tab bar that fits the screen, keeps the message box clear and opens Tasks and Make", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, { theme: "light" });
  await expect(page.getByTestId("rail-chat")).toBeVisible();
  await expect(page.getByTestId("presence-header")).toBeVisible();
  await expect(page.getByTestId("presence-avatar")).toBeVisible();
  await expect(page.getByLabel("Today's work")).toHaveCount(0);
  // A pill floating above the bottom edge, inset from the sides, with finger-sized items.
  const bar = (await page.getByTestId("sidebar").boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(844 - 12);
  expect(bar.x).toBeGreaterThanOrEqual(12);
  expect(bar.x + bar.width).toBeLessThanOrEqual(390 - 12);
  for (const id of ["rail-chat", "rail-tasks", "rail-make", "rail-memory", "rail-search"]) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
  }
  // Nothing to type into or send hides behind it.
  const composer = (await page.getByTestId("composer").boundingBox())!;
  expect(composer.y + composer.height).toBeLessThanOrEqual(bar.y);
  // Tasks carries the count of what's waiting on you: the mock's 1 approval plus its 2 tasks ready for review.
  await expect(page.getByTestId("rail-tasks").getByTestId("rail-badge")).toHaveText("3");
  await page.getByTestId("rail-tasks").click();
  await expect(page.getByTestId("rail-tasks")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Tasks sections" })).toBeVisible();
  await page.getByTestId("rail-make").click();
  await expect(page.getByTestId("rail-make")).toHaveAttribute("aria-current", "page");
  await expect(page.locator("main h1")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("The frame: a thin rail, the chat with the agent's big head, and the workspace beside it; Search opens Recent requests", async ({
  page,
}) => {
  await openApp(page);
  // No Today panel and no New request button.
  await expect(page.getByLabel("Today's work")).toHaveCount(0);
  await expect(page.getByTestId("new-request")).toHaveCount(0);
  const rail = page.getByTestId("sidebar");
  const header = page.getByTestId("presence-header");
  const workspace = page.getByTestId("workspace");
  // The roster isn't a column any more: it lives in the rail's Team popover.
  await expect(page.getByTestId("roster")).toHaveCount(0);
  for (const width of [1440, 1100, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    // A fixed, narrow rail that never grows with the window.
    await expect.poll(async () => (await rail.boundingBox())?.width).toBe(52);
    const r = (await rail.boundingBox())!;
    // The chat sits between the rail and the workspace; the big head is at least 56px.
    const h = (await header.boundingBox())!;
    const w = (await workspace.boundingBox())!;
    expect(h.x).toBeGreaterThanOrEqual(r.x + r.width - 1);
    expect(w.x).toBeGreaterThanOrEqual(h.x + h.width - 1);
    expect(w.x + w.width).toBeLessThanOrEqual(width);
    expect((await page.getByTestId("presence-avatar").boundingBox())!.width).toBeGreaterThanOrEqual(56);
  }
  // Below 1100 the workspace is a sheet on demand, not a column.
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(workspace).toHaveCount(0);
  await page.getByTestId("toggle-workspace").click();
  await expect(workspace).toBeVisible();
  // A modal sheet: focus moves into it, the chat behind is out of reach, and Escape closes it.
  await expect(workspace).toHaveAttribute("role", "dialog");
  await expect.poll(() => workspace.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(workspace).toHaveCount(0);
  await page.getByTestId("toggle-workspace").click();
  await expect(workspace).toBeVisible();
  await page.getByTestId("workspace-close").click();
  await expect(workspace).toHaveCount(0);

  await page.getByTestId("rail-search").click();
  const palette = page.getByTestId("command-palette");
  await expect(palette).toContainText("Recent requests");
  await palette.getByRole("button", { name: /Find me the best deal/ }).click();
  await expect(palette).toHaveCount(0);
  await expect(page.locator(".workspace-highlight")).toContainText("Find me the best deal");
});

/** Yo's chat with the presence header (fresh layout). */
async function openPresence(page: Page) {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto("/?mock=1&fast=1&onboarded=1");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  const avatar = page.getByTestId("presence-avatar");
  const header = page.getByTestId("presence-header");
  const patch = (p: object) => page.evaluate((p) => (window as any).__yoMock.patchAgent("agt_yo", p), p);
  return { avatar, header, patch };
}

test("Yo's presence: a big live head with what he's doing, and the profile popover on a click", async ({
  page,
}) => {
  const { avatar, header, patch } = await openPresence(page);
  // Yo's Softie: the logo bubble, drawn live (SVG, no canvas).
  await expect(header.locator('[data-softie="yo"]')).toHaveCount(1);
  expect((await avatar.boundingBox())!.width).toBeGreaterThanOrEqual(56);
  // Yo is idle, but one of his helpers is busy: one calm line says so (never by the helper's name), and the
  // helper's small head is tucked at the big head's lower right, much smaller than it.
  await expect(page.getByTestId("presence-line")).toHaveText("Working with 1 helper");
  await expect(header.getByTestId("helper-head")).toHaveCount(1);
  await expect(page.getByTestId("helpers-pill")).toHaveCount(0);
  const big = (await avatar.boundingBox())!;
  const small = (await header.getByTestId("helper-head").boundingBox())!;
  expect(small.width).toBeLessThanOrEqual(big.width / 3);
  expect(small.x).toBeGreaterThan(big.x + big.width / 2);
  expect(small.y).toBeGreaterThan(big.y + big.height / 3);

  // A click on the head opens the profile popover; Escape closes it and the draft stays.
  await page.getByTestId("composer-input").fill("Keep this draft");
  const profile = await openProfile(page);
  await expect(profile).toContainText("Yo");
  await page.keyboard.press("Escape");
  await expect(profile).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toHaveValue("Keep this draft");

  // Working: the line follows his plan and his pose follows the turn.
  await patch({ activity: "working", todos: [{ text: "Comparing three stores", status: "in_progress" }] });
  // (His helper is still on its task: the line counts it.)
  await expect(page.getByTestId("presence-line")).toHaveText(
    /^Working on comparing three stores · 1 helper$/,
  );
  await expect(header.locator('[data-softie="yo"]')).toHaveAttribute("data-state", /^(thinking|working)$/);
  // The computer button in the chat's top-right brings his screen up in the workspace beside the chat.
  await page.getByTestId("toggle-workspace").click();
  await expect(page.getByTestId("workspace")).toHaveCount(0);
  await page.getByTestId("topbar-computer").click();
  await expect(page.getByTestId("workspace")).toBeVisible();
  await expect(page.getByTestId("toggle-workspace")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("ws-tab-computer")).toContainText("Yo’s computer");
  await page.getByTestId("toggle-workspace").click();
  await expect(page.getByTestId("workspace")).toHaveCount(0);
});

// Split from the test above so each walkthrough fits its time budget on a busy machine.
test("Yo's presence when he's asleep or needs you: wake him, or go straight to what's waiting", async ({
  page,
}) => {
  const { header, patch } = await openPresence(page);

  // Sleeping: wake him up from the profile's computer card.
  await patch({ activity: "sleeping", todos: [], computer: { state: "hibernated", lease: "agent" } });
  await expect(page.getByTestId("presence-line")).toHaveText("Asleep");
  await expect(header).toHaveAttribute("data-tone", "sleeping");
  const profile = await openProfile(page);
  await expect(profile.getByTestId("computer-status")).toHaveText("Asleep");
  await profile.getByRole("button", { name: "Wake" }).click();
  await expect(profile.getByTestId("computer-status")).toHaveText(/Ready|Waking up/);
  await expect(page.getByTestId("presence-line")).not.toHaveText("Asleep");
  await page.keyboard.press("Escape");

  // Needs you: the line says so, and what's waiting is in the profile.
  await patch({ activity: "waiting" });
  await expect(page.getByTestId("presence-line")).toHaveText("Waiting for you");
  // What's waiting is listed in the profile of the agent it waits on (the mock's approval is Pico's): one click
  // closes the profile and brings that request into view in the chat.
  await openAgent(page, "Pico");
  const pico = await openProfile(page);
  await pico.getByTestId("pane-approval").first().click();
  await expect(pico).toHaveCount(0);
  await expect(page.getByTestId("approval-card")).toBeInViewport();
});

test("One calm look for every agent: neutral surfaces, and each agent's colour only in its own world", async ({
  page,
}) => {
  await openApp(page, { theme: "light" });
  const token = (name: string) =>
    page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  const accent = (name: string) =>
    page
      .getByTestId(`agent-row-${name}`)
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--accent").trim().toLowerCase());
  expect(await token("--bg")).toBe("#ffffff");
  expect(await token("--sidebar")).toBe("#f7f7f7");
  // No per-character re-skin of the whole window any more.
  await expect(page.locator("html")).not.toHaveAttribute("data-hue");
  // Every teammate brings its own colour to its row (its unread dot, "Waiting for you").
  await openTeam(page);
  const colours = new Set([await accent("Yo"), await accent("Dew"), await accent("Pico")]);
  expect(colours.size).toBe(3);
  const pico = await accent("Pico");
  // Opening a teammate tints its profile and workspace, not the app.
  await openAgent(page, "Pico");
  const profile = await openProfile(page);
  expect(
    await profile.evaluate((el) => getComputedStyle(el).getPropertyValue("--accent").trim().toLowerCase()),
  ).toBe(pico);
  await page.keyboard.press("Escape");
  const workspace = await openWorkspace(page);
  expect(
    await workspace
      .locator(".ws-body")
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--accent").trim().toLowerCase()),
  ).toBe(pico);
  expect(await token("--bg")).toBe("#ffffff");
});

test("the pill over the agent's screen says what it's doing while it works, and who has control when idle", async ({
  page,
}) => {
  await openApp(page);
  const workspace = await openWorkspace(page);
  const pill = workspace.getByTestId("ws-control");
  const patch = (p: object) => page.evaluate((p) => (window as any).__yoMock.patchAgent("agt_yo", p), p);
  await patch({ activity: "idle", statusLine: null });
  await expect(pill).toContainText("Yo has control");
  await expect(workspace.getByTestId("ws-doing")).toHaveCount(0);
  // Working: one pill, its face and what it's doing, with Take over still in it.
  await patch({ activity: "working", statusLine: "checking times on resy.com" });
  await expect(workspace.getByTestId("ws-doing")).toHaveText("Yo · Checking times on resy.com");
  await expect(pill.getByTestId("ws-take-over")).toBeVisible();
  await expect(workspace.getByTestId("ws-control")).toHaveCount(1);
  // Idle again: back to who has control.
  await patch({ activity: "idle", statusLine: null });
  await expect(pill).toContainText("Yo has control");
});
