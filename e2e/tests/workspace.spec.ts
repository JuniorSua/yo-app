import { expect, type Page, test } from "@playwright/test";
import { openAgent, openApp } from "./helpers";

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

test("The sidebar is the team: the space's main agent first, every teammate with a live line, never a helper", async ({
  page,
}) => {
  await openApp(page);
  const { names, helpers } = await page.evaluate(() => {
    const agents = (window as any).__yoMock.s.agents;
    return {
      // Pip leads Personal time: one switch away, not in the Work roster.
      names: agents.filter((a: any) => a.kind !== "helper" && a.space !== "personal").map((a: any) => a.name),
      helpers: agents.filter((a: any) => a.kind === "helper").map((a: any) => a.name),
    };
  });
  const roster = page.getByTestId("roster");
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
  // The faces are the navigation: a row opens that agent's chat, and stays marked as open.
  await openAgent(page, "Pico");
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

test("The frame: a thin rail, the team roster, the chat with the agent's head, and the inspector; Search opens Recent requests", async ({
  page,
}) => {
  await openApp(page);
  // No Today panel and no New request button.
  await expect(page.getByLabel("Today's work")).toHaveCount(0);
  await expect(page.getByTestId("new-request")).toHaveCount(0);
  const rail = page.getByTestId("sidebar");
  const roster = page.getByTestId("roster");
  const header = page.getByTestId("presence-header");
  const inspector = page.getByTestId("work-pane");
  for (const width of [1440, 1100, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    // A fixed, narrow rail and a roster that never grow with the window.
    await expect.poll(async () => (await rail.boundingBox())?.width).toBe(48);
    const r = (await rail.boundingBox())!;
    const s = (await roster.boundingBox())!;
    expect(s.x).toBe(r.x + r.width);
    expect(s.width).toBeGreaterThanOrEqual(240);
    expect(s.width).toBeLessThanOrEqual(264);
    // The chat sits between the roster and the inspector, the head at least 56px.
    const h = (await header.boundingBox())!;
    const i = (await inspector.boundingBox())!;
    expect(h.x).toBeGreaterThanOrEqual(s.x + s.width - 1);
    expect(i.x).toBeGreaterThanOrEqual(h.x + h.width - 1);
    expect(i.x + i.width).toBeLessThanOrEqual(width);
    expect((await page.getByTestId("presence-avatar").boundingBox())!.width).toBeGreaterThanOrEqual(56);
  }

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
  const header = page.locator("header").filter({ has: avatar });
  const card = page.getByTestId("presence-card");
  const patch = (p: object) => page.evaluate((p) => (window as any).__yoMock.patchAgent("agt_yo", p), p);
  return { avatar, header, card, patch };
}

test("Yo's presence: a large live avatar with what he's doing, and the right next step on a click", async ({
  page,
}) => {
  const { avatar, header, card, patch } = await openPresence(page);
  // Yo's Softie: the logo bubble, drawn live (SVG, no canvas).
  await expect(header.locator('[data-softie="yo"]')).toHaveCount(1);
  expect((await avatar.boundingBox())!.width).toBeGreaterThanOrEqual(56);
  // Yo is idle, but one of his helpers is busy: the header says so (never by the helper's name).
  await expect(page.getByTestId("presence-line")).toHaveText(
    "1 helper working · Checking times at Joe's Stone Crab",
  );

  // Idle: the main action is a new request (the draft stays).
  await page.getByTestId("composer-input").fill("Keep this draft");
  await avatar.click();
  await expect(card).toContainText("Yo");
  await card.getByTestId("presence-new").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(page.getByTestId("composer-input")).toHaveValue("Keep this draft");

  // Working: the line follows his plan, his pose follows the turn, and the main action is to watch him.
  await patch({ activity: "working", todos: [{ text: "Comparing three stores", status: "in_progress" }] });
  await expect(page.getByTestId("presence-line")).toHaveText(/^Comparing three stores( · \d+m)?$/);
  await expect(header.locator('[data-softie="yo"]')).toHaveAttribute("data-state", /^(thinking|working)$/);
  await avatar.click();
  // On a wide window his screen opens in the right pane, beside the chat.
  await card.getByTestId("presence-computer").click();
  await expect(page.getByTestId("work-pane")).toBeVisible();
  await expect(page.getByTestId("toggle-workspace")).toHaveAttribute("aria-expanded", "true");
  await page.getByTestId("toggle-workspace").click();
  await expect(page.getByTestId("work-pane")).toBeHidden();
});

// Split from the test above so each walkthrough fits its time budget on a busy machine.
test("Yo's presence when he's asleep or needs you: wake him, or go straight to what's waiting", async ({
  page,
}) => {
  const { avatar, header, card, patch } = await openPresence(page);

  // Sleeping: wake him up from the card.
  await patch({ activity: "sleeping", todos: [], computer: { state: "hibernated", lease: "agent" } });
  await expect(header.getByTestId("status-pill")).toHaveText("Sleeping");
  await avatar.click();
  await card.getByTestId("presence-wake").click();
  await expect(card).toHaveCount(0);
  await expect(header.getByTestId("status-pill")).toHaveText("Ready");

  // Needs you: straight to what's waiting.
  await patch({ activity: "waiting" });
  await expect(page.getByTestId("presence-line")).toContainText("Waiting for your OK");
  await avatar.click();
  await card.getByTestId("presence-review").click();
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
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
  // No per-character or per-space re-skin of the whole window any more.
  await expect(page.locator("html")).not.toHaveAttribute("data-hue");
  await expect(page.locator("html")).not.toHaveAttribute("data-space");
  // Every teammate brings its own colour to its row (its unread dot, "Waiting for you").
  const colours = new Set([await accent("Yo"), await accent("Dew"), await accent("Pico")]);
  expect(colours.size).toBe(3);
  // Opening a teammate tints its inspector, not the app.
  await openAgent(page, "Pico");
  const inspector = page.getByTestId("work-pane");
  expect(
    await inspector.evaluate((el) => getComputedStyle(el).getPropertyValue("--accent").trim().toLowerCase()),
  ).toBe(await accent("Pico"));
  expect(await token("--bg")).toBe("#ffffff");
});
