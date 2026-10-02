/**
 * One agent's desktop: Xvfb + openbox + wallpaper + headed Chromium (CDP on loopback) + x11vnc (loopback).
 * Every process is supervised: unexpected exits are restarted with exponential backoff.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, promises as fsp, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ComputerState, LeaseHolder } from "@yo/contracts";
import { scrubEnv } from "../auth";
import { config, paths } from "../config";
import { errMsg, type Logger } from "../log";
import { cdpPort, vncPort } from "./allocation";
import { applyPendingRestore } from "./cdpRestore";
import { prepareSessionRestore } from "./sessionRestore";
import { wallpaperFile } from "./wallpaper";

export type ProcName = "xvfb" | "openbox" | "wallpaper" | "chromium" | "x11vnc";

export interface DisplayEvents {
  onState(state: ComputerState, lease: LeaseHolder, message?: string): void;
}

interface ProcSlot {
  name: ProcName;
  child: ChildProcess | null;
  /** Expected to keep running (false for one-shot helpers). */
  daemon: boolean;
  stopping: boolean;
  crashes: number[];
  restartTimer: NodeJS.Timeout | null;
  lastStderr: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 150,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {
      // keep polling
    }
    await sleep(intervalMs);
  }
  return false;
}

export async function cdpReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function tcpReady(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

/** Environment for every process on this display. Never contains agentd secrets (stripped at boot). */
export function displayEnv(agentId: string, n: number): NodeJS.ProcessEnv {
  return {
    ...scrubEnv(process.env),
    DISPLAY: `:${n}`,
    HOME: paths.agentHome(agentId),
    YO_AGENT_ID: agentId,
    YO_CDP_URL: `http://127.0.0.1:${cdpPort(n)}`,
    LANG: process.env.LANG ?? "C.UTF-8",
  };
}

export class Display {
  state: ComputerState = "off";
  lease: LeaseHolder = "agent";
  readonly cdpPort: number;
  readonly vncPort: number;
  private wanted = false;
  /** The profile has a previous session to reopen (set just before each Chromium launch). */
  private restoreSession = false;
  private booting: Promise<void> | null = null;
  private procs = new Map<ProcName, ProcSlot>();
  private wallpaperTimer: NodeJS.Timeout | null = null;
  lastActiveAt = 0;

  constructor(
    readonly agentId: string,
    readonly n: number,
    private readonly log: Logger,
    private readonly events: DisplayEvents,
  ) {
    this.cdpPort = cdpPort(n);
    this.vncPort = vncPort(n);
  }

  private setState(state: ComputerState, message?: string): void {
    const changed = state !== this.state;
    this.state = state;
    if (changed || message) this.events.onState(state, this.lease, message);
  }

  /* ------------------------------- lifecycle ------------------------------- */

  async ensure(): Promise<void> {
    this.lastActiveAt = Date.now();
    if (this.state === "ready" && this.wanted) return;
    if (this.booting) return this.booting;
    this.booting = this.boot().finally(() => {
      this.booting = null;
    });
    return this.booting;
  }

  private async boot(): Promise<void> {
    this.wanted = true;
    this.setState("booting");
    try {
      const home = paths.agentHome(this.agentId);
      await fsp.mkdir(home, { recursive: true });
      await fsp.mkdir(paths.profileDir(this.agentId), { recursive: true, mode: 0o700 });
      await this.startXvfb();
      this.startProc("openbox");
      this.setWallpaper();
      await this.startChromium();
      await this.startX11vnc();
      this.wallpaperTimer ??= setInterval(() => this.setWallpaper(), 15 * 60_000);
      this.setState("ready");
      this.log.info("display ready", { agentId: this.agentId, display: this.n });
    } catch (err) {
      this.log.error("display boot failed", { agentId: this.agentId, err: errMsg(err) });
      await this.stopAll();
      this.wanted = false;
      this.setState("error", errMsg(err));
      throw err;
    }
  }

  async hibernate(): Promise<void> {
    if (this.booting) await this.booting.catch(() => undefined);
    this.wanted = false;
    await this.stopAll();
    this.setState("hibernated");
  }

  async shutdown(): Promise<void> {
    this.wanted = false;
    await this.stopAll();
  }

  async setLease(holder: LeaseHolder): Promise<void> {
    if (holder === this.lease) return;
    this.lease = holder;
    if (this.wanted && this.procs.get("x11vnc")?.child) {
      await this.stopProc("x11vnc");
      await this.startX11vnc();
    }
    this.events.onState(this.state, this.lease);
  }

  /* ------------------------------ processes ------------------------------ */

  private xSocket(): string {
    return `/tmp/.X11-unix/X${this.n}`;
  }

  private async startXvfb(): Promise<void> {
    // Clean stale lock/socket left by a previous container run.
    if (!this.procs.get("xvfb")?.child) {
      for (const f of [`/tmp/.X${this.n}-lock`, this.xSocket()]) {
        try {
          rmSync(f, { force: true });
        } catch {
          // ignore
        }
      }
    }
    this.startProc("xvfb");
    const ok = await waitFor(() => existsSync(this.xSocket()), 10_000, 100);
    if (!ok) throw new Error(`Xvfb :${this.n} did not start (${this.stderrTail("xvfb")})`);
  }

  private async startChromium(): Promise<void> {
    const profile = paths.profileDir(this.agentId);
    this.restoreSession = prepareSessionRestore(profile);
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      try {
        rmSync(path.join(profile, f), { force: true });
      } catch {
        // ignore
      }
    }
    this.startProc("chromium");
    const ok = await waitFor(() => cdpReady(this.cdpPort), 30_000, 250);
    if (!ok) throw new Error(`Chromium CDP :${this.cdpPort} not ready (${this.stderrTail("chromium")})`);
    void applyPendingRestore(this.cdpPort, profile, this.log);
  }

  private async startX11vnc(): Promise<void> {
    this.startProc("x11vnc");
    const ok = await waitFor(() => tcpReady(this.vncPort), 10_000, 150);
    if (!ok) throw new Error(`x11vnc :${this.vncPort} not ready (${this.stderrTail("x11vnc")})`);
  }

  private setWallpaper(): void {
    try {
      const file = wallpaperFile(config.runDir, config.screen.width, config.screen.height);
      this.startProc("wallpaper", ["--no-fehbg", "--bg-fill", file]);
    } catch (err) {
      this.log.warn("wallpaper failed", { err: errMsg(err) });
    }
  }

  private command(name: ProcName, extra: string[] = []): { cmd: string; args: string[] } {
    const { width, height, depth } = config.screen;
    switch (name) {
      case "xvfb":
        return {
          cmd: "Xvfb",
          args: [
            `:${this.n}`,
            "-screen",
            "0",
            `${width}x${height}x${depth}`,
            "-nolisten",
            "tcp",
            "-dpi",
            "96",
          ],
        };
      case "openbox":
        return { cmd: "openbox", args: ["--sm-disable"] };
      case "wallpaper":
        return { cmd: "feh", args: extra };
      case "chromium":
        return {
          cmd: config.chromiumBin,
          args: [
            `--user-data-dir=${paths.profileDir(this.agentId)}`,
            "--remote-debugging-address=127.0.0.1",
            `--remote-debugging-port=${this.cdpPort}`,
            "--no-sandbox",
            "--test-type",
            "--no-first-run",
            "--no-default-browser-check",
            "--password-store=basic",
            "--disable-features=Translate,MediaRouter",
            "--hide-crash-restore-bubble",
            "--start-maximized",
            "--window-position=0,0",
            `--window-size=${width},${height}`,
            "--disk-cache-size=104857600",
            // Reopen the tabs that were open when Chromium last stopped (hibernate, restart, update).
            // A fresh profile starts on a blank tab instead.
            ...(this.restoreSession ? ["--restore-last-session"] : ["about:blank"]),
          ],
        };
      case "x11vnc":
        return {
          cmd: "x11vnc",
          args: [
            "-display",
            `:${this.n}`,
            "-localhost",
            "-noipv6",
            "-rfbportv6",
            "-1",
            "-rfbport",
            String(this.vncPort),
            "-forever",
            "-shared",
            "-nopw",
            "-noxdamage",
            "-quiet",
            ...(this.lease === "user" ? [] : ["-viewonly"]),
          ],
        };
    }
  }

  private startProc(name: ProcName, extra: string[] = []): void {
    let slot = this.procs.get(name);
    if (!slot) {
      slot = {
        name,
        child: null,
        daemon: name !== "wallpaper",
        stopping: false,
        crashes: [],
        restartTimer: null,
        lastStderr: [],
      };
      this.procs.set(name, slot);
    }
    if (slot.child && slot.daemon) return;
    const { cmd, args } = this.command(name, extra);
    slot.stopping = false;
    const child = spawn(cmd, args, {
      env: displayEnv(this.agentId, this.n),
      cwd: paths.agentHome(this.agentId),
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    slot.child = child;
    const s = slot;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      for (const line of d.split("\n")) {
        if (!line.trim()) continue;
        s.lastStderr.push(line.slice(0, 400));
        if (s.lastStderr.length > 15) s.lastStderr.shift();
      }
    });
    child.on("error", (err) => {
      this.log.error("spawn failed", { agentId: this.agentId, proc: name, err: errMsg(err) });
    });
    child.on("exit", (code, signal) => {
      if (s.child === child) s.child = null;
      if (!s.daemon) return;
      if (s.stopping || !this.wanted) return;
      this.log.warn("process exited unexpectedly", {
        agentId: this.agentId,
        proc: name,
        code,
        signal,
        stderr: s.lastStderr.slice(-3),
      });
      // Everything else dies with the X server; the xvfb restart rebuilds the whole stack.
      if (name !== "xvfb" && !this.procs.get("xvfb")?.child) return;
      this.scheduleRestart(s);
    });
  }

  private scheduleRestart(slot: ProcSlot): void {
    const now = Date.now();
    slot.crashes = slot.crashes.filter((t) => now - t < 120_000);
    slot.crashes.push(now);
    if (slot.crashes.length > 6) {
      this.log.error("process crash loop; giving up", { agentId: this.agentId, proc: slot.name });
      this.wanted = false;
      void this.stopAll().then(() => this.setState("error", `${slot.name} keeps crashing`));
      return;
    }
    const delay = Math.min(30_000, 500 * 2 ** (slot.crashes.length - 1));
    this.setState(this.state, `${slot.name} exited; restarting in ${delay}ms`);
    if (slot.restartTimer) clearTimeout(slot.restartTimer);
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      void this.restart(slot.name);
    }, delay);
  }

  private async restart(name: ProcName): Promise<void> {
    if (!this.wanted) return;
    if (name !== "xvfb" && !this.procs.get("xvfb")?.child) return;
    try {
      if (name === "xvfb") {
        // Everything depends on the X server: rebuild the whole stack.
        this.setState("booting", "display server restarted");
        for (const p of ["x11vnc", "chromium", "openbox"] as const) await this.stopProc(p);
        await this.startXvfb();
        this.startProc("openbox");
        this.setWallpaper();
        await this.startChromium();
        await this.startX11vnc();
      } else if (name === "chromium") {
        await this.startChromium();
      } else if (name === "x11vnc") {
        await this.startX11vnc();
      } else {
        this.startProc(name);
      }
      if (this.wanted) this.setState("ready", `${name} restarted`);
    } catch (err) {
      this.log.error("restart failed", { agentId: this.agentId, proc: name, err: errMsg(err) });
      const slot = this.procs.get(name);
      if (slot && this.wanted) this.scheduleRestart(slot);
    }
  }

  private async stopProc(name: ProcName, timeoutMs = 4000): Promise<void> {
    const slot = this.procs.get(name);
    if (!slot) return;
    if (slot.restartTimer) {
      clearTimeout(slot.restartTimer);
      slot.restartTimer = null;
    }
    const child = slot.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      slot.child = null;
      return;
    }
    slot.stopping = true;
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // gone
        }
      }
    };
    kill("SIGTERM");
    const t = setTimeout(() => kill("SIGKILL"), timeoutMs);
    await Promise.race([exited, sleep(timeoutMs + 1500)]);
    clearTimeout(t);
    slot.child = null;
  }

  private async stopAll(): Promise<void> {
    if (this.wallpaperTimer) {
      clearInterval(this.wallpaperTimer);
      this.wallpaperTimer = null;
    }
    // Chromium writes its session (open tabs) on a clean SIGTERM; give it time before SIGKILL.
    for (const p of ["x11vnc", "chromium", "openbox", "wallpaper", "xvfb"] as const)
      await this.stopProc(p, p === "chromium" ? 10_000 : 4000);
  }

  private stderrTail(name: ProcName): string {
    return (this.procs.get(name)?.lastStderr ?? []).slice(-3).join(" | ") || "no output";
  }

  pids(): Partial<Record<ProcName, number>> {
    const out: Partial<Record<ProcName, number>> = {};
    for (const [k, v] of this.procs) if (v.child?.pid) out[k] = v.child.pid;
    return out;
  }
}
