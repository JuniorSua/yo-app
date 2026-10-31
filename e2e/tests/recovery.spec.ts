// Recovery paths use the in-memory backend; no provider calls or live account data.
import { expect, test } from "@playwright/test";
import { openAgent, openApp, openWorkspacePage, send } from "./helpers";

/** Make the mock fail the given methods (installed before the app boots). */
async function failMethods(page: import("@playwright/test").Page, methods: string[], hang = false) {
  await page.addInitScript(
    ({ methods, hang }) => {
      let m: any;
      Object.defineProperty(window, "__yoMock", {
        configurable: true,
        get: () => m,
        set: (v) => {
          m = v;
          const call = v.call.bind(v);
          (window as any).__yoFail = new Set(methods);
          v.call = (method: string, params: unknown) => {
            if ((window as any).__yoFail.has(method))
              return hang ? new Promise(() => {}) : Promise.reject(new Error(`${method} timed out`));
            return call(method, params);
          };
        },
      });
    },
    { methods, hang },
  );
}

test("slow first load explains how to recover", async ({ page }) => {
  await page.clock.install();
  await failMethods(page, ["bootstrap"], true);
  await page.goto("/?mock=1&fast=1&onboarded=1");
  // The splash records Date.now() on its first render. Advancing the clock before that paint
  // makes "started" already include the jump, so the slow message never appears.
  await expect(page.getByText("Connecting to Yo…")).toBeVisible();
  await page.clock.runFor(20_000);
  await expect(page.getByText("Yo is taking longer than usual to answer")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("reconnect preserves a draft and shows helpful status", async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await page.getByTestId("composer-input").fill("Keep this draft");
  await page.evaluate(() => {
    for (const cb of (window as any).__yoMock.statusCbs) cb("closed", false);
  });
  await page.clock.runFor(40_000);
  await expect(page.getByText("Can't reach Yo · trying for 40s")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toHaveValue("Keep this draft");
  await page.evaluate(() => {
    for (const cb of (window as any).__yoMock.statusCbs) cb("open", true);
  });
  await expect(page.getByText(/Can't reach Yo/)).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toHaveValue("Keep this draft");
});

test("conversation load failure is retryable", async ({ page }) => {
  await failMethods(page, ["timeline.list"]);
  await openApp(page);
  await expect(page.getByTestId("timeline-load-failed")).toBeVisible();
  await page.evaluate(() => (window as any).__yoFail.clear());
  await page.getByTestId("timeline-retry").click();
  await expect(page.getByTestId("timeline-load-failed")).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Loading", exact: true })).toHaveCount(0);
});

for (const [name, method] of [
  ["activity", "activity.list"],
  ["memory", "memory.list"],
  ["artifacts", "artifacts.list"],
  ["routines", "routine.list"],
] as const) {
  test(`${name} load failure is retryable`, async ({ page }) => {
    await failMethods(page, [method]);
    await openApp(page);
    await openWorkspacePage(page, name);
    await expect(page.getByTestId("load-failed")).toBeVisible();
    await page.evaluate(() => (window as any).__yoFail.clear());
    await page.getByTestId("load-retry").click();
    await expect(page.getByTestId("load-failed")).toHaveCount(0);
    await expect(page.getByRole("status", { name: "Loading", exact: true })).toHaveCount(0);
  });
}

test("failed memory writes preserve drafts and existing rows", async ({ page }) => {
  await failMethods(page, ["memory.add", "memory.update", "memory.delete"]);
  await openApp(page);
  await openWorkspacePage(page, "memory");
  const input = page.getByTestId("memory-input");
  await input.fill("Keep this new memory");
  await page.getByTestId("memory-add").click();
  await expect(page.getByText("Couldn't remember that")).toBeVisible();
  await expect(input).toHaveValue("Keep this new memory");
  const row = page.getByTestId("memory-row").first();
  await row.hover();
  await row.getByRole("button", { name: "Edit memory" }).click();
  await row.getByRole("textbox").fill("Keep this edit");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Couldn't save the change")).toBeVisible();
  await expect(row.getByRole("textbox")).toHaveValue("Keep this edit");
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  const count = await page.getByTestId("memory-row").count();
  await row.getByTestId("memory-delete").click();
  await expect(page.getByText("Something went wrong", { exact: true })).toBeVisible();
  await expect(page.getByTestId("memory-row")).toHaveCount(count);
});

test("failed send preserves the message", async ({ page }) => {
  await failMethods(page, ["chat.send"]);
  await openApp(page);
  await openAgent(page, "Dew");
  await send(page, "Compare the three cheapest flights to Lisbon");
  await expect(page.getByText("Couldn't send message")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toHaveValue(
    "Compare the three cheapest flights to Lisbon",
  );
});

test("working between steps remains visible", async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await openAgent(page, "Dew");
  await page.evaluate(() => {
    const m = (window as any).__yoMock;
    const a = m.s.agents.find((x: any) => x.name === "Dew");
    Object.assign(a, { activity: "working", preview: "Reading reviews on rtings.com" });
    m.emit("agent.updated", { ...a });
  });
  await page.clock.runFor(12 * 60_000);
  await expect(page.getByTestId("working-row")).toBeVisible();
  await expect(page.getByTestId("working-elapsed")).toHaveText("· 12 min");
  await expect(page.getByTestId("working-hint")).toBeVisible();
});

test("a long disconnect offers to try again right away", async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await page.evaluate(() => (window as any).__yoMock.simulateDisconnect());
  await expect(page.getByText("Reconnecting to Yo…")).toBeVisible();
  await expect(page.getByTestId("reconnect-now")).toHaveCount(0);
  await page.clock.runFor(15_000);
  await page.getByTestId("reconnect-now").click();
  await expect(page.getByText(/Can't reach Yo|Reconnecting/)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__yoMock.reconnectRequests)).toBe(1);
});

test("chat history that didn't refresh stays readable with a retry", async ({ page }) => {
  await failMethods(page, []);
  await openApp(page);
  await expect(page.getByTestId("user-message").first()).toBeVisible();
  await page.evaluate(() => {
    (window as any).__yoFail.add("timeline.list");
    (window as any).__yoMock.simulateReconnect();
  });
  await expect(page.getByTestId("timeline-stale")).toBeVisible();
  await expect(page.getByTestId("user-message").first()).toBeVisible();
  await page.evaluate(() => (window as any).__yoFail.clear());
  await page.getByTestId("timeline-stale-retry").click();
  await expect(page.getByTestId("timeline-stale")).toHaveCount(0);
});
