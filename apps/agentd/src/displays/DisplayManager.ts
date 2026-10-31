/**
 * Owns every agent's computer: stable numbering, boot/hibernate, leases, screenshots. On the shared computer
 * (default) an agent's computer is a seat on the one shared desktop; otherwise it's its own Display.
 */
import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { ComputerState, LeaseHolder } from "@yo/contracts";
import { assertSafeId, config, paths } from "../config";
import type { Logger } from "../log";
import { DisplayAllocator, noFreeSeat } from "./allocation";
import { Display, displayEnv } from "./Display";
import { type Seat, SHARED_DISPLAY, SharedDesktop } from "./SharedDesktop";

/** What the rest of agentd needs from an agent's computer, whichever kind it is. */
export interface AgentComputer {
  readonly agentId: string;
  readonly n: number;
  readonly cdpPort: number;
  readonly vncPort: number;
  state: ComputerState;
  lease: LeaseHolder;
  lastActiveAt: number;
  ensure(): Promise<void>;
  hibernate(): Promise<void>;
  setLease(holder: LeaseHolder): Promise<void>;
  shutdown(): Promise<void>;
}

/** Where an agent's screen is: its X display and, on the shared computer, its tile. */
export interface ScreenPlace {
  display: number;
  area: { x: number; y: number; width: number; height: number } | null;
}

export type StateListener = (
  agentId: string,
  state: ComputerState,
  lease: LeaseHolder,
  message?: string,
) => void;

const isAwake = (d: AgentComputer) => d.state === "ready" || d.state === "booting";

export class DisplayManager {
  private readonly allocator: DisplayAllocator;
  private readonly displays = new Map<string, AgentComputer>();
  private readonly shared: SharedDesktop | null;
  private readonly shots = new Map<string, { at: number; png: Promise<Buffer> }>();

  constructor(
    private readonly log: Logger,
    private readonly onState: StateListener,
  ) {
    this.allocator = new DisplayAllocator(paths.displaysFile());
    this.shared = config.sharedComputer ? new SharedDesktop(log.child("shared")) : null;
  }

  get sharedComputer(): boolean {
    return !!this.shared;
  }

  /** Stable display number for the agent (allocates + persists on first use). */
  displayNumber(agentId: string): number {
    return this.allocator.get(assertSafeId(agentId, "agentId"));
  }

  get(agentId: string): AgentComputer {
    let d = this.displays.get(agentId);
    if (!d) {
      const n = this.displayNumber(agentId);
      if (this.shared) {
        const seat = this.shared.seat(agentId, n);
        seat.onState = (state, lease, message) => this.onState(agentId, state, lease, message);
        d = seat;
      } else {
        d = new Display(agentId, n, this.log.child(`display:${n}`), {
          onState: (state, lease, message) => this.onState(agentId, state, lease, message),
        });
      }
      this.displays.set(agentId, d);
    }
    return d;
  }

  /** The agent's screen: its own display, or its tile of the shared one (null until it first wakes). */
  place(agentId: string): ScreenPlace {
    const d = this.get(agentId);
    if (!this.shared) return { display: d.n, area: null };
    return { display: SHARED_DISPLAY, area: (d as Seat).area() };
  }

  /**
   * Wakes the agent's computer. Every wake goes through here (core's requests, the live view, a turn), so
   * this is where the cap on awake computers holds: one more than YO_MAX_AWAKE_SEATS is refused with
   * NO_FREE_SEAT. Which awake agent can go to sleep is core's call (it knows who is working or waiting on
   * the user), so core frees one and asks again.
   */
  async ensure(agentId: string): Promise<AgentComputer> {
    const d = this.get(agentId);
    if (!isAwake(d) && !this.hasRoom()) {
      const cap = config.maxAwakeSeats;
      throw noFreeSeat(`${cap} agent ${cap === 1 ? "computer is" : "computers are"} already awake.`);
    }
    await d.ensure();
    return d;
  }

  /** True when one more computer may wake (YO_MAX_AWAKE_SEATS; 0 means no cap). */
  hasRoom(): boolean {
    const cap = config.maxAwakeSeats;
    return cap <= 0 || [...this.displays.values()].filter(isAwake).length < cap;
  }

  async hibernate(agentId: string): Promise<void> {
    const d = this.displays.get(agentId);
    if (d) await d.hibernate();
  }

  /**
   * Gone for good (a helper that finished): its tabs close without being saved, its seat, tile and display
   * number are freed, and its home folder and browser profile are deleted. ~/Shared is only a link in the
   * home folder, so it's untouched.
   */
  async discard(agentId: string): Promise<void> {
    assertSafeId(agentId, "agentId");
    const d = this.displays.get(agentId);
    this.displays.delete(agentId);
    this.shots.delete(agentId);
    if (this.shared) await this.shared.discard(agentId);
    else if (d) await d.shutdown().catch(() => undefined);
    this.allocator.release(agentId);
    await fsp.rm(paths.agentHome(agentId), { recursive: true, force: true });
    if (!this.shared) await fsp.rm(paths.profileDir(agentId), { recursive: true, force: true });
  }

  async lease(agentId: string, holder: LeaseHolder): Promise<void> {
    await this.get(agentId).setLease(holder);
  }

  status(): { agentId: string; state: ComputerState; display: number; lease: LeaseHolder }[] {
    const out = new Map<
      string,
      { agentId: string; state: ComputerState; display: number; lease: LeaseHolder }
    >();
    for (const [agentId, n] of this.allocator.entries())
      out.set(agentId, { agentId, state: "off", display: n, lease: "agent" });
    for (const d of this.displays.values()) {
      out.set(d.agentId, { agentId: d.agentId, state: d.state, display: d.n, lease: d.lease });
    }
    return [...out.values()].sort((a, b) => a.display - b.display);
  }

  /** PNG of the agent's screen (cached ~1s). Throws if the display isn't running. */
  async screenshot(agentId: string): Promise<Buffer> {
    const d = this.displays.get(agentId);
    if (!d || (d.state !== "ready" && d.state !== "booting")) {
      const e = new Error(`computer for ${agentId} is not running`);
      (e as Error & { status?: number }).status = 409;
      throw e;
    }
    const cached = this.shots.get(agentId);
    if (cached && Date.now() - cached.at < 1000) return cached.png;
    const file = path.join(config.runDir, "shots", `${agentId}.png`);
    const { display, area } = this.place(agentId);
    const png = (async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        execFile(
          "scrot",
          [
            "--overwrite",
            "--pointer",
            "--silent",
            ...(area ? ["-a", `${area.x},${area.y},${area.width},${area.height}`] : []),
            file,
          ],
          { env: { ...displayEnv(agentId, d.n), DISPLAY: `:${display}` }, timeout: 10_000 },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      return fsp.readFile(file);
    })();
    this.shots.set(agentId, { at: Date.now(), png });
    png.catch(() => this.shots.delete(agentId));
    return png;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.displays.values()].map((d) => d.shutdown().catch(() => undefined)));
    await this.shared?.shutdown().catch(() => undefined);
  }
}
