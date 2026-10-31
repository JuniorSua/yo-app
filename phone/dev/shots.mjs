// Screenshots (and a smoke check) of Yo Phone with the dev relay and the fake core. Mock data only.
//
//   node phone/dev/shots.mjs [--root phone] [--core-root phone] [--out /tmp/phone-shots] [--port 5411] [--check]
//
// Starts phone/dev/server.mjs and phone/dev/fake-core.mjs from --root on --port, opens the phone link in Chromium
// at 390×844 (iPhone size), chats a little and saves light and dark screenshots to --out (light-NN-what.png and
// dark-NN-what.png): the chat, the morning brief, Yo's own quick replies, an approval card, and (1.3) the Tasks tab's
// Active and Up next. With --check it also asserts the features (pictures, lightbox, tables, photos, offline,
// brief, chips, Tasks) and exits non-zero if one is missing.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const root = resolve(opt("root", fileURLToPath(new URL("..", import.meta.url))));
// The fake core can come from elsewhere (e.g. this checkout's, to show an older app getting pictures).
const coreRoot = resolve(opt("core-root", root));
const out = resolve(opt("out", "/tmp/phone-shots"));
const port = Number(opt("port", "5411"));
const check = args.includes("--check");
mkdirSync(out, { recursive: true });

const procs = [];
function run(file, extra, env = {}, base = root) {
  const p = spawn(process.execPath, [join(base, file), ...extra], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(p);
  return p;
}
const cleanup = () => {
  for (const p of procs) p.kill();
};
process.on("exit", cleanup);

const fail = (msg) => {
  console.error(`check failed: ${msg}`);
  cleanup();
  process.exit(1);
};

const server = run("dev/server.mjs", [], { YO_PHONE_DEV_FAST: "1" });
await new Promise((ok, no) => {
  server.stdout.on("data", (d) => String(d).includes("dev server") && ok());
  server.on("exit", () => no(new Error("dev server exited")));
  setTimeout(() => no(new Error("dev server didn't start")), 10_000);
});
const core = run(
  "dev/fake-core.mjs",
  ["--relay", `http://localhost:${port}`, "--slow", "1200"],
  {},
  coreRoot,
);
const link = await new Promise((ok, no) => {
  let buf = "";
  core.stdout.on("data", (d) => {
    buf += d;
    const m = /phone link: (\S+)/.exec(buf);
    if (m) ok(m[1]);
  });
  setTimeout(() => no(new Error("fake core didn't print a link")), 10_000);
});

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  serviceWorkers: "block",
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("page error:", e.message));

let shotN = 0;
async function shot(name) {
  shotN += 1;
  const nn = String(shotN).padStart(2, "0");
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${scheme}-${nn}-${name}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

async function say(text, waitFor) {
  const before = await page.locator(waitFor).count();
  if (text !== null) await page.fill("#input", text);
  await page.click("#send-btn");
  await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length > n, [waitFor, before], {
    timeout: 20_000,
  });
}

await page.goto(link);
await page.waitForSelector("#chat:not([hidden])", { timeout: 15_000 });
// 1.3: the core says it has Tasks, the tab bar shows, and the badge counts what's waiting on you.
await page.waitForSelector("#tabbar:not([hidden])", { timeout: 15_000 });
await page.waitForSelector("#tasks-badge:not([hidden])", { timeout: 15_000 });
await page.waitForTimeout(800);
await shot("empty");

// The morning brief: its card, then the reply's text under it.
await say("What's my morning brief?", ".brief");
await page.waitForTimeout(400);
await page.evaluate(() => {
  document.querySelector(".brief")?.scrollIntoView({ block: "start" });
  document.getElementById("log").scrollTop -= 12;
});
await page.waitForTimeout(300);
await shot("brief");
// Show 2 more, then Start the first "Needs you" row: it sends "Take care of: …" and says Started.
await page.locator(".brief-more").first().click();
await page.locator(".brief-start").first().click();
await page.waitForSelector(".brief-started", { timeout: 5000 });
await page.waitForFunction(() => document.querySelectorAll(".msg.yo").length >= 2, null, { timeout: 20_000 });
await page.evaluate(() => {
  document.querySelector(".brief .brief-sec")?.scrollIntoView({ block: "start" });
});
await page.waitForTimeout(300);
await shot("brief-started");

// Quick replies Yo picked itself (not the phone's guess).
await say("Help me choose a dentist time", ".msg.yo");
await page.waitForSelector(".quick-chip", { timeout: 5000 });
await page.waitForTimeout(500);
await shot("chips");
const chips = await page.locator(".quick-chip").allTextContents();

// An approval card: Refuse / Allow.
await say("Buy the tickets (approval)", ".req");
await page.waitForTimeout(800);
await shot("approval");

// The composer with the keyboard up (the tab bar steps aside). Chromium has no keyboard: pretend one.
await page.evaluate(() => document.documentElement.classList.add("kb-open"));
await page.fill("#input", "Can you also check the matinee?");
await page.waitForTimeout(200);
await shot("keyboard");
await page.fill("#input", "");
await page.evaluate(() => document.documentElement.classList.remove("kb-open"));

// Tasks: Active, then Up next.
await page.click("#tab-tasks");
await page.waitForSelector(".task-row", { timeout: 15_000 });
await page.waitForTimeout(400);
await shot("tasks-active");
await page.click('[data-view="upnext"]');
await page.waitForSelector(".sugg", { timeout: 5000 });
await page.waitForTimeout(400);
await shot("tasks-upnext");
// Start a suggestion: it moves to Active as Working.
const before = await page.locator(".sugg").count();
await page.locator(".sugg [data-start]").first().click();
await page.waitForFunction((n) => document.querySelectorAll(".sugg").length < n, before, { timeout: 10_000 });
// "Started" only once the core's list has it under way (it left Up next just now).
if (check) {
  const said = await page.locator("#toast").textContent();
  if (!/^Started/.test(said ?? "")) fail(`Start didn't say Started after the list came: ${said}`);
}
await page.click('[data-view="active"]');
await page.waitForTimeout(600);
await page.evaluate(() => {
  document.querySelector('[data-group="in_progress"]')?.scrollIntoView({ block: "start" });
});
await page.waitForTimeout(300);
await shot("tasks-started");
await page.click("#tab-chat");
await page.waitForTimeout(300);

if (check) {
  if ((await page.locator(".brief-sec").count()) < 3) fail("the brief's sections didn't show");
  if (chips.join("|") !== "Tuesday 9:30|Thursday 2:00|Neither works")
    fail(`the chips weren't Yo's own: ${chips.join("|")}`);
  if (!(await page.locator(".msg.me", { hasText: "Take care of: Reply to Dana" }).count()))
    fail("Start in the brief didn't send its message");
}

// The richer replies from 1.1–1.2: lists, a table and a picture.
await say("Find a quiet dinner spot for Friday", ".msg.yo");
await say("Compare the two flights in a table", ".msg.yo");
await say("Show me the screenshot", ".msg.yo");
await page.waitForTimeout(2500);
await shot("chat");

// While Yo works: the indicator with what it's doing.
await page.fill("#input", "Research the best e-bikes under $2k");
await page.click("#send-btn");
await page.waitForSelector("#live:not([hidden])", { timeout: 10_000 });
await page.waitForTimeout(400);
await shot("working");
await page.waitForSelector("#live", { state: "hidden", timeout: 20_000 });

if (check) {
  const imgs = await page.locator(".msg.yo img.pic-img").count();
  if (imgs < 1) fail("no picture shown in Yo's reply");
  const loaded = await page.$eval(".msg.yo img.pic-img", (img) => img.complete && img.naturalWidth > 0);
  if (!loaded) fail("the picture didn't load");
  if ((await page.locator(".msg.yo table").count()) < 1) fail("no table rendered");
  await page.locator(".msg.yo img.pic-img").first().click();
  await page.waitForSelector("#viewer[open]", { timeout: 5000 });
  await shot("viewer");
  await page.locator("#viewer-close").click();

  // A photo from the phone: picked, shrunk, sent encrypted; the fake core opens it and answers with its size.
  if (await page.locator("#photo-btn").isHidden()) fail("no photo button although the core can take photos");
  const png = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 2400;
    c.height = 1800;
    const g = c.getContext("2d");
    g.fillStyle = "#7fb2ff";
    g.fillRect(0, 0, 2400, 1800);
    g.fillStyle = "#ffd43b";
    g.fillRect(400, 300, 1200, 900);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await page.setInputFiles("#photo-input", {
    name: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from(png),
  });
  await page.waitForSelector("#tray .tray-item", { timeout: 5000 });
  await page.fill("#input", "What's in this photo?");
  await shot("photo-picked");
  await say(null, ".msg.yo");
  const last = await page.locator(".msg.yo").last().textContent();
  if (!/Got your photo \(1600×1200/.test(last ?? "")) fail(`the photo didn't reach the core: ${last}`);

  // Offline: the message waits, then goes by itself.
  await ctx.setOffline(true);
  await page.fill("#input", "Sent from the subway");
  await page.click("#send-btn");
  await page.waitForSelector(".msg.me.queued", { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot("offline");
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForSelector(".msg.me.queued", { state: "detached", timeout: 15_000 });
  await page
    .waitForFunction(
      () => /Sent from the subway/.test(document.querySelector(".msg.yo:last-of-type")?.textContent ?? ""),
      null,
      { timeout: 15_000 },
    )
    .catch(() => {});
  // A brief-only reply: the card, without its titles repeated as text under it.
  await say("Just the brief only please", ".brief");
  await page.waitForTimeout(300);
  if (await page.locator(".msg.yo", { hasText: "Your brief:" }).count())
    fail("a brief-only reply showed its fallback text under the card");

  console.log("check passed");
}

await browser.close();
cleanup();
console.log(`screenshots in ${out}`);
process.exit(0);
