import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPoll } from "./poll";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("startPoll", () => {
  it("polls one request at a time until a result stops it", async () => {
    let n = 0;
    const tick = vi.fn(async () => ++n);
    const onResult = vi.fn((r: number) => r >= 3);
    startPoll({ tick, onResult, intervalMs: 100, timeoutMs: 10_000 });
    await flush();
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(onResult).toHaveBeenLastCalledWith(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("never overlaps a slow request", async () => {
    let resolve!: (v: string) => void;
    const tick = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    startPoll({ tick, onResult: () => false, intervalMs: 10, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(500);
    expect(tick).toHaveBeenCalledTimes(1);
    resolve("waiting");
    await vi.advanceTimersByTimeAsync(10);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("stop() cancels the timer and drops a late result (unmount)", async () => {
    let resolve!: (v: string) => void;
    const tick = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const onResult = vi.fn(() => false);
    const stop = startPoll({ tick, onResult, intervalMs: 10, timeoutMs: 10_000 });
    await flush();
    stop();
    resolve("connected");
    await vi.advanceTimersByTimeAsync(1000);
    expect(onResult).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing when stopped right away (StrictMode's mount, unmount, mount)", async () => {
    const tick = vi.fn(async () => "waiting");
    startPoll({ tick, onResult: () => false, intervalMs: 10, timeoutMs: 10_000 })();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("keeps going through failures and reports them; callbacks that throw don't escape", async () => {
    let n = 0;
    const tick = vi.fn(async () => {
      if (++n <= 2) throw new Error("socket closed");
      return "ok";
    });
    const onError = vi.fn(() => {
      throw new Error("bad callback");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const onResult = vi.fn(() => true);
    startPoll({ tick, onResult, onError, intervalMs: 50, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(200);
    expect(onError.mock.calls.map((c) => (c as unknown[])[0])).toEqual([1, 2]);
    expect(onResult).toHaveBeenCalledWith("ok");
    err.mockRestore();
  });

  it("gives up after the timeout", async () => {
    const onTimeout = vi.fn();
    const tick = vi.fn(async () => "waiting");
    startPoll({ tick, onResult: () => false, onTimeout, intervalMs: 100, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(tick.mock.calls.length).toBeLessThanOrEqual(12);
    expect(vi.getTimerCount()).toBe(0);
  });
});
