/**
 * The agent's head floats over the conversation (Dots). The messages scroll on under it, but the head and its name
 * card sit on the page's own opaque ground: nothing shows behind them. Below them a short fade eases the chat
 * out: a plain gradient to transparent, no blur and no tint, so nothing behind it is ever smeared. The fade never
 * swallows a click or a scroll.
 */
import { expect, type Page, test } from "@playwright/test";
import { openApp } from "./helpers";

/** The alpha of every colour in a computed `background-image` (rgb(), rgba(), color(srgb … / a), color-mix()). */
function alphas(image: string): number[] {
  const out: number[] = [];
  const re =
    /color-mix\(in srgb, (?:rgba?\([^)]*\)|#\w+|\w+) (\d+(?:\.\d+)?)%, transparent\)|rgba?\([^)]*\)|color\([^)]*\)/g;
  for (const m of image.matchAll(re)) {
    const c = m[0];
    if (c.startsWith("color-mix")) out.push(Number(m[1]) / 100);
    else if (c.startsWith("rgba")) out.push(Number(c.slice(5, -1).split(",")[3]));
    else if (c.startsWith("rgb(")) out.push(c.includes("/") ? Number(c.split("/")[1]!.replace(")", "")) : 1);
    else out.push(c.includes("/") ? Number(c.split("/")[1]!.replace(")", "")) : 1);
  }
  return out;
}

async function zone(page: Page) {
  return page.locator(".chat-top.has-head").evaluate((el) => {
    const fade = getComputedStyle(el, "::before");
    const card = el.querySelector(".chat-head-card")!;
    const c = getComputedStyle(el.querySelector(".chat-head-name")!);
    const col = el.closest(".chat-column")!;
    const top = el.getBoundingClientRect().top;
    return {
      fade: {
        image: fade.backgroundImage,
        blur: fade.backdropFilter || fade.getPropertyValue("-webkit-backdrop-filter") || "none",
        mask: fade.maskImage || fade.getPropertyValue("-webkit-mask-image") || "none",
        pointer: fade.pointerEvents,
      },
      card: {
        bg: c.backgroundColor,
        blur: c.backdropFilter || c.getPropertyValue("-webkit-backdrop-filter") || "none",
      },
      // The whole zone (the fade layer's height) and its solid part (the box: the head's own area).
      headZone: Number.parseFloat(fade.height),
      headSolid: el.getBoundingClientRect().height,
      cardBottom: card.getBoundingClientRect().bottom - top,
      nameBottom: el.querySelector(".chat-head-name")!.getBoundingClientRect().bottom - top,
      statusBottom: el.querySelector(".chat-head-status")!.getBoundingClientRect().bottom - top,
      feedTop: Number.parseFloat(getComputedStyle(col.querySelector(".chat-feed")!).paddingTop),
      box: el.getBoundingClientRect().toJSON() as DOMRect,
    };
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: the head zone is opaque behind the head and its card, then a short soft fade with no blur`, async ({
    page,
  }) => {
    await openApp(page, { theme });
    await expect(page.getByTestId("presence-header")).toBeVisible();
    const z = await zone(page);
    const a = alphas(z.fade.image);
    // Opaque from the top to the end of the head's own area, then down to nothing, never back up.
    expect(a[0]).toBe(1);
    expect(a[1]).toBe(1);
    expect(a.at(-1)!).toBe(0);
    for (let i = 1; i < a.length; i++) expect(a[i]!).toBeLessThanOrEqual(a[i - 1]!);
    // No material: nothing behind the fade is blurred or masked into a smear.
    expect(z.fade.blur).toBe("none");
    expect(z.fade.mask).toBe("none");
    expect(z.fade.pointer).toBe("none");
    // A short edge, so the top rows stay readable: 16–24px.
    expect(z.headZone - z.headSolid).toBeGreaterThanOrEqual(16);
    expect(z.headZone - z.headSolid).toBeLessThanOrEqual(24);
    // The name pill: opaque, no blur.
    expect(alphas(z.card.bg)[0]).toBe(1);
    expect(z.card.blur).toBe("none");
  });
}

test("the fade lets clicks and scrolls through to the chat; the head and its pills still take the pointer", async ({
  page,
}) => {
  await openApp(page);
  const timeline = page.getByTestId("timeline");
  await expect(page.getByTestId("presence-header")).toBeVisible();
  const z = await zone(page);
  const chat = (await page.locator(".chat-column").boundingBox())!;
  // Below the near-solid part (the drag area) and inside the fade, away from the head's pills: that's the chat.
  const x = chat.x + 40;
  const y = z.box.bottom + 12;
  expect(y).toBeLessThan(z.headZone);
  const under = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('[data-testid="timeline"]'),
    [x, y],
  );
  expect(under).toBe(true);
  // The head, the name and the status line are hit-testable.
  for (const id of ["presence-avatar", "agent-title", "presence-line"]) {
    const b = (await page.getByTestId(id).boundingBox())!;
    const hit = await page.evaluate(
      ([x, y, id]) => !!document.elementFromPoint(Number(x), Number(y))?.closest(`[data-testid="${id}"]`),
      [b.x + b.width / 2, b.y + b.height / 2, id] as const,
    );
    expect(hit, id).toBe(true);
  }
  // A wheel over the fade, and over the solid top beside the head, scrolls the chat.
  const top = () => timeline.evaluate((el) => el.scrollTop);
  // Room to scroll up twice.
  await expect.poll(top).toBeGreaterThan(300);
  const before = await top();
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -240);
  await expect.poll(top).toBeLessThan(before - 100);
  const mid = await top();
  await page.mouse.move(chat.x + 40, 80);
  await page.mouse.wheel(0, -240);
  await expect.poll(top).toBeLessThan(mid - 100);
});

test("nothing shows behind the head or its name card: in big and short windows and on a phone", async ({
  page,
}) => {
  await openApp(page);
  await expect(page.getByTestId("presence-header")).toBeVisible();
  for (const [width, height] of [
    [1440, 900],
    [1100, 720],
    [1100, 600],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    const z = await zone(page);
    const where = `${width}×${height}`;
    // The name, then the status line, both on the card; the solid part ends below the card with a little air.
    expect(z.nameBottom, where).toBeLessThan(z.statusBottom);
    expect(z.statusBottom, where).toBeLessThanOrEqual(z.cardBottom);
    expect(z.cardBottom + 4, where).toBeLessThanOrEqual(z.headSolid);
    expect(z.headSolid - z.cardBottom, where).toBeLessThanOrEqual(16);
    // Then the fade, and at rest the first message starts under it, not behind it.
    expect(z.headZone - z.headSolid, where).toBeGreaterThanOrEqual(16);
    expect(z.feedTop, where).toBeGreaterThanOrEqual(z.headZone - 8);
  }
});

test("the head is Dots' size (a 104px box, about 80px drawn at 1440×900), smaller in a short window and on a phone", async ({
  page,
}) => {
  await openApp(page);
  const softie = page.getByTestId("presence-avatar").locator("svg").first();
  expect((await softie.boundingBox())!.width).toBe(104);
  await page.setViewportSize({ width: 1100, height: 720 });
  await expect.poll(async () => (await softie.boundingBox())!.width).toBe(96);
  await page.setViewportSize({ width: 1100, height: 600 });
  await expect.poll(async () => (await softie.boundingBox())!.width).toBe(84);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await softie.boundingBox())!.width).toBe(64);
  // The phone's zone still clears the status line, and the status line clears the first message's top.
  const z = await zone(page);
  const status = (await page.getByTestId("presence-line").boundingBox())!;
  expect(status.y + status.height).toBeLessThanOrEqual(z.headZone);
});
