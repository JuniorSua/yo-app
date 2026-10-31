import { describe, expect, it } from "vitest";
import {
  agoLabel,
  composerHeight,
  elapsedLabel,
  fitViewport,
  isPhoneSideways,
  localDate,
  presenceView,
  quickReplies,
  workingView,
} from "../lib/view.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

describe("workingView", () => {
  it("is null when Yo isn't working, or the status went stale", () => {
    expect(workingView({ working: null, now: NOW })).toBeNull();
    expect(workingView({ working: { state: "working", at: NOW - 6 * MIN }, now: NOW })).toBeNull();
  });

  it("shows the current step, how long, and helpers", () => {
    const v = workingView({
      working: { state: "working", detail: "Checking Roadster…", at: NOW, since: NOW - 3 * MIN },
      helpers: 2,
      agent: "Yo",
      now: NOW,
    });
    expect(v).toEqual({
      tone: "working",
      title: "Yo is working",
      step: "Checking Roadster",
      elapsed: "3m",
      helpers: "2 helpers helping",
      canStop: true,
    });
  });

  it("says something calm when there's no step (or just 'Thinking')", () => {
    for (const detail of ["", "Thinking", "thinking…"])
      expect(workingView({ working: { state: "working", detail, at: NOW }, now: NOW })?.step).toBe(
        "Thinking it through",
      );
  });

  it("queued and stopping can't be stopped again", () => {
    expect(workingView({ working: { state: "queued", at: NOW }, agent: "Kai", now: NOW })).toMatchObject({
      tone: "queued",
      title: "Up next",
      step: "Kai will get to this after the current task",
      canStop: false,
    });
    expect(workingView({ working: { state: "working", stopping: true, at: NOW }, now: NOW })).toMatchObject({
      tone: "stopping",
      title: "Stopping…",
      canStop: false,
    });
  });
});

describe("presenceView", () => {
  it("connecting, then online, working and away", () => {
    expect(presenceView({ seen: undefined, now: NOW })).toMatchObject({ tone: "connecting", banner: null });
    expect(presenceView({ seen: NOW - MIN, now: NOW })).toMatchObject({ tone: "online", text: "Online" });
    expect(presenceView({ seen: NOW - MIN, helpers: 1, now: NOW }).text).toBe("Online · 1 helper working");
    expect(
      presenceView({ seen: NOW, working: { state: "working", detail: "Booking a table…" }, now: NOW }),
    ).toMatchObject({ tone: "working", text: "Booking a table" });
    expect(presenceView({ seen: NOW, working: { state: "queued" }, now: NOW }).text).toBe(
      "Busy · you're next",
    );
    const away = presenceView({ seen: NOW - 20 * MIN, agent: "Yo", now: NOW });
    expect(away).toMatchObject({ tone: "offline", text: "Away · seen 20 min ago", online: false });
    expect(away.banner).toEqual({
      tone: "away",
      text: "Yo's computer is offline. It'll get your messages when it's back.",
    });
  });

  it("no connection wins, and says whether a message is waiting", () => {
    expect(presenceView({ seen: NOW, netDown: true, now: NOW })).toMatchObject({
      tone: "reconnecting",
      text: "Reconnecting…",
      banner: { tone: "net", text: "No connection. Trying again…" },
    });
    expect(presenceView({ seen: NOW, netDown: true, queuedToSend: 1, now: NOW }).banner?.text).toMatch(
      /will send by itself/,
    );
  });
});

describe("quickReplies", () => {
  const yo = (text, extra = {}) => ({ k: "yo", id: "r1", text, at: NOW, ...extra });

  it("offers the options Yo listed", () => {
    const text =
      "Three quiet spots:\n\n1. **Via Carota** · Italian, cozy, $$\n2. **Cervo's** · seafood\n3. **Hart's** · wine\n\nWant me to book one?";
    expect(quickReplies([yo(text)])).toEqual(["Via Carota", "Cervo's", "Hart's"]);
  });

  it("offers yes and no for a yes-or-no question", () => {
    expect(quickReplies([yo("I found a table at 7:30. Want me to book it?")])).toEqual([
      "Yes, please",
      "No, thanks",
    ]);
  });

  it("nothing for open questions, statements, your own last message or a peek", () => {
    expect(quickReplies([yo("Where should we go?")])).toEqual([]);
    expect(quickReplies([yo("Booked it.")])).toEqual([]);
    expect(quickReplies([yo("Want me to book it?"), { k: "me", text: "hm", at: NOW }])).toEqual([]);
    expect(quickReplies([yo("Want to see more?", { peek: true })])).toEqual([]);
    expect(quickReplies([])).toEqual([]);
  });

  it("uses the replies Yo picked itself (v2.3) over its own guess", () => {
    const text = "Two openings next week. Which one works for you?";
    expect(quickReplies([yo(text)])).toEqual([]);
    expect(quickReplies([yo(text, { replies: ["Tuesday 9:30", "Thursday 2:00"] })])).toEqual([
      "Tuesday 9:30",
      "Thursday 2:00",
    ]);
    // Even for a statement, and never more than three; an empty list falls back to the guess.
    expect(
      quickReplies([yo("Booked it.", { replies: ["Thanks", "Add to calendar", "Cancel it", "More"] })]),
    ).toEqual(["Thanks", "Add to calendar", "Cancel it"]);
    expect(quickReplies([yo("Want me to book it?", { replies: [] })])).toEqual(["Yes, please", "No, thanks"]);
    expect(quickReplies([yo("Here's my screen.", { peek: true, replies: ["Thanks"] })])).toEqual([]);
  });
});

describe("localDate", () => {
  it("is the phone's own date as YYYY-MM-DD", () => {
    expect(localDate(new Date(2026, 9, 28, 23, 59))).toBe("2026-10-28");
    expect(localDate(new Date(2027, 0, 5, 0, 1))).toBe("2027-01-05");
  });
});

describe("fitViewport", () => {
  it("follows the visual viewport when the keyboard is up", () => {
    expect(fitViewport({ innerHeight: 844, vvHeight: 508, vvTop: 0 })).toEqual({
      height: 508,
      top: 0,
      kbOpen: true,
      kb: 336,
    });
    // iOS panned the page: the app box follows the visual viewport down.
    expect(fitViewport({ innerHeight: 844, vvHeight: 508, vvTop: 336 })).toEqual({
      height: 508,
      top: 336,
      kbOpen: true,
      kb: 336,
    });
    expect(fitViewport({ innerHeight: 844, vvHeight: 844 })).toEqual({
      height: 844,
      top: 0,
      kbOpen: false,
      kb: 0,
    });
  });

  it("guesses from the last keyboard while it slides in, so nothing has to jump after", () => {
    expect(fitViewport({ innerHeight: 844, vvHeight: 844, focused: true, lastKb: 336 })).toEqual({
      height: 508,
      top: 0,
      kbOpen: true,
      kb: 336,
      guess: true,
    });
    expect(fitViewport({ innerHeight: 844, vvHeight: 844, focused: false, lastKb: 336 }).kbOpen).toBe(false);
    // A remembered height that can't be a keyboard isn't used.
    expect(fitViewport({ innerHeight: 844, vvHeight: 844, focused: true, lastKb: 700 }).kbOpen).toBe(false);
  });
});

describe("isPhoneSideways", () => {
  const phone = { screenW: 393, screenH: 852, innerW: 393, innerH: 659, coarse: true };
  it("a phone in landscape, by its screen's orientation", () => {
    expect(
      isPhoneSideways({ ...phone, orientationType: "landscape-primary", innerW: 852, innerH: 340 }),
    ).toBe(true);
    expect(isPhoneSideways({ ...phone, orientationType: "portrait-primary" })).toBe(false);
    // Older iOS: window.orientation
    expect(isPhoneSideways({ ...phone, legacyOrientation: -90 })).toBe(true);
    expect(isPhoneSideways({ ...phone, legacyOrientation: 0 })).toBe(false);
  });
  it("a keyboard that makes the window wide doesn't count", () => {
    expect(isPhoneSideways({ ...phone, orientationType: "portrait-primary", innerW: 412, innerH: 330 })).toBe(
      false,
    );
  });
  it("tablets and computers are never sideways", () => {
    const tablet = { screenW: 820, screenH: 1180, innerW: 1180, innerH: 820, coarse: true };
    expect(isPhoneSideways({ ...tablet, orientationType: "landscape-primary" })).toBe(false);
    expect(isPhoneSideways({ ...phone, coarse: false, orientationType: "landscape-primary" })).toBe(false);
  });
});

describe("composerHeight", () => {
  it("is exactly one line when empty, grows by whole lines, and stops at five", () => {
    expect(composerHeight(42)).toEqual({ lines: 1, height: 42, scroll: false });
    expect(composerHeight(20)).toEqual({ lines: 1, height: 42, scroll: false });
    expect(composerHeight(64)).toEqual({ lines: 2, height: 64, scroll: false });
    expect(composerHeight(130)).toEqual({ lines: 5, height: 130, scroll: false });
    expect(composerHeight(300)).toEqual({ lines: 5, height: 130, scroll: true });
  });
});

describe("labels", () => {
  it("elapsed and ago", () => {
    expect(elapsedLabel(NOW - 30_000, NOW)).toBe("");
    expect(elapsedLabel(NOW - 5 * MIN, NOW)).toBe("5m");
    expect(elapsedLabel(NOW - 65 * MIN, NOW)).toBe("1h 5m");
    expect(elapsedLabel(NOW - 120 * MIN, NOW)).toBe("2h");
    expect(agoLabel(NOW - 10_000, NOW)).toBe("just now");
    expect(agoLabel(NOW - 3 * 60 * MIN, NOW)).toBe("3 hr ago");
    expect(agoLabel(NOW - 30 * 60 * MIN, NOW)).toBeNull();
  });
});
