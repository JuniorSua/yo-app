/**
 * Issue #158: after a wake, Chromium's session restore brought back 29 windows at the parking spot, which no
 * seat owned and nothing ever closed (7+ GB). These run SharedDesktop's reconcile and window keeper against a
 * fake Chromium (CDP calls answered from an in-memory list of windows and pages): no X, no browser.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import type { Logger } from "../log";
import type { CdpClient } from "./cdpClient";
import { SharedDesktop } from "./SharedDesktop";
import type { TabState } from "./tabTrim";

const W = config.screen.width;
const H = config.screen.height;
const PARK_X = config.sharedTiles * W;
const MIN = 60_000;

interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
  windowState: string;
}

/** Just enough of Chromium's CDP for SharedDesktop: windows, pages, closing, creating, reading a page. */
class FakeChrome {
  closed = false;
  windows = new Map<number, Bounds>();
  pageList: { id: string; url: string; title: string; windowId: number }[] = [];
  /** What a page's state read returns (default: nothing typed, no media). */
  state = new Map<string, TabState>();
  private nextWindow = 100;
  private nextPage = 1;
  private active: string | null = null;

  window(left: number, urls: string[]): { windowId: number; ids: string[] } {
    const windowId = this.nextWindow++;
    this.windows.set(windowId, { left, top: 0, width: W, height: H, windowState: "normal" });
    return { windowId, ids: urls.map((url) => this.addPage(windowId, url)) };
  }

  private addPage(windowId: number, url: string): string {
    const id = `T${this.nextPage++}`;
    this.pageList.push({ id, url, title: "", windowId });
    return id;
  }

  async pages() {
    return this.pageList.map((p) => ({ id: p.id, type: "page", url: p.url, title: p.title }));
  }

  async call(method: string, params: Record<string, any> = {}, _timeout?: number, sessionId?: string) {
    const page = (id: string) => {
      const p = this.pageList.find((x) => x.id === id);
      if (!p) throw new Error("No target with given id found");
      return p;
    };
    switch (method) {
      case "Browser.getWindowForTarget": {
        const p = page(params.targetId);
        return { windowId: p.windowId, bounds: { ...this.windows.get(p.windowId)! } };
      }
      case "Browser.setWindowBounds": {
        const b = this.windows.get(params.windowId);
        if (!b) throw new Error("Browser window not found");
        Object.assign(b, params.bounds);
        return {};
      }
      case "Target.closeTarget": {
        const p = page(params.targetId);
        this.pageList = this.pageList.filter((x) => x !== p);
        if (!this.pageList.some((x) => x.windowId === p.windowId)) this.windows.delete(p.windowId);
        return { success: true };
      }
      case "Target.createTarget": {
        // Like Chromium started with --window-position=PARK_X,0: a new window opens in the parking spot.
        if (params.newWindow || !this.active) {
          const { ids } = this.window(PARK_X, [params.url]);
          return { targetId: ids[0] };
        }
        return { targetId: this.addPage(page(this.active).windowId, params.url) };
      }
      case "Target.activateTarget":
        page(params.targetId);
        this.active = params.targetId;
        return {};
      case "Target.attachToTarget":
        page(params.targetId);
        return { sessionId: `s:${params.targetId}` };
      case "Target.detachFromTarget":
        return {};
      case "Runtime.evaluate": {
        if (params.expression === "1") return { result: { value: 1 } };
        const id = sessionId!.slice(2);
        const s = this.state.has(id) ? this.state.get(id) : { dirty: false, media: false };
        return { result: { value: JSON.stringify(s) } };
      }
      default:
        throw new Error(`unexpected CDP call ${method}`);
    }
  }

  close() {}

  parked() {
    return [...this.windows].filter(([, b]) => b.left >= PARK_X).map(([id]) => id);
  }

  urlsIn(windowId: number) {
    return this.pageList.filter((p) => p.windowId === windowId).map((p) => p.url);
  }

  /** Pages per tile (by the window's left edge), web pages only. */
  tabsInTile(tile: number) {
    return this.pageList.filter((p) => {
      const b = this.windows.get(p.windowId)!;
      return b.left >= tile * W && b.left < (tile + 1) * W && /^https?:/.test(p.url);
    });
  }

  orphanCount() {
    return this.pageList.filter((p) => this.windows.get(p.windowId)!.left >= PARK_X && /^https?:/.test(p.url))
      .length;
  }
}

const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
const rec =
  (level: string) =>
  (msg: string, fields?: Record<string, unknown>): void => {
    logs.push({ level, msg, fields });
  };
const log: Logger = {
  debug: rec("debug"),
  info: rec("info"),
  warn: rec("warn"),
  error: rec("error"),
  child: () => log,
};

let dir: string;
const saved = { ...config };
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "yo-orphans-"));
  config.dataDir = dir;
  config.runDir = dir;
  config.sharedComputer = true;
  config.maxSeatTabs = 8;
  logs.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T16:35:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  Object.assign(config, saved);
  rmSync(dir, { recursive: true, force: true });
});

/** A SharedDesktop wired to a fake Chromium, its display marked ready, with no real memory readings. */
function desktop(chrome: FakeChrome, memory: { available?: number | null; renderers?: number | null } = {}) {
  const shared = new SharedDesktop(log);
  const internals = shared as unknown as { cdp: unknown; keep(): Promise<void> };
  internals.cdp = chrome;
  shared.display.state = "ready";
  shared.memoryProbe = {
    available: () => memory.available ?? null,
    renderers: () => memory.renderers ?? null,
  };
  return {
    shared,
    cdp: chrome as unknown as CdpClient,
    keep: () => internals.keep(),
    later: (ms: number) => vi.setSystemTime(Date.now() + ms),
  };
}

/** An awake seat in `tile` (no proxy or live view: those need X). */
function wake(shared: SharedDesktop, agentId: string, n: number) {
  const seat = shared.seat(agentId, n);
  seat.tile = shared.claimTile(agentId);
  seat.state = "ready";
  return seat;
}

const roadster = Array.from({ length: 7 }, (_, i) => `https://roadster.example/deal/${i}`);
const mail = [
  ...Array.from({ length: 6 }, (_, i) => `https://mail.example/inbox/${i}`),
  "https://activix.example/leads",
  "https://activix.example/calendar",
];

describe("wake after sleep (the issue's acceptance scenario)", () => {
  it("15+ tabs across 2 seats -> sleep -> wake restored at PARK_X: one parked window, <= 8 tabs per seat", async () => {
    const chrome = new FakeChrome();
    const { shared, cdp, keep } = desktop(chrome);
    // Before sleep: two agents with 15 tabs between them, saved when they went to sleep (seats.json).
    shared.claimTile("agt_a");
    shared.claimTile("agt_b");
    shared.saveTabs("agt_a", roadster);
    shared.saveTabs("agt_b", mail);
    expect(shared.savedTabs("agt_a").length + shared.savedTabs("agt_b").length).toBe(15);

    // Wake: --restore-last-session brings everything back in the parking spot.
    chrome.window(PARK_X, ["about:blank"]);
    for (const url of roadster) chrome.window(PARK_X, [url, url]); // copies
    chrome.window(PARK_X, [roadster[0]!, "https://roadster.example/deal/new"]);
    for (const url of mail) chrome.window(PARK_X, [url, `${url}#thread`]);
    for (let i = 0; i < 5; i++) chrome.window(PARK_X, ["https://login.example/mfa?step=2"]);
    expect(chrome.parked().length).toBe(1 + 7 + 1 + 8 + 5);
    expect(chrome.pageList.length).toBeGreaterThan(30);

    await shared.reconcileWindows(cdp);

    // Exactly one parked window: the blank session keeper.
    expect(chrome.parked()).toHaveLength(1);
    expect(chrome.urlsIn(chrome.parked()[0]!)).toEqual(["about:blank"]);
    // The restored pages went to their agent's reopen list (deduped, capped at 8); the MFA junk to nobody.
    expect(shared.savedTabs("agt_a")).toEqual([...roadster, "https://roadster.example/deal/new"]);
    expect(shared.savedTabs("agt_b")).toEqual(mail);
    const closedLog = logs.find((l) => l.msg === "closed windows restored off the screen");
    expect(closedLog?.fields).toMatchObject({ windows: 21 });
    expect(String(closedLog?.fields?.hosts)).toContain("login.example×5");
    expect(JSON.stringify(closedLog?.fields)).not.toContain("/deal/"); // hosts only

    // Both agents wake and reopen their saved tabs as usual; then one keeper pass.
    for (const [agentId, n] of [
      ["agt_a", 1],
      ["agt_b", 2],
    ] as const) {
      const seat = wake(shared, agentId, n);
      await shared.openInTile(seat.tile!, shared.savedTabs(agentId));
    }
    await keep();

    expect(chrome.parked()).toHaveLength(1);
    expect(chrome.tabsInTile(0).length).toBeLessThanOrEqual(8);
    expect(chrome.tabsInTile(1).length).toBeLessThanOrEqual(8);
    expect(chrome.tabsInTile(0).length + chrome.tabsInTile(1).length).toBe(16);
    expect(chrome.orphanCount()).toBe(0);
  });

  it("parks a new blank window before closing the rest when no restored window is blank", async () => {
    const chrome = new FakeChrome();
    const { shared, cdp } = desktop(chrome);
    chrome.window(PARK_X, ["https://a.example/"]);
    chrome.window(PARK_X, ["https://b.example/"]);
    await shared.reconcileWindows(cdp);
    expect(chrome.parked()).toHaveLength(1);
    expect(chrome.urlsIn(chrome.parked()[0]!)).toEqual(["about:blank"]);
  });
});

/** Seat A awake in tile 0 with two tabs, the parked keeper, and `n` orphan pages in the parking spot. */
async function withOrphans(n: number, memory?: Parameters<typeof desktop>[1]) {
  const chrome = new FakeChrome();
  const d = desktop(chrome, memory);
  wake(d.shared, "agt_a", 1);
  chrome.window(PARK_X, ["about:blank"]);
  chrome.window(0, ["https://crm.example/", "https://mail.example/"]);
  await d.shared.reconcileWindows(d.cdp);
  const orphans = Array.from(
    { length: n },
    (_, i) => chrome.window(PARK_X, [`https://site${i}.example/`]).ids[0]!,
  );
  return { chrome, orphans, ...d };
}

describe("keeper safety net for orphan tabs", () => {
  it("closes orphans over the cap at once, the rest after 2 minutes unused; the keeper and seat tabs stay", async () => {
    const { chrome, keep, later } = await withOrphans(10);
    await keep();
    expect(chrome.orphanCount()).toBe(8);
    later(30_000);
    await keep();
    expect(chrome.orphanCount()).toBe(8); // still fresh
    later(2 * MIN);
    await keep();
    expect(chrome.orphanCount()).toBe(0);
    expect(chrome.parked()).toHaveLength(1);
    expect(chrome.tabsInTile(0)).toHaveLength(2);
    expect(logs.filter((l) => l.msg === "closed a tab no agent owns")).toHaveLength(10);
    expect(logs.find((l) => l.msg === "closed a tab no agent owns")?.fields?.host).toMatch(/\.example$/);
  });

  it("keeps an orphan someone typed into (within 2 h) or playing media", async () => {
    const { chrome, orphans, shared, keep, later } = await withOrphans(3);
    shared.touch(orphans[0]!, "Input.insertText");
    chrome.state.set(orphans[0]!, { dirty: true, media: false });
    chrome.state.set(orphans[1]!, { dirty: false, media: true });
    await keep();
    later(3 * MIN);
    await keep();
    expect(chrome.pageList.map((p) => p.id)).toEqual(expect.arrayContaining([orphans[0], orphans[1]]));
    expect(chrome.pageList.map((p) => p.id)).not.toContain(orphans[2]);
    // Typing keeps it only for the 2 h grace.
    later(2 * 60 * MIN);
    await keep();
    expect(chrome.pageList.map((p) => p.id)).not.toContain(orphans[0]);
    expect(chrome.pageList.map((p) => p.id)).toContain(orphans[1]);
  });

  it("closes nothing outside the seats while the user has taken one over", async () => {
    const { chrome, shared, keep, later } = await withOrphans(12);
    await shared.seat("agt_a", 1).setLease("user");
    await keep();
    later(5 * MIN);
    await keep();
    expect(chrome.orphanCount()).toBe(12);
  });

  it("leaves the seat's own tiled tabs to the per-seat rules", async () => {
    const { chrome, keep, later } = await withOrphans(0);
    later(5 * MIN);
    await keep();
    expect(chrome.tabsInTile(0)).toHaveLength(2);
  });
});

describe("memory guard", () => {
  it("under 25% available: closes orphans of any age, then other copies in seats; at most once a minute", async () => {
    const { chrome, keep, later, orphans } = await withOrphans(3, { available: 0.1 });
    chrome.state.set(orphans[2]!, { dirty: false, media: true }); // protected
    const tile = chrome.tabsInTile(0)[0]!.windowId;
    chrome.pageList.push({ id: "copy1", url: "https://crm.example/", title: "", windowId: tile });
    chrome.pageList.push({ id: "copy2", url: "https://crm.example/#2", title: "", windowId: tile });
    await keep();
    const swept = logs.filter((l) => l.msg === "memory guard swept tabs");
    expect(swept).toHaveLength(1);
    expect(swept[0]!.fields).toMatchObject({ reason: "low memory", availablePct: 10 });
    expect(chrome.orphanCount()).toBe(1); // only the one playing media
    // Rate limit: another orphan 20 s later stays (fresh, under the cap) until a minute has passed.
    chrome.window(PARK_X, ["https://late.example/"]);
    later(20_000);
    await keep();
    expect(logs.filter((l) => l.msg === "memory guard swept tabs")).toHaveLength(1);
    expect(chrome.orphanCount()).toBe(2);
    later(45_000);
    await keep();
    expect(logs.filter((l) => l.msg === "memory guard swept tabs")).toHaveLength(2);
    expect(chrome.orphanCount()).toBe(1);
    // Other copies of crm.example in the seat (seen a minute ago, so older than the newest): one stays.
    expect(chrome.tabsInTile(0).filter((p) => p.url.startsWith("https://crm.example/"))).toHaveLength(1);
  });

  it("too many renderers sweeps too; plenty of memory and few renderers doesn't", async () => {
    const limit = config.sharedTiles * 8 + 4;
    const busy = await withOrphans(3, { available: 0.5, renderers: limit + 1 });
    await busy.keep();
    expect(logs.filter((l) => l.msg === "memory guard swept tabs")[0]?.fields?.reason).toBe("too many pages");
    expect(busy.chrome.orphanCount()).toBe(0);
    logs.length = 0;
    const calm = await withOrphans(3, { available: 0.5, renderers: 10 });
    await calm.keep();
    expect(logs.filter((l) => l.msg === "memory guard swept tabs")).toHaveLength(0);
    expect(calm.chrome.orphanCount()).toBe(3);
  });
});
