import type { TimelineEntry } from "@yo/contracts";
import type { Block } from "./blocks";

/** What the "N new messages" pill counts: the agent's replies, the morning brief, and cards that need the user. */
function isMessage(b: Block) {
  return b.type === "assistant" || b.type === "request" || b.type === "brief";
}

/**
 * How many replies and cards arrived since the user last saw the bottom of the chat (`seen` holds the keys of the
 * blocks that were there then). Counted by block, so a reply still streaming in counts once, not per word.
 */
export function countNewMessages(blocks: Block[], seen: ReadonlySet<string>): number {
  let n = 0;
  for (const b of blocks) if (isMessage(b) && !seen.has(b.key)) n++;
  return n;
}

/**
 * Whether a task left something to read. Core adds one unread per task (turn) that ended with a reply or an
 * error, but not for a quiet routine run (its reply became a notice) or a /compact (only its notice).
 */
function leftSomething(e: TimelineEntry) {
  if (e.item.kind === "assistant_message") return true;
  return e.item.kind === "notice" && e.item.status === "failed" && !e.id.startsWith("ntc_compact_");
}

/**
 * The block to draw the "New" line above when a chat opens with `unread` unread tasks: the start of the oldest of
 * the last `unread` tasks that left something to read. Null when there's nothing unread, or when the chat doesn't
 * hold that many tasks (older ones aren't loaded), so the line is never drawn in the wrong place.
 */
export function firstUnreadKey(blocks: Block[], unread: number): string | null {
  if (unread <= 0) return null;
  // Each turn's first block, in order, and the turns that left something to read.
  const starts = new Map<string, string>();
  const counted = new Set<string>();
  for (const b of blocks)
    for (const e of b.type === "group" ? b.entries : [b.entry]) {
      if (!e.turnId) continue;
      if (!starts.has(e.turnId)) starts.set(e.turnId, b.key);
      if (leftSomething(e)) counted.add(e.turnId);
    }
  const turns = [...starts.keys()].filter((t) => counted.has(t));
  if (turns.length < unread) return null;
  return starts.get(turns[turns.length - unread]!)!;
}
