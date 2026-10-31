/**
 * Drives the seat proxy against a real headless Chromium: two agents (seat A on the left, seat B on the
 * right) share one browser through their own proxies, the way playwright-mcp connects to them.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Logger } from "../log";
import { type Seat, seatOwnsBounds, startCdpProxy } from "./cdpProxy";

const exe = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return "";
  }
})();
const haveChromium = !!exe && existsSync(exe);
if (!haveChromium)
  console.warn(
    `cdpProxy tests skipped: no Playwright Chromium at "${exe}" (run: npx playwright install chromium)`,
  );

const SEAT_A: Seat = { x: 0, width: 1280, height: 800 };
const SEAT_B: Seat = { x: 1280, width: 1280, height: 800 };

const noop = () => undefined;
const log: Logger = {
  debug: noop,
  info: noop,
  warn: (m, f) => console.warn(m, f ?? ""),
  error: (m, f) => console.error(m, f ?? ""),
  child: () => log,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** Minimal raw CDP client: calls plus a log of every event it received. */
class Raw {
  events: { method: string; params: any; sessionId?: string }[] = [];
  private next = 1;
  private waiting = new Map<number, (m: any) => void>();
  private constructor(private ws: WebSocket) {
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (typeof m.id === "number") this.waiting.get(m.id)?.(m);
      else this.events.push(m);
    });
  }
  static async open(url: string): Promise<Raw> {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new Raw(ws);
  }
  /** Resolves with the whole response ({result} or {error}). */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const r = await this.send(method, params, sessionId);
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  }
  close(): void {
    this.ws.close();
  }
}

const getJson = async (url: string, init?: RequestInit) => (await fetch(url, init)).json() as Promise<any>;

async function targetId(context: BrowserContext, page: Page): Promise<string> {
  const s = await context.newCDPSession(page);
  const { targetInfo } = await s.send("Target.getTargetInfo");
  await s.detach();
  return targetInfo.targetId;
}

describe.skipIf(!haveChromium)("cdpProxy (shared Chromium, two seats)", () => {
  let proc: ChildProcess;
  let profile: string;
  let downloadDir: string;
  let upstreamPort: number;
  let upstream: Raw;
  let site: http.Server;
  let base: string;
  const proxies: { port: number; close(): Promise<void> }[] = [];
  let pa: number;
  let pb: number;
  let bA: Browser;
  let bB: Browser;
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let idA: string;
  let idB: string;
  /** Target ids of every page B's Playwright was ever shown ("gone" if it vanished right away). */
  const pagesSeenByB: Promise<string>[] = [];
  const idsOfA = new Set<string>();

  const boundsOf = async (id: string) =>
    (await upstream.call("Browser.getWindowForTarget", { targetId: id })) as {
      windowId: number;
      bounds: any;
    };

  beforeAll(async () => {
    profile = mkdtempSync(path.join(os.tmpdir(), "yo-cdpproxy-"));
    downloadDir = path.join(profile, "downloads");
    upstreamPort = await freePort();
    proc = spawn(
      exe,
      [
        "--headless=new",
        `--remote-debugging-port=${upstreamPort}`,
        `--user-data-dir=${path.join(profile, "chrome")}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,800",
        "--window-position=0,0",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    let version: any;
    for (let i = 0; i < 150 && !version; i++) {
      version = await getJson(`http://127.0.0.1:${upstreamPort}/json/version`).catch(() => undefined);
      if (!version) await sleep(100);
    }
    expect(version, "Chromium never exposed CDP").toBeTruthy();
    upstream = await Raw.open(version.webSocketDebuggerUrl);

    site = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/set") {
        res.writeHead(200, { "Set-Cookie": "shared=yes; Path=/", "Content-Type": "text/html" });
        return res.end("<title>set</title>set");
      }
      if (url.pathname === "/read") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end(`cookie:${req.headers.cookie ?? ""}`);
      }
      if (url.pathname === "/dl") {
        res.writeHead(200, {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="export-${url.searchParams.get("who")}.csv"`,
        });
        return res.end(`who,${url.searchParams.get("who")}\n`);
      }
      if (url.pathname === "/dlpage") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(`<a id="d" href="/dl?who=${url.searchParams.get("who")}">download</a>`);
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;

    let chain: Promise<unknown> = Promise.resolve();
    const createLock = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(fn);
      chain = run.catch(noop);
      return run;
    };
    for (const seat of [SEAT_A, SEAT_B])
      proxies.push(
        await startCdpProxy({
          listenPort: 0,
          upstreamPort,
          seat: () => seat,
          createLock,
          downloadDir,
          log,
        }),
      );
    pa = proxies[0]!.port;
    pb = proxies[1]!.port;
    bA = await chromium.connectOverCDP(`http://127.0.0.1:${pa}`);
    bB = await chromium.connectOverCDP(`http://127.0.0.1:${pb}`);
    ctxA = bA.contexts()[0]!;
    ctxB = bB.contexts()[0]!;
    ctxB.on("page", (p) => pagesSeenByB.push(targetId(ctxB, p).catch(() => "gone")));
  }, 40_000);

  afterAll(async () => {
    await bA?.close().catch(noop);
    await bB?.close().catch(noop);
    for (const p of proxies) await p.close();
    upstream?.close();
    site?.close();
    proc?.kill("SIGKILL");
    await sleep(200);
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  it("gives each agent only its own pages, placed in its own tile", async () => {
    pageA = await ctxA.newPage();
    await pageA.goto("data:text/html,<title>A</title>A");
    pageB = await ctxB.newPage();
    await pageB.goto("data:text/html,<title>B</title>B");
    const pageA2 = await ctxA.newPage(); // B now has the newest window: must not land there
    await pageA2.goto("data:text/html,<title>A2</title>A2");

    const titles = async (c: BrowserContext) => Promise.all(c.pages().map((p) => p.title()));
    expect(await titles(ctxA)).toEqual(expect.arrayContaining(["A", "A2"]));
    expect(await titles(ctxA)).not.toContain("B");
    expect(await titles(ctxB)).toEqual(["B"]);

    idA = await targetId(ctxA, pageA);
    idB = await targetId(ctxB, pageB);
    expect(seatOwnsBounds(SEAT_A, (await boundsOf(idA)).bounds)).toBe(true);
    const idA2 = await targetId(ctxA, pageA2);
    expect(seatOwnsBounds(SEAT_A, (await boundsOf(idA2)).bounds)).toBe(true);
    idsOfA.add(idA).add(idA2);
    expect(seatOwnsBounds(SEAT_B, (await boundsOf(idB)).bounds)).toBe(true);
    await pageA2.close();
  });

  it("shares cookies between agents", async () => {
    await pageA.goto(`${base}/set`);
    await pageB.goto(`${base}/read`);
    expect(await pageB.textContent("body")).toContain("shared=yes");
    expect((await ctxB.cookies(base)).map((c) => c.name)).toContain("shared");
  });

  it("gives a popup to the agent whose page opened it, inside its tile", async () => {
    const [popup] = await Promise.all([
      ctxA.waitForEvent("page"),
      // Ask for a spot in B's tile: the opener decides, and the window is pulled back into A's tile.
      pageA.evaluate(
        `window.open("about:blank#popup", "_blank", "popup,width=400,height=300,left=1500,top=10")`,
      ),
    ]);
    expect(popup.url()).toContain("#popup");
    expect(ctxB.pages().some((p) => p.url().includes("#popup"))).toBe(false);
    const id = await targetId(ctxA, popup);
    idsOfA.add(id);
    expect(seatOwnsBounds(SEAT_A, (await boundsOf(id)).bounds)).toBe(true);
    await popup.close();
  });

  it("keeps A's hands off B's pages and the browser itself", async () => {
    const v = await getJson(`http://127.0.0.1:${pa}/json/version`);
    expect(v.webSocketDebuggerUrl).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:${pa}/devtools/browser/`));
    const a = await Raw.open(v.webSocketDebuggerUrl);
    try {
      const ids = (await a.call("Target.getTargets")).targetInfos.map((t: any) => t.targetId);
      expect(ids).toContain(idA);
      expect(ids).not.toContain(idB);
      for (const method of ["Target.closeTarget", "Target.attachToTarget", "Target.activateTarget"])
        expect((await a.send(method, { targetId: idB, flatten: true })).error?.code).toBe(-32602);
      expect((await a.send("Browser.close")).error?.message).toMatch(/shared/);
      expect((await a.send("Storage.clearCookies")).error?.message).toMatch(/shared/);
      expect((await a.send("Runtime.evaluate", { expression: "1" }, "not-a-session")).error).toBeTruthy();
    } finally {
      a.close();
    }
    expect(await getJson(`http://127.0.0.1:${upstreamPort}/json/version`)).toBeTruthy();
    expect(await pageB.title()).toBeDefined();
    expect((await ctxB.cookies(base)).map((c) => c.name)).toContain("shared");
  });

  it("doesn't freeze a teammate's new tab when this agent auto-attaches with waitForDebuggerOnStart", async () => {
    const v = await getJson(`http://127.0.0.1:${pa}/json/version`);
    const a = await Raw.open(v.webSocketDebuggerUrl);
    try {
      await a.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      const pageB2 = await ctxB.newPage();
      await pageB2.goto("data:text/html,<script>document.title='ran'</script>", { timeout: 10_000 });
      expect(await pageB2.title()).toBe("ran");
      const idB2 = await targetId(ctxB, pageB2);
      // A tab opened straight on the browser (not via any proxy) in B's tile must run too.
      const { targetId: raw } = await upstream.call("Target.createTarget", {
        url: "data:text/html,<script>document.title='raw-ran'</script>",
        newWindow: true,
        left: 1280,
        top: 0,
        width: 1280,
        height: 800,
      });
      let title = "";
      for (let i = 0; i < 50 && title !== "raw-ran"; i++) {
        title = (await upstream.call("Target.getTargetInfo", { targetId: raw })).targetInfo.title;
        if (title !== "raw-ran") await sleep(100);
      }
      expect(title).toBe("raw-ran");
      await sleep(300);
      const attached = a.events
        .filter((e) => e.method === "Target.attachedToTarget")
        .map((e) => e.params.targetInfo.targetId);
      expect(attached).toContain(idA);
      expect(attached).not.toContain(idB2);
      expect(attached).not.toContain(raw);
      expect(a.events.some((e) => e.params?.targetInfo?.type === "service_worker")).toBe(false);
      expect(ctxA.pages().length).toBeGreaterThan(0);
      await upstream.call("Target.closeTarget", { targetId: raw });
      await pageB2.close();
    } finally {
      a.close();
    }
  });

  it("filters /json/list, creates /json/new in the seat, and refuses foreign page sockets", async () => {
    const listA = (await getJson(`http://127.0.0.1:${pa}/json/list`)) as any[];
    const listB = (await getJson(`http://127.0.0.1:${pb}/json`)) as any[];
    expect(listA.map((t) => t.id)).toContain(idA);
    expect(listA.map((t) => t.id)).not.toContain(idB);
    expect(listB.map((t) => t.id)).toContain(idB);
    expect(listB.map((t) => t.id)).not.toContain(idA);
    expect(listA.every((t) => t.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${pa}/devtools/page/`))).toBe(
      true,
    );

    const refused = await new Promise<number | string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${pa}/devtools/page/${idB}`);
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve("opened"));
      ws.on("error", (err) => resolve(String(err)));
    });
    expect(refused).toBe(404);

    const own = await Raw.open(listA.find((t) => t.id === idA).webSocketDebuggerUrl);
    expect((await own.call("Runtime.evaluate", { expression: "1 + 1" })).result.value).toBe(2);
    own.close();

    const created = await getJson(`http://127.0.0.1:${pb}/json/new?about:blank%23fromhttp`, {
      method: "PUT",
    });
    expect(created.webSocketDebuggerUrl).toContain(`127.0.0.1:${pb}/devtools/page/${created.id}`);
    expect(seatOwnsBounds(SEAT_B, (await boundsOf(created.id)).bounds)).toBe(true);
    // B's Playwright picks the tab up like any other of its pages.
    await expect.poll(() => ctxB.pages().some((p) => p.url().includes("fromhttp"))).toBe(true);
    await Promise.all(pagesSeenByB);
    expect((await fetch(`http://127.0.0.1:${pa}/json/close/${created.id}`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${pb}/json/close/${created.id}`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${pa}/json/protocol`)).status).toBe(404);
  });

  it("keeps maximize and resize inside the tile", async () => {
    const v = await getJson(`http://127.0.0.1:${pb}/json/version`);
    const b = await Raw.open(v.webSocketDebuggerUrl);
    try {
      const { windowId } = await b.call("Browser.getWindowForTarget", { targetId: idB });
      await b.call("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } });
      expect((await upstream.call("Browser.getWindowBounds", { windowId })).bounds).toEqual({
        left: 1280,
        top: 0,
        width: 1280,
        height: 800,
        windowState: "normal",
      });
      await b.call("Browser.setWindowBounds", {
        windowId,
        bounds: { left: 0, top: 50, width: 2000, height: 500 },
      });
      expect((await upstream.call("Browser.getWindowBounds", { windowId })).bounds).toMatchObject({
        left: 1280,
        top: 50,
        width: 1280,
        height: 500,
      });
      await b.call("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } });
      const after = (await upstream.call("Browser.getWindowBounds", { windowId })).bounds;
      expect(after).toMatchObject({ left: 1280, top: 0, width: 1280, height: 800 });
      const { windowId: aWindow } = await boundsOf(idA);
      expect((await b.send("Browser.getWindowBounds", { windowId: aWindow })).error).toBeTruthy();
      expect(
        (await b.send("Browser.setWindowBounds", { windowId: aWindow, bounds: { left: 1300 } })).error,
      ).toBeTruthy();
      expect((await b.send("Browser.getWindowForTarget", { targetId: idA })).error?.code).toBe(-32602);
    } finally {
      b.close();
    }
  });

  it("delivers each agent's downloads to that agent only", async () => {
    const seenByB: string[] = [];
    const seenByA: string[] = [];
    pageB.on("download", (d) => seenByB.push(d.suggestedFilename()));
    pageA.on("download", (d) => seenByA.push(d.suggestedFilename()));

    await pageA.goto(`${base}/dlpage?who=A`);
    const [dlA] = await Promise.all([pageA.waitForEvent("download"), pageA.click("#d")]);
    expect(dlA.suggestedFilename()).toBe("export-A.csv");
    expect(readFileSync(await dlA.path(), "utf8")).toBe("who,A\n");

    await pageB.goto(`${base}/dlpage?who=B`);
    const [dlB] = await Promise.all([pageB.waitForEvent("download"), pageB.click("#d")]);
    expect(readFileSync(await dlB.path(), "utf8")).toBe("who,B\n");
    const saved = path.join(profile, "saved-b.csv");
    await dlB.saveAs(saved);
    expect(readFileSync(saved, "utf8")).toBe("who,B\n");

    await sleep(300);
    expect(seenByA).toEqual(["export-A.csv"]);
    expect(seenByB).toEqual(["export-B.csv"]);
  });

  it("never showed B a page that wasn't B's", async () => {
    const seen = await Promise.all(pagesSeenByB);
    // B's newPage x2, its /json/new tab and the raw tab opened in its tile; no A page, no half-placed tab.
    expect(seen.length).toBe(4);
    expect(seen).not.toContain("gone");
    for (const id of idsOfA) expect(seen).not.toContain(id);
  });
});
