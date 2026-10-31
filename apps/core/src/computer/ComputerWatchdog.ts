/**
 * Brings Yo's computer back when its link to Yo breaks and nothing else will (C8).
 *
 * Seen after a Mac sleeps and wakes: Colima's VM (or its port forward to agentd) doesn't come back, core keeps
 * trying to reconnect forever, and the user had to find Settings → Computer → Stop, then Start. The watchdog does
 * that for them, conservatively:
 *  - only when Yo's computer should be running (core started it, the user didn't stop it, auto-sleep didn't stop
 *    it, the first-run setup is done) and nothing is starting, updating or repairing it right now;
 *  - only after agentd has been unreachable for a while (UNREACHABLE_MS), so an agentd restart or a short
 *    hiccup never triggers it; much longer (FIRST_CONNECT_MS) when it hasn't answered yet since Yo started or
 *    since the last repair, so a slow first boot on a busy Mac is never cut short;
 *  - at most once per REPAIR_GAP_MS, and at most MAX_REPAIRS times until the link comes back: if a repair
 *    doesn't help, it stops and leaves the computer's status for the user (no restart loop).
 */
import { logger } from "../log";

const log = logger("computer");

/** How long agentd may be unreachable before the computer is restarted. */
export const UNREACHABLE_MS = 2 * 60_000;
/** The same, for a computer that hasn't answered yet (core just started, or right after a repair). */
export const FIRST_CONNECT_MS = 6 * 60_000;
/** Least time between two repairs. */
export const REPAIR_GAP_MS = 15 * 60_000;
/** Repairs in a row without the link coming back, before giving up until it does (or the user steps in). */
export const MAX_REPAIRS = 2;
/** How often the watchdog looks. */
export const CHECK_EVERY_MS = 15_000;

export interface WatchdogDeps {
  now(): number;
  /** Core's link to agentd is up. */
  connected(): boolean;
  /**
   * Yo's computer should be running and nothing is changing it right now: core started it (runtime "running"),
   * it isn't starting / updating / being repaired, and the first-run setup is done.
   */
  shouldBeRunning(): boolean;
  /** Restart the VM and the computer (ComputerLifecycle.repair). Rejects when that didn't work. */
  repair(): Promise<void>;
}

export class ComputerWatchdog {
  private downSince: number | null = null;
  private lastRepairAt: number | null = null;
  private repairsInARow = 0;
  private repairing = false;
  /** agentd answered since Yo started or since the last repair (so a slow boot gets FIRST_CONNECT_MS). */
  private seenConnected = false;

  constructor(private d: WatchdogDeps) {}

  /** One look. Returns true when it started a repair (tests). */
  check(): boolean {
    if (this.repairing) return false;
    const now = this.d.now();
    if (this.d.connected()) {
      if (this.repairsInARow) log.info("Yo's computer is reachable again");
      this.downSince = null;
      this.repairsInARow = 0;
      this.seenConnected = true;
      return false;
    }
    if (!this.d.shouldBeRunning()) {
      this.downSince = null;
      return false;
    }
    this.downSince ??= now;
    if (now - this.downSince < (this.seenConnected ? UNREACHABLE_MS : FIRST_CONNECT_MS)) return false;
    if (this.repairsInARow >= MAX_REPAIRS) return false;
    if (this.lastRepairAt != null && now - this.lastRepairAt < REPAIR_GAP_MS) return false;
    this.lastRepairAt = now;
    this.repairsInARow++;
    this.repairing = true;
    log.warn(
      `Yo's computer has been unreachable for ${Math.round((now - this.downSince) / 1000)}s; restarting it (repair ${this.repairsInARow} of ${MAX_REPAIRS})`,
    );
    void this.d
      .repair()
      .then(
        () => log.info("Yo's computer restarted after it stopped answering"),
        (err) => log.warn("restarting Yo's computer didn't work", err),
      )
      .finally(() => {
        this.repairing = false;
        // Give the restarted computer the full (first-boot) wait again before judging it.
        this.downSince = null;
        this.seenConnected = false;
      });
    return true;
  }

  start(everyMs = CHECK_EVERY_MS): NodeJS.Timeout {
    const t = setInterval(() => this.check(), everyMs);
    t.unref();
    return t;
  }
}
