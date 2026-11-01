import { expect, test } from "@playwright/test";
import { openAgent, openApp, openTeam, send } from "./helpers";

test.describe("team chat", () => {
  test("an exchange is two calm rows (asked, reported); a click opens the specialist's view", async ({
    page,
  }) => {
    await openApp(page);
    await openAgent(page, "Pico");
    const exchange = page.getByTestId("team-exchange").first();
    await expect(exchange).toHaveAttribute("data-state", "replied");
    await expect(exchange.getByTestId("team-ask-row")).toContainText(
      "Asked Dew: Which of the venues you found can seat 12 on Saturday night",
    );
    await expect(exchange.getByTestId("team-reply-row")).toContainText("Dew: Two can seat 12 on Saturday");
    // Not chat bubbles, and not hidden in the steps: no "Worked for" group for that turn.
    await expect(page.getByText(/Messaged Dew/)).toHaveCount(0);

    await exchange.getByTestId("team-reply-row").click();
    await expect(page.getByTestId("agent-title")).toHaveText("Dew");
    await expect(page.getByTestId("specialist-bar")).toBeVisible();
    const incoming = page.getByTestId("teammate-message");
    await expect(incoming).toContainText("Pico");
    await expect(incoming).toContainText("Which of the venues you found");
    // It arrives as Pico's message, not as one of yours (Dew's own view has your old requests too).
    await expect(page.getByTestId("user-message").filter({ hasText: "venues you found" })).toHaveCount(0);
  });

  test("a handoff is async: Asked Dew now, and Dew's report comes back a few seconds later", async ({
    page,
  }) => {
    await openApp(page);
    await send(page, "Ask Dew about the venue for Saturday");
    // Sent at once: the row doesn't wait for Dew, and Yo carries on.
    const live = page.getByTestId("team-exchange").last();
    await expect(live).toHaveAttribute("data-state", "later");
    await expect(live.getByTestId("team-ask-row")).toContainText(
      "Asked Dew: look into the venue for Saturday",
    );
    await expect(page.getByText("I've handed this to Dew.")).toBeVisible();
    // Meanwhile Dew works on it in its own view (its face by Yo's head shows it working).
    const dew = () =>
      page.evaluate(() => {
        const a = (window as any).__yoMock.s.agents.find((x: any) => x.name === "Dew");
        return { activity: a.activity, statusLine: a.statusLine ?? null };
      });
    await expect.poll(async () => (await dew()).activity).toBe("working");
    await expect.poll(async () => (await dew()).statusLine).toBe("For Yo: the venue for Saturday");
    // Dew's report folds into the same exchange (the row says what Dew found), and Yo sums it up.
    await expect(page.getByText("Dew got back to me on the venue for Saturday")).toBeVisible({
      timeout: 20_000,
    });
    await expect(live).toHaveAttribute("data-state", "replied");
    await expect(live.getByTestId("team-reply-row")).toContainText("Dew: Here's what I found on");
    await expect(live.getByTestId("team-unread")).toBeVisible();
    const reply = await page.evaluate(
      () => (window as any).__yoMock.s.timelines.agt_yo.find((e: any) => e.item.from?.reply)?.item,
    );
    expect(reply.from).toMatchObject({ name: "Dew", reply: true });
    expect(reply.from.exchangeId).toMatch(/^xch_/);
    expect(reply.text).toContain("Still open");
    await live.getByTestId("team-ask-row").click();
    await expect(page.getByTestId("agent-title")).toHaveText("Dew");
    await expect(page.getByTestId("teammate-message").last()).toContainText("the venue for Saturday");
  });

  test("'… and wait' keeps the row waiting for the report (wait: true)", async ({ page }) => {
    await openApp(page);
    await send(page, "Ask Dew to research venues for Saturday and wait");
    const live = page.getByTestId("team-exchange").last();
    await expect(live).toHaveAttribute("data-state", "waiting");
    await expect(live.getByTestId("team-waiting")).toBeVisible();
    await expect(live).toHaveAttribute("data-state", "replied", { timeout: 20_000 });
  });

  test("Yo routes 'take care of pending leads' to Pepe: his face works by Yo's, then he reports", async ({
    page,
  }) => {
    await openApp(page, { query: "mockTeam=owner" });
    await send(page, "Take care of pending leads");
    const live = page.getByTestId("team-exchange").last();
    await expect(live.getByTestId("team-ask-row")).toContainText("Asked Pepe: follow up pending leads");
    // Pepe's small face by Yo's head picks up a working ring while he's on it.
    const faces = page.getByTestId("chat-team");
    await expect(faces.locator('[data-testid="team-face"][data-working]')).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(live.getByTestId("team-reply-row")).toContainText("Pepe: 3 leads followed up", {
      timeout: 20_000,
    });
    await expect(page.getByText("Pepe followed up all 3 pending leads")).toBeVisible({ timeout: 20_000 });
    await expect(faces.locator('[data-testid="team-face"][data-working]')).toHaveCount(0);
    // A click opens Pepe's view: what Yo asked and the work he did, read-only.
    await live.getByTestId("team-reply-row").click();
    await expect(page.getByTestId("agent-title")).toHaveText("Pepe");
    await expect(page.getByTestId("teammate-message")).toContainText("follow up pending leads");
    await expect(page.getByTestId("assistant-message").last()).toContainText("3 leads followed up");
  });

  test("an agent can add a specialist once the user approves", async ({ page }) => {
    await openApp(page);
    await send(page, "Please add a new agent named Pepe, role Head of Polestar");
    const card = page.getByTestId("approval-card");
    await expect(card).toContainText("Add a new agent: Pepe, Head of Polestar");
    await expect(card.getByText("Always allow")).toHaveCount(0);
    await card.getByTestId("approve-once").click();
    // The new specialist joins the Team popover, says hello and asks one question about its job.
    await expect((await openTeam(page)).getByTestId("agent-row-Pepe")).toBeVisible();
    await openAgent(page, "Pepe");
    await expect(page.getByText("Hi, I'm Pepe, your Head of Polestar teammate!")).toBeVisible({
      timeout: 15_000,
    });
    const ask = page.getByTestId("ask-card");
    await expect(ask.getByTestId("ask-question")).toHaveCount(1);
    await expect(ask.getByTestId("ask-question")).toContainText("What should I focus on first?");
  });
});
