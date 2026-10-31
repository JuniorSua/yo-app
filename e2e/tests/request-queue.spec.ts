import { expect, type Page, test } from "@playwright/test";
import { openApp } from "./helpers";

/** Yo busy on a long task (`&mockBusy=1`, or `queue` with two messages already waiting in Up next). */
async function openBusy(page: Page, opts: { queue?: boolean; theme?: "light" | "dark" } = {}) {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto(
    `/?mock=1&fast=1&onboarded=1&mockBusy=${opts.queue ? "queue" : "1"}${opts.theme ? `&theme=${opts.theme}` : ""}`,
  );
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("agent-title")).toHaveText("Yo");
}

const upNextTexts = (page: Page) => page.getByTestId("up-next-text");

async function capture(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}

test("⌘N focuses the message box (keeping its draft), and Enter sends when Yo is free", async ({ page }) => {
  await openApp(page);
  // Wait out the seed's brief "working" so Yo is free.
  await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", "Message Yo…");
  // No separate New request button or box: the message box is the one place to ask.
  await expect(page.getByTestId("new-request")).toHaveCount(0);
  await page.getByTestId("composer-input").fill("Find a plumber for Saturday morning");
  await page.getByTestId("composer-input").blur();

  // ⌘N (Ctrl+N elsewhere) brings you back to it, draft intact.
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(page.getByTestId("composer-input")).toHaveValue("Find a plumber for Saturday morning");
  await expect(page.getByTestId("request-box")).toHaveCount(0);
  // The palette's New request does the same.
  await page.getByTestId("composer-input").blur();
  await page.keyboard.press("ControlOrMeta+k");
  await page
    .getByTestId("command-palette")
    .getByRole("button", { name: /New request/ })
    .click();
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByTestId("user-message").last()).toContainText("Find a plumber for Saturday morning");
  await expect(page.getByTestId("composer-input")).toHaveValue("");
  expect(await page.evaluate(() => (window as any).__yoMock.sends.at(-1).text)).toBe(
    "Find a plumber for Saturday morning",
  );
});

test("While Yo is busy, the message box queues; Up next edits, reorders and cancels", async ({ page }) => {
  await openBusy(page);
  const input = page.getByTestId("composer-input");
  await expect(input).toHaveAttribute("placeholder", "Queue a message for Yo…");

  // Enter = Queue.
  await input.fill("Draft an email to the landlord");
  await expect(page.getByTestId("composer-busy-hint")).toContainText("Enter to queue");
  await input.press("Enter");
  await expect(page.getByTestId("up-next")).toContainText("Up next (1)");
  // Queued messages wait in Up next, not in the chat.
  await expect(page.getByTestId("user-message").filter({ hasText: "Draft an email" })).toHaveCount(0);

  await input.fill("Remind me to call Mom");
  await input.press("Enter");
  await input.fill("Book a haircut");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("up-next")).toContainText("Up next (3)");
  await expect(upNextTexts(page)).toHaveText([
    "Draft an email to the landlord",
    "Remind me to call Mom",
    "Book a haircut",
  ]);

  // Edit the first.
  const items = page.getByTestId("up-next-item");
  await items.nth(0).getByTestId("up-next-edit").click();
  await page.getByTestId("up-next-edit-input").fill("Draft a short, friendly email to the landlord");
  await page.getByTestId("up-next-edit-input").press("Enter");
  await expect(upNextTexts(page).first()).toHaveText("Draft a short, friendly email to the landlord");

  // Move the last one up, then the first one down.
  await items.nth(2).getByTestId("up-next-up").click();
  await expect(upNextTexts(page)).toHaveText([
    "Draft a short, friendly email to the landlord",
    "Book a haircut",
    "Remind me to call Mom",
  ]);
  await items.nth(0).getByTestId("up-next-down").click();
  await expect(upNextTexts(page)).toHaveText([
    "Book a haircut",
    "Draft a short, friendly email to the landlord",
    "Remind me to call Mom",
  ]);

  // Cancel one.
  await items.nth(2).getByTestId("up-next-cancel").click();
  await expect(page.getByTestId("up-next")).toContainText("Up next (2)");
  await expect(upNextTexts(page)).toHaveText([
    "Book a haircut",
    "Draft a short, friendly email to the landlord",
  ]);

  // When the task ends, the line runs in that order, each joining the chat as it starts.
  await page.evaluate(() => (window as any).__yoMock.finishBusy());
  await expect(page.getByTestId("user-message").filter({ hasText: "Book a haircut" })).toBeVisible();
  await expect(page.getByTestId("up-next")).toContainText("Up next (1)");
  await expect(page.getByTestId("user-message").filter({ hasText: "friendly email" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("up-next")).toHaveCount(0);
  await expect(page.getByTestId("user-message").filter({ hasText: "Remind me to call Mom" })).toHaveCount(0);
});

test("Steer sends a message into the running task, from the message box or from Up next", async ({
  page,
}) => {
  await openBusy(page, { queue: true });
  await expect(upNextTexts(page)).toHaveCount(2);

  // From the message box: ⌘Enter steers.
  await page.getByTestId("composer-input").fill("Only desks that ship to Lisbon");
  await page.getByTestId("composer-input").press("ControlOrMeta+Enter");
  const steered = page.getByTestId("user-message").filter({ hasText: "Only desks that ship to Lisbon" });
  await expect(steered).toBeVisible();
  await expect(steered.getByTestId("steered-label")).toHaveText("Sent mid-task");
  await expect(page.getByText("Got it — only desks that ship to Lisbon")).toBeVisible();
  await expect(page.getByTestId("agent-title")).toHaveText("Yo");
  await expect(upNextTexts(page)).toHaveCount(2);

  // From Up next: Steer now on the second waiting message.
  await page.getByTestId("up-next-item").nth(1).getByTestId("up-next-steer").click();
  await expect(
    page.getByTestId("user-message").filter({ hasText: "Remind me to call Mom at 6" }),
  ).toBeVisible();
  await expect(page.getByText("Got it — remind me to call Mom at 6")).toBeVisible();
  await expect(page.getByTestId("up-next")).toContainText("Up next (1)");
  // Still the same task: Yo keeps working.
  await expect(page.getByTestId("stop-button")).toBeVisible();
});

test("Send again to steer: with the box empty, Steer (or Enter) sends the newest waiting message into the task", async ({
  page,
}) => {
  await openBusy(page, { queue: true });
  await expect(upNextTexts(page)).toHaveCount(2);
  const input = page.getByTestId("composer-input");
  const steer = page.getByTestId("steer-button");
  // Typing turns it back into Send (Enter queues); an empty box offers Steer beside Stop.
  await input.fill("Book a haircut");
  await expect(steer).toHaveCount(0);
  await input.fill("");
  await expect(steer).toBeVisible();
  await expect(page.getByTestId("stop-button")).toBeVisible();

  // The newest one ("Remind me to call Mom at 6") goes in; a double tap steers it once.
  await steer.dblclick();
  await expect(page.getByText("Got it — remind me to call Mom at 6")).toBeVisible();
  await expect(upNextTexts(page)).toHaveText([/^Then draft a short email/]);
  await expect(page.getByTestId("user-message").filter({ hasText: "Then draft a short email" })).toHaveCount(
    0,
  );

  // Enter on the empty box does the same for what's left.
  await input.focus();
  await input.press("Enter");
  await expect(page.getByTestId("up-next")).toHaveCount(0);
  await expect(
    page
      .getByTestId("user-message")
      .filter({ hasText: "Then draft a short email" })
      .getByTestId("steered-label"),
  ).toHaveText("Sent mid-task");
  // Nothing left to steer: just Stop. Yo is still on the same task.
  await expect(steer).toHaveCount(0);
  await expect(page.getByTestId("stop-button")).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`Up next and the busy message box look right (${theme})`, async ({ page }) => {
    await openBusy(page, { queue: true, theme });
    await expect(upNextTexts(page)).toHaveCount(2);
    await capture(page, `up-next-${theme}`);
    await page.getByTestId("composer-input").fill("Only desks that ship to Lisbon");
    await expect(page.getByTestId("composer-busy-hint")).toBeVisible();
    await capture(page, `composer-busy-${theme}`);
    await expect(page.getByTestId("up-next")).toBeVisible();
  });
}

test("On the Mac's native glass, Up next is a glass card like the message box, with nothing painted behind", async ({
  page,
}) => {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.dataset.nativeGlass = "true";
    });
  });
  await openBusy(page, { queue: true, theme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-native-glass", "true");
  const bg = (testId: string) =>
    page.getByTestId(testId).evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(page.getByTestId("up-next")).toBeVisible();
  expect(await bg("up-next")).toBe(await bg("composer"));
  // Its column (shared with the message box) paints no band of its own across the chat.
  const column = await page.getByTestId("up-next").evaluate((el) =>
    [el.parentElement!, el.parentElement!.parentElement!].map((p) => {
      const s = getComputedStyle(p);
      return { backgroundColor: s.backgroundColor, backgroundImage: s.backgroundImage };
    }),
  );
  for (const s of column) {
    expect(s.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(s.backgroundImage).toBe("none");
  }
  await capture(page, "up-next-native-glass");
});
