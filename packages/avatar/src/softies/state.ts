/**
 * Agent activity → what a Softie shows. Pure (no React), shared by the renderer and the tests.
 * - idle: blinks now and then · done: one hop + sparkles · sleeping: closed eyes · error: still, red badge
 * - waiting → needs you: leans in once, amber glow + "!"
 * - working → working (a little satellite orbits it), or **thinking** (thought bubble) while the current turn has no
 *   tool step running and its newest step is reasoning, a streaming reply, or nothing yet. Between two tool steps
 *   it stays on working, so it doesn't flicker. Without loaded turn info it's always working.
 */
import type { AgentActivity, ItemKind, TimelineEntry } from "@yo/contracts";

export type SoftieState = "idle" | "thinking" | "working" | "needs" | "done" | "sleeping" | "error";

export const SOFTIE_STATES: readonly SoftieState[] = [
  "idle",
  "thinking",
  "working",
  "needs",
  "done",
  "sleeping",
  "error",
];

export const SOFTIE_STATE_LABEL: Record<SoftieState, string> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  needs: "Needs you",
  done: "Done",
  sleeping: "Asleep",
  error: "Error",
};

/** What the client knows about the agent's current turn (from its timeline), when it has it loaded. */
export interface TurnInfo {
  /** A tool-like step (command, file change, tool, browser, web) is running right now. */
  toolRunning: boolean;
  /** Kind of the newest step of the current turn (after the last user message), or null if none yet. */
  lastKind: ItemKind | null;
}

/** Steps that mean "doing something on the computer", as opposed to reasoning or writing. */
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

export function softieState(activity: AgentActivity, turn?: TurnInfo): SoftieState {
  switch (activity) {
    case "waiting":
      return "needs";
    case "working": {
      const thinking =
        !!turn &&
        !turn.toolRunning &&
        (turn.lastKind === null || turn.lastKind === "reasoning" || turn.lastKind === "assistant_message");
      return thinking ? "thinking" : "working";
    }
    default:
      return activity;
  }
}
