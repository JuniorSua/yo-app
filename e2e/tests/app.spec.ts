import { expect, test } from "@playwright/test";
import { openAgent, openApp, openSettings, openWorkspacePage, send } from "./helpers";

test("onboarding flow lands in the shell", async ({ page }) => {
  await openApp(page, { onboarded: false });
  await expect(page.getByTestId("onboarding")).toContainText("Runs on Claude or ChatGPT");
  await page.getByTestId("onboarding-start").click();

  // Connect your model: Claude and ChatGPT only (no Grok); connect Claude with a pasted token (fake).
  // The walkthrough itself is covered in connect.spec.ts.
  await expect(page.getByTestId("connect-pick-claude")).toBeVisible();
  await expect(page.getByTestId("connect-pick-grok")).toHaveCount(0);
  await expect(page.getByTestId("onboarding")).not.toContainText("Grok");
  await page.getByTestId("connect-pick-claude").click();
  await page.getByTestId("claude-token-input").fill(`sk-ant-oat01-${"FAKE_e2e_token-".repeat(7)}`);
  await page.getByTestId("claude-token-submit").click();
  await page.getByTestId("connect-claude-done").click();

  // No computer step: the first agent sets up its computer in its chat (setup.spec.ts).
  // Optional Mac access: in the browser it only explains where to set it up.
  await expect(page.getByTestId("onboarding-access")).toBeVisible();
  await page.getByTestId("access-skip").click();

  // Meet Yo
  await page.getByTestId("primary-name").fill("Jarvis");
  await page.getByTestId("user-name").fill("Junior");
  await page.getByTestId("shape-squircle").click();
  await page.getByTestId("onboarding-finish").click();

  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("agent-title")).toHaveText("Jarvis");
  await expect(page.getByTestId("setup-greeting")).toContainText("Let's set up my computer.");
  await page.getByTestId("setup-later").click();
  await expect(page.getByTestId("empty-state")).toContainText("Hey Junior, I'm Jarvis.");
});

test("send a message and get a streamed reply", async ({ page }) => {
  await openApp(page);
  await send(page, "Research the history of the espresso machine");
  await expect(page.getByTestId("user-message").last()).toContainText("history of the espresso machine");
  await expect(page.getByTestId("status-pill").first()).toHaveText("Working");
  await expect(page.getByTestId("todo-card").last()).toBeVisible();
  await expect(page.getByTestId("assistant-message").last()).toContainText("Here's what I found", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("assistant-message").last()).toContainText("one-page brief", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("status-pill").first()).toHaveText(/Done|Idle/);
  await expect(page.getByTestId("activity-group").last()).toContainText(/Worked for .* steps/);
});

test("stop interrupts a running agent", async ({ page }) => {
  await openApp(page);
  await send(page, "Research something long");
  await page.getByTestId("stop-button").click();
  await expect(page.getByTestId("notice-row").last()).toContainText("Stopped");
  await expect(page.getByTestId("status-pill").first()).toHaveText("Idle");
});

test("approval card: allow once", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("approvals-badge")).toHaveText("1");
  await openAgent(page, "Shopper");
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("Buy AirPods Pro 2 for $189.99");
  await page.getByTestId("approve-once").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("Allowed", { exact: true })).toBeVisible();
  await expect(page.getByTestId("assistant-message").last()).toContainText("Order #112-4471903", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("approvals-badge")).toHaveCount(0);
});

test("approval via a new purchase request can be denied", async ({ page }) => {
  await openApp(page);
  await send(page, "Buy me a USB-C cable");
  await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Deny" }).click();
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

test("computer overlay: take over, terminal, give back", async ({ page }) => {
  await openApp(page);
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

test("create an agent from a template and customize its avatar", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("new-agent").click();
  await page.getByTestId("template-builder").click();
  await expect(page.getByTestId("agent-name")).toHaveValue("Builder");
  // Every worker wears the headset: there is no accessory picker anymore.
  await expect(page.locator('[data-testid^="accessory-"]')).toHaveCount(0);
  // Copilot: fully customizable (no CupCat in the shape list).
  await page.getByTestId("preset-violet-copilot").click();
  await expect(page.getByTestId("preset-violet-copilot")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("shape-cupcat")).toHaveCount(0);
  await page.getByTestId("shape-hex").click();
  await page.getByTestId("color-violet").click();
  await page.getByTestId("eyes-happy").click();
  await expect(page.getByTestId("shape-hex")).toHaveAttribute("aria-pressed", "true");
  // CupCat: one tile, rolled with odds, not customizable.
  await page.getByTestId("preset-cupcat").click();
  await expect(page.getByTestId("cupcat-card")).toBeVisible();
  await expect(page.getByTestId("cupcat-rarity")).toContainText("%");
  await expect(page.getByTestId("shape-hex")).toHaveCount(0);
  await page.getByTestId("cupcat-odds-toggle").click();
  await expect(page.getByTestId("cupcat-odds").locator("> div")).toHaveCount(15);
  // You roll once: the cat is locked in, and coming back to CupCat brings the same cat (no reroll).
  await expect(page.getByTestId("cupcat-locked")).toBeVisible();
  await expect(page.getByTestId("cupcat-roll")).toHaveCount(0);
  const cat = await page.getByTestId("cupcat-name").innerText();
  await page.getByTestId("preset-violet-copilot").click();
  await page.getByTestId("preset-cupcat").click();
  await expect(page.getByTestId("cupcat-name")).toHaveText(cat);
  await page.getByTestId("agent-name").fill("Bob");
  await page.getByTestId("create-agent").click();

  await expect(page.getByTestId("new-agent-dialog")).toHaveCount(0);
  await expect(page.getByTestId("agent-title")).toHaveText("Bob");
  await expect(page.getByTestId("agent-row-Bob")).toBeVisible();
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("switch model, then switch account/provider in the picker", async ({ page }) => {
  await openApp(page);
  const trigger = page.getByTestId("model-picker-trigger");
  await expect(trigger).toContainText("Sonnet 4.5");
  await trigger.click();
  await page.getByTestId("picker-model-claude-opus-4-5").click();
  await expect(trigger).toContainText("Opus 4.5");

  // ChatGPT isn't signed in yet: the picker offers sign-in. Claude and ChatGPT are the only providers.
  await trigger.click();
  await expect(page.getByTestId("model-picker")).not.toContainText("Grok");
  await page.getByTestId("picker-account-ChatGPT").click();
  await expect(page.getByTestId("model-picker")).toContainText("Sign in to ChatGPT");
  await page.keyboard.press("Escape");

  // Connect it in Settings (the walkthrough; Codex signs in from Terminal), then switch.
  await openSettings(page);
  await page.getByTestId("connect-codex").click();
  await page.evaluate(() => (window as any).__yoMock.connect.finishCodexLogin());
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

test("a Grok account left by an older Yo is hidden and its agent falls back to Claude", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto("/?mock=1&fast=1&onboarded=1&legacyGrok=1");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await openAgent(page, "Yo");

  // Yo is still pinned to Grok 4 (High): the picker shows the default Claude account's model instead.
  const trigger = page.getByTestId("model-picker-trigger");
  await expect(trigger).toHaveText(/Sonnet 4\.5/);
  await expect(trigger).not.toContainText("High");
  await trigger.click();
  await expect(page.getByTestId("model-picker")).toContainText("Opus 4.5");
  await expect(page.getByTestId("model-picker")).not.toContainText("Grok");
  await page.keyboard.press("Escape");

  // A late push about the Grok account doesn't bring it back.
  await page.evaluate(() => {
    const m = (window as any).__yoMock;
    const grok = m.s.accounts.find((a: { id: string }) => a.id === "acc_grok");
    m.emit("account.updated", { ...grok, status: "authenticated" });
  });
  await openSettings(page);
  await expect(page.getByTestId("account-claude")).toBeVisible();
  await expect(page.getByTestId("account-grok")).toHaveCount(0);
  await expect(page.getByTestId("settings-dialog")).not.toContainText("Grok");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);

  // Saving the agent's settings moves it to the default account rather than keeping the hidden one.
  await page.getByTestId("agent-options").click();
  await page.getByTestId("open-agent-settings").click();
  await expect(page.getByTestId("agent-settings-dialog")).not.toContainText("Grok");
  await page.getByTestId("save-agent").click();
  await expect(page.getByTestId("agent-settings-dialog")).toHaveCount(0);
  const saved = await page.evaluate(() =>
    (window as any).__yoMock.s.agents.find((a: { isPrimary: boolean }) => a.isPrimary),
  );
  expect(saved).toMatchObject({ accountId: null, model: null, effort: null });
  await expect(page.locator("body")).not.toContainText("Grok");
});

test("accounts: only Claude and ChatGPT can be added", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await expect(page.getByTestId("add-account-codex")).toBeVisible();
  await expect(page.getByTestId("add-account-grok")).toHaveCount(0);
  await expect(page.getByTestId("settings-dialog")).not.toContainText("Grok");
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
  await page.keyboard.type("Researcher");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("agent-title")).toHaveText("Researcher");
});

test("profile menu: global pages, keyboard and dismissal", async ({ page }) => {
  await openApp(page);
  // Pending approvals stay visible outside the menu.
  await expect(page.getByTestId("approvals-shortcut")).toContainText("Needs approval");
  await page.getByTestId("approvals-shortcut").click();
  await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();

  const trigger = page.getByTestId("profile-trigger");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("profile-menu")).toBeVisible();
  await expect(page.getByTestId("nav-activity")).toBeFocused();
  await expect(page.getByTestId("profile-menu")).toContainText("Across all agents");
  await expect(page.getByTestId("account-chip")).not.toContainText("subscription (token)");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("profile-menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // Opened from an agent, pages stay global.
  await openAgent(page, "Researcher");
  await openWorkspacePage(page, "activity");
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
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

test("living characters: pick one, recolor it, and it shows in the sidebar", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("new-agent").click();
  await page.getByTestId("template-builder").click();
  await page.getByTestId("living-lagoon").click();
  await expect(page.getByTestId("living-lagoon")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("living-editor")).toContainText("Lagoon Pebble");
  await expect(page.getByTestId("shape-hex")).toHaveCount(0);
  await page.getByTestId("living-body-mint").click();
  await page.getByTestId("living-headset-ocean").click();
  await expect(page.getByTestId("living-body-mint")).toHaveClass(/ring-2/);
  await page.getByTestId("agent-name").fill("Lagoon");
  await page.getByTestId("create-agent").click();
  const row = page.getByTestId("agent-row-Lagoon");
  await expect(row.locator('[data-living="lagoon"]')).toBeVisible();
  await expect(row.getByTestId("agent-role")).toHaveText("Code, scripts & automations");
  // It renders (the canvas gets painted).
  await expect
    .poll(() =>
      row.locator('[data-living="lagoon"] canvas').evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]! > 20) n++;
        return n;
      }),
    )
    .toBeGreaterThan(200);
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

test("Upcoming refreshes when a routine is added or removed, even after a reconnect", async ({ page }) => {
  await openApp(page);
  const pane = page.getByTestId("work-pane");
  await expect(pane).toBeVisible();
  // The connection drops and comes back (e.g. Yo's server restarted), while the Workspace stays on screen.
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
          cron: "0 9 * * *",
        })
      ).id as string,
    agentId,
  );
  await expect(pane).toContainText("Check October programs");
  await page.evaluate(async (id) => (window as any).__yoMock.call("routine.delete", { id }), id);
  await expect(pane).not.toContainText("Check October programs");
});
