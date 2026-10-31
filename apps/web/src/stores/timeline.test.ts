import type { TimelineEntry } from "@yo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The store batches deltas per animation frame; drive the frames by hand.
let frames: (() => void)[] = [];
vi.stubGlobal("document", { visibilityState: "visible" });
vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
vi.stubGlobal("cancelAnimationFrame", (id: number) => {
  frames[id - 1] = () => {};
});
const nextFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

const { useTimeline } = await import("./timeline");

const entry = (id: string, seq: number, text = ""): TimelineEntry =>
  ({
    id,
    agentId: "agt_1",
    seq,
    item: { id, kind: "assistant_message", status: "running", text },
  }) as TimelineEntry;

const text = (id: string) => useTimeline.getState().byAgent.agt_1?.find((e) => e.id === id)?.item.text;
const delta = (entryId: string, d: string) =>
  useTimeline.getState().delta({ agentId: "agt_1", entryId, delta: d, stream: "text" });

describe("timeline deltas", () => {
  beforeEach(() => {
    nextFrame();
    useTimeline.setState({ byAgent: {}, loaded: {} });
  });

  it("applies a frame's worth of streamed text in one update", () => {
    useTimeline.getState().upsert(entry("a", 1));
    const updates = vi.fn();
    const off = useTimeline.subscribe(updates);
    delta("a", "Hel");
    delta("a", "lo");
    delta("a", " there");
    expect(text("a")).toBe("");
    expect(updates).not.toHaveBeenCalled();
    nextFrame();
    expect(text("a")).toBe("Hello there");
    expect(updates).toHaveBeenCalledTimes(1);
    off();
  });

  it("applies pending text before an upsert, so the upsert wins", () => {
    useTimeline.getState().upsert(entry("a", 1));
    delta("a", "partial");
    useTimeline.getState().upsert(entry("a", 1, "final"));
    nextFrame();
    expect(text("a")).toBe("final");
  });

  it("keeps entries that didn't change", () => {
    useTimeline.getState().upsert(entry("a", 1, "done"));
    useTimeline.getState().upsert(entry("b", 2));
    const before = useTimeline.getState().byAgent.agt_1!;
    delta("b", "x");
    nextFrame();
    const after = useTimeline.getState().byAgent.agt_1!;
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(text("b")).toBe("x");
  });

  it("drops text for timelines that aren't loaded", () => {
    delta("zzz", "lost");
    nextFrame();
    expect(useTimeline.getState().byAgent).toEqual({});
  });
});
