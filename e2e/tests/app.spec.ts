import { expect, test } from "@playwright/test";
import {
  chooseClaudeFirstRun,
  newTeammate,
  openAgent,
  openApp,
  openSettings,
  openWorkspacePage,
  send,
  signInChatGPT,
} from "./helpers";

test("onboarding flow lands in the shell", async ({ page }) => {
  await openApp(page, { onboarded: false });
  await expect(page.getByTestId("onboarding")).toContainText("Runs on Claude, ChatGPT or Grok");
  await page.getByTestId("onboarding-start").click();

  // Connect your model: Claude, ChatGPT and Grok. Claude signs in on Yo's computer, which this fresh Mac doesn't
  // have yet, so it comes right after the setup chat. The walkthrough itself is covered in connect.spec.ts.
  await expect(page.getByTestId("connect-pick-claude")).toBeVisible();
  await expect(page.getByTestId("connect-pick-grok")).toContainText("SuperGrok or X Premium");
  await chooseClaudeFirstRun(page);

  // No computer step: the first agent sets up its computer in its chat (setup.spec.ts).
  // Optional Mac access: in the browser it only explains where to set it up.
  await expect(page.getByTestId("onboarding-access")).toBeVisible();
  await page.getByTestId("access-skip").click();

  // Meet Yo (said once, in the title)
  await expect(page.getByTestId("meet-intro")).toHaveText(
    "Give your assistant a name and a look. You can change both later.",
  );
  await page.getByTestId("primary-name").fill("Jarvis");
  await page.getByTestId("user-name").fill("Sam");
  // Its look: any of the six Softies (Yo's bubble by default), in any of the ten colours.
  await expect(page.getByTestId("softie-yo")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("softie-dew").click();
  await expect(page.getByTestId("softie-dew")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("onboarding-finish").click();

  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("agent-title")).toHaveText("Jarvis");
  await expect(page.getByTestId("setup-greeting")).toContainText("Let's set up my computer first.");
  await page.getByTestId("setup-later").click();
  await expect(page.getByTestId("empty-state")).toContainText(/(Morning|Afternoon|Evening|Hi), Sam\./);
  await expect(page.getByTestId("empty-state")).toContainText("I'm Jarvis.");
});

test("send a message and get a streamed reply", async ({ page }) => {
  // The mock streams the reply in ~130 timer ticks. On CI's 2-core runners, with other workers rendering,
  // those ticks run several times slower: the reply arrives, just later (#93).
  test.slow();
  await openApp(page);
  await send(page, "Research the history of the espresso machine");
  await expect(page.getByTestId("user-message").last()).toContainText("history of the espresso machine");
  await expect(page.getByTestId("status-pill").first()).toHaveText("Working");
  await expect(page.getByTestId("todo-card").last()).toBeVisible();
  await expect(page.getByTestId("assistant-message").last()).toContainText("Here's what I found", {
    timeout: 45_000,
  });
  await expect(page.getByTestId("assistant-message").last()).toContainText("one-page brief", {
    timeout: 45_000,
  });
  await expect(page.getByTestId("status-pill").first()).toHaveText(/Done|Ready/);
  await expect(page.getByTestId("activity-group").last()).toContainText(/Worked for .* steps/);
});

test("stop interrupts a running agent", async ({ page }) => {
  await openApp(page);
  await send(page, "Research something long");
  await page.getByTestId("stop-button").click();
  await expect(page.getByTestId("notice-row").last()).toContainText("Stopped");
  await expect(page.getByTestId("status-pill").first()).toHaveText("Ready");
});

test("approval card: allow once", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("approvals-shortcut")).toHaveText(/^Needs you\s*1$/);
  await openAgent(page, "Pico");
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("Publish the RSVP page");
  await page.getByTestId("approve-once").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("Allowed", { exact: true })).toBeVisible();
  await expect(page.getByTestId("assistant-message").last()).toContainText("It's live at", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("approvals-shortcut")).toHaveCount(0);
});

test("approval via a new purchase request can be denied", async ({ page }) => {
  await openApp(page);
  await send(page, "Buy me a USB-C cable");
  await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Refuse" }).click();
  await expect(page.getByTestId("assistant-message").last()).toContainText("didn't buy anything", {
    timeout: 15_000,
  });
});

test("ask-user card: answer with an option", async ({ page }) => {
  await openApp(page);
  await send(page, "Find me a flight to Lisbon");
  const card = page.getByTestId("ask-card");
  await expect(card).toContainText("Which dates work best for you?", { timeout: 15_000 });
  await expect(page.getByTestId("status-pill").first()).toHaveText("Needs you");
  await card.getByRole("button", { name: /Oct 17 – 21/ }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("assistant-message").last()).toContainText("Oct 17 – 21", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("assistant-message").last()).toContainText("JetBlue");
});

test("ask-user card: several questions, one of them pick-any, sent together", async ({ page }) => {
  await openApp(page);
  await send(page, "Help me plan a dinner party");
  const card = page.getByTestId("ask-card");
  await expect(card.getByTestId("ask-question")).toHaveCount(2, { timeout: 15_000 });
  await expect(card).toContainText("Pick any that apply");
  const send_ = card.getByTestId("ask-send");
  await expect(send_).toBeDisabled();
  await card.getByRole("radio", { name: /5–8/ }).click();
  await expect(card.getByRole("radio", { name: /5–8/ })).toHaveAttribute("aria-checked", "true");
  // Still one question to go.
  await expect(send_).toBeDisabled();
  await card.getByRole("checkbox", { name: /Vegetarian/ }).click();
  await card.getByRole("checkbox", { name: /Gluten-free/ }).click();
  await send_.click();
  await expect(card).toHaveCount(0);
  // The answered card keeps each question's answer.
  const answered = page.getByTestId("ask-answered");
  await expect(answered).toContainText("How many people are coming? → 5–8");
  await expect(answered).toContainText("Any food needs I should plan around? → Vegetarian, Gluten-free");
  const reply = page.getByTestId("assistant-message").last();
  await expect(reply).toContainText("5–8 guests", { timeout: 15_000 });
  await expect(reply.locator("table")).toBeVisible();
});

test("a revised draft highlights what changed", async ({ page }) => {
  await openApp(page);
  await send(page, "Text Sam about coffee on Friday");
  const first = page.getByTestId("approval-card");
  await expect(first.getByTestId("draft-text")).toContainText("Friday at 3pm", { timeout: 15_000 });
  // The first draft has nothing to compare with.
  await expect(first.getByTestId("draft-revised")).toHaveCount(0);
  await first.getByRole("button", { name: "Refuse" }).click();
  await expect(page.getByTestId("assistant-message").last()).toContainText("I didn't send it", {
    timeout: 15_000,
  });
  await send(page, "Make it 4pm at the Blue Door cafe");
  const second = page.getByTestId("approval-card");
  await expect(second.getByTestId("draft-revised")).toBeVisible({ timeout: 15_000 });
  await expect(second.getByTestId("draft-removed")).toHaveText(["3pm?"]);
  await expect(second.getByTestId("draft-added")).toHaveText(["4pm at the Blue Door cafe?"]);
});

test("computer overlay: take over, terminal, give back", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("agent-options").click();
  await page.getByTestId("open-computer").click();
  const overlay = page.getByTestId("computer-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.getByTestId("mock-desktop")).toBeVisible();

  await page.getByTestId("take-over").click();
  await expect(overlay.getByTestId("status-pill")).toHaveText("You have control");
  await expect(overlay.getByText("You have control — Yo is paused")).toBeVisible();

  await page.getByTestId("dock-terminal").click();
  const term = page.getByTestId("terminal-window");
  await expect(term).toContainText("agent@yo");
  await term.locator(".xterm").click();
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await expect(term).toContainText("/home/agent");

  await page.getByTestId("dock-files").click();
  await page.getByTestId("files").getByText("Documents").click();
  await expect(page.getByTestId("files")).toContainText("standing-desks.md");

  await page.getByTestId("give-back").click();
  await expect(overlay.getByTestId("status-pill")).not.toHaveText("You have control");
  await expect(page.getByTestId("take-over")).toBeVisible();

  await page.getByTestId("close-computer").click();
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId("notice-row").last()).toContainText("handed control back");
});

test("add a teammate: pick a Softie, name it, give it a job and a subscription", async ({ page }) => {
  await openApp(page);
  await newTeammate(page);
  const dialog = page.getByTestId("new-agent-dialog");
  // The six Softies with their jobs. The first one nobody wears yet is picked (Dew, Pico and Pip's Mochi are taken).
  for (const kind of ["yo", "dew", "pico", "mochi", "clove", "kiki"])
    await expect(dialog.getByTestId(`new-softie-${kind}`)).toBeVisible();
  await expect(dialog.getByTestId("new-softie-clove")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("agent-name")).toHaveValue("Clove");
  await expect(page.getByTestId("agent-job")).toHaveValue(/Draft and edit/);
  // Another Softie brings its own name and job, until you type yours.
  await dialog.getByTestId("new-softie-kiki").click();
  await expect(page.getByTestId("agent-name")).toHaveValue("Kiki");
  // Dew is already on the team in blue: a second Dew gets its own colour, and any of the ten can be picked.
  await dialog.getByTestId("new-softie-dew").click();
  await expect(dialog.getByTestId("softie-color-cobalt")).toHaveAttribute("aria-checked", "false");
  await expect(dialog.getByTestId("softie-color-slate")).toHaveAttribute("aria-checked", "true");
  await dialog.getByTestId("softie-color-orchid").click();
  await expect(dialog.getByTestId("softie-color-orchid")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("agent-name").fill("Bob");
  await page.getByTestId("agent-job").fill("Track my reading list and sum up new chapters.");
  await expect(page.getByTestId("agent-model")).toContainText("Claude");
  await page.getByTestId("create-agent").click();

  await expect(page.getByTestId("new-agent-dialog")).toHaveCount(0);
  await expect(page.getByTestId("agent-title")).toHaveText("Bob");
  // A new teammate joins the roster in the sidebar, as the Softie you picked.
  const row = page.getByTestId("roster").getByTestId("agent-row-Bob");
  await expect(row).toBeVisible();
  await expect(row.locator('[data-softie="dew"]')).toBeVisible();
  const bob = await page.evaluate(() =>
    (window as any).__yoMock.s.agents.find((a: { name: string }) => a.name === "Bob"),
  );
  expect(bob.avatar.softie).toEqual({ kind: "dew", color: "#DD6ADC" });
  expect(bob.role).toBe("Research");
  expect(bob.instructions).toBe("Track my reading list and sum up new chapters.");
});

test("switch model, then switch account/provider in the picker", async ({ page }) => {
  await openApp(page);
  const trigger = page.getByTestId("model-picker-trigger");
  await expect(trigger).toContainText("Sonnet 4.5");
  await trigger.click();
  await page.getByTestId("picker-model-claude-opus-4-5").click();
  await expect(trigger).toContainText("Opus 4.5");

  // ChatGPT isn't signed in yet: the picker offers sign-in. Grok is listed too.
  await trigger.click();
  await expect(page.getByTestId("picker-account-Grok")).toBeVisible();
  await page.getByTestId("picker-account-ChatGPT").click();
  await expect(page.getByTestId("model-picker")).toContainText("Sign in to ChatGPT");
  await page.keyboard.press("Escape");

  // Connect it in Settings (the walkthrough; ChatGPT signs in on Yo's computer), then switch.
  await openSettings(page);
  await page.getByTestId("connect-codex").click();
  await signInChatGPT(page);
  await page.getByTestId("connect-codex-done").click();
  await expect(page.getByTestId("account-codex")).toContainText("Plus · Connected");
  await page.keyboard.press("Escape");

  await trigger.click();
  await page.getByTestId("picker-account-ChatGPT").click();
  await expect(page.getByTestId("switch-note")).toContainText("keeps its memory");
  await page.getByTestId("picker-model-gpt-5-codex").click();
  await expect(trigger).toContainText("GPT-5 Codex");
  await expect(page.getByTestId("notice-row").last()).toContainText("Switched to ChatGPT");
});

test("accounts: Claude, ChatGPT and Grok can be added", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await expect(page.getByTestId("settings-dialog")).toContainText("Claude, ChatGPT or Grok plan");
  await expect(page.getByTestId("account-grok")).toContainText("Not connected");
  await expect(page.getByTestId("add-account-codex")).toBeVisible();
  await page.getByTestId("add-account-grok").click();
  await expect(page.getByTestId("account-grok")).toHaveCount(2);
  await page.getByTestId("add-account-claude").click();
  await expect(page.getByTestId("account-claude")).toHaveCount(2);
});

test("create a routine", async ({ page }) => {
  await openApp(page);
  await openWorkspacePage(page, "routines");
  await expect(page.getByTestId("routine-row")).toHaveCount(3);
  await page.getByTestId("new-routine").click();
  await page.getByTestId("routine-name").fill("Inbox zero");
  await page.getByTestId("routine-prompt").fill("Triage my inbox and draft replies.");
  await page.getByRole("radio", { name: "Weekdays" }).click();
  await expect(page.getByTestId("routine-dialog")).toContainText("Weekdays at 8:00 AM");
  await page.getByTestId("routine-save").click();
  await expect(page.getByTestId("routine-dialog")).toHaveCount(0);
  await expect(page.getByTestId("routine-row")).toHaveCount(4);
  await expect(page.getByTestId("routine-list")).toContainText("Inbox zero");
});

test("a routine on chosen days, and every few hours", async ({ page }) => {
  await openApp(page);
  await openWorkspacePage(page, "routines");
  await page.getByTestId("new-routine").click();
  await page.getByTestId("routine-name").fill("Gym");
  await page.getByTestId("routine-prompt").fill("Remind me to pack my gym bag.");
  await page.getByRole("radio", { name: "Days", exact: true }).click();
  const monday = page.getByRole("button", { name: "Monday" });
  await expect(monday).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Wednesday" }).click();
  await page.getByRole("button", { name: "Friday" }).click();
  await expect(page.getByRole("button", { name: "Friday" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("routine-schedule")).toContainText("Mon, Wed and Fri at 8:00 AM");
  await expect(page.getByTestId("routine-next")).toContainText("Next:");
  // At least one day stays on.
  for (const day of ["Wednesday", "Friday", "Monday"]) await page.getByRole("button", { name: day }).click();
  await expect(monday).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("routine-schedule")).toContainText("Mondays at 8:00 AM");
  await page.getByRole("button", { name: "Thursday" }).click();
  await page.getByTestId("routine-save").click();
  await expect(page.getByTestId("routine-list")).toContainText("Mon and Thu at 8:00 AM");

  // Opened again, it's still on those days; then every 4 hours.
  const row = page.getByTestId("routine-row").filter({ hasText: "Gym" });
  await row.getByRole("button", { name: "Routine options" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page.getByRole("button", { name: "Thursday" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("radio", { name: "Hours" }).click();
  await page.getByTestId("routine-every").click();
  await page.getByRole("option", { name: "Every 4 hours" }).click();
  await expect(page.getByTestId("routine-schedule")).toContainText("Every 4 hours");
  await page.getByTestId("routine-save").click();
  await expect(page.getByTestId("routine-list")).toContainText("Every 4 hours");
});

test("memory: add and delete", async ({ page }) => {
  await openApp(page);
  await openWorkspacePage(page, "memory");
  const rows = page.getByTestId("memory-row");
  await expect(rows).toHaveCount(6);
  await page.getByTestId("memory-input").fill("I'm vegetarian");
  await page.getByTestId("memory-add").click();
  await expect(rows).toHaveCount(7);
  const row = rows.filter({ hasText: "I'm vegetarian" });
  await row.hover();
  await row.getByTestId("memory-delete").click();
  await expect(rows).toHaveCount(6);
  await expect(page.getByTestId("memory-list")).not.toContainText("vegetarian");
});

test("settings: theme toggle", async ({ page }) => {
  await openApp(page);
  await expect(page.locator("html")).toHaveClass("dark");
  await openSettings(page);
  await page.getByTestId("settings-appearance").click();
  await page.getByTestId("theme-light").click();
  await expect(page.locator("html")).toHaveClass("light");
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveClass("dark");
});

test("command palette switches agents", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.type("Dew");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("agent-title")).toHaveText("Dew");
});

test("profile menu: global pages, keyboard and dismissal", async ({ page }) => {
  await openApp(page);
  // Pending approvals stay visible outside the menu.
  await expect(page.getByTestId("approvals-shortcut")).toHaveText(/^Needs you\s*1$/);
  await page.getByTestId("approvals-shortcut").click();
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();

  const trigger = page.getByTestId("profile-trigger");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("profile-menu")).toBeVisible();
  await expect(page.getByTestId("nav-tasks")).toBeFocused();
  await expect(page.getByTestId("profile-menu")).toContainText("Your workspace");
  await expect(page.getByTestId("account-chip")).not.toContainText("subscription (token)");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("profile-menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // Opened from an agent, pages stay global.
  await openAgent(page, "Dew");
  await openWorkspacePage(page, "activity");
  await expect(page.getByRole("heading", { name: "Everything in motion, in one place." })).toBeVisible();
});

test("pictures from the agent's computer show inline and open full size", async ({ page }) => {
  await openApp(page);
  await send(page, "Send me a screenshot of the desk");
  const img = page.getByTestId("chat-image").first();
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect(img.locator("img")).toHaveJSProperty("complete", true);
  expect(await img.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  // A picture that can't load says so instead of showing a broken icon.
  await expect(page.getByTestId("chat-image-missing")).toContainText("Old desk");
  await img.click();
  await expect(page.getByTestId("image-viewer")).toBeVisible();
  await expect(page.getByTestId("image-viewer")).toContainText("Desk – 27mo/7.5k");

  // Zoom: buttons, keyboard, pinch/⌘-scroll, double-click; fit-to-window resets.
  const level = page.getByTestId("zoom-level");
  const pct = async () => Number((await level.innerText()).replace("%", ""));
  await expect.poll(pct).toBeGreaterThan(0);
  const fit = await pct();
  const width = () =>
    page
      .getByTestId("zoom-box")
      .locator("img")
      .evaluate((i: HTMLImageElement) => i.getBoundingClientRect().width);
  const fitWidth = await width();
  await page.getByTestId("zoom-in").click();
  await expect.poll(pct).toBeGreaterThan(fit);
  expect(await width()).toBeGreaterThan(fitWidth * 1.2);
  await page.keyboard.press("0");
  await expect.poll(pct).toBe(fit);
  const box = await page.getByTestId("zoom-box").boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -200);
  await page.keyboard.up("Control");
  await expect.poll(pct).toBeGreaterThan(fit * 2);
  await page.getByTestId("zoom-fit").click();
  await expect.poll(pct).toBe(fit);
  await page.getByTestId("zoom-box").dblclick();
  await expect.poll(pct).toBeGreaterThan(fit * 2);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("image-viewer")).toHaveCount(0);
});

test("/compact from the composer and the agent menu", async ({ page }) => {
  await openApp(page);
  const input = page.getByTestId("composer-input");
  await input.fill("/co");
  await expect(page.getByTestId("slash-menu")).toContainText("/compact");
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("/compact ");
  await input.fill("/compact keep the prices");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("notice-row").last()).toContainText("focused on keep the prices");
  // The command is never sent to the agent as a chat message.
  await expect(page.getByTestId("user-message").filter({ hasText: "/compact" })).toHaveCount(0);
  await page.getByTestId("agent-options").click();
  await page.getByTestId("compact-conversation").click();
  await expect(page.getByTestId("notice-row").last()).toContainText("Compacted our conversation");
});

test("The Next chip refreshes when a routine is added or removed, even after a reconnect", async ({
  page,
}) => {
  await openApp(page);
  const next = page.getByTestId("next-routine");
  await expect(next).toBeVisible();
  // The connection drops and comes back (e.g. Yo's server restarted), while the chat stays on screen.
  await page.evaluate(() => (window as any).__yoMock.simulateReconnect());
  await page.waitForTimeout(300);
  // The agent schedules something (same server push as its schedule_task tool).
  const agentId = await page.evaluate(() => {
    const ui = JSON.parse(localStorage.getItem("yo.ui") ?? "{}");
    return ui.agentId as string;
  });
  const id = await page.evaluate(
    async (agentId) =>
      (
        await (window as any).__yoMock.call("routine.create", {
          agentId,
          name: "Check October programs",
          prompt: "Read the October programs tab",
          // Every minute: sooner than any seeded routine, so it's the one the chip shows.
          cron: "* * * * *",
        })
      ).id as string,
    agentId,
  );
  await expect(next).toContainText("Check October programs");
  await page.evaluate(async (id) => (window as any).__yoMock.call("routine.delete", { id }), id);
  await expect(next).not.toContainText("Check October programs");
});

test("a picture in the chat has a copy button that puts the image itself on the clipboard", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page);
  await send(page, "Send me a screenshot of the desk");
  const img = page.getByTestId("chat-image").first();
  await expect(img).toBeVisible({ timeout: 15_000 });
  await img.hover();
  const copy = page.getByTestId("copy-image").first();
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(copy).toHaveAttribute("data-copied", "true");
  const types = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => i.types));
  expect(types).toContain("image/png");
  // The same button is in the full-size viewer.
  await img.click();
  await expect(page.getByTestId("viewer-copy-image")).toBeVisible();
});
