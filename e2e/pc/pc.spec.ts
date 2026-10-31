/**
 * The PC edition from A to Z against a real install (e2e/pc/run.mjs installs it and sets the env). Runs in Chromium
 * and Firefox; each browser signs in with its own one-time link and keeps one page for the whole journey.
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

const BASE = process.env.YO_PC_URL ?? "";
const PROJECT = process.env.YO_PC_PROJECT ?? "yo-app-e2e";
const CORE = `${PROJECT}-yo-core-1`;
const COMPUTER = `${PROJECT}-yo-computer-1`;
const PORT = new URL(BASE || "http://127.0.0.1:7798").port;
/**
 * An Anthropic API key for the one live message. Claude plan sign-ins can't be scripted (the person signs in on
 * Claude's own page), so the live test uses an API-key account instead.
 */
const ANTHROPIC_KEY = process.env.YO_E2E_ANTHROPIC_API_KEY ?? "";

/** `yo-app <args>` on the test install. */
function helper(...args: string[]): string {
  return execFileSync(process.env.YO_PC_HELPER ?? "yo-app", args, {
    encoding: "utf8",
    env: { ...process.env, ...JSON.parse(process.env.YO_PC_HELPER_ENV ?? "{}") },
  });
}

/** A fresh one-time sign-in link, the way a user gets one. */
function newLink(): string {
  const link = helper("signin").match(/http:\/\/127\.0\.0\.1:\d+\/#signin=[0-9a-f]{64}/)?.[0];
  if (!link) throw new Error("yo-app signin printed no link");
  return link;
}

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
});
test.afterAll(async () => {
  await context?.close();
});

test("a browser that isn't signed in gets the sign-in screen, and core refuses it", async () => {
  await page.goto("/");
  await expect(page.getByTestId("sign-in")).toBeVisible();
  await expect(page.getByTestId("sign-in-pc")).toContainText("yo-app signin");
  expect(await page.evaluate(async () => (await fetch("/api/version")).status)).toBe(401);
});

test("a one-time link signs it in, even pasted into the open tab, and leaves no token behind", async ({
  browserName,
}) => {
  // Chromium uses the link the installer printed; Firefox gets its own from `yo-app signin`.
  const link = browserName === "chromium" && process.env.YO_PC_SIGNIN ? process.env.YO_PC_SIGNIN : newLink();
  await page.goto(link); // same document: only the fragment changes, like pasting into the address bar
  await expect(page.getByTestId("sign-in")).toHaveCount(0, { timeout: 30_000 });
  expect(page.url()).not.toContain("signin=");
  expect(await page.evaluate(async () => (await fetch("/api/version")).status)).toBe(200);
});

test("a used link doesn't work twice", async ({ browser }) => {
  const link = newLink();
  const first = await browser.newContext({ baseURL: BASE });
  const p1 = await first.newPage();
  await p1.goto(link);
  await expect(p1.getByTestId("sign-in")).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => p1.evaluate(async () => (await fetch("/api/version")).status)).toBe(200);
  const second = await browser.newContext({ baseURL: BASE });
  const p2 = await second.newPage();
  await p2.goto(link);
  await expect(p2.getByTestId("sign-in-error")).toContainText("already used or has expired");
  await first.close();
  await second.close();
});

test("first run on the PC: welcome without the Mac, connect a model, no Mac sharing step", async () => {
  await page.goto("/");
  const onboarding = page.getByTestId("onboarding");
  const home = page.getByTestId("composer-input");
  await expect(onboarding.or(home)).toBeVisible();
  test.skip(!(await onboarding.isVisible()), "This Yo was set up by the other browser's run");
  await expect(onboarding).toContainText("Your files stay private unless you share them.");
  await page.getByTestId("onboarding-start").click();
  await expect(page.getByTestId("connect-model")).toBeVisible();
  // Claude: the real Claude Code on Yo's computer starts its own sign-in and Yo shows Claude's link. Nobody can
  // finish it here, so cancel it and go on.
  await page.getByTestId("connect-pick-claude").click();
  await page.getByTestId("claude-start").click();
  await expect(page.getByTestId("claude-login-url")).toContainText("https://claude.com/cai/oauth/authorize", {
    timeout: 180_000,
  });
  await expect(page.getByTestId("connect-steps-claude")).not.toContainText(/setup-token|sk-ant/);
  await page.getByTestId("claude-cancel").click();
  await page.getByTestId("connect-back").click();
  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("meet-intro")).toBeVisible();
  await expect(page.getByTestId("onboarding-access")).toHaveCount(0);
  await page.getByTestId("user-name").fill("Tester");
  await page.getByTestId("onboarding-finish").click();
  await expect(home).toBeVisible();
});

test("chat with Yo on Claude through an API-key account (one short Haiku message)", async ({
  browserName,
}) => {
  test.skip(!ANTHROPIC_KEY, "Set YO_E2E_ANTHROPIC_API_KEY to run the live model test");
  test.skip(browserName !== "chromium", "One live message per run is enough");
  test.setTimeout(240_000);
  await page.goto("/");
  await page.getByTestId("profile-trigger").click();
  await page.getByTestId("open-settings").click();
  const card = page.getByTestId("account-claude").first();
  await card.getByRole("button", { name: "Account options" }).click();
  await page.getByText("Use an API key instead").click();
  await card.getByPlaceholder("Anthropic API key").fill(ANTHROPIC_KEY);
  await card.getByRole("button", { name: "Save key" }).click();
  await expect(card).toContainText("Connected", { timeout: 120_000 });
  await page.keyboard.press("Escape");
  await page.getByTestId("model-picker-trigger").click();
  await page.getByTestId("picker-model-haiku").click();
  await page.keyboard.press("Escape");
  await page
    .getByTestId("composer-input")
    .fill("Reply with exactly the word pong and nothing else. Don't use any tools.");
  const before = await page.getByTestId("assistant-message").count();
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("assistant-message")).toHaveCount(before + 1, { timeout: 200_000 });
  await expect(page.getByTestId("assistant-message").last()).toContainText(/pong/i);
});

/** Watch Yo's computer: wake it if it's asleep, and wait for real pixels on the live screen. */
async function watchScreen() {
  await page.goto("/");
  await expect(page.getByTestId("composer-input")).toBeVisible();
  const watch = page.getByText("Watch screen", { exact: true });
  if (await watch.isVisible()) await watch.click();
  const wake = page.getByRole("button", { name: "Wake" }).first();
  if (await wake.isVisible().catch(() => false)) await wake.click();
  if (
    await page
      .getByTestId("close-computer")
      .isVisible()
      .catch(() => false)
  )
    await page.getByTestId("close-computer").click();
  const screen = page.getByTestId("vnc-screen").first();
  await expect(screen).toBeVisible({ timeout: 120_000 });
  // The noVNC canvas has a picture on it (not one flat color).
  await expect
    .poll(
      async () =>
        screen
          .locator("canvas")
          .first()
          .evaluate((c: HTMLCanvasElement) => {
            if (!c.width || !c.height) return 0;
            const d = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
            if (!d) return 0;
            const seen = new Set<number>();
            for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
            return seen.size;
          }),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(8);
}

test("watch the computer live, take over, type in its browser, use its terminal, give it back", async () => {
  test.setTimeout(240_000);
  await watchScreen();
  // Control lives on the server: a run that stopped halfway may have left it taken. Then just open the view.
  if (await page.getByTestId("pane-take-over").isEnabled()) await page.getByTestId("pane-take-over").click();
  else await page.getByTestId("open-computer-pane").click();
  await expect(page.getByTestId("give-back")).toBeVisible();
  try {
    // The overlay's terminal: a command runs on Yo's computer and its output comes back.
    await page.getByTestId("dock-terminal").click();
    await expect(page.getByTestId("terminal")).toBeVisible();
    // Type once the shell's prompt is there, at a person's pace (a busy test machine can drop bursts of keys).
    await expect(page.getByTestId("terminal")).toContainText("agent@", { timeout: 30_000 });
    await expect(async () => {
      await page.getByTestId("terminal").click();
      await page.keyboard.press("Control+c");
      await page.keyboard.type("echo yo-e2e-$((40+2))\n", { delay: 25 });
      await expect(page.getByTestId("terminal")).toContainText("yo-e2e-42", { timeout: 10_000 });
    }).toPass({ timeout: 60_000 });
    await page.getByTestId("dock-files").click();
    await expect(page.getByTestId("files")).toBeVisible();
  } finally {
    // Always hand the computer back, so a failure here doesn't leave Yo paused for the next test.
    if (
      await page
        .getByTestId("give-back")
        .isVisible()
        .catch(() => false)
    )
      await page.getByTestId("give-back").click();
  }
  await expect(page.getByTestId("give-back")).toHaveCount(0);
  await expect(page.getByTestId("presence-line")).not.toContainText("You have his computer");
});

test("sign in another browser from Settings, then sign it out from here", async ({ browser }) => {
  await page.goto("/");
  await page.getByTestId("profile-trigger").click();
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-browsers").click();
  await expect(page.locator("[data-self]")).toContainText("This browser");
  await page.getByTestId("signin-link-create").click();
  const link = await page
    .getByTestId("signin-link")
    .evaluate((e) => (e as HTMLInputElement).value ?? e.textContent);
  expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/#signin=`));

  const other: Browser = browser;
  const ctx2 = await other.newContext({ baseURL: BASE });
  const p2 = await ctx2.newPage();
  await p2.goto(String(link));
  await expect(p2.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });

  // The new browser shows up in the list (refreshed while the link panel is open); sign it out.
  const id = await p2.evaluate(
    async () => ((await (await fetch("/auth/me")).json()) as { controllerId: string }).controllerId,
  );
  await expect(page.getByTestId(`client-${id}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`client-signout-${id}`).click();
  await page.getByTestId("client-signout-confirm").click();
  await expect(p2.getByTestId("sign-in")).toBeVisible({ timeout: 20_000 });
  expect(await p2.evaluate(async () => (await fetch("/api/version")).status)).toBe(401);
  await ctx2.close();
});

test("restarting Yo doesn't sign this browser out or lose a draft", async () => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByTestId("composer-input").fill("a draft that survives a restart");
  execFileSync("docker", ["restart", CORE]);
  await expect
    .poll(async () => page.evaluate(async () => (await fetch("/api/version")).status).catch(() => 0), {
      timeout: 90_000,
    })
    .toBe(200);
  await expect(page.getByTestId("sign-in")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toHaveValue("a draft that survives a restart");
  await page.getByTestId("composer-input").fill("");
  // A brand-new tab in the same browser opens straight into Yo.
  const tab = await context.newPage();
  await tab.goto("/");
  await expect(tab.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
  await tab.close();
});

test("the agent's computer can't reach Yo's core, but has the internet", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "Not browser-specific");
  const probe = (url: string) =>
    execFileSync(
      "docker",
      [
        "exec",
        COMPUTER,
        "node",
        "-e",
        `fetch(${JSON.stringify(url)}).then(r=>console.log("reached "+r.status),e=>console.log("blocked "+(e.cause?.code||e.message)))`,
      ],
      { encoding: "utf8" },
    ).trim();
  expect(probe(`http://yo-core:${PORT}/healthz`)).toMatch(/^blocked/);
  expect(probe("https://example.com")).toMatch(/^reached 200/);
  // And nothing of the computer is published on the PC.
  expect(execFileSync("docker", ["port", COMPUTER], { encoding: "utf8" }).trim()).toBe("");
});

test("core turns away other host names and malformed cookies, and stays up", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "Not browser-specific");
  const raw = (headers: Record<string, string>, p = "/auth/info") =>
    new Promise<number>((resolve) => {
      http
        .get({ host: "127.0.0.1", port: Number(PORT), path: p, headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", () => resolve(0));
    });
  expect(await raw({ host: `127.0.0.1:${PORT}` })).toBe(200);
  expect(await raw({ host: `rebind.example:${PORT}` })).toBe(421);
  expect(await raw({ host: `127.0.0.1:${PORT}`, cookie: `yo_session_${PORT}=%` }, "/auth/me")).toBe(200);
  // A WebSocket upgrade with a malformed cookie is refused, not fatal.
  const upgraded = await raw(
    {
      host: `127.0.0.1:${PORT}`,
      cookie: `yo_session_${PORT}=%`,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      // RFC 6455's sample key, built here so the leak scan doesn't read it as a secret.
      "sec-websocket-key": Buffer.from("the sample nonce").toString("base64"),
    },
    "/ws",
  );
  expect(upgraded).not.toBe(101);
  expect(await raw({ host: `127.0.0.1:${PORT}` }, "/healthz")).toBe(200);
  // The agent's computer can't use Docker Desktop's names for this PC.
  const resolved = execFileSync(
    "docker",
    [
      "exec",
      COMPUTER,
      "node",
      "-e",
      "require('dns').lookup('host.docker.internal',(e,a)=>console.log(e?'none':a))",
    ],
    { encoding: "utf8" },
  ).trim();
  expect(["none", "0.0.0.0"]).toContain(resolved);
});

test("yo-app status reports a healthy Yo", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "Not browser-specific");
  expect(helper("status")).toMatch(/running|healthy/i);
});
