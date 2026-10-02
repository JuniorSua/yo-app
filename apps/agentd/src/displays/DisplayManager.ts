/** Owns every agent's Display: stable numbering, boot/hibernate, leases, screenshots. */
import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { ComputerState, LeaseHolder } from "@yo/contracts";
import { assertSafeId, config, paths } from "../config";
import type { Logger } from "../log";
import { DisplayAllocator } from "./allocation";
import { Display, displayEnv } from "./Display";

export type StateListener = (
  agentId: string,
  state: ComputerState,
  lease: LeaseHolder,
  message?: string,
) => void;

export class DisplayManager {
  private readonly allocator: DisplayAllocator;
  private readonly displays = new Map<string, Display>();
  private readonly shots = new Map<string, { at: number; png: Promise<Buffer> }>();

  constructor(
    private readonly log: Logger,
    private readonly onState: StateListener,
  ) {
    this.allocator = new DisplayAllocator(paths.displaysFile());
  }

  /** Stable display number for the agent (allocates + persists on first use). */
  displayNumber(agentId: string): number {
    return this.allocator.get(assertSafeId(agentId, "agentId"));
  }

  get(agentId: string): Display {
    let d = this.displays.get(agentId);
    if (!d) {
      const n = this.displayNumber(agentId);
      d = new Display(agentId, n, this.log.child(`display:${n}`), {
        onState: (state, lease, message) => this.onState(agentId, state, lease, message),
      });
      this.displays.set(agentId, d);
    }
    return d;
  }

  async ensure(agentId: string): Promise<Display> {
    const d = this.get(agentId);
    await d.ensure();
    return d;
  }

  async hibernate(agentId: string): Promise<void> {
    const d = this.displays.get(agentId);
    if (d) await d.hibernate();
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
    const png = (async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        execFile(
          "scrot",
          ["--overwrite", "--pointer", "--silent", file],
          { env: displayEnv(agentId, d.n), timeout: 10_000 },
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
  }
}
