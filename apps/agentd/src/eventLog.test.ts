import { describe, expect, it } from "vitest";
import { RingBuffer, SessionEventLog } from "./eventLog";

describe("RingBuffer", () => {
  it("keeps the most recent items in order", () => {
    const r = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) r.push(i);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.size).toBe(3);
  });
});

describe("SessionEventLog", () => {
  it("assigns per-session monotonically increasing seq", () => {
    const log = new SessionEventLog<string>(10);
    expect(log.append("s1", "a").seq).toBe(1);
    expect(log.append("s1", "b").seq).toBe(2);
    expect(log.append("s2", "x").seq).toBe(1);
    expect(log.lastSeq("s1")).toBe(2);
    expect(log.lastSeq("nope")).toBe(0);
  });

  it("replays events after lastSeq", () => {
    const log = new SessionEventLog<string>(10);
    for (const v of ["a", "b", "c", "d"]) log.append("s", v);
    const r = log.since("s", 2);
    expect(r.gap).toBe(false);
    expect(r.entries.map((e) => [e.seq, e.value])).toEqual([
      [3, "c"],
      [4, "d"],
    ]);
    expect(log.since("s", 4).entries).toEqual([]);
    expect(log.since("unknown", 0)).toEqual({ entries: [], gap: false });
  });

  it("reports a gap when requested events were evicted", () => {
    const log = new SessionEventLog<number>(3);
    for (let i = 1; i <= 10; i++) log.append("s", i);
    const r = log.since("s", 2);
    expect(r.gap).toBe(true);
    expect(r.entries.map((e) => e.seq)).toEqual([8, 9, 10]);
    expect(log.since("s", 7).gap).toBe(false);
    expect(log.since("s", 10).gap).toBe(false);
  });
});
