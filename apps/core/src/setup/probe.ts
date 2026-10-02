/**
 * Reads the facts the setup chat's requirement check needs from the machine core runs on (the Mac, in local
 * mode). Every probe is best effort: a missing command, a timeout or odd output gives null ("unknown") or
 * "not installed", never a thrown error. An unhandled rejection here would take core down.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type { MachineFacts, ToolFact, ToolId } from "@yo/contracts";
import { hostEnv } from "../computer/ComputerLifecycle";

/** Runs a command and resolves with its stdout, or rejects (missing binary, non-zero exit, timeout). */
export type Runner = (cmd: string, args: string[]) => Promise<string>;

export const runCommand: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    try {
      execFile(cmd, args, { env: hostEnv(), timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout) =>
        err ? reject(err) : resolve(String(stdout)),
      );
    } catch (err) {
      reject(err);
    }
  });

async function tryRun(run: Runner, cmd: string, args: string[]): Promise<string | null> {
  try {
    return await run(cmd, args);
  } catch {
    return null;
  }
}

/** `sw_vers -productVersion` -> "14.5". Also accepts full `sw_vers` output ("ProductVersion:\t14.5"). */
export function parseSwVers(out: string | null): string | null {
  if (!out) return null;
  const line = out.match(/ProductVersion:\s*([\d.]+)/)?.[1] ?? out.trim().split("\n")[0]?.trim();
  return line && /^\d+(\.\d+)*$/.test(line) ? line : null;
}

/**
 * macOS version from the Darwin kernel release (os.release()), when sw_vers isn't available.
 * Darwin 20-24 = macOS 11-15; Darwin 25 = macOS 26 (Apple jumped to year numbers).
 */
export function macosFromDarwin(release: string): string | null {
  const major = Number(release.split(".")[0]);
  if (!Number.isInteger(major) || major < 20) return null;
  return major >= 25 ? `${major + 1}.0` : `${major - 9}.0`;
}

/** A positive integer from `sysctl -n` output, or null. */
export function parseCount(out: string | null): number | null {
  const n = Number(out?.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** First non-empty line, trimmed and capped (version strings). */
export function firstLine(out: string | null): string | null {
  const line = out
    ?.split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return line ? line.slice(0, 120) : null;
}

async function tool(run: Runner, cmd: string, args: string[]): Promise<ToolFact> {
  const out = await tryRun(run, cmd, args);
  return out == null ? { installed: false, version: null } : { installed: true, version: firstLine(out) };
}

export interface ProbeDeps {
  run?: Runner;
  platform?: NodeJS.Platform;
  totalmem?: () => number;
  cpus?: () => { model: string }[];
  arch?: string;
  release?: () => string;
  /** Free bytes for `dir` (statfs). */
  freeBytes?: (dir: string) => Promise<number>;
  home?: () => string;
}

async function statfsFree(dir: string): Promise<number> {
  const s = await fs.promises.statfs(dir);
  return s.bavail * s.bsize;
}

/** Measure the machine. Never rejects. */
export async function probeMachine(deps: ProbeDeps = {}): Promise<MachineFacts> {
  const run = deps.run ?? runCommand;
  const platform = deps.platform ?? process.platform;
  const mac = platform === "darwin";
  const safe = <T>(f: () => T): T | null => {
    try {
      return f();
    } catch {
      return null;
    }
  };

  const totalMemBytes = safe(() => (deps.totalmem ?? os.totalmem)()) || null;
  const cpus = safe(() => (deps.cpus ?? os.cpus)()) ?? [];

  const [brand, arm64, physical, logical, swVers, freeBytes, tools] = await Promise.all([
    mac ? tryRun(run, "sysctl", ["-n", "machdep.cpu.brand_string"]) : Promise.resolve(null),
    // 1 on Apple silicon even when core itself runs under Rosetta.
    mac ? tryRun(run, "sysctl", ["-n", "hw.optional.arm64"]) : Promise.resolve(null),
    mac ? tryRun(run, "sysctl", ["-n", "hw.physicalcpu"]) : Promise.resolve(null),
    mac ? tryRun(run, "sysctl", ["-n", "hw.logicalcpu"]) : Promise.resolve(null),
    mac ? tryRun(run, "sw_vers", ["-productVersion"]) : Promise.resolve(null),
    (deps.freeBytes ?? statfsFree)(safe(() => (deps.home ?? os.homedir)()) ?? "/").catch(() => null),
    probeTools(run),
  ]);

  const model = firstLine(brand) ?? cpus[0]?.model?.trim() ?? null;
  const arch = deps.arch ?? process.arch;
  const appleSilicon = !mac
    ? arch === "arm64"
    : arm64 != null
      ? arm64.trim() === "1"
      : model
        ? /^Apple\b/.test(model)
          ? true
          : /Intel/i.test(model)
            ? false
            : null
        : null;

  let macosVersion: string | null = null;
  if (mac) macosVersion = parseSwVers(swVers) ?? macosFromDarwin(safe(deps.release ?? os.release) ?? "");

  return {
    platform,
    totalMemBytes,
    cpu: {
      model,
      appleSilicon,
      physicalCores: parseCount(physical) ?? (cpus.length || null),
      logicalCores: parseCount(logical) ?? (cpus.length || null),
    },
    diskFreeBytes: typeof freeBytes === "number" && Number.isFinite(freeBytes) ? freeBytes : null,
    macosVersion,
    tools,
  };
}

/** Homebrew, Colima, the Docker CLI and its Compose plugin. */
export async function probeTools(run: Runner = runCommand): Promise<Record<ToolId, ToolFact>> {
  const [homebrew, colima, docker, compose] = await Promise.all([
    tool(run, "brew", ["--version"]),
    tool(run, "colima", ["version"]),
    tool(run, "docker", ["--version"]),
    tool(run, "docker", ["compose", "version"]),
  ]);
  return { homebrew, colima, docker, compose };
}
