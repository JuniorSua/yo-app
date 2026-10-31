import { expect, type Page, test } from "@playwright/test";
import { openAgent, openApp, openInspector, openSettings, openWorkspacePage } from "./helpers";

/**
 * In the Mac app, a window-drag area (`app-region: drag`) moves the window instead of clicking, and Chromium
 * applies drag and no-drag areas in document order: a drag area later in the page covers a no-drag button that
 * came earlier, whatever the z-index. A plain browser ignores app-region, so every other spec clicks straight
 * through. This replays that order and lists each visible control that would sit under a drag area.
 */
async function controlsUnderDrag(page: Page) {
  return page.evaluate(() => {
    const regions: { drag: boolean; r: DOMRect; el: Element }[] = [];
    for (const el of document.querySelectorAll("*")) {
      const s = getComputedStyle(el);
      const v = s.getPropertyValue("app-region") || s.getPropertyValue("-webkit-app-region");
      if (v === "drag" || v === "no-drag")
        regions.push({ drag: v === "drag", r: el.getBoundingClientRect(), el });
    }
    /** The drag area that wins at this point, or null when the point is clickable. */
    const dragAt = (x: number, y: number) => {
      let by: Element | null = null;
      for (const { drag, r, el } of regions)
        if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) by = drag ? el : null;
      return by;
    };
    const bad: string[] = [];
    const controls = document.querySelectorAll(
      "button, a[href], input, select, textarea, [role='button'], [role='tab'], [role='menuitem'], [role='switch'], [role='option']",
    );
    for (const el of controls) {
      const b = el.getBoundingClientRect();
      if (b.width < 4 || b.height < 4) continue;
      const x = b.left + b.width / 2;
      const y = b.top + b.height / 2;
      const top = document.elementFromPoint(x, y);
      if (!top || !(el === top || el.contains(top))) continue; // hidden or covered by something else
      // The middle and four points a quarter in from the corners: a half-dead button counts too.
      const points = [
        [x, y],
        [b.left + b.width / 4, b.top + b.height / 4],
        [b.right - b.width / 4, b.top + b.height / 4],
        [b.left + b.width / 4, b.bottom - b.height / 4],
        [b.right - b.width / 4, b.bottom - b.height / 4],
      ];
      const by = points.map(([px, py]) => dragAt(px, py)).find(Boolean);
      if (by) {
        const name =
          el.getAttribute("data-testid") ||
          el.getAttribute("aria-label") ||
          el.textContent?.trim().slice(0, 40);
        bad.push(`${name || el.tagName} (under ${by.tagName.toLowerCase()}.${[...by.classList].join(".")})`);
      }
    }
    return { regions: regions.filter((r) => r.drag).length, bad };
  });
}

async function expectAllClickable(page: Page, where: string) {
  const { regions, bad } = await controlsUnderDrag(page);
  // The window has drag areas (rail top, sidebar head, chat top), so the check is really running.
  expect(regions, `${where}: no drag areas found`).toBeGreaterThan(0);
  expect(bad, `${where}: controls the Mac app can't click`).toEqual([]);
}

test.describe("Mac window: every visible button is clickable", () => {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1100, height: 720 },
  ]) {
    test(`chat, menus and pages at ${size.width}×${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      await openApp(page);
      await expectAllClickable(page, "Yo's chat");
      if (size.width >= 1440) {
        await openInspector(page);
        await expectAllClickable(page, "chat with the inspector");
      }

      await page.getByTestId("agent-options").click();
      await expect(page.getByTestId("new-session")).toBeVisible();
      await expectAllClickable(page, "the agent's ⋯ menu");
      await page.keyboard.press("Escape");

      await page.getByTestId("model-picker-trigger").click();
      await expectAllClickable(page, "the model picker");
      await page.keyboard.press("Escape");

      await openAgent(page, "Pico");
      await expectAllClickable(page, "Pico's chat");

      for (const name of ["tasks", "activity", "approvals", "routines", "memory", "artifacts"] as const) {
        await openWorkspacePage(page, name);
        await expectAllClickable(page, `the ${name} page`);
      }

      await openSettings(page);
      await expectAllClickable(page, "Settings");
      await page.getByTestId("settings-support").click();
      await expectAllClickable(page, "Settings → Support Yo");
    });
  }

  test("first run", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 720 });
    await openApp(page, { onboarded: false });
    await expectAllClickable(page, "onboarding");
  });
});
