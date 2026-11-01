/**
 * The chat column beside the workspace can be dragged wider or narrower by its edge (a focusable separator), from
 * 360px to 60% of the window. Arrow keys, Home and End move it too; a double-click puts the default back, and the
 * width is remembered.
 */
import { expect, type Page, test } from "@playwright/test";

/** Yo's chat with the workspace open; storage is cleared once, so a reload keeps what the test saved. */
async function open(page: Page, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    if (sessionStorage.getItem("resize-e2e")) return;
    sessionStorage.setItem("resize-e2e", "1");
    localStorage.removeItem("yo.ui");
  });
  await page.goto("/?mock=1&fast=1&onboarded=1");
  await expect(page.getByTestId("workspace")).toBeVisible();
  const handle = page.getByTestId("chat-resizer");
  await expect(handle).toBeVisible();
  return handle;
}

const chatWidth = async (page: Page) => Math.round((await page.locator("#chat-column").boundingBox())!.width);
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("yo.ui") ?? "{}").chatWidth ?? null);

/** Drag the handle sideways by `dx` with the mouse, in a few steps like a real hand. */
async function dragBy(page: Page, dx: number) {
  const box = (await page.getByTestId("chat-resizer").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test("drag the chat's edge to resize it, within 360px and 60% of the window, and it's remembered", async ({
  page,
}) => {
  const handle = await open(page);
  // The default: clamp(400px, 48vw, 700px) = 691px at 1440.
  expect(await chatWidth(page)).toBe(691);
  await expect(handle).toHaveAttribute("role", "separator");
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  await expect(handle).toHaveAttribute("aria-valuemin", "360");
  await expect(handle).toHaveAttribute("aria-valuemax", "864");
  await expect(handle).toHaveAttribute("aria-valuenow", "691");

  await dragBy(page, -120);
  await expect.poll(() => chatWidth(page)).toBe(571);
  await expect(handle).toHaveAttribute("aria-valuenow", "571");
  expect(await saved(page)).toBe(571);
  // The workspace takes the rest, and the handle follows the seam.
  const ws = (await page.getByTestId("workspace").boundingBox())!;
  const chat = (await page.locator("#chat-column").boundingBox())!;
  expect(Math.round(ws.x)).toBe(Math.round(chat.x + chat.width));
  const h = (await handle.boundingBox())!;
  expect(h.x).toBeLessThan(ws.x);
  expect(h.x + h.width).toBeGreaterThan(ws.x);

  // Never narrower than 360px, never wider than 60% of the window.
  await dragBy(page, -400);
  await expect.poll(() => chatWidth(page)).toBe(360);
  await dragBy(page, 900);
  await expect.poll(() => chatWidth(page)).toBe(864);

  // Remembered across a reload.
  await page.reload();
  await expect(page.getByTestId("chat-resizer")).toBeVisible();
  await expect.poll(() => chatWidth(page)).toBe(864);

  // A double-click puts the default back.
  await page.getByTestId("chat-resizer").dblclick();
  await expect.poll(() => chatWidth(page)).toBe(691);
  expect(await saved(page)).toBeNull();
});

test("the keyboard resizes the chat too: arrows (Shift for more), Home, End and Enter", async ({ page }) => {
  const handle = await open(page);
  await handle.focus();
  await expect(handle).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => chatWidth(page)).toBe(707);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => chatWidth(page)).toBe(643);
  await expect(handle).toHaveAttribute("aria-valuenow", "643");
  await page.keyboard.press("Home");
  await expect.poll(() => chatWidth(page)).toBe(360);
  await page.keyboard.press("End");
  await expect.poll(() => chatWidth(page)).toBe(864);
  await page.keyboard.press("Enter");
  await expect.poll(() => chatWidth(page)).toBe(691);
  expect(await saved(page)).toBeNull();
});

test("a saved width still fits a smaller window, and the handle is gone without the workspace", async ({
  page,
}) => {
  await open(page);
  await page.getByTestId("chat-resizer").focus();
  await page.keyboard.press("End");
  await expect.poll(() => chatWidth(page)).toBe(864);
  // 60% of 1100 is 660: the workspace keeps the rest.
  await page.setViewportSize({ width: 1100, height: 720 });
  await expect.poll(() => chatWidth(page)).toBe(660);
  await expect(page.getByTestId("chat-resizer")).toHaveAttribute("aria-valuemax", "660");
  // Workspace closed: the chat is centred and there's nothing to drag.
  await page.getByTestId("toggle-workspace").click();
  await expect(page.getByTestId("workspace")).toHaveCount(0);
  await expect(page.getByTestId("chat-resizer")).toHaveCount(0);
  // Narrow windows open the workspace as a sheet: no handle there either.
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.getByTestId("toggle-workspace").click();
  await expect(page.getByTestId("workspace")).toBeVisible();
  await expect(page.getByTestId("chat-resizer")).toHaveCount(0);
});
