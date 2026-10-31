import { describe, expect, it } from "vitest";
import {
  ComputerWatchdog,
  FIRST_CONNECT_MS,
  MAX_REPAIRS,
  REPAIR_GAP_MS,
  UNREACHABLE_MS,
} from "./ComputerWatchdog";

/**
 * A fake Mac: a clock, Yo's link to its computer, and a repair that the test decides the outcome of. By default
 * the link was up, then broke (the Mac slept and woke); `neverConnected` is a computer that hasn't answered yet.
 */
function fake(opts: { shouldBeRunning?: boolean; repairFixes?: boolean; neverConnected?: boolean } = {}) {
  const st = {
    now: 1_000_000,
    connected: false,
    shouldBeRunning: opts.shouldBeRunning ?? true,
    repairs: 0,
  };
  let finish: (() => void) | null = null;
  const dog = new ComputerWatchdog({
    now: () => st.now,
    connected: () => st.connected,
    shouldBeRunning: () => st.shouldBeRunning,
    repair: () => {
      st.repairs++;
      return new Promise<void>((resolve, reject) => {
        finish = () => {
          if (opts.repairFixes) st.connected = true;
          (opts.repairFixes === false ? () => reject(new Error("still broken")) : resolve)();
        };
      });
    },
  });
  if (!opts.neverConnected) {
    st.connected = true;
    dog.check();
    st.connected = false;
  }
  const settle = async () => {
    finish?.();
    finish = null;
    await new Promise((r) => setTimeout(r, 0));
  };
  /** Look every 15 s for `ms`. */
  const run = (ms: number) => {
    for (let t = 0; t <= ms; t += 15_000) {
      dog.check();
      st.now += 15_000;
    }
  };
  return { st, dog, settle, run };
}

describe("watching Yo's computer after the Mac sleeps and wakes", () => {
  it("leaves a short hiccup alone (agentd restarting, a slow wake)", () => {
    const f = fake();
    f.run(UNREACHABLE_MS - 30_000);
    f.st.connected = true;
    f.dog.check();
    f.st.connected = false;
    f.run(UNREACHABLE_MS - 30_000);
    expect(f.st.repairs).toBe(0);
  });

  it("restarts the computer once it has been unreachable for two minutes", async () => {
    const f = fake({ repairFixes: true });
    f.run(UNREACHABLE_MS + 15_000);
    expect(f.st.repairs).toBe(1);
    // Nothing else starts while that repair runs.
    f.run(5 * 60_000);
    expect(f.st.repairs).toBe(1);
    await f.settle();
    expect(f.st.connected).toBe(true);
  });

  it("gives a computer that hasn't answered yet (a slow first boot) much longer", () => {
    const f = fake({ neverConnected: true });
    f.run(FIRST_CONNECT_MS - 30_000);
    expect(f.st.repairs).toBe(0);
    f.run(60_000);
    expect(f.st.repairs).toBe(1);
  });

  it("never touches a computer that shouldn't be running (stopped, asleep, setting up, starting, updating)", () => {
    const f = fake({ shouldBeRunning: false });
    f.run(60 * 60_000);
    expect(f.st.repairs).toBe(0);
  });

  it("tries again at most every 15 minutes, and gives up after a couple of tries (no restart loop)", async () => {
    const f = fake({ repairFixes: false });
    f.run(UNREACHABLE_MS + 15_000);
    expect(f.st.repairs).toBe(1);
    await f.settle();
    // Still broken: not again before the gap is over, even though it's been down for longer than 2 minutes.
    f.run(REPAIR_GAP_MS - UNREACHABLE_MS - 60_000);
    expect(f.st.repairs).toBe(1);
    f.run(2 * UNREACHABLE_MS);
    expect(f.st.repairs).toBe(2);
    await f.settle();
    // MAX_REPAIRS reached: hours later, still no more.
    f.run(3 * 60 * 60_000);
    expect(f.st.repairs).toBe(MAX_REPAIRS);
  });

  it("starts counting again once the link has come back", async () => {
    const f = fake({ repairFixes: false });
    for (let i = 0; i < MAX_REPAIRS; i++) {
      f.run(REPAIR_GAP_MS + 15_000);
      await f.settle();
    }
    expect(f.st.repairs).toBe(MAX_REPAIRS);
    // The user pressed Start (or the Mac came back by itself), then it broke again the next day.
    f.st.connected = true;
    f.dog.check();
    f.st.connected = false;
    f.st.now += 24 * 60 * 60_000;
    f.run(UNREACHABLE_MS + 15_000);
    expect(f.st.repairs).toBe(MAX_REPAIRS + 1);
  });
});
