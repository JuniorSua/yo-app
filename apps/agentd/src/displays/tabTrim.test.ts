import { describe, expect, it } from "vitest";
import { FreezeWatch, type SeatTab, type TabState, tabsToSave, trimSeatTabs } from "./tabTrim";

const MIN = 60_000;
const NOW = 1_000 * MIN;

/** Tabs t0..t(n-1), where t0 was used most recently and each next one a minute earlier. */
function seat(n: number, url = (i: number) => `https://site${i}.example/`) {
  const tabs: SeatTab[] = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, url: url(i), title: `T${i}` }));
  const used = new Map(tabs.map((t, i) => [t.id, NOW - i * MIN]));
  return { tabs, used };
}

async function trim(
  s: { tabs: SeatTab[]; used: Map<string, number> },
  o: {
    idleMs?: number;
    maxTabs?: number;
    duplicateMs?: number;
    typedGraceMs?: number;
    typed?: string[];
    state?: Record<string, TabState>;
    failClose?: string[];
  } = {},
) {
  const closed: string[] = [];
  const kept: string[] = [];
  const reasons: string[] = [];
  await trimSeatTabs({
    tabs: s.tabs,
    lastUse: (id) => s.used.get(id),
    now: NOW,
    idleMs: o.idleMs ?? 0,
    maxTabs: o.maxTabs ?? 0,
    duplicateMs: o.duplicateMs,
    typedGraceMs: o.typedGraceMs,
    typed: o.typed ? (id) => o.typed!.includes(id) : undefined,
    state: async (id) => (o.state && id in o.state ? o.state[id]! : { dirty: false, media: false }),
    close: async (t, why) => {
      if (o.failClose?.includes(t.id)) return false;
      closed.push(t.id);
      reasons.push(why);
      return true;
    },
    kept: (t, why) => kept.push(`${t.id}:${why}`),
  });
  return { closed, kept, reasons };
}

describe("trimSeatTabs: tab cap", () => {
  it("closes the least recently used tabs down to the cap", async () => {
    const r = await trim(seat(13), { maxTabs: 10 });
    expect(r.closed).toEqual(["t12", "t11", "t10"]);
    expect(r.reasons).toEqual(["tab cap", "tab cap", "tab cap"]);
  });

  it("does nothing at or under the cap, or with the cap off", async () => {
    expect((await trim(seat(10), { maxTabs: 10 })).closed).toEqual([]);
    expect((await trim(seat(30), { maxTabs: 0 })).closed).toEqual([]);
  });

  it("skips tabs with unsaved typing, playing media or an unreadable state, and closes the next instead", async () => {
    const r = await trim(seat(12), {
      maxTabs: 10,
      state: { t11: { dirty: true, media: false }, t10: { dirty: false, media: true }, t9: null },
    });
    expect(r.closed).toEqual(["t8", "t7"]);
    expect(r.kept).toEqual(["t11:unsaved input", "t10:media playing", "t9:unreadable"]);
  });

  it("never closes the most recently used tab, even when every other tab must stay", async () => {
    const s = seat(3);
    const r = await trim(s, {
      maxTabs: 1,
      state: { t1: { dirty: true, media: false }, t2: { dirty: true, media: false } },
    });
    expect(r.closed).toEqual([]);
    // With the others closable it keeps only the newest.
    expect((await trim(seat(3), { maxTabs: 1 })).closed).toEqual(["t2", "t1"]);
  });

  it("counts and closes only web pages", async () => {
    const s = seat(12, (i) => (i >= 10 ? "chrome://newtab/" : `https://site${i}.example/`));
    expect((await trim(s, { maxTabs: 10 })).closed).toEqual([]);
    const s2 = seat(12, (i) => (i === 11 ? "about:blank" : `https://site${i}.example/`));
    expect((await trim(s2, { maxTabs: 10 })).closed).toEqual(["t10"]);
  });

  it("a tab that wouldn't close still counts as open", async () => {
    const r = await trim(seat(12), { maxTabs: 10, failClose: ["t11"] });
    expect(r.closed).toEqual(["t10", "t9"]);
  });
});

describe("trimSeatTabs: idle tabs", () => {
  it("closes tabs unused for the idle time, keeping the newest even when it's idle too", async () => {
    const s = seat(4);
    for (const [id, at] of s.used) s.used.set(id, at - 60 * MIN); // everything idle for over an hour
    const r = await trim(s, { idleMs: 30 * MIN });
    expect(r.closed).toEqual(["t3", "t2", "t1"]);
    expect(r.reasons.every((x) => x === "idle")).toBe(true);
  });

  it("leaves recently used tabs and tabs with no known use", async () => {
    const s = seat(40);
    s.used.delete("t39");
    const r = await trim(s, { idleMs: 30 * MIN });
    expect(r.closed).toEqual(["t38", "t37", "t36", "t35", "t34", "t33", "t32", "t31", "t30"]);
  });

  it("runs with the cap in one pass: idle tabs first, then the cap only for what's left", async () => {
    const r = await trim(seat(14), { idleMs: 12 * MIN, maxTabs: 10 });
    // t12, t13 are idle (12+ minutes); then 12 left, so t11 and t10 go for the cap.
    expect(r.closed).toEqual(["t13", "t12", "t11", "t10"]);
    expect(r.reasons).toEqual(["idle", "idle", "tab cap", "tab cap"]);
  });
});

describe("trimSeatTabs: what really keeps a tab open", () => {
  const busy = { dirty: true, media: false };

  it("ignores 'unsaved input' in tabs nobody typed into (sites fill their own fields)", async () => {
    const r = await trim(seat(12), {
      maxTabs: 10,
      typed: ["t10"],
      state: { t11: busy, t10: busy },
    });
    expect(r.closed).toEqual(["t11", "t9"]);
    expect(r.kept).toEqual(["t10:unsaved input"]);
  });

  it("typing keeps a tab only until it has been unused for the grace time", async () => {
    const s = seat(3);
    s.used.set("t2", NOW - 3 * 60 * MIN);
    s.used.set("t1", NOW - 40 * MIN);
    const r = await trim(s, {
      idleMs: 30 * MIN,
      typedGraceMs: 2 * 60 * MIN,
      typed: ["t1", "t2"],
      state: { t1: busy, t2: busy },
    });
    expect(r.closed).toEqual(["t2"]);
    expect(r.kept).toEqual(["t1:unsaved input"]);
  });

  it("closes a frozen tab instead of keeping it, and says why", async () => {
    const r = await trim(seat(12), { maxTabs: 10, state: { t11: { dirty: true, media: true, hung: true } } });
    expect(r.closed).toEqual(["t11", "t10"]);
    expect(r.reasons).toEqual(["frozen", "tab cap"]);
  });
});

describe("trimSeatTabs: copies of the same page", () => {
  const url = (i: number) => (i % 2 ? "https://crm.example/home#x" : `https://site${i}.example/`);

  it("closes older copies of a page once they're unused for a while, keeping the newest copy", async () => {
    // t1, t3, t5 are the same page (t1 newest).
    const r = await trim(seat(6, url), { duplicateMs: 2 * MIN });
    expect(r.closed).toEqual(["t5", "t3"]);
    expect(r.reasons).toEqual(["duplicate", "duplicate"]);
  });

  it("leaves a copy the agent just opened", async () => {
    const r = await trim(seat(6, url), { duplicateMs: 4 * MIN });
    expect(r.closed).toEqual(["t5"]);
  });
});

describe("tabsToSave", () => {
  it("saves web pages once each, up to the cap, in order", () => {
    expect(
      tabsToSave(
        [
          "https://a/",
          "chrome://newtab/",
          "https://b/#1",
          "https://a/",
          "https://b/#2",
          "https://c/",
          "https://d/",
        ],
        3,
      ),
    ).toEqual(["https://a/", "https://b/#1", "https://c/"]);
  });
});

describe("FreezeWatch", () => {
  it("reports a tab only after it misses checks in a row, and forgets it when it answers or closes", () => {
    const w = new FreezeWatch(3);
    expect(
      w.record([
        { id: "a", answered: false },
        { id: "b", answered: false },
      ]),
    ).toEqual([]);
    expect(
      w.record([
        { id: "a", answered: false },
        { id: "b", answered: true },
      ]),
    ).toEqual([]);
    expect(
      w.record([
        { id: "a", answered: false },
        { id: "b", answered: false },
      ]),
    ).toEqual(["a"]);
    // b's count started over when it answered; a is gone (closed), so it starts over too.
    expect(w.record([{ id: "b", answered: false }])).toEqual([]);
    expect(
      w.record([
        { id: "a", answered: false },
        { id: "b", answered: false },
      ]),
    ).toEqual(["b"]);
  });
});
