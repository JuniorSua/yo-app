/**
 * Process helpers: run-and-collect for short CLI calls, and a lazy node-pty loader.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the executable could not be spawned (ENOENT etc.). */
  spawnError?: string;
}

export function runCollect(
  command: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        env: opts.env ?? (process.env as Record<string, string>),
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      done({ code: null, stdout, stderr, timedOut, spawnError: String(err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 15_000);
    timer.unref?.();
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr, timedOut, spawnError: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Minimal slice of node-pty we use (keeps the dependency lazily loaded and mockable). */
export interface PtyProcess {
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  kill(signal?: string): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  opts: { cols: number; rows: number; cwd: string; env: Record<string, string>; name?: string },
) => PtyProcess;

/**
 * node-pty ships its macOS/Linux `spawn-helper` in prebuilds without the exec bit when installed
 * through pnpm, which makes every spawn fail with "posix_spawnp failed". Fix it up once.
 */
function ensurePtyHelperExecutable(): void {
  try {
    const req = createRequire(import.meta.url);
    const root = dirname(req.resolve("node-pty/package.json"));
    for (const dir of [
      join(root, "prebuilds", `${process.platform}-${process.arch}`),
      join(root, "build", "Release"),
    ]) {
      const helper = join(dir, "spawn-helper");
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
    }
  } catch {
    // best effort
  }
}

let ptySpawn: PtySpawn | undefined;

export async function loadPty(): Promise<PtySpawn> {
  if (ptySpawn) return ptySpawn;
  ensurePtyHelperExecutable();
  const mod = (await import("node-pty")) as unknown as { spawn: PtySpawn; default?: { spawn: PtySpawn } };
  const fn = mod.spawn ?? mod.default?.spawn;
  if (!fn) throw new Error("node-pty is not available");
  ptySpawn = fn;
  return fn;
}
