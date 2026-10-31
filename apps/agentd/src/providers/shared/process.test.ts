import { describe, expect, it } from "vitest";
import { runCollect } from "./process";

describe("runCollect", () => {
  it("collects output and the exit code", async () => {
    const r = await runCollect("sh", ["-c", "echo hi; echo oops >&2; exit 3"]);
    expect(r).toMatchObject({ code: 3, stdout: "hi\n", stderr: "oops\n", timedOut: false });
  });

  it("returns on timeout even when a grandchild keeps its output open", async () => {
    // A wrapper script whose real binary outlives it: killing the wrapper alone never closes stdout.
    const started = Date.now();
    const r = await runCollect("sh", ["-c", "sleep 8 & echo started; wait"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe("started\n");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports a missing executable instead of throwing", async () => {
    const r = await runCollect("/nonexistent/yo-cli", []);
    expect(r.spawnError).toBeTruthy();
  });
});
