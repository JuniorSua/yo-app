/**
 * The live view (x11vnc) of a shared-desktop seat. A friend's live view went off for good: the seat woke again
 * while its old x11vnc, hung on a screen that had restarted, still held the port, so each new one exited at once.
 * Starting it again must close the old one first, with SIGKILL when SIGTERM is ignored. No X: spawn is faked.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeChild = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (sig?: NodeJS.Signals) => boolean;
  ignoresTerm: boolean;
};

const children: FakeChild[] = [];
let nextPid = 900_000;

function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.pid = nextPid++;
  c.exitCode = null;
  c.signalCode = null;
  c.ignoresTerm = false;
  c.kill = (sig = "SIGTERM") => {
    if (c.exitCode !== null || c.signalCode !== null) return false;
    if (sig === "SIGTERM" && c.ignoresTerm) return true;
    c.signalCode = sig;
    queueMicrotask(() => c.emit("exit", null, sig));
    return true;
  };
  children.push(c);
  return c;
}

vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: vi.fn(() => fakeChild()),
}));
vi.mock("./Display", async (orig) => ({
  ...(await orig<typeof import("./Display")>()),
  tcpReady: vi.fn(async () => true),
}));

const { SharedDesktop } = await import("./SharedDesktop");
const noop = () => undefined;
const log = { debug: noop, info: noop, warn: noop, error: noop, child: () => log } as never;

beforeEach(() => {
  children.length = 0;
  // Signals go to the fake child, never to a real process group.
  vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: NodeJS.Signals) => {
    const c = children.find((x) => x.pid === -pid);
    if (!c) throw new Error("ESRCH");
    c.kill(sig);
    return true;
  }) as typeof process.kill);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function seat() {
  const s = new SharedDesktop(log).seat("agt_a", 1);
  s.tile = 0;
  return s as unknown as { startVnc(): Promise<void>; setLease(h: "user" | "agent"): Promise<void> };
}

describe("seat live view", () => {
  it("starting again closes the old x11vnc first, so only one holds the port", async () => {
    const s = seat();
    await s.startVnc();
    await s.startVnc();
    expect(children).toHaveLength(2);
    expect(children[0]!.signalCode).toBe("SIGTERM");
    expect(children[1]!.signalCode).toBeNull();
  });

  it("an x11vnc that ignores SIGTERM is killed, and taking control still gets a fresh one", async () => {
    vi.useFakeTimers();
    const s = seat();
    await s.startVnc();
    children[0]!.ignoresTerm = true;
    const taking = s.setLease("user");
    await vi.advanceTimersByTimeAsync(2100);
    await taking;
    expect(children[0]!.signalCode).toBe("SIGKILL");
    expect(children).toHaveLength(2);
    expect(children[1]!.signalCode).toBeNull();
  });
});
