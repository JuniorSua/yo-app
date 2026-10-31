import { expect, type Page, test } from "@playwright/test";
import { openAgent, openApp } from "./helpers";

/** Adds a reply to the primary agent's chat through the mock backend (same id: it grows, like streaming). */
async function addReply(page: Page, id: string, text: string, status = "completed") {
  await page.evaluate(
    ({ id, text, status }) => {
      const m = (window as any).__yoMock;
      const agentId = m.s.agents.find((a: { isPrimary: boolean }) => a.isPrimary).id;
      const existing = m.s.timelines[agentId]?.find((e: { id: string }) => e.id === id);
      const item = { id: `it_${id}`, kind: "assistant_message", text, status };
      m.upsert(existing ? { ...existing, item } : { ...m.entry(agentId, item, { turnId: `trn_${id}` }), id });
    },
    { id, text, status },
  );
}

/** Scrolls the chat to the top and waits until the app has seen the scroll (it handles scroll events a frame later). */
async function scrollToTop(page: Page) {
  await page.getByTestId("timeline").evaluate(
    (el) =>
      new Promise<void>((done) => {
        el.addEventListener("scroll", () => requestAnimationFrame(() => done()), { once: true });
        el.scrollTo({ top: 0 });
      }),
  );
}

test("replies that arrive while scrolled up are counted on the pill", async ({ page }) => {
  await openApp(page);
  const long = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long reply.`).join("\n\n");
  await addReply(page, "seed", long);
  await expect(page.getByTestId("assistant-message").last()).toContainText("Line 40");
  await expect(page.getByTestId("jump-latest")).toHaveCount(0);

  await scrollToTop(page);
  await addReply(page, "a", "First", "running");
  await expect(page.getByTestId("jump-latest")).toHaveText("1 new message");
  // The same reply streaming in more text is still one message.
  await addReply(page, "a", "First, and then some more words");
  await addReply(page, "b", "Second");
  await expect(page.getByTestId("jump-latest")).toHaveText("2 new messages");
  await expect(page.getByTestId("jump-latest")).toHaveAccessibleName("2 new messages. Jump to latest");

  await page.getByTestId("jump-latest").click();
  await expect(page.getByTestId("jump-latest")).toHaveCount(0);
  // The pill glides the chat down: let it land before scrolling up again.
  await expect
    .poll(() =>
      page.getByTestId("timeline").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    )
    .toBeLessThan(2);
  await scrollToTop(page);
  await addReply(page, "c", "Third");
  await expect(page.getByTestId("jump-latest")).toHaveText("1 new message");
});

test("a chat opened with an unread reply marks where it starts", async ({ page }) => {
  await openApp(page);
  // Dew finished a task while we were elsewhere: the line sits right above that task.
  await openAgent(page, "Dew");
  const divider = page.getByTestId("unread-divider");
  await expect(divider).toHaveText("New");
  await expect(
    divider.locator("xpath=following-sibling::div[1]").getByTestId("activity-group"),
  ).toBeVisible();
  // Read now: coming back to the chat doesn't draw it again.
  await openAgent(page, "Yo");
  await openAgent(page, "Dew");
  await expect(page.getByTestId("timeline")).toBeVisible();
  await expect(divider).toHaveCount(0);
});
