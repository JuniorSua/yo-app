import type { TimelineEntry } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { toBlocks } from "./blocks";
import { countNewMessages, firstUnreadKey } from "./unread";

let seq = 0;
const entry = (
  turnId: string | null,
  item: Partial<TimelineEntry["item"]> = {},
  id?: string,
): TimelineEntry => ({
  id: id ?? `e${++seq}`,
  agentId: "agt_yo",
  turnId,
  seq: ++seq,
  createdAt: seq * 1000,
  item: { id: `i${seq}`, kind: "tool", status: "completed", ...item },
});
const user = () => entry(null, { kind: "user_message", text: "hi" });
const reply = (turnId: string, text = "ok", status: "running" | "completed" = "completed") =>
  entry(turnId, { kind: "assistant_message", text, status });
const step = (turnId: string) => entry(turnId, { kind: "command", title: "ls" });
const notice = (turnId: string, status: "completed" | "failed", id?: string) =>
  entry(turnId, { kind: "notice", text: "note", status }, id);
const request = (turnId: string): TimelineEntry => ({
  ...entry(turnId, { kind: "tool", title: "Buy it?" }),
  request: { requestId: "r1", kind: "tool_approval", title: "Buy it?", status: "pending" },
});

const keys = (entries: TimelineEntry[]) => new Set(toBlocks(entries).map((b) => b.key));

describe("new messages while scrolled up", () => {
  it("counts replies and cards that need the user, not steps or the user's own messages", () => {
    const before = [user(), reply("t1")];
    const after = [...before, user(), step("t2"), reply("t2"), request("t2"), reply("t2")];
    expect(countNewMessages(toBlocks(after), keys(before))).toBe(3);
  });

  it("counts a reply once while it streams in", () => {
    const u = user();
    const seen = keys([u]);
    const r = reply("t1", "Hel", "running");
    expect(countNewMessages(toBlocks([u, r]), seen)).toBe(1);
    const done = { ...r, item: { ...r.item, text: "Hello there, here it is", status: "completed" as const } };
    expect(countNewMessages(toBlocks([u, done]), seen)).toBe(1);
  });

  it("is zero once everything has been seen", () => {
    const all = [user(), reply("t1"), request("t1")];
    expect(countNewMessages(toBlocks(all), keys(all))).toBe(0);
  });
});

describe("where unread replies start", () => {
  it("is the start of the oldest unread task", () => {
    const t2 = step("t2");
    const blocks = toBlocks([user(), reply("t1"), user(), t2, reply("t2"), user(), reply("t3")]);
    expect(firstUnreadKey(blocks, 2)).toBe(`g_${t2.id}`);
    const last = blocks[blocks.length - 1]!;
    expect(firstUnreadKey(blocks, 1)).toBe(last.key);
  });

  it("skips tasks core doesn't count: a quiet routine run and a /compact", () => {
    const r1 = reply("t1");
    const blocks = toBlocks([
      user(),
      r1,
      notice("t2", "completed"), // a routine run with nothing to report
      notice("t3", "failed", "ntc_compact_t3"), // a /compact that failed
      user(),
      reply("t4"),
    ]);
    expect(firstUnreadKey(blocks, 2)).toBe(r1.id);
  });

  it("counts a task that failed with only an error", () => {
    const err = notice("t2", "failed");
    const blocks = toBlocks([user(), reply("t1"), user(), err]);
    expect(firstUnreadKey(blocks, 1)).toBe(err.id);
  });

  it("draws nothing when nothing is unread or the tasks aren't all loaded", () => {
    const blocks = toBlocks([user(), reply("t1")]);
    expect(firstUnreadKey(blocks, 0)).toBeNull();
    expect(firstUnreadKey(blocks, 2)).toBeNull();
    expect(firstUnreadKey([], 1)).toBeNull();
  });
});
