import { describe, expect, it } from "vitest";
import {
  hostSummary,
  LOW_MEMORY,
  memoryPressure,
  mergeSavedTabs,
  ownerByUrl,
  planReconcile,
  type RestoredWindow,
  trimOrphans,
} from "./orphans";
import type { SeatTab, TabState } from "./tabTrim";

const W = 1280;
const TILES = 6;
const PARK_X = TILES * W;
const MIN = 60_000;
const NOW = 1_000 * MIN;

let nextPage = 0;
const win = (id: number, left: number, urls: string[]): RestoredWindow => ({
  id,
  bounds: { left, windowState: "normal" },
  pages: urls.map((url) => ({ id: `p${nextPage++}`, url })),
});

const plan = (windows: RestoredWindow[], o: Partial<Parameters<typeof planReconcile>[0]> = {}) =>
  planReconcile({
    windows,
    parkX: PARK_X,
    tileWidth: W,
    tiles: TILES,
    held: new Set(),
    tileOwner: {},
    saved: {},
    ...o,
  });

describe("planReconcile: after a wake", () => {
  it("keeps exactly one blank parked window and closes every other parked one (the issue's 28 of 29)", () => {
    const windows = [
      win(1, PARK_X, ["https://roadster.example/deal/1"]),
      win(2, PARK_X, ["about:blank"]),
      ...Array.from({ length: 26 }, (_, i) => win(10 + i, PARK_X, [`https://mail.example/u/${i % 3}`])),
      win(99, PARK_X, ["about:blank", "https://activix.example/"]),
    ];
    const p = plan(windows);
    expect(p.keeper).toBe(2);
    expect(p.close.map((c) => c.windowId).sort((a, b) => a - b)).toEqual(
      windows
        .map((w) => w.id)
        .filter((id) => id !== 2)
        .sort((a, b) => a - b),
    );
    expect(p.close.every((c) => c.parked)).toBe(true);
    expect(p.remember).toEqual([]);
  });

  it("prefers a window with only about:blank; none blank means a new one gets parked", () => {
    expect(plan([win(1, PARK_X, ["chrome://newtab/"]), win(2, PARK_X, ["about:blank"])]).keeper).toBe(2);
    expect(plan([win(1, PARK_X, ["chrome://newtab/"])]).keeper).toBe(1);
    const p = plan([win(1, PARK_X, ["https://a.example/"]), win(2, PARK_X, ["https://b.example/"])]);
    expect(p.keeper).toBeNull();
    expect(p.close).toHaveLength(2);
  });

  it("gives each closed parked window to the agent whose saved tabs it matches", () => {
    const saved = {
      agt_a: ["https://roadster.example/deal/1", "https://roadster.example/deals"],
      agt_b: ["https://mail.example/inbox"],
    };
    const p = plan(
      [
        win(1, PARK_X, ["about:blank"]),
        win(2, PARK_X, ["https://roadster.example/deal/1#notes", "https://roadster.example/deal/2"]),
        win(3, PARK_X, ["https://mail.example/inbox"]),
        win(4, PARK_X, ["https://login.example/mfa"]),
      ],
      { saved },
    );
    const owner = Object.fromEntries(p.close.map((c) => [c.windowId, c.owner]));
    expect(owner).toEqual({ 2: "agt_a", 3: "agt_b", 4: null });
  });

  it("keeps windows in a held tile and closes those in an unheld tile for the tile's last owner (as before)", () => {
    const p = plan(
      [
        win(1, PARK_X, ["about:blank"]),
        win(2, 0, ["https://a.example/"]),
        win(3, W + 10, ["https://b.example/"]),
        win(4, 3 * W, ["https://c.example/"]),
      ],
      { held: new Set([0]), tileOwner: { 1: "agt_b" } },
    );
    expect(p.remember).toEqual([{ windowId: 2, tile: 0 }]);
    expect(p.close.map((c) => [c.windowId, c.owner, c.parked])).toEqual([
      [3, "agt_b", false],
      [4, null, false],
    ]);
  });
});

describe("ownerByUrl", () => {
  it("picks the agent with the most matching pages, and nobody on a tie or no match", () => {
    const saved = { a: ["https://x/1", "https://x/2"], b: ["https://x/2", "https://y/"] };
    expect(ownerByUrl(["https://x/1", "https://x/2"], saved)).toBe("a");
    expect(ownerByUrl(["https://x/2"], saved)).toBeNull();
    expect(ownerByUrl(["https://z/"], saved)).toBeNull();
    expect(ownerByUrl(["about:blank"], saved)).toBeNull();
  });
});

describe("mergeSavedTabs", () => {
  it("adds pages after the saved ones (most recent first), each page once, capped", () => {
    expect(
      mergeSavedTabs(
        ["https://a/", "https://b/"],
        ["https://b/#x", "chrome://newtab/", "https://c/", "https://d/"],
        3,
      ),
    ).toEqual(["https://a/", "https://b/", "https://c/"]);
  });
});

describe("hostSummary", () => {
  it("counts hosts, most first, without paths", () => {
    expect(
      hostSummary(["https://mail.example/a?x=secret", "https://mail.example/b", "https://crm.example/"]),
    ).toBe("mail.example×2, crm.example");
  });
});

/** Orphans o0..o(n-1): o0 used most recently, each next one a minute earlier. */
function orphans(n: number) {
  const tabs: SeatTab[] = Array.from({ length: n }, (_, i) => ({
    id: `o${i}`,
    url: `https://site${i}.example/`,
    title: "",
  }));
  return { tabs, used: new Map(tabs.map((t, i) => [t.id, NOW - i * MIN])) };
}

async function trim(
  s: ReturnType<typeof orphans>,
  o: { idleMs?: number; maxTabs?: number; typed?: string[]; state?: Record<string, TabState> } = {},
) {
  const closed: string[] = [];
  const reasons: string[] = [];
  const kept: string[] = [];
  await trimOrphans({
    tabs: s.tabs,
    lastUse: (id) => s.used.get(id),
    now: NOW,
    idleMs: o.idleMs ?? 2 * MIN,
    maxTabs: o.maxTabs ?? 8,
    typedGraceMs: 120 * MIN,
    typed: (id) => o.typed?.includes(id) ?? false,
    state: async (id) => (o.state && id in o.state ? o.state[id]! : { dirty: false, media: false }),
    close: async (t, why) => {
      closed.push(t.id);
      reasons.push(why);
      return true;
    },
    kept: (t, why) => kept.push(`${t.id}:${why}`),
  });
  return { closed, reasons, kept };
}

describe("trimOrphans", () => {
  it("closes orphans unused for 2 minutes, oldest first, and leaves fresher ones", async () => {
    const r = await trim(orphans(4));
    expect(r.closed).toEqual(["o3", "o2"]);
    expect(r.reasons).toEqual(["orphan", "orphan"]);
  });

  it("closes the least recently used at once while there are more than the cap, even if just used", async () => {
    const s = orphans(12);
    for (const t of s.tabs) s.used.set(t.id, NOW); // all fresh
    const r = await trim(s, { maxTabs: 8 });
    expect(r.closed).toHaveLength(4);
  });

  it("keeps no tab for being the newest: the last orphan goes too", async () => {
    const s = orphans(1);
    s.used.set("o0", NOW - 5 * MIN);
    expect((await trim(s)).closed).toEqual(["o0"]);
  });

  it("keeps typed-in unsaved input (2 h grace), playing media and unreadable tabs; closes frozen ones", async () => {
    const s = orphans(6);
    s.used.set("o5", NOW - 3 * 60 * MIN); // typed long ago: grace over
    const busy = { dirty: true, media: false };
    const r = await trim(s, {
      typed: ["o2", "o5"],
      state: {
        o2: busy,
        o3: { dirty: false, media: true },
        o4: null,
        o5: busy,
        o1: { dirty: false, media: false, hung: true },
      },
      idleMs: 0,
    });
    expect(r.kept).toEqual(["o4:unreadable", "o3:media playing", "o2:unsaved input"]);
    expect(r.closed).toEqual(["o5", "o1", "o0"]);
    expect(r.reasons).toEqual(["orphan", "frozen", "orphan"]);
  });

  it("ignores non-web pages", async () => {
    const r = await trim({
      tabs: [{ id: "x", url: "about:blank", title: "" }],
      used: new Map([["x", 0]]),
    });
    expect(r.closed).toEqual([]);
  });
});

describe("memoryPressure", () => {
  const limit = TILES * 8 + 4;
  it("sweeps under 25% available or above the page limit; not otherwise", () => {
    expect(LOW_MEMORY).toBe(0.25);
    expect(memoryPressure({ available: 0.24, processes: 10, limit })).toBe("low memory");
    expect(memoryPressure({ available: 0.25, processes: limit, limit })).toBeNull();
    // The issue's PC: 42% available but 61 renderers (> 52).
    expect(memoryPressure({ available: 0.42, processes: 61, limit })).toBe("too many pages");
    expect(memoryPressure({ available: null, processes: 10, limit })).toBeNull();
    expect(memoryPressure({ available: null, processes: 500, limit: 0 })).toBeNull();
  });
});
