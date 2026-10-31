import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { availableMemory, countRenderers, readMetrics } from "./metrics";

const MB = 1024 * 1024;

function fakeCgroup(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "yo-cgroup-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
}

// The 2026-10-04 reading from the PC: 290 MB current, of which 187 MB was inactive file cache.
const STAT = [
  "anon 62914560",
  `file ${224 * MB}`,
  "kernel 3145728",
  `active_file ${37 * MB}`,
  `inactive_file ${187 * MB}`,
  "pgfault 1234",
].join("\n");

describe("readMetrics", () => {
  it("reports in use as memory.current minus inactive file cache", () => {
    const root = fakeCgroup({
      "memory.current": `${290 * MB}\n`,
      "memory.max": `${8192 * MB}\n`,
      "memory.stat": STAT,
      "memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
    });
    expect(readMetrics(root)).toMatchObject({ memMB: 103, memLimitMB: 8192, cacheMB: 187, oomKills: 0 });
  });

  it("counts out-of-memory kills", () => {
    const root = fakeCgroup({
      "memory.current": `${7900 * MB}`,
      "memory.max": `${8192 * MB}`,
      "memory.stat": `inactive_file ${100 * MB}`,
      "memory.events": "max 41\noom 3\noom_kill 2\n",
    });
    expect(readMetrics(root)).toMatchObject({ memMB: 7800, cacheMB: 100, oomKills: 2 });
  });

  it("falls back to memory.current alone when memory.stat is missing", () => {
    const root = fakeCgroup({ "memory.current": `${500 * MB}`, "memory.max": "max" });
    const m = readMetrics(root);
    expect(m.memMB).toBe(500);
    expect(m.memLimitMB).toBe(Math.round(os.totalmem() / MB));
    expect(m.cacheMB).toBeUndefined();
    expect(m.oomKills).toBeUndefined();
  });

  it("falls back to the host's memory without cgroup v2", () => {
    const m = readMetrics(fakeCgroup({}));
    expect(m.memMB).toBeGreaterThan(0);
    expect(m.memLimitMB).toBe(Math.round(os.totalmem() / MB));
    expect(m.cacheMB).toBeUndefined();
  });
});

describe("availableMemory (the memory guard's reading)", () => {
  const meminfo = (total: number, avail: number) => {
    const dir = fakeCgroup({
      meminfo: `MemTotal:       ${total} kB\nMemFree:  1 kB\nMemAvailable:   ${avail} kB\n`,
    });
    return path.join(dir, "meminfo");
  };

  it("uses the container's limit when it has one (in use = current minus inactive file cache)", () => {
    const root = fakeCgroup({
      "memory.current": `${7000 * MB}`,
      "memory.max": `${8000 * MB}`,
      "memory.stat": `inactive_file ${1000 * MB}`,
    });
    expect(availableMemory(root, meminfo(100, 90))).toBeCloseTo(0.25);
  });

  it("without a limit, reads MemAvailable / MemTotal (the issue's PC: 6786 of 15997 MB)", () => {
    const root = fakeCgroup({ "memory.current": `${9000 * MB}`, "memory.max": "max" });
    expect(availableMemory(root, meminfo(15997 * 1024, 6786 * 1024))).toBeCloseTo(0.424, 3);
  });

  it("is null when nothing can be read", () => {
    expect(availableMemory(fakeCgroup({}), "/nonexistent/meminfo")).toBeNull();
  });
});

describe("countRenderers", () => {
  it("counts Chromium renderer processes in /proc", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "yo-proc-"));
    const proc = (pid: string, cmd: string) => {
      mkdirSync(path.join(dir, pid));
      writeFileSync(path.join(dir, pid, "cmdline"), cmd.split(" ").join("\0"));
    };
    proc("10", "chromium --type=renderer --renderer-client-id=5");
    proc("11", "chromium --type=renderer --renderer-client-id=6");
    proc("12", "chromium --type=gpu-process");
    proc("13", "node agentd.js");
    mkdirSync(path.join(dir, "self"));
    expect(countRenderers(dir)).toBe(2);
    expect(countRenderers("/nonexistent/proc")).toBeNull();
  });
});
