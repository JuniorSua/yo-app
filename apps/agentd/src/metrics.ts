/** Container memory/CPU from cgroup v2, with os fallbacks. */
import { readFileSync } from "node:fs";
import os from "node:os";

function readNum(file: string): number | null {
  try {
    const s = readFileSync(file, "utf8").trim();
    if (s === "max") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function cpuUsageUsec(): number | null {
  try {
    const m = /usage_usec\s+(\d+)/.exec(readFileSync("/sys/fs/cgroup/cpu.stat", "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

let last: { t: number; usage: number } | null = null;

export interface Metrics {
  memMB: number;
  memLimitMB: number;
  cpuPct?: number;
}

export function readMetrics(): Metrics {
  const MB = 1024 * 1024;
  const current = readNum("/sys/fs/cgroup/memory.current");
  const max = readNum("/sys/fs/cgroup/memory.max");
  const memMB = Math.round((current ?? os.totalmem() - os.freemem()) / MB);
  const memLimitMB = Math.round((max ?? os.totalmem()) / MB);
  const out: Metrics = { memMB, memLimitMB };
  const usage = cpuUsageUsec();
  const now = Date.now();
  if (usage !== null) {
    if (last && now > last.t) {
      const pct = ((usage - last.usage) / 1000 / (now - last.t) / os.cpus().length) * 100;
      out.cpuPct = Math.max(0, Math.round(pct * 10) / 10);
    }
    last = { t: now, usage };
  }
  return out;
}
