/**
 * What an update looks like while it's applied (updates.apply): a bar that fills over APPLY_MIN_MS and words
 * that move from "Installing Yo 0.1.N…" to "Restarting Yo…". The download already happened in the background,
 * so without this a Restart would be a blink. Shared by the update button, the update card, the pill and
 * Settings, so every way in looks the same.
 */
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { APPLY_MIN_MS, type Applying, SERVER_APPLY_MS, useUpdates } from "../stores/updates";

/** The words switch to "Restarting…" once this share of the bar has filled. */
const LATE_AT = 0.7;

/** How long the bar takes to fill: a server update (backup, swap, health check) takes much longer. */
export function applyDuration(applying: Applying) {
  return applying.kind === "server" ? SERVER_APPLY_MS : APPLY_MIN_MS;
}

export function useApplying() {
  return useUpdates((s) => s.applying);
}

/** True once most of the bar has filled. */
export function useApplyLate(applying: Applying | null) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!applying) {
      setLate(false);
      return;
    }
    const left = applyDuration(applying) * LATE_AT - (Date.now() - applying.startedAt);
    if (left <= 0) {
      setLate(true);
      return;
    }
    setLate(false);
    const t = setTimeout(() => setLate(true), left);
    return () => clearTimeout(t);
  }, [applying]);
  return late;
}

export function applyCopy(applying: Applying, late: boolean) {
  if (applying.kind === "server")
    return late
      ? { title: "Almost there…", short: "Updating…", line: "Yo reloads by itself when it's back." }
      : { title: "Updating Yo…", short: "Updating…", line: "Yo will be back in about 30 seconds." };
  if (applying.kind === "restart")
    return late
      ? { title: "Restarting Yo…", short: "Restarting…", line: "Back in a moment." }
      : {
          title: applying.version ? `Installing Yo ${applying.version}…` : "Installing the update…",
          short: "Installing…",
          line: "Yo restarts when it's done.",
        };
  return late
    ? { title: "Loading the new version…", short: "Loading…", line: "Back in a moment." }
    : { title: "Updating Yo…", short: "Updating…", line: "Getting the new version ready." };
}

/**
 * How far along the bar is now (0-1) and how long it has left, fixed when it mounts, so it picks up where it
 * should be if it appears mid-way (say the popover opens again).
 */
export function useApplyFill(applying: Applying) {
  const [start] = useState(() => {
    const total = applyDuration(applying);
    const elapsed = Math.min(total, Math.max(0, Date.now() - applying.startedAt));
    return { from: elapsed / total, ms: total - elapsed };
  });
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    // Two frames: the first paints the starting width, the second starts the transition from it.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setFilled(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);
  // A server update ends when the updater says so, not on a clock: its bar stops just short of full.
  const end = applying.kind === "server" ? 0.92 : 1;
  return {
    fraction: (filled ? 1 : start.from) * end,
    transition: filled ? `${start.ms}ms cubic-bezier(0.3, 0.6, 0.4, 1)` : "none",
  };
}

export function ApplyBar({ applying, className }: { applying: Applying; className?: string }) {
  const { fraction, transition } = useApplyFill(applying);
  return (
    <div
      data-testid="update-progress"
      role="progressbar"
      aria-label="Installing the update"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      className={cn("h-1.5 overflow-hidden rounded-full bg-active", className)}
    >
      <div
        className="h-full rounded-full bg-brand"
        style={{
          width: `${fraction * 100}%`,
          transition: transition === "none" ? "none" : `width ${transition}`,
        }}
      />
    </div>
  );
}
