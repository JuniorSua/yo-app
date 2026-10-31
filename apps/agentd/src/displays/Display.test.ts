import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../config";
import { createLogger } from "../log";
import { Display, type DisplaySpec } from "./Display";

const realChromium = config.chromiumBin;
afterEach(() => {
  config.chromiumBin = realChromium;
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("Display", () => {
  it("stops a Chromium that never answers, so the retry launches a fresh one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "yo-display-"));
    // A "Chromium" that starts but never opens its CDP port (wedged).
    const fake = path.join(dir, "chromium");
    writeFileSync(fake, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(fake, 0o755);
    config.chromiumBin = fake;
    const spec: DisplaySpec = {
      width: 100,
      height: 100,
      profileDir: path.join(dir, "profile"),
      home: dir,
      env: { PATH: process.env.PATH },
      vnc: false,
      windowArgs: () => [],
      openboxArgs: [],
    };
    // Display 999: a CDP port nothing listens on.
    const d = new Display("agt_test", 999, createLogger("test"), { onState: () => {} }, spec);
    d.chromiumReadyMs = 300;
    const priv = d as unknown as { startChromium(): Promise<void> };

    await expect(priv.startChromium()).rejects.toThrow(/not ready/);
    expect(d.pids().chromium).toBeUndefined();

    // The retry really starts a new process (it used to find the stuck one still "running" and wait on it).
    const second = priv.startChromium().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    const pid = d.pids().chromium!;
    expect(pid).toBeGreaterThan(0);
    await second;
    expect(alive(pid)).toBe(false);
  }, 20_000);
});
