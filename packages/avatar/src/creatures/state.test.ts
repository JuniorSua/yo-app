import type { Item, TimelineEntry } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { CREATURE_FALLBACK, CREATURE_ORDER, creatureAvatar, creatureFallback } from "./meta";
import { creatureState, liveFps, SNAPSHOT_BUCKETS, snapshotKey, snapshotPx, turnInfo } from "./state";

let seq = 0;
const entry = (kind: Item["kind"], status: Item["status"] = "completed"): TimelineEntry => ({
  id: `e${seq}`,
  agentId: "a",
  turnId: "t",
  seq: seq++,
  createdAt: 0,
  item: { id: `i${seq}`, kind, status },
});

describe("turnInfo", () => {
  it("is unknown without a loaded timeline", () => {
    expect(turnInfo(undefined)).toBeUndefined();
  });

  it("only looks at the current turn (after the last user message)", () => {
    const old = [entry("user_message"), entry("command", "running")];
    expect(turnInfo([...old, entry("user_message")])).toEqual({ toolRunning: false, lastKind: null });
  });

  it("sees a running tool step, and ignores the plan and notices", () => {
    expect(turnInfo([entry("user_message"), entry("browser", "running"), entry("todo", "running")])).toEqual({
      toolRunning: true,
      lastKind: "browser",
    });
    expect(turnInfo([entry("user_message"), entry("reasoning", "running"), entry("notice")])).toEqual({
      toolRunning: false,
      lastKind: "reasoning",
    });
  });
});

describe("creatureState", () => {
  it("maps every activity", () => {
    expect(creatureState("idle")).toEqual({ pose: "idle", glow: false, error: false });
    expect(creatureState("working")).toEqual({ pose: "working", glow: false, error: false });
    expect(creatureState("waiting")).toEqual({ pose: "question", glow: true, error: false });
    expect(creatureState("done")).toEqual({ pose: "done", glow: false, error: false });
    expect(creatureState("sleeping")).toEqual({ pose: "sleeping", glow: false, error: false });
    // Errors: the question pose without the glow, plus the red badge.
    expect(creatureState("error")).toEqual({ pose: "question", glow: false, error: true });
  });

  it("thinks while a turn reasons or writes, and works while a tool runs", () => {
    const think = (entries: TimelineEntry[]) => creatureState("working", turnInfo(entries)).pose;
    expect(think([entry("user_message")])).toBe("thinking");
    expect(think([entry("user_message"), entry("reasoning", "running")])).toBe("thinking");
    expect(think([entry("user_message"), entry("assistant_message", "running")])).toBe("thinking");
    expect(think([entry("user_message"), entry("command", "running")])).toBe("working");
    expect(think([entry("user_message"), entry("reasoning"), entry("web", "running")])).toBe("working");
    // Between two tool steps it stays on the laptop (no flicker).
    expect(think([entry("user_message"), entry("file_change")])).toBe("working");
    // A finished tool, then more reasoning: thinking again.
    expect(think([entry("user_message"), entry("command"), entry("reasoning", "running")])).toBe("thinking");
  });

  it("falls back to working without turn info (lists), and ignores turns when not working", () => {
    expect(creatureState("working", undefined).pose).toBe("working");
    expect(creatureState("idle", { toolRunning: false, lastKind: "reasoning" }).pose).toBe("idle");
  });
});

describe("still picture cache keys", () => {
  it("rounds sizes up to a few shared buckets", () => {
    expect(snapshotPx(22, 1)).toBe(48);
    expect(snapshotPx(42, 1)).toBe(48);
    expect(snapshotPx(42, 2)).toBe(96);
    expect(snapshotPx(30, 2)).toBe(96);
    expect(snapshotPx(52, 2)).toBe(160);
    expect(snapshotPx(128, 2)).toBe(256);
    expect(snapshotPx(400, 3)).toBe(256);
    // dpr is clamped to 1..2.
    expect(snapshotPx(42, 0)).toBe(48);
    expect(snapshotPx(30, 3)).toBe(96);
  });

  it("keys by creature, pose and size bucket", () => {
    expect(snapshotKey("sprout", "idle", 48)).toBe("sprout:idle:48");
    const keys = new Set<string>();
    for (const kind of CREATURE_ORDER)
      for (const pose of ["idle", "working", "question"] as const)
        for (const b of SNAPSHOT_BUCKETS) keys.add(snapshotKey(kind, pose, b));
    expect(keys.size).toBe(3 * 3 * SNAPSHOT_BUCKETS.length);
    // Every list size at a given density shares one picture.
    expect(new Set([18, 20, 22, 24, 28, 30, 36, 42].map((s) => snapshotPx(s, 1))).size).toBe(1);
  });
});

describe("live frame rate", () => {
  it("is lower for small avatars and calm poses", () => {
    expect(liveFps(30, "idle")).toBeLessThan(liveFps(30, "working"));
    expect(liveFps(30, "working")).toBeLessThan(liveFps(128, "working"));
    expect(liveFps(128, "working")).toBeLessThanOrEqual(30);
  });
});

describe("picking a creature", () => {
  it("fills the drawn fallback and keeps the headset", () => {
    for (const kind of CREATURE_ORDER) {
      const a = creatureAvatar(kind);
      expect(a.creature).toEqual({ kind });
      expect(a).toMatchObject({ ...CREATURE_FALLBACK[kind], accessory: "headset", eyes: "capsule" });
      expect(a.living).toBeUndefined();
      const drawn = creatureFallback(a);
      expect(drawn.creature).toBeUndefined();
      expect(drawn.shape).toBe(CREATURE_FALLBACK[kind].shape);
    }
  });
});
