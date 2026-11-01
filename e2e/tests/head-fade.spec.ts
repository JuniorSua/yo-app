/**
 * The agent's head floats over the conversation (Dots). The messages scroll on under it, but the head, its name and
 * its status line sit on a solid ground: nothing shows behind them. Below the status line a short translucent,
 * softly blurred fade lets the chat show through as it scrolls away. The fade never swallows a click or a scroll.
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
    const status = el.querySelector(".chat-head-status")!;
    const s = getComputedStyle(status);
    const col = el.closest(".chat-column")!;
    return {
      fade: {
        image: fade.backgroundImage,
        blur: fade.backdropFilter || fade.getPropertyValue("-webkit-backdrop-filter"),
        mask: fade.maskImage || fade.getPropertyValue("-webkit-mask-image"),
        pointer: fade.pointerEvents,
        height: Number.parseFloat(fade.height),
      },
      status: {
        bg: s.backgroundColor,
        blur: s.backdropFilter || s.getPropertyValue("-webkit-backdrop-filter"),
      },
      // The whole zone (the fade layer's height) and its solid part (the box: the head's own area).
      headZone: Number.parseFloat(fade.height),
      headSolid: el.getBoundingClientRect().height,
      statusBottom: status.getBoundingClientRect().bottom - el.getBoundingClientRect().top,
      nameBottom:
        el.querySelector(".chat-head-name")!.getBoundingClientRect().bottom - el.getBoundingClientRect().top,
      feedTop: Number.parseFloat(getComputedStyle(col.querySelector(".chat-feed")!).paddingTop),
      box: el.getBoundingClientRect().toJSON() as DOMRect,
    };
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: the head zone is solid behind the head and its pills, then fades to translucent over the chat`, async ({
    page,
  }) => {
    await openApp(page, { theme });
    await expect(page.getByTestId("presence-header")).toBeVisible();
    const z = await zone(page);
    const a = alphas(z.fade.image);
    // Solid from the top to the end of the head's own area, then translucent: the chat shows through softly.
    expect(a[0]).toBe(1);
    expect(a[1]).toBe(1);
    expect(a.at(-1)!).toBeGreaterThanOrEqual(0.2);
    expect(a.at(-1)!).toBeLessThan(0.6);
    expect(z.fade.blur).toMatch(/blur\(/);
    expect(z.fade.mask).toMatch(/gradient/);
    expect(z.fade.pointer).toBe("none");
    expect(z.headZone - z.headSolid).toBeGreaterThanOrEqual(24);
    // The status line's pill: a near-solid backdrop of its own.
    const bg = alphas(z.status.bg);
    expect(bg[0]).toBeGreaterThanOrEqual(0.8);
    expect(z.status.blur).toMatch(/blur\(/);
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
  await expect.poll(top).toBeGreaterThan(400);
  const before = await top();
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -240);
  await expect.poll(top).toBeLessThan(before - 100);
  const mid = await top();
  await page.mouse.move(chat.x + 40, 80);
  await page.mouse.wheel(0, -240);
  await expect.poll(top).toBeLessThan(mid - 100);
});

test("nothing shows behind the head, the name or the status line: in big and short windows and on a phone", async ({
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
    // The solid part ends below the status pill (and so below the name), with a little air.
    expect(z.nameBottom, where).toBeLessThan(z.statusBottom);
    expect(z.statusBottom + 4, where).toBeLessThanOrEqual(z.headSolid);
    expect(z.headSolid - z.statusBottom, where).toBeLessThanOrEqual(16);
    // Then the fade, and at rest the first message starts under it, not behind it.
    expect(z.headZone - z.headSolid, where).toBeGreaterThanOrEqual(24);
    expect(z.feedTop, where).toBeGreaterThanOrEqual(z.headZone - 8);
  }
});

test("the head is big (about 136px drawn at 1440×900), smaller in a short window and on a phone", async ({
  page,
}) => {
  await openApp(page);
  const softie = page.getByTestId("presence-avatar").locator("svg").first();
  expect((await softie.boundingBox())!.width).toBe(176);
  await page.setViewportSize({ width: 1100, height: 720 });
  await expect.poll(async () => (await softie.boundingBox())!.width).toBe(148);
  await page.setViewportSize({ width: 1100, height: 600 });
  await expect.poll(async () => (await softie.boundingBox())!.width).toBe(120);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await softie.boundingBox())!.width).toBe(68);
  // The phone's zone still clears the status line, and the status line clears the first message's top.
  const z = await zone(page);
  const status = (await page.getByTestId("presence-line").boundingBox())!;
  expect(status.y + status.height).toBeLessThanOrEqual(z.headZone);
});
