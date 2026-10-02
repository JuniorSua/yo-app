import type { Routine } from "@yo/contracts";
import { Cron } from "croner";
import type { Store } from "../db/store";
import type { Hub } from "../hub";
import { logger } from "../log";

const log = logger("scheduler");

/** Missed runs older than this (e.g. Mac was asleep all day) are skipped instead of caught up. */
export const CATCHUP_WINDOW_MS = 6 * 60 * 60 * 1000;

export function nextRun(r: Pick<Routine, "cron" | "runAt" | "timezone">, after = new Date()): number | null {
  if (r.cron) {
    try {
      const next = new Cron(r.cron, { timezone: r.timezone, paused: true }).nextRun(after);
      return next ? next.getTime() : null;
    } catch {
      return null;
    }
  }
  if (r.runAt && r.runAt > after.getTime()) return r.runAt;
  return null;
}

export function validateCron(expr: string): string | null {
  try {
    new Cron(expr, { paused: true });
    return null;
  } catch (err: any) {
    return err?.message ?? "Invalid cron expression";
  }
}

export type FireFn = (routine: Routine) => Promise<void>;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private fire: FireFn = async () => {};

  constructor(
    private store: Store,
    private hub: Hub,
  ) {}

  setFire(fn: FireFn) {
    this.fire = fn;
  }

  start(intervalMs = 15000) {
    this.recoverInterrupted();
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  create(input: {
    agentId: string;
    name: string;
    prompt: string;
    cron: string | null;
    runAt: number | null;
  }): Routine {
    if (!input.prompt.trim()) throw new Error("prompt is required");
    if (!input.cron && !input.runAt) throw new Error("Provide a cron schedule or a runAt time");
    if (input.cron) {
      const err = validateCron(input.cron);
      if (err) throw new Error(`Invalid schedule: ${err}`);
    }
    const timezone = this.store.getSettings().timezone;
    const r = this.store.createRoutine({
      agentId: input.agentId,
      name: input.name,
      prompt: input.prompt,
      cron: input.cron,
      runAt: input.runAt,
      timezone,
      enabled: true,
      nextRunAt: nextRun({ cron: input.cron, runAt: input.runAt, timezone }),
    });
    this.hub.push("routine.updated", r);
    this.store.addActivity({
      agentId: r.agentId,
      kind: "routine",
      summary: `Routine created: ${r.name}`,
      ref: r.id,
    });
    return r;
  }

  update(id: string, patch: Partial<Pick<Routine, "name" | "prompt" | "cron" | "enabled">>): Routine {
    const cur = this.store.getRoutine(id);
    if (!cur) throw new Error("Unknown routine");
    if (patch.cron) {
      const err = validateCron(patch.cron);
      if (err) throw new Error(`Invalid schedule: ${err}`);
    }
    const merged = { ...cur, ...patch };
    const r = this.store.updateRoutine(id, { ...patch, nextRunAt: merged.enabled ? nextRun(merged) : null })!;
    this.hub.push("routine.updated", r);
    return r;
  }

  remove(id: string) {
    this.store.deleteRoutine(id);
    this.hub.push("routine.removed", { id });
  }

  async runNow(id: string) {
    const r = this.store.getRoutine(id);
    if (!r) throw new Error("Unknown routine");
    await this.fireRoutine(r, Date.now(), Date.now());
  }

  /**
   * A run claimed but never handed to the agent means core stopped in between. We can't know whether the
   * agent saw it, so we say so instead of firing it a second time.
   */
  private recoverInterrupted() {
    for (const run of this.store.claimedRoutineRuns()) {
      this.store.setRoutineRunStatus(
        run.routineId,
        run.scheduledFor,
        "interrupted",
        "Yo restarted before it started",
      );
      const r = this.store.getRoutine(run.routineId);
      if (r)
        this.store.addActivity({
          agentId: r.agentId,
          kind: "routine",
          summary: `Routine didn't start (Yo restarted): ${r.name}`,
          ref: r.id,
        });
    }
  }

  /** Visible for tests. */
  tick(now = Date.now()) {
    for (const r of this.store.listRoutines()) {
      if (!r.enabled) continue;
      if (r.nextRunAt == null) {
        const n = nextRun(r, new Date(now));
        if (n) this.hub.push("routine.updated", this.store.updateRoutine(r.id, { nextRunAt: n })!);
        continue;
      }
      if (r.nextRunAt > now) continue;
      if (now - r.nextRunAt > CATCHUP_WINDOW_MS) {
        log.info(`skipping stale run of ${r.name}`);
        const n = nextRun(r, new Date(now));
        this.hub.push(
          "routine.updated",
          this.store.updateRoutine(r.id, { nextRunAt: n, enabled: n != null ? r.enabled : false })!,
        );
        continue;
      }
      void this.fireRoutine(r, r.nextRunAt, now);
    }
  }

  private async fireRoutine(r: Routine, scheduledFor: number, now: number) {
    // One row per occurrence, written before the schedule advances: a duplicate tick or a second core
    // process loses the insert and never fires the same occurrence twice.
    if (!this.store.claimRoutineRun(r.id, scheduledFor, now)) {
      log.info(`occurrence of ${r.name} at ${new Date(scheduledFor).toISOString()} already claimed`);
      return;
    }
    const n = r.cron ? nextRun(r, new Date(now + 1000)) : null;
    const updated = this.store.updateRoutine(r.id, {
      lastRunAt: now,
      nextRunAt: n,
      enabled: r.cron ? r.enabled : false,
    })!;
    this.hub.push("routine.updated", updated);
    this.store.addActivity({
      agentId: r.agentId,
      kind: "routine",
      summary: `Routine ran: ${r.name}`,
      ref: r.id,
    });
    try {
      await this.fire(r);
      this.store.setRoutineRunStatus(r.id, scheduledFor, "dispatched", null);
    } catch (err: any) {
      this.store.setRoutineRunStatus(r.id, scheduledFor, "failed", String(err?.message ?? err).slice(0, 500));
      log.warn(`routine ${r.name} failed to fire`, err);
    }
  }
}
