/**
 * A crash-safe poll loop for the "Connect your model" walkthrough: one request at a time (the next one is
 * scheduled only after the last one settled), nothing ever rejects unhandled, and `stop()` (called on unmount)
 * cancels the pending timer and drops any result that arrives afterwards.
 */
export interface PollOptions<T> {
  tick: () => Promise<T>;
  /** Return true to stop polling (connected, or an error the user has to act on). */
  onResult: (r: T) => boolean;
  /** The request failed (core unreachable); `consecutive` counts failures in a row. Polling continues. */
  onError?: (consecutive: number) => void;
  /** Gave up after `timeoutMs` without a stopping result. */
  onTimeout?: () => void;
  intervalMs: number;
  timeoutMs: number;
  now?: () => number;
}

export function startPoll<T>(o: PollOptions<T>): () => void {
  const now = o.now ?? Date.now;
  const started = now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fails = 0;
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      console.error("connect poll callback failed", err);
    }
  };

  const loop = async () => {
    timer = null;
    if (stopped) return;
    try {
      const r = await o.tick();
      if (stopped) return;
      fails = 0;
      let done = false;
      safely(() => {
        done = o.onResult(r);
      });
      if (done) {
        stopped = true;
        return;
      }
    } catch {
      if (stopped) return;
      fails++;
      safely(() => o.onError?.(fails));
    }
    if (now() - started >= o.timeoutMs) {
      stopped = true;
      safely(() => o.onTimeout?.());
      return;
    }
    timer = setTimeout(() => void loop(), o.intervalMs);
  };

  // The first request goes out on the next tick, not synchronously: a mount that is torn down right away
  // (React StrictMode, a quick Back) then never sends one whose result it would have to drop.
  timer = setTimeout(() => void loop(), 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
