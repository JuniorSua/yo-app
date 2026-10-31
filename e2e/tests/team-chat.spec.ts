import { expect, test } from "@playwright/test";
import { openAgent, openApp, send } from "./helpers";

test.describe("team chat", () => {
  test("shows both sides of an agent-to-agent exchange", async ({ page }) => {
    await openApp(page);
    await openAgent(page, "Pico");
    const exchange = page.getByTestId("team-exchange").first();
    await expect(exchange).toHaveAttribute("data-state", "replied");
    // One quiet row; the full exchange is behind a click.
    await exchange.getByTestId("team-toggle").click();
    await expect(exchange.getByTestId("team-ask")).toContainText("Which of the venues you found");
    await expect(exchange.getByTestId("team-reply")).toContainText("Casa Lupe");
    // Not hidden in the steps: no "Worked for" group for that turn.
    await expect(page.getByText(/Messaged Dew/)).toHaveCount(0);

    await exchange.getByTestId("team-open").click();
    await expect(page.getByTestId("agent-title")).toHaveText("Dew");
    const incoming = page.getByTestId("teammate-message");
    await expect(incoming).toContainText("Pico");
    await expect(incoming).toContainText("Which of the venues you found");
    // It arrives as Pico's message, not as one of yours (Dew's own chat has your requests too).
    await expect(page.getByTestId("user-message").filter({ hasText: "venues you found" })).toHaveCount(0);
  });

  test("a handoff is async: Messaged Dew now, and Dew's reply comes back a few seconds later", async ({
    page,
  }) => {
    await openApp(page);
    await send(page, "Ask Dew about the venue for Saturday");
    // Sent at once: the row doesn't wait for Dew, and Yo carries on.
    const live = page.getByTestId("team-exchange").last();
    await expect(live).toHaveAttribute("data-state", "later");
    await expect(page.getByText("I've handed this to Dew.")).toBeVisible();
    // Meanwhile Dew works on it in its own chat (the roster shows Dew working).
    const dew = () =>
      page.evaluate(() => {
        const a = (window as any).__yoMock.s.agents.find((x: any) => x.name === "Dew");
        return { activity: a.activity, statusLine: a.statusLine ?? null };
      });
    await expect.poll(async () => (await dew()).activity).toBe("working");
    await expect.poll(async () => (await dew()).statusLine).toBe("For Yo: the venue for Saturday");
    // Dew's reply lands in Yo's chat as a message from Dew on the same exchange, and Yo sums it up.
    await expect(page.getByText("Dew got back to me on the venue for Saturday")).toBeVisible({
      timeout: 20_000,
    });
    const reply = await page.evaluate(
      () => (window as any).__yoMock.s.timelines.agt_yo.find((e: any) => e.item.from?.reply)?.item,
    );
    expect(reply.from).toMatchObject({ name: "Dew", reply: true });
    expect(reply.from.exchangeId).toMatch(/^xch_/);
    expect(reply.text).toContain("Still open");
    await openAgent(page, "Dew");
    await expect(page.getByTestId("teammate-message").last()).toContainText("the venue for Saturday");
  });

  test("'… and wait' keeps the row waiting for the reply (wait: true)", async ({ page }) => {
    await openApp(page);
    await send(page, "Ask Dew to research venues for Saturday and wait");
    const live = page.getByTestId("team-exchange").last();
    await expect(live).toHaveAttribute("data-state", "waiting");
    await expect(live).toHaveAttribute("data-state", "replied", { timeout: 20_000 });
  });

  test("an agent can add a teammate once the user approves", async ({ page }) => {
    await openApp(page);
    await send(page, "Please add a new agent named Pepe, role Head of Polestar");
    const card = page.getByTestId("approval-card");
    await expect(card).toContainText("Add a new agent: Pepe, Head of Polestar");
    await expect(card.getByText("Always allow")).toHaveCount(0);
    await card.getByTestId("approve-once").click();
    // The new teammate joins the roster in the sidebar, says hello and asks one question about its job.
    await expect(page.getByTestId("roster").getByTestId("agent-row-Pepe")).toBeVisible();
    await openAgent(page, "Pepe");
    await expect(page.getByText("Hi, I'm Pepe, your Head of Polestar teammate!")).toBeVisible({
      timeout: 15_000,
    });
    const ask = page.getByTestId("ask-card");
    await expect(ask.getByTestId("ask-question")).toHaveCount(1);
    await expect(ask.getByTestId("ask-question")).toContainText("What should I focus on first?");
  });
});
