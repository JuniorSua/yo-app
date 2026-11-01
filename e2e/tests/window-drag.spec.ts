import { expect, type Page, test } from "@playwright/test";
import {
  openAgent,
  openApp,
  openProfile,
  openSettings,
  openTeam,
  openWorkspace,
  openWorkspacePage,
} from "./helpers";

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
      "button, a[href], input, select, textarea, [role='button'], [role='tab'], [role='menuitem'], [role='switch'], [role='option'], [role='separator'][tabindex]",
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
  // The window has drag areas (rail top, chat top, the workspace tab strip), so the check is really running.
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
      if (size.width >= 1100) {
        const workspace = await openWorkspace(page);
        await expectAllClickable(page, "chat with the workspace");
        // The full-screen computer (a dialog with its own drag strip) and its Take over / Close.
        await workspace.getByTestId("ws-watch").click();
        await expect(page.getByTestId("computer-overlay")).toBeVisible();
        await expectAllClickable(page, "the full-screen computer");
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("computer-overlay")).toHaveCount(0);
      }

      await openProfile(page);
      await expectAllClickable(page, "the profile popover");
      await page.keyboard.press("Escape");

      await openTeam(page);
      await expectAllClickable(page, "the Team popover");
      await page.keyboard.press("Escape");

      await page.getByTestId("model-picker-trigger").click();
      await expectAllClickable(page, "the model picker");
      await page.keyboard.press("Escape");

      await openAgent(page, "Pico");
      await expectAllClickable(page, "Pico's chat");

      for (const name of ["tasks", "activity", "approvals", "routines", "memory", "artifacts"] as const) {
        await openWorkspacePage(page, name);
        await expectAllClickable(page, `the ${name} page`);
        if (name === "memory") {
          // The confirm step before a delete.
          const row = page.getByTestId("memory-row").first();
          await row.hover();
          await row.getByTestId("memory-delete").click();
          await expect(page.getByTestId("confirm-dialog")).toBeVisible();
          await expectAllClickable(page, "the confirm dialog");
          await page.keyboard.press("Escape");
          await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
        }
      }

      await openSettings(page);
      await expectAllClickable(page, "Settings");
      await page.getByTestId("settings-support").click();
      await expectAllClickable(page, "Settings → Support Yo");
    });
  }

  test("workspace tabs, helper tabs and the strip's empty space", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, { query: "mockHelpers=2" });
    const workspace = await openWorkspace(page);
    await expectAllClickable(page, "the workspace");
    // The helpers' faces beside the head, the pill, and a tab per helper: all clickable.
    await expect(page.getByTestId("helper-head").first()).toBeVisible();
    const helperTabs = workspace.locator('[data-testid^="ws-tab-helper:"]');
    await expect(helperTabs).toHaveCount(2);
    await expectAllClickable(page, "chat with helpers and the workspace tabs");
    await helperTabs.first().getByRole("tab").click();
    await expect(workspace.getByTestId("ws-helper-status")).toBeVisible();
    await expectAllClickable(page, "a helper's tab");
    // A page tab, with its close button.
    await workspace.getByTestId("ws-new-tab").click();
    await page.getByRole("menuitem").first().click();
    await expect(workspace.getByTestId("ws-tab-close")).toBeVisible();
    await expectAllClickable(page, "a page tab");
    // Drag regions: the tab strip's empty space and the chat's top; every tab and the + are no-drag.
    const appRegion = (loc: ReturnType<Page["locator"]>) =>
      loc.evaluate((el) => {
        const s = getComputedStyle(el);
        return s.getPropertyValue("app-region") || s.getPropertyValue("-webkit-app-region");
      });
    expect(await appRegion(workspace.locator(".ws-strip"))).toBe("drag");
    expect(await appRegion(workspace.getByRole("tablist"))).toBe("drag");
    expect(await appRegion(page.locator(".chat-top"))).toBe("drag");
    for (const tab of await workspace.getByRole("tab").all()) expect(await appRegion(tab)).toBe("no-drag");
    expect(await appRegion(workspace.getByTestId("ws-new-tab"))).toBe("no-drag");
    expect(await appRegion(page.getByTestId("presence-avatar"))).toBe("no-drag");
    // The chat's resize handle sits over the seam, across the chat's top and the tab strip (both drag areas): it
    // comes after them in the page and is no-drag, so the Mac app hands it the pointer from top to bottom.
    const handle = page.getByTestId("chat-resizer");
    expect(await appRegion(handle)).toBe("no-drag");
    const hb = (await handle.boundingBox())!;
    for (const y of [hb.y + 8, hb.y + 30, hb.y + hb.height / 2, hb.y + hb.height - 8]) {
      const at = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x!, y!)!;
          const s = getComputedStyle(el);
          return {
            id: el.getAttribute("data-testid"),
            region: s.getPropertyValue("app-region") || s.getPropertyValue("-webkit-app-region"),
          };
        },
        [hb.x + hb.width / 2, y],
      );
      expect(at).toEqual({ id: "chat-resizer", region: "no-drag" });
    }
    // The strip's empty space (right of the last tab and the +) really is a drag point, even with every tab open.
    const strip = (await workspace.locator(".ws-strip").boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x!, y!)!;
        const s = getComputedStyle(el);
        return s.getPropertyValue("app-region") || s.getPropertyValue("-webkit-app-region");
      },
      [strip.x + strip.width - 12, strip.y + strip.height / 2],
    );
    expect(hit).toBe("drag");
  });

  test("workspace as a sheet on a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 720 });
    await openApp(page, { query: "mockHelpers=2" });
    await page.getByTestId("toggle-workspace").click();
    await expect(page.getByTestId("workspace")).toBeVisible();
    await expectAllClickable(page, "the workspace sheet");
  });

  test("a phone: the chat's Team button and the tab bar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    await expect(page.getByTestId("chat-team")).toBeVisible();
    await expectAllClickable(page, "the phone chat");
    await page.getByTestId("chat-team").click();
    await expect(page.getByTestId("roster")).toBeVisible();
    await expectAllClickable(page, "the Team popover on a phone");
  });

  test("first run", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 720 });
    await openApp(page, { onboarded: false });
    await expectAllClickable(page, "onboarding");
  });
});
