/** Terminal output printed before the UI's socket attaches (the shell's first prompt) reaches the socket. */
import { describe, expect, it } from "vitest";
import { PtyEarlyOutput } from "../src/http/ptyEarly";

const data = (ptyId: string, d: string) => ({ type: "pty.data" as const, ptyId, data: d });

describe("PtyEarlyOutput", () => {
  it("hands the output printed before attaching to the socket, once", () => {
    const e = new PtyEarlyOutput();
    e.onPush(data("p1", "agent@box:~$ "));
    e.onPush(data("p2", "other"));
    expect(e.attach("p1")).toEqual({ output: "agent@box:~$ ", exited: false });
    // After attaching, live output goes straight to the socket, not here.
    e.onPush(data("p1", "later"));
    expect(e.attach("p1").output).toBe("");
    expect(e.attach("p2").output).toBe("other");
  });

  it("says when the shell already exited", () => {
    const e = new PtyEarlyOutput();
    e.onPush(data("p1", "bye"));
    e.onPush({ type: "pty.exit", ptyId: "p1", code: 0 });
    expect(e.attach("p1")).toEqual({ output: "bye", exited: true });
  });

  it("is bounded and forgets terminals nobody opened", () => {
    let t = 0;
    const e = new PtyEarlyOutput(() => t);
    for (let i = 0; i < 400; i++) e.onPush(data("big", "x".repeat(1024)));
    expect(e.attach("big").output.length).toBeLessThanOrEqual(256 * 1024);
    e.onPush(data("stale", "old"));
    t = 61_000;
    e.onPush(data("fresh", "new"));
    expect(e.attach("stale").output).toBe("");
    expect(e.attach("fresh").output).toBe("new");
  });

  it("ignores other pushes", () => {
    const e = new PtyEarlyOutput();
    e.onPush({ type: "hello" } as never);
    expect(e.attach("p1")).toEqual({ output: "", exited: false });
  });
});
