/** Container memory/CPU from cgroup v2, with os fallbacks. */
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CGROUP_ROOT = "/sys/fs/cgroup";

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

/** `key value` lines (memory.stat, memory.events, cpu.stat) → map; null if the file can't be read. */
function readKeyed(file: string): Map<string, number> | null {
  try {
    const out = new Map<string, number>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const [k, v] = line.trim().split(/\s+/);
      const n = Number(v);
      if (k && v !== undefined && Number.isFinite(n)) out.set(k, n);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Share of memory still available, 0..1, as the computer sees it: with a container memory limit
 * (cgroup memory.max), the limit minus what's in use (memory.current minus inactive file cache, like
 * readMetrics); without one, MemAvailable / MemTotal from /proc/meminfo. null when neither can be read.
 */
export function availableMemory(root = CGROUP_ROOT, meminfo = "/proc/meminfo"): number | null {
  const max = readNum(path.join(root, "memory.max"));
  const current = readNum(path.join(root, "memory.current"));
  if (max !== null && max > 0 && current !== null) {
    const inactive = readKeyed(path.join(root, "memory.stat"))?.get("inactive_file") ?? 0;
    const used = Math.max(0, current - Math.min(inactive, current));
    return Math.max(0, Math.min(1, (max - used) / max));
  }
  try {
    const kb = new Map<string, number>();
    for (const line of readFileSync(meminfo, "utf8").split("\n")) {
      const m = /^(\w+):\s+(\d+)/.exec(line);
      if (m) kb.set(m[1]!, Number(m[2]));
    }
    const total = kb.get("MemTotal");
    const avail = kb.get("MemAvailable");
    if (!total || avail === undefined) return null;
    return Math.max(0, Math.min(1, avail / total));
  } catch {
    return null;
  }
}

/** Chromium renderer processes running (`--type=renderer` in /proc/<pid>/cmdline); null without /proc. */
export function countRenderers(proc = "/proc"): number | null {
  let pids: string[];
  try {
    pids = readdirSync(proc).filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  let n = 0;
  for (const pid of pids) {
    try {
      if (readFileSync(path.join(proc, pid, "cmdline"), "utf8").includes("--type=renderer")) n++;
    } catch {
      // gone, or not ours to read
    }
  }
  return n;
}

let last: { t: number; usage: number } | null = null;

export interface Metrics {
  /** Memory in use: memory.current minus inactive file cache (the number `docker stats` shows). */
  memMB: number;
  memLimitMB: number;
  /** Inactive file cache the kernel frees as soon as programs need the room (absent without cgroup v2). */
  cacheMB?: number;
  /** Programs killed for lack of memory since the computer started (memory.events `oom_kill`). */
  oomKills?: number;
  cpuPct?: number;
}

/** `root` is injectable so tests can point it at a fake cgroup directory. */
export function readMetrics(root = CGROUP_ROOT): Metrics {
  const MB = 1024 * 1024;
  const current = readNum(path.join(root, "memory.current"));
  const max = readNum(path.join(root, "memory.max"));
  const stat = current !== null ? readKeyed(path.join(root, "memory.stat")) : null;
  const inactive = stat?.get("inactive_file");
  const used =
    current === null
      ? os.totalmem() - os.freemem()
      : inactive !== undefined
        ? Math.max(0, current - inactive)
        : current;
  const out: Metrics = {
    memMB: Math.round(used / MB),
    memLimitMB: Math.round((max ?? os.totalmem()) / MB),
  };
  if (current !== null && inactive !== undefined) out.cacheMB = Math.round(Math.min(inactive, current) / MB);
  const oomKills = readKeyed(path.join(root, "memory.events"))?.get("oom_kill");
  if (oomKills !== undefined) out.oomKills = oomKills;
  const usage = readKeyed(path.join(root, "cpu.stat"))?.get("usage_usec") ?? null;
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
