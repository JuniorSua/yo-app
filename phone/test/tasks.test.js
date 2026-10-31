import { describe, expect, it } from "vitest";
import {
  activeGroups,
  afterAction,
  BRIEF_FOLD_AT,
  briefFold,
  briefGreeting,
  briefStartText,
  briefTextShows,
  normalizeBrief,
  normalizeReplies,
  normalizeTasks,
  START_WAIT_MS,
  startLanded,
  statusWord,
  tasksBadge,
  upNext,
} from "../lib/tasks.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const task = (id, status, extra = {}) => ({
  id,
  title: `Task ${id}`,
  status,
  updatedAt: NOW - MIN,
  ...extra,
});

describe("normalizeTasks", () => {
  it("keeps known statuses, drops bad rows and repeats, clips the strings", () => {
    const out = normalizeTasks([
      { id: "a", title: "  Compare   deals ", status: "review", note: "x".repeat(400), updatedAt: NOW },
      { id: "b", title: "Weird", status: "exploded", updatedAt: NOW },
      { id: "", title: "No id", status: "open" },
      { id: "c", title: "", status: "open" },
      { id: "a", title: "Again", status: "done" },
      null,
      "nope",
      { id: "d", title: "Saved", status: "open", origin: "user", why: "because", updatedAt: "soon" },
    ]);
    expect(out.map((t) => t.id)).toEqual(["a", "d"]);
    expect(out[0].title).toBe("Compare deals");
    expect(out[0].note).toHaveLength(300);
    expect(out[0].note.endsWith("…")).toBe(true);
    expect(out[1]).toEqual({
      id: "d",
      title: "Saved",
      status: "open",
      why: "because",
      origin: "user",
      updatedAt: 0,
    });
  });

  it("is empty for anything that isn't a list, and stops at 40", () => {
    expect(normalizeTasks(undefined)).toEqual([]);
    expect(normalizeTasks({ items: [] })).toEqual([]);
    const many = Array.from({ length: 60 }, (_, i) => task(`t${i}`, "open"));
    expect(normalizeTasks(many)).toHaveLength(40);
  });

  it("drops an origin it doesn't know", () => {
    expect(normalizeTasks([task("a", "open", { origin: "martian" })])[0].origin).toBeUndefined();
  });
});

describe("activeGroups", () => {
  const tasks = [
    task("r1", "review", { updatedAt: NOW - 5 * MIN }),
    task("r2", "review", { updatedAt: NOW - MIN }),
    task("w", "waiting"),
    task("p", "in_progress"),
    task("todo", "open", { origin: "asked" }),
    task("saved", "open", { origin: "user" }),
    task("s", "suggested"),
    task("h", "hidden"),
    task("d", "done", { updatedAt: NOW - DAY }),
    task("old", "done", { updatedAt: NOW - 8 * DAY }),
  ];

  it("groups in the desktop's order, newest first, without empty groups", () => {
    const groups = activeGroups(tasks, NOW);
    expect(groups.map((g) => g.id)).toEqual(["review", "waiting", "in_progress", "todo", "done"]);
    expect(groups.map((g) => g.label)).toEqual([
      "Ready for review",
      "Needs input",
      "Working",
      "To do",
      "Resolved",
    ]);
    expect(groups[0].tasks.map((t) => t.id)).toEqual(["r2", "r1"]);
  });

  it("keeps the user's saved tasks, suggestions and hidden ones out; done ones only for a week", () => {
    const ids = activeGroups(tasks, NOW).flatMap((g) => g.tasks.map((t) => t.id));
    expect(ids).not.toContain("saved");
    expect(ids).not.toContain("s");
    expect(ids).not.toContain("h");
    expect(ids).toContain("d");
    expect(ids).not.toContain("old");
  });

  it("is empty when nothing is active", () => {
    expect(activeGroups([task("s", "suggested")], NOW)).toEqual([]);
  });
});

describe("upNext", () => {
  it("suggestions, then what the user saved for later, newest first", () => {
    const { suggestions, saved } = upNext([
      task("s1", "suggested", { updatedAt: NOW - 9 * MIN }),
      task("s2", "suggested", { updatedAt: NOW - MIN }),
      task("u", "open", { origin: "user" }),
      task("yo", "open", { origin: "asked" }),
      task("p", "in_progress"),
    ]);
    expect(suggestions.map((t) => t.id)).toEqual(["s2", "s1"]);
    expect(saved.map((t) => t.id)).toEqual(["u"]);
  });
});

describe("statusWord and the badge", () => {
  it("names each status like the desktop", () => {
    expect(statusWord(task("a", "review"))).toBe("Ready");
    expect(statusWord(task("a", "waiting"))).toBe("Needs input");
    expect(statusWord(task("a", "in_progress"))).toBe("Working");
    expect(statusWord(task("a", "open", { origin: "asked" }))).toBe("To do");
    expect(statusWord(task("a", "open", { origin: "user" }))).toBe("Saved");
    expect(statusWord(task("a", "done"))).toBe("Done");
  });

  it("counts what's ready for review or needs input", () => {
    expect(
      tasksBadge([
        task("a", "review"),
        task("b", "waiting"),
        task("c", "in_progress"),
        task("d", "suggested"),
      ]),
    ).toBe(2);
    expect(tasksBadge([])).toBe(0);
  });

  it("shows hide and check off right away, but never a Start the core hasn't taken", () => {
    const t = task("a", "suggested");
    expect(afterAction(t, "hide").status).toBe("hidden");
    expect(afterAction(task("b", "review"), "done").status).toBe("done");
    expect(afterAction(t, "start")).toBe(t);
    expect(afterAction(t, "explode")).toBe(t);
  });

  it("calls a Start landed only once the core's list has it under way", () => {
    const list = [task("a", "suggested"), task("b", "in_progress"), task("c", "review"), task("d", "open")];
    expect(startLanded(list, "a")).toBe(false);
    expect(startLanded(list, "d")).toBe(false);
    expect(startLanded(list, "b")).toBe(true);
    expect(startLanded(list, "c")).toBe(true);
    expect(startLanded(list, "gone")).toBe(false);
    expect(startLanded(null, "a")).toBe(false);
    expect(START_WAIT_MS).toBe(20_000);
  });
});

describe("morning brief", () => {
  it("greets by the hour", () => {
    expect(briefGreeting(4)).toBe("Good morning.");
    expect(briefGreeting(11)).toBe("Good morning.");
    expect(briefGreeting(12)).toBe("Good afternoon.");
    expect(briefGreeting(16)).toBe("Good afternoon.");
    expect(briefGreeting(17)).toBe("Good evening.");
    expect(briefGreeting(2)).toBe("Good evening.");
  });

  it("folds after three, but never for just one more", () => {
    expect(BRIEF_FOLD_AT).toBe(3);
    expect(briefFold(3)).toEqual({ shown: 3, more: 0 });
    expect(briefFold(4)).toEqual({ shown: 4, more: 0 });
    expect(briefFold(6)).toEqual({ shown: 3, more: 3 });
    expect(briefFold(6, true)).toEqual({ shown: 6, more: 0 });
  });

  it("reads a brief, dropping bad rows and Yo's own start notes", () => {
    const b = normalizeBrief({
      needsYou: [
        { title: "Reply to Dana", detail: "She asked twice", start: "Draft it" },
        { detail: "no title" },
      ],
      canWait: "nope",
      today: [{ title: "Standup", time: "9:30 AM" }],
      couldNotCheck: [{ source: "Slack", why: "signed out" }, { why: "no source" }],
    });
    expect(b).toEqual({
      needsYou: [{ title: "Reply to Dana", detail: "She asked twice" }],
      canWait: [],
      today: [{ title: "Standup", time: "9:30 AM" }],
      couldNotCheck: [{ source: "Slack", why: "signed out" }],
    });
    expect(normalizeBrief(null)).toBeNull();
    expect(normalizeBrief([])).toBeNull();
    expect(normalizeBrief("brief")).toBeNull();
  });

  it("hides a brief-only reply's fallback text under the card, but keeps Yo's own words", () => {
    expect(briefTextShows({ text: "Your brief: • Reply to Dana", briefText: true })).toBe(false);
    expect(briefTextShows({ text: "Dana is the one that matters today." })).toBe(true);
    expect(briefTextShows({ text: "  " })).toBe(false);
    expect(briefTextShows({ text: "Here's your brief." })).toBe(true);
  });

  it("Start sends exactly what the row shows", () => {
    expect(briefStartText({ title: "Reply to Dana", start: "secret plan" })).toBe(
      "Take care of: Reply to Dana",
    );
  });
});

describe("normalizeReplies", () => {
  it("keeps up to three short, distinct replies", () => {
    expect(
      normalizeReplies(["Tuesday 9:30", " Thursday  2:00 ", "Tuesday 9:30", "Neither", "Later"]),
    ).toEqual(["Tuesday 9:30", "Thursday 2:00", "Neither"]);
  });

  it("is null when there are none (the phone guesses its own)", () => {
    expect(normalizeReplies(undefined)).toBeNull();
    expect(normalizeReplies([])).toBeNull();
    expect(normalizeReplies(["", 3, null])).toBeNull();
  });
});
