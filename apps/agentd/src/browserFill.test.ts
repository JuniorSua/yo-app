/**
 * browser.fillLogin against a real Chromium (Playwright's, when installed; skipped otherwise): the login is typed
 * into the right fields and submitted, a wrong site gets nothing, and a password left in a form after a failed
 * sign-in is cleared so a page snapshot (what the model reads) can't show it.
 */
import { existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { type Browser, chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FillError, fillLogin, hostsOf, matchingTabs, safeFillError } from "./browserFill";

// Made-up test values (never real credentials).
const USER = "alice@example.com";
const PASS = "correct-horse-battery-staple-41";

const PAGES: Record<string, string> = {
  "/classic": `<form method="post" action="/done">
      <label>Email <input name="email" type="email" autocomplete="username"></label>
      <label>Password <input name="pw" type="password"></label>
      <button type="submit">Sign in</button></form>`,
  // A single-page app that turns the sign-in down and keeps the form (and the typed password) on screen.
  "/spa": `<form id="f"><input placeholder="Username"><input type="password" placeholder="Password">
      <button>Log in</button><p id="msg"></p></form>
      <script>f.onsubmit = (e) => { e.preventDefault(); msg.textContent = "Wrong password"; };</script>`,
  "/otp": `<form method="post" action="/done"><p>Enter the code</p>
      <div>${[1, 2, 3, 4, 5, 6].map((i) => `<input name="c${i}" maxlength="1" inputmode="numeric">`).join("")}</div>
      <button type="submit">Verify</button></form>
      <script>for (const [i, b] of [...document.querySelectorAll("input")].entries())
        b.addEventListener("input", () => document.querySelectorAll("input")[i + 1]?.focus());</script>`,
  "/search": `<input type="search" name="q"><form><input name="query" placeholder="Search"></form>`,
};

const executable = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return "";
  }
})();
const haveChromium = !!executable && existsSync(executable);

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

describe("which tabs may get a login", () => {
  const sites = [{ url: "https://github.com", mode: "anywhere" as const }];
  it("only tabs on the login's site", () => {
    const tabs = [
      { id: "1", type: "page", url: "https://evilgithub.com/login" },
      { id: "2", type: "page", url: "https://github.com/login" },
      { id: "3", type: "service_worker", url: "https://github.com/sw.js" },
    ];
    expect(matchingTabs(tabs, sites).map((t) => t.id)).toEqual(["2"]);
    expect(hostsOf([...sites, { url: "www.gitlab.com", mode: "exact" }])).toBe("github.com or gitlab.com");
    expect(hostsOf([{ url: "x.com", mode: "never" }])).toBe("no website");
  });

  it("a public suffix is not a site a tab can match", () => {
    const evil = [{ id: "1", type: "page", url: "https://evil.github.io/login" }];
    expect(matchingTabs(evil, [{ url: "https://github.io", mode: "anywhere" }])).toEqual([]);
    expect(matchingTabs(evil, [{ url: "https://vercel.app", mode: "anywhere" }])).toEqual([]);
    expect(
      matchingTabs(
        [{ id: "2", type: "page", url: "https://my-app.vercel.app/" }],
        [{ url: "https://my-app.vercel.app", mode: "anywhere" }],
      ).map((t) => t.id),
    ).toEqual(["2"]);
  });
});

describe("errors that leave a fill", () => {
  it("drops an unknown error so a typed value can't be logged or shown", () => {
    const secret = "Made-Up-Secret-Pw-91";
    const err = safeFillError(new Error(`Input.insertText failed: ${secret}`));
    expect(err).toBeInstanceOf(FillError);
    expect(err.code).toBe("fill_failed");
    expect(err.message).not.toContain(secret);
    expect(err.stack ?? "").not.toContain(secret);
    const known = new FillError("The page moved to another site.", "moved");
    expect(safeFillError(known)).toBe(known);
  });
});

describe.skipIf(!haveChromium)("filling a login in Chromium", () => {
  let server: http.Server;
  let origin = "";
  let browser: Browser;
  let cdpPort = 0;
  const posted: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          posted.push(body);
          res.end("<p>Welcome</p>");
        });
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><body>${PAGES[req.url ?? ""] ?? "<p>home</p>"}</body>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cdpPort = await freePort();
    browser = await chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  const site = () => [{ url: origin, mode: "exact" as const }];
  const open = async (path: string) => {
    const page = await browser.newPage();
    await page.goto(`${origin}${path}`);
    return page;
  };

  it("types the username and password into the sign-in form and submits it", async () => {
    const page = await open("/classic");
    const dry = await fillLogin(cdpPort, {
      sites: site(),
      fields: [{ kind: "username" }, { kind: "password" }, { kind: "one_time_code" }],
      dryRun: true,
    });
    expect(dry).toMatchObject({ found: ["username", "password"], filled: [] });
    const r = await fillLogin(cdpPort, {
      sites: site(),
      fields: [
        { kind: "username", value: USER },
        { kind: "password", value: PASS },
      ],
      dryRun: false,
    });
    expect(r).toMatchObject({ filled: ["username", "password"], submitted: true, stillOnForm: false });
    expect(posted.at(-1)).toBe(`email=${encodeURIComponent(USER)}&pw=${PASS}`);
    await page.close();
  });

  it("clears a password a failed sign-in leaves in the form, so a snapshot can't show it", async () => {
    const page = await open("/spa");
    const r = await fillLogin(cdpPort, {
      sites: site(),
      fields: [
        { kind: "username", value: USER },
        { kind: "password", value: PASS },
      ],
      dryRun: false,
    });
    expect(r).toMatchObject({ filled: ["username", "password"], submitted: true, stillOnForm: true });
    await expect.poll(() => page.locator("#msg").textContent()).toBe("Wrong password");
    expect(await page.locator("input[type=password]").inputValue()).toBe("");
    // What Playwright's snapshot (the model's view of the page) shows: the username, never the password.
    const snapshot = await page.locator("body").ariaSnapshot();
    expect(snapshot).toContain(USER);
    expect(snapshot).not.toContain(PASS);
    await page.close();
  });

  it("types a one-time code into a row of one-digit boxes", async () => {
    const page = await open("/otp");
    const r = await fillLogin(cdpPort, {
      sites: site(),
      fields: [{ kind: "one_time_code", value: "492817" }],
      dryRun: false,
    });
    expect(r).toMatchObject({ filled: ["one_time_code"], submitted: true });
    expect(posted.at(-1)).toBe("c1=4&c2=9&c3=2&c4=8&c5=1&c6=7");
    await expect.poll(() => page.textContent("body")).toContain("Welcome");
    await page.close();
  });

  it("never fills a tab on another site, nor a search box", async () => {
    const page = await open("/classic");
    const elsewhere = fillLogin(cdpPort, {
      sites: [{ url: "https://github.com", mode: "anywhere" }],
      fields: [{ kind: "password", value: PASS }],
      dryRun: false,
    });
    await expect(elsewhere).rejects.toBeInstanceOf(FillError);
    await expect(elsewhere).rejects.toThrow("No open tab is on github.com");
    expect(await page.locator("input[type=password]").inputValue()).toBe("");
    await page.close();

    const search = await open("/search");
    await expect(
      fillLogin(cdpPort, {
        sites: site(),
        fields: [{ kind: "username", value: USER }],
        dryRun: false,
      }),
    ).rejects.toThrow(/doesn't show a username field/);
    expect(await search.locator("input[name=q]").inputValue()).toBe("");
    await search.close();
  });
});
