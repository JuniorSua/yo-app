/**
 * Agent activity → creature pose. Pure (no `three`), shared by the renderer and the tests.
 * The mapping is written down in docs/avatars/CREATURES.md.
 */
import type { AgentActivity, ItemKind, TimelineEntry } from "@yo/contracts";
import type { CreatureId, CreaturePose } from "./meta";

/** What the client knows about the agent's current turn (from its timeline), when it has it loaded. */
export interface TurnInfo {
  /** A tool-like step (command, file change, tool, browser, web) is running right now. */
  toolRunning: boolean;
  /** Kind of the newest step of the current turn (after the last user message), or null if none yet. */
  lastKind: ItemKind | null;
}

/** Steps that mean "doing something on the computer" (the laptop), as opposed to reasoning or writing. */
const TOOL_KINDS: ReadonlySet<ItemKind> = new Set(["command", "file_change", "tool", "browser", "web"]);
/** Bookkeeping rows that don't say what the agent is doing (a plan stays "running" for the whole turn). */
const IGNORED_KINDS: ReadonlySet<ItemKind> = new Set(["todo", "notice"]);

export function turnInfo(entries: readonly TimelineEntry[] | undefined): TurnInfo | undefined {
  if (!entries) return undefined;
  let start = entries.length;
  while (start > 0 && entries[start - 1]!.item.kind !== "user_message") start--;
  let toolRunning = false;
  let lastKind: ItemKind | null = null;
  for (let i = start; i < entries.length; i++) {
    const { kind, status } = entries[i]!.item;
    if (IGNORED_KINDS.has(kind)) continue;
    if (TOOL_KINDS.has(kind) && status === "running") toolRunning = true;
    lastKind = kind;
  }
  return { toolRunning, lastKind };
}

export interface CreatureView {
  pose: CreaturePose;
  /** Yellow glow around the avatar: the agent needs you. */
  glow: boolean;
  /** Error badge (red dot). */
  error: boolean;
}

/**
 * - idle → idle (breathing) · done → done (polishes its laptop) · sleeping → sleeping eyes
 * - waiting → question pose + yellow glow
 * - error → question pose, no glow, red error badge
 * - working → working (laptop), or **thinking** (thought cloud) while the current turn has no tool step running
 *   and its newest step is reasoning, a streaming reply, or nothing yet. Between two tool steps it stays on
 *   the laptop, so it doesn't flicker. Without turn info (lists) it's always working.
 */
export function creatureState(activity: AgentActivity, turn?: TurnInfo): CreatureView {
  switch (activity) {
    case "waiting":
      return { pose: "question", glow: true, error: false };
    case "error":
      return { pose: "question", glow: false, error: true };
    case "working": {
      const thinking =
        !!turn &&
        !turn.toolRunning &&
        (turn.lastKind === null || turn.lastKind === "reasoning" || turn.lastKind === "assistant_message");
      return { pose: thinking ? "thinking" : "working", glow: false, error: false };
    }
    default:
      return { pose: activity, glow: false, error: false };
  }
}

/**
 * Frame rate of the live canvas. Breathing and dozing are slow, sub-pixel motions in a small avatar, so they
 * need far fewer frames than typing or polishing in a large one.
 */
export function liveFps(size: number, pose: CreaturePose): number {
  const calm = pose === "idle" || pose === "sleeping" || pose === "question";
  if (size < 64) return calm ? 8 : 15;
  return calm ? 20 : 30;
}

/** Snapshot sizes (device px). Each request is rounded up to one of these so lists share a handful of images. */
export const SNAPSHOT_BUCKETS = [48, 96, 160, 256] as const;

export function snapshotPx(cssSize: number, dpr = 1): number {
  const want = Math.ceil(cssSize * Math.min(Math.max(dpr, 1), 2));
  return SNAPSHOT_BUCKETS.find((b) => b >= want) ?? SNAPSHOT_BUCKETS[SNAPSHOT_BUCKETS.length - 1]!;
}

/** Cache key of a still picture: one per (creature, pose, size bucket), shared by every avatar that shows it. */
export function snapshotKey(kind: CreatureId, pose: CreaturePose, px: number): string {
  return `${kind}:${pose}:${px}`;
}
