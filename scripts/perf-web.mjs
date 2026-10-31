// Measures how light the web UI feels on the mock backend: startup, a streamed reply in a long chat, switching
// agents, and hovering the sidebar. Run it against a production build so the numbers match the real app:
//   pnpm --filter @yo/web build && pnpm --filter @yo/web exec vite preview --port 5440 --strictPort
//   node scripts/perf-web.mjs "http://localhost:5440/?mock=1&fast=1&onboarded=1" [label] [--cpu 4] [--turns 12]
// The CPU is slowed (default 4x, like a busy laptop) so differences show up. Reports:
// - startup: JS downloaded before the app shell shows, and the time until the sidebar is visible;
// - streaming: main-thread busy time (CDP TaskDuration, split into script/layout/style), frames per second and
//   frames over 50 ms while the agent writes a reply
//   at the bottom of a chat that already has `turns` replies in it;
// - switching: slowest click → next paint when switching agents (Event Timing);
// - hover: slowest pointer event while sweeping the sidebar.
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = Number(args[i + 1]);
  args.splice(i, 2);
  return v;
};
const cpu = flag("--cpu", 4);
const turns = flag("--turns", 12);
const [url, label = ""] = args;
if (!url) {
  console.error('usage: node scripts/perf-web.mjs "<url with ?mock=1>" [label] [--cpu 4] [--turns 12]');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.removeItem("yo.ui");
  // Slowest event per kind (click, pointerover, …), from Event Timing.
  window.__slow = {};
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      window.__slow[e.name] = Math.max(window.__slow[e.name] ?? 0, e.duration);
  }).observe({ type: "event", durationThreshold: 16, buffered: true });
});
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });

let jsBytes = 0;
let counting = true;
page.on("response", async (r) => {
  if (!counting || r.request().resourceType() !== "script") return;
  const len = Number(r.headers()["content-length"]);
  jsBytes += Number.isFinite(len) ? len : (await r.body().catch(() => Buffer.alloc(0))).length;
});

const t0 = Date.now();
await page.goto(url);
await page.getByTestId("sidebar").waitFor();
const shellMs = Date.now() - t0;
counting = false;
const startupKB = Math.round(jsBytes / 1024);

const input = page.getByTestId("composer-input");
// The composer's placeholder says "Steer …" while the agent works.
const working = (on) =>
  page.waitForFunction(
    (on) => document.querySelector("[data-testid=composer-input]")?.placeholder.startsWith("Steer") === on,
    on,
    { timeout: 120_000 },
  );
async function turn(text) {
  await input.fill(text);
  await input.press("Enter");
  await working(true);
  await working(false);
}

// A long chat to stream into.
for (let i = 0; i < turns; i++) await turn(`Research topic number ${i}`);
await page.waitForTimeout(500);

const metric = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
};
await page.evaluate(() => {
  window.__frames = [];
  let last = performance.now();
  const loop = (t) => {
    window.__frames.push(t - last);
    last = t;
    window.__raf = requestAnimationFrame(loop);
  };
  window.__raf = requestAnimationFrame(loop);
});
const before = await metric();
const s0 = Date.now();
await turn("Research the final topic");
const streamMs = Date.now() - s0;
const after = await metric();
const frames = await page.evaluate(() => {
  cancelAnimationFrame(window.__raf);
  return window.__frames;
});
const busyMs = Math.round((after.TaskDuration - before.TaskDuration) * 1000);
const scriptMs = Math.round((after.ScriptDuration - before.ScriptDuration) * 1000);
const layoutMs = Math.round((after.LayoutDuration - before.LayoutDuration) * 1000);
const styleMs = Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000);
const longFrames = frames.filter((f) => f > 50).length;

// Switch agents back and forth.
await page.evaluate(() => (window.__slow = {}));
const rows = page.locator("[data-testid^=agent-row-]");
const n = Math.min(await rows.count(), 4);
for (let r = 0; r < 2; r++)
  for (let i = 0; i < n; i++) {
    await rows.nth(i).click();
    await page.waitForTimeout(250);
  }
await rows.nth(0).click();
await page.waitForTimeout(400);
const switchMs = await page.evaluate(() => Math.round(window.__slow.click ?? 0));

// Sweep the pointer over the sidebar.
await page.evaluate(() => (window.__slow = {}));
const box = await page.getByTestId("sidebar").boundingBox();
for (let pass = 0; pass < 3; pass++)
  for (let y = box.y + 60; y < box.y + box.height - 60; y += 12)
    await page.mouse.move(box.x + box.width / 2, y);
await page.waitForTimeout(300);
const hoverMs = await page.evaluate(() =>
  Math.round(
    Math.max(
      0,
      ...Object.entries(window.__slow)
        .filter(([k]) => /pointer|mouse/.test(k))
        .map(([, v]) => v),
    ),
  ),
);

await browser.close();
const out = {
  label,
  cpu: `${cpu}x`,
  startupJsKB: startupKB,
  shellMs,
  streamMs,
  streamBusyMs: busyMs,
  streamScriptMs: scriptMs,
  streamLayoutMs: layoutMs,
  streamStyleMs: styleMs,
  streamFps: Math.round(frames.length / (streamMs / 1000)),
  longFrames,
  switchWorstMs: switchMs,
  hoverWorstMs: hoverMs,
};
console.log(JSON.stringify(out));
