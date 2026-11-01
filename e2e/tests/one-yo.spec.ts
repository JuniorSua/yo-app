/**
 * One Yo (Dots, not Grok Bot): you talk to Yo only. Its specialists sit at the top, by Yo's head, as small faces; the
 * Team popover lists every one of them with its job and what it's doing, with View and Edit. A specialist's view is
 * read-only: to give it work, you ask Yo ("@Pepe …").
 */
import { expect, type Page, test } from "@playwright/test";
import { openAgent, openApp, openTeam } from "./helpers";

/** Add specialists straight through the mock (no hello turn), the way core would push them. */
async function addSpecialists(page: Page, names: string[]) {
  await page.evaluate(async (list) => {
    const m = (window as any).__yoMock;
    for (const name of list)
      await m.call("agent.create", {
        name,
        role: name === "Nova" ? "" : `${name} desk`,
        instructions: "",
        avatar: {
          shape: "bubble",
          color: "#9165F7",
          eyes: "capsule",
          accessory: "none",
          softie: { kind: "clove" },
        },
      });
  }, names);
}

test("the Team popover lists every specialist, 4 and more, and scrolls when there are many", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  // Dew, Pico and Pip, plus five more: eight specialists.
  await addSpecialists(page, ["Kai", "Nova", "Remy", "Juno", "Otto"]);
  // Yo's head shows a few faces and a "+N" for the rest; the popover has them all.
  const faces = page.getByTestId("chat-team");
  await expect(faces.getByTestId("team-face")).toHaveCount(3);
  await expect(faces.getByTestId("team-more")).toHaveText("+5");
  await expect(faces).toHaveAccessibleName(/8 specialists/);
  await faces.click();
  const roster = page.getByTestId("roster");
  await expect(roster).toBeVisible();
  const rows = roster.locator('[data-testid^="agent-row-"]');
  await expect(rows).toHaveCount(8);
  for (const name of ["Dew", "Pico", "Pip", "Kai", "Nova", "Remy", "Juno", "Otto"]) {
    const row = roster.getByTestId(`agent-row-${name}`);
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeInViewport();
    await expect(row.getByTestId("agent-view")).toBeVisible();
    await expect(row.getByTestId("agent-edit")).toBeVisible();
  }
  // The list scrolls inside the card; the footer stays put.
  const list = roster.getByTestId("team-list");
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(roster.getByTestId("ask-yo-add")).toBeInViewport();
  // Each row: its job line (or "No job set" with a way to set one), status and what it's on or last did.
  await expect(roster.getByTestId("agent-row-Dew").getByTestId("agent-job-line")).toHaveText("Research");
  await expect(roster.getByTestId("agent-row-Pico").getByTestId("agent-status")).toHaveText("Needs you");
  await expect(roster.getByTestId("agent-row-Dew").getByTestId("agent-state")).toContainText(
    "Brief ready: 5 best standing desks under $600",
  );
  const nova = roster.getByTestId("agent-row-Nova");
  await expect(nova.getByTestId("agent-job-line")).toHaveText("No job set");
  await nova.getByTestId("agent-set-job").click();
  await expect(page.getByTestId("agent-settings-dialog")).toBeVisible();
  await expect(page.getByTestId("agent-name")).toHaveValue("Nova");
  await page.getByTestId("agent-role").fill("Travel");
  await page.getByTestId("save-agent").click();
  await expect(page.getByTestId("agent-settings-dialog")).toHaveCount(0);
  await expect((await openTeam(page)).getByTestId("agent-row-Nova").getByTestId("agent-job-line")).toHaveText(
    "Travel",
  );
});

test("Ask Yo to add a specialist starts the request in Yo's message box", async ({ page }) => {
  await openApp(page);
  await openAgent(page, "Dew");
  const roster = await openTeam(page);
  await roster.getByTestId("ask-yo-add").click();
  await expect(page.getByTestId("roster")).toHaveCount(0);
  await expect(page.getByTestId("agent-title")).toHaveText("Yo");
  await expect(page.getByTestId("composer-input")).toHaveValue("Add a specialist for ");
  await expect(page.getByTestId("composer-input")).toBeFocused();
});

test("a specialist's view is read-only; Ask Yo goes back to Yo with @Name ready", async ({ page }) => {
  await openApp(page);
  await openAgent(page, "Dew");
  // Its work under a small header (face, name, job, status, Edit), and no message box.
  await expect(page.getByTestId("presence-header")).toHaveAttribute("data-tone", "done");
  await expect(page.getByTestId("specialist-job")).toContainText("Research");
  await expect(page.getByTestId("composer-input")).toHaveCount(0);
  await expect(page.getByTestId("specialist-bar")).toHaveText(
    /Dew works for Yo\. To give Dew work, ask Yo\./,
  );
  await expect(page.getByTestId("assistant-message").first()).toBeVisible();
  // Edit is right there.
  await page.getByTestId("specialist-edit").click();
  await expect(page.getByTestId("agent-settings-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  // Ask Yo: Yo's chat with "@Dew " in the box; what you write goes to Yo, who hands it to Dew.
  await page.getByTestId("ask-yo").click();
  await expect(page.getByTestId("agent-title")).toHaveText("Yo");
  const box = page.getByTestId("composer-input");
  await expect(box).toHaveValue("@Dew ");
  await expect(box).toBeFocused();
  await page.keyboard.type("compare standing desks");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("team-exchange").last().getByTestId("team-ask-row")).toContainText(
    "Asked Dew: compare standing desks",
  );
  // And the way home from any view: the back pill.
  await openAgent(page, "Pip");
  await page.getByTestId("back-to-yo").click();
  await expect(page.getByTestId("agent-title")).toHaveText("Yo");
  await expect(page.getByTestId("rail-chat")).toHaveAttribute("aria-current", "page");
});

test("exchange rows in Yo's chat open the specialist's view (Pepe on the pending leads)", async ({
  page,
}) => {
  await openApp(page, { query: "mockTeam=leads" });
  // Pepe is working for Yo: a ring on his face by Yo's head, and a calm row in Yo's chat.
  await expect(page.getByTestId("chat-team").locator('[data-testid="team-face"][data-working]')).toHaveCount(
    1,
  );
  const row = page.getByTestId("team-exchange").last();
  await expect(row).toHaveAttribute("data-state", "later");
  await expect(row.getByTestId("team-ask-row")).toContainText("Asked Pepe: follow up pending leads");
  await expect(row.getByTestId("team-waiting")).toContainText("working on it");
  await row.getByTestId("team-ask-row").click();
  await expect(page.getByTestId("agent-title")).toHaveText("Pepe");
  await expect(page.getByTestId("specialist-job")).toContainText("Polestar desk");
  await expect(page.getByTestId("presence-line")).toHaveText("For Yo: follow up pending leads");
  await expect(page.getByTestId("teammate-message")).toContainText("Yo asked");
  await expect(page.getByTestId("teammate-message")).toContainText("follow up pending leads");
});

test("Edit renames a specialist; Remove asks first, then takes it off the team", async ({ page }) => {
  await openApp(page, { query: "mockTeam=owner" });
  let roster = await openTeam(page);
  await roster.getByTestId("agent-row-Scout").getByTestId("agent-edit").click();
  for (const item of ["edit-rename", "edit-job", "edit-model", "edit-avatar", "edit-remove"])
    await expect(page.getByTestId(item)).toBeVisible();
  await page.getByTestId("edit-rename").click();
  const dialog = page.getByTestId("agent-settings-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("roster")).toHaveCount(0);
  await page.getByTestId("agent-name").fill("Sage");
  await page.getByTestId("save-agent").click();
  await expect(dialog).toHaveCount(0);
  roster = await openTeam(page);
  await expect(roster.getByTestId("agent-row-Sage").getByTestId("agent-job-line")).toHaveText(
    "Content manager",
  );
  await expect(roster.getByTestId("agent-row-Scout")).toHaveCount(0);

  // Remove: a confirm first (Cancel keeps it), then it's gone from the popover and the head.
  await roster.getByTestId("agent-row-Pip").getByTestId("agent-edit").click();
  await page.getByTestId("edit-remove").click();
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toContainText("Remove Pip?");
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  roster = await openTeam(page);
  await expect(roster.getByTestId("agent-row-Pip")).toBeVisible();
  await roster.getByTestId("agent-row-Pip").getByTestId("agent-edit").click();
  await page.getByTestId("edit-remove").click();
  await page.getByTestId("confirm-action").click();
  await expect(confirm).toHaveCount(0);
  await expect
    .poll(() =>
      // Archived in core (the mock drops it from the team).
      page.evaluate(() => (window as any).__yoMock.s.agents.some((a: any) => a.name === "Pip")),
    )
    .toBe(false);
  roster = await openTeam(page);
  await expect(roster.locator('[data-testid^="agent-row-"]')).toHaveCount(2);
  await expect(roster.getByTestId("agent-row-Pip")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-team").getByTestId("team-face")).toHaveCount(2);
});

test("a message aimed at a specialist goes to Yo as @Name (like core's chat.send)", async ({ page }) => {
  await openApp(page);
  await openAgent(page, "Pico");
  await expect(page.getByTestId("composer-input")).toHaveCount(0);
  // An older client (or the phone) sends to Pico anyway: Yo gets it as "@Pico …" and routes it.
  const r = await page.evaluate(() =>
    (window as any).__yoMock.call("chat.send", { agentId: "agt_pico", text: "check the RSVP page" }),
  );
  expect(r.agentId).toBe("agt_yo");
  const texts = await page.evaluate(() => {
    const t = (window as any).__yoMock.s.timelines;
    return {
      yo: t.agt_yo.filter((e: any) => e.item.kind === "user_message").map((e: any) => e.item.text),
      pico: t.agt_pico.map((e: any) => e.item.text),
    };
  });
  expect(texts.yo).toContain("@Pico check the RSVP page");
  expect(texts.pico).not.toContain("check the RSVP page");
  await page.getByTestId("rail-chat").click();
  await expect(page.getByTestId("user-message").last()).toContainText("@Pico check the RSVP page");
  await expect(page.getByTestId("team-exchange").last().getByTestId("team-ask-row")).toContainText(
    "Asked Pico: check the RSVP page",
  );
});
