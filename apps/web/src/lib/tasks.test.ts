import type { LedgerTask } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import {
  activeGroups,
  applyTaskUpdate,
  latestSuggestion,
  onPage,
  RESOLVED_FOR_MS,
  statusWord,
  upNext,
} from "./tasks";

const NOW = 1_800_000_000_000;
let n = 0;
function task(p: Partial<LedgerTask> & Pick<LedgerTask, "status">): LedgerTask {
  n++;
  return {
    id: `tsk_${n}`,
    ownerId: "agt_yo",
    title: `Task ${n}`,
    helperId: null,
    note: null,
    createdAt: NOW - 10_000 + n,
    updatedAt: NOW - 10_000 + n,
    ...p,
  };
}

describe("activeGroups", () => {
  it("groups review, needs input, working, to do, resolved in that order, newest first, empty groups left out", () => {
    const oldReview = task({ status: "review", title: "Old review", updatedAt: NOW - 5000 });
    const newReview = task({ status: "review", title: "New review", updatedAt: NOW - 100 });
    const working = task({ status: "in_progress", title: "Working" });
    const done = task({ status: "done", title: "Done today", updatedAt: NOW - 3600_000 });
    const ownTodo = task({ status: "open", title: "Yo's to-do", origin: "asked" });
    const legacy = task({ status: "open", title: "No origin" });
    const groups = activeGroups(
      [
        done,
        working,
        oldReview,
        newReview,
        ownTodo,
        legacy,
        task({ status: "open", origin: "user" }),
        task({ status: "suggested" }),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.id, g.label, g.tasks.map((t) => t.title)])).toEqual([
      ["review", "Ready for review", ["New review", "Old review"]],
      ["in_progress", "Working", ["Working"]],
      ["todo", "To do", ["No origin", "Yo's to-do"]],
      ["done", "Resolved", ["Done today"]],
    ]);
  });

  it("words a row by who it belongs to", () => {
    expect(statusWord(task({ status: "open", origin: "asked" }))).toBe("To do");
    expect(statusWord(task({ status: "open", origin: "user" }))).toBe("Saved");
    expect(statusWord(task({ status: "review" }))).toBe("Ready");
  });

  it("keeps done tasks for 7 days only", () => {
    const fresh = task({ status: "done", updatedAt: NOW - RESOLVED_FOR_MS + 1000 });
    const stale = task({ status: "done", updatedAt: NOW - RESOLVED_FOR_MS - 1000 });
    expect(activeGroups([fresh, stale], NOW)[0]!.tasks).toEqual([fresh]);
    expect(onPage(stale, NOW)).toBe(false);
  });
});

describe("upNext", () => {
  it("lists suggestions, then the tasks the user saved, each newest first (not Yo's own to-dos)", () => {
    const s1 = task({ status: "suggested", updatedAt: NOW - 50 });
    const s2 = task({ status: "suggested", updatedAt: NOW - 10 });
    const saved = task({ status: "open", origin: "user" });
    const own = task({ status: "open", origin: "asked" });
    const r = upNext([s1, saved, own, task({ status: "review" }), s2]);
    expect(r.suggestions).toEqual([s2, s1]);
    expect(r.saved).toEqual([saved]);
  });

  it("picks an agent's newest suggestion for above the message box", () => {
    const mine = task({ status: "suggested", updatedAt: NOW - 50 });
    const newer = task({ status: "suggested", updatedAt: NOW - 10 });
    const pips = task({ status: "suggested", ownerId: "agt_pip", updatedAt: NOW });
    expect(latestSuggestion([mine, newer, pips], "agt_yo")).toBe(newer);
    expect(latestSuggestion([pips], "agt_yo")).toBeUndefined();
    expect(latestSuggestion(undefined, "agt_yo")).toBeUndefined();
  });
});

describe("applyTaskUpdate", () => {
  it("updates in place, adds new ones, and drops hidden or cancelled ones", () => {
    const a = task({ status: "suggested" });
    const b = task({ status: "open" });
    const started = { ...a, status: "in_progress" as const };
    expect(applyTaskUpdate([a, b], started, NOW)).toEqual([started, b]);
    const c = task({ status: "review" });
    expect(applyTaskUpdate([a, b], c, NOW)).toEqual([a, b, c]);
    expect(applyTaskUpdate([a, b], { ...a, status: "hidden" }, NOW)).toEqual([b]);
    expect(applyTaskUpdate([a, b], { ...b, status: "cancelled" }, NOW)).toEqual([a]);
  });
});
