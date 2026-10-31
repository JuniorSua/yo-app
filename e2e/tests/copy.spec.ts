import { expect, type Page, test } from "@playwright/test";
import { openApp, send } from "./helpers";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test("a code block in a Yo reply has a visible Copy button that copies just the block", async ({ page }) => {
  await openApp(page);
  await send(page, "What do I paste in terminal?");
  const reply = page.getByTestId("assistant-message").last();
  await expect(reply).toContainText("Tell me if you see an error", { timeout: 15_000 });
  const copy = reply.getByTestId("code-block").getByTestId("copy-code");
  // Shown without hovering, so it works on touch.
  await page.mouse.move(0, 0);
  await expect(copy).toBeVisible();
  await expect(copy).toHaveText("Copy");
  await copy.click();
  await expect(copy).toHaveAttribute("data-copied", "true");
  await expect(copy).toHaveText("Copied");
  expect(await clipboard(page)).toBe("brew install --cask yo && open -a Yo");
  // The check goes back to "Copy" after a moment.
  await expect(copy).toHaveText("Copy", { timeout: 4_000 });
});

test("the code block's Copy button works from the keyboard", async ({ page }) => {
  await openApp(page);
  await send(page, "Open terminal please");
  const reply = page.getByTestId("assistant-message").last();
  await expect(reply).toContainText("Tell me if you see an error", { timeout: 15_000 });
  await expect(page.getByTestId("status-pill").first()).toHaveText(/Done|Ready/);
  const copy = reply.getByTestId("copy-code");
  await copy.focus();
  await expect(copy).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(copy).toHaveAttribute("data-copied", "true");
  expect(await clipboard(page)).toBe("brew install --cask yo && open -a Yo");
});

test("a finished reply has its own Copy button that copies the whole reply", async ({ page }) => {
  await openApp(page);
  await send(page, "What do I paste in terminal?");
  const reply = page.getByTestId("assistant-message").last();
  await expect(reply).toContainText("Tell me if you see an error", { timeout: 15_000 });
  const copy = reply.getByTestId("copy-reply");
  // Shown without hovering, so it works on touch, and below the text instead of over it.
  await page.mouse.move(0, 0);
  await expect(copy).toBeVisible();
  await expect(copy).toHaveAccessibleName("Copy reply");
  const button = await copy.boundingBox();
  const block = await reply.getByTestId("code-block").boundingBox();
  expect(button && block && button.y >= block.y + block.height).toBe(true);
  await copy.click();
  await expect(copy).toHaveAttribute("data-copied", "true");
  const copied = await clipboard(page);
  expect(copied).toContain("brew install --cask yo && open -a Yo");
  expect(copied).toContain("Tell me if you see an error");
});

test("every finished reply in the chat can be copied", async ({ page }) => {
  await openApp(page);
  const replies = page.getByTestId("assistant-message");
  await expect(replies.last()).toBeVisible();
  const n = await replies.count();
  await expect(page.getByTestId("copy-reply")).toHaveCount(n);
});

test("a drafted message shows as wrapped text, with Copy on its own bar above it", async ({ page }) => {
  await openApp(page);
  await send(page, "Draft a reply to Michael");
  const reply = page.getByTestId("assistant-message").last();
  await expect(reply).toContainText("change anything", { timeout: 15_000 });
  const block = reply.getByTestId("code-block");
  await expect(block).toHaveAttribute("data-kind", "text");
  await expect(block).toContainText("Text");
  // Wraps instead of scrolling sideways, and the button sits above the text instead of over it.
  const pre = block.locator("pre");
  expect(await pre.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const button = await block.getByTestId("copy-code").boundingBox();
  const text = await pre.boundingBox();
  expect(button && text && button.y + button.height <= text.y).toBe(true);
  await block.getByTestId("copy-code").click();
  expect(await clipboard(page)).toMatch(/^Great, Michael! .*Saturday morning\?$/);
});

test("a command keeps its terminal look", async ({ page }) => {
  await openApp(page);
  await send(page, "What do I paste in terminal?");
  const block = page.getByTestId("assistant-message").last().getByTestId("code-block");
  await expect(block).toHaveAttribute("data-kind", "code", { timeout: 15_000 });
  await expect(block).toContainText("Terminal");
});
