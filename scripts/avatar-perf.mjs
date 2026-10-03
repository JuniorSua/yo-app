// Measures the web UI's memory/CPU on the mock backend (round 2 creature avatars; the numbers go in the PR).
//   node scripts/avatar-perf.mjs "http://localhost:5433/?mock=1&fast=1&onboarded=1&theme=light" [label]
// Reports: JS heap (CDP Performance.getMetrics JSHeapUsedSize after a GC), PSS of the renderer and GPU
// processes (/proc, Linux only), and CPU over 10 s idle and 10 s with the viewed agent ("Yo") working:
// the page's TaskDuration delta and the renderer + GPU processes' CPU time.
import { readdirSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const url = process.argv[2];
const label = process.argv[3] ?? "";
const MARK = `--yo-perf-${process.pid}`;
const browser = await chromium.launch({
  args: [MARK, "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

function procs() {
  const all = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ");
      all.push({ pid: Number(d), ppid: Number(rest[1]), cpu: Number(rest[11]) + Number(rest[12]), cmd });
    } catch {}
  }
  const root = all.find((p) => p.cmd.includes(MARK) && !p.cmd.includes("--type="));
  const tree = new Set([root.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all)
      if (!tree.has(p.pid) && tree.has(p.ppid)) {
        tree.add(p.pid);
        grew = true;
      }
  }
  return all
    .filter((p) => tree.has(p.pid))
    .map((p) => {
      const type = /--type=([\w-]+)/.exec(p.cmd)?.[1] ?? "browser";
      let pss = 0;
      try {
        pss = Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${p.pid}/smaps_rollup`, "utf8"))?.[1] ?? 0);
      } catch {}
      return { ...p, type, pss };
    });
}
const pick = (ps) => ps.filter((p) => p.type === "renderer" || p.type === "gpu-process");
const sum = (ps, k) => ps.reduce((n, p) => n + p[k], 0);
const round1 = (n) => Math.round(n * 10) / 10;

const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
const metrics = async () =>
  Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

await page.goto(url);
await page.getByTestId("sidebar").waitFor();
await page.waitForTimeout(6000);
await cdp.send("HeapProfiler.collectGarbage");
await page.waitForTimeout(500);
const m0 = await metrics();
const p0 = procs();
const canvases = await page.evaluate(() => document.querySelectorAll("canvas").length);

async function window10() {
  const a = await metrics();
  const pa = pick(procs());
  await page.waitForTimeout(10_000);
  const b = await metrics();
  const pb = pick(procs());
  const cpu = (sum(pb, "cpu") - sum(pa, "cpu")) / 100; // clock ticks -> s
  return {
    taskMs: Math.round((b.TaskDuration - a.TaskDuration) * 1000),
    procCpuPct: round1((cpu / 10) * 100),
  };
}
const idle = await window10();
await page.evaluate(() => window.__yoMock.patchAgent("agt_yo", { activity: "working" }));
await page.waitForTimeout(1000);
const working = await window10();
console.log(
  JSON.stringify({
    label,
    jsHeapMB: round1(m0.JSHeapUsedSize / 1048576),
    rendererPssMB: Math.round(
      sum(
        p0.filter((p) => p.type === "renderer"),
        "pss",
      ) / 1024,
    ),
    gpuPssMB: Math.round(
      sum(
        p0.filter((p) => p.type === "gpu-process"),
        "pss",
      ) / 1024,
    ),
    allChromePssMB: Math.round(sum(p0, "pss") / 1024),
    canvases,
    idle,
    working,
  }),
);
await browser.close();
