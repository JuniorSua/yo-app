import {
  briefFromInput,
  exchangeIdIn,
  type MorningBrief,
  readReplies,
  type TimelineEntry,
} from "@yo/contracts";
import { bugCall, outputText } from "./bugFields";
import { isTeamEntry } from "./team";

export type Block =
  | { type: "user"; key: string; entry: TimelineEntry }
  | { type: "assistant"; key: string; entry: TimelineEntry }
  | { type: "group"; key: string; entries: TimelineEntry[] }
  | { type: "todo"; key: string; entry: TimelineEntry }
  | { type: "request"; key: string; entry: TimelineEntry }
  | { type: "artifact"; key: string; entry: TimelineEntry }
  /** A Page the agent made (create_page): a live preview that opens in the page viewer. */
  | { type: "page"; key: string; entry: TimelineEntry; artifactId: string }
  | { type: "bug"; key: string; entry: TimelineEntry; bug: BugInfo }
  /** The morning brief (post_brief): a card with Needs you (each with Start), Can wait, Today and Couldn't check. */
  | { type: "brief"; key: string; entry: TimelineEntry; brief: MorningBrief }
  /**
   * An agent-to-agent exchange (message_agent): one quiet row, not a tool step. `reply`: the teammate's answer
   * that came back later as its own message (async handoff), folded into the row instead of shown on its own.
   */
  | { type: "team"; key: string; entry: TimelineEntry; reply?: TimelineEntry }
  /** One of Yo's one-off helpers (`hcard_<helperId>`): its progress, controls and result. */
  | { type: "helper"; key: string; entry: TimelineEntry }
  | { type: "notice"; key: string; entry: TimelineEntry };

const ACTIVITY_KINDS = new Set(["reasoning", "command", "file_change", "tool", "browser", "web"]);

/** A helper card core keeps up to date in the parent's timeline. */
export function isHelperEntry(e: TimelineEntry) {
  return !!e.item.helper;
}

export function isArtifactEntry(e: TimelineEntry) {
  return e.item.kind === "tool" && !!e.item.toolName && /(^|__)save_artifact$/.test(e.item.toolName);
}

/** A finished create_page call: the Page's artifact id (from its result), else null (still running or failed). */
export function pageArtifactId(e: TimelineEntry): string | null {
  if (e.item.kind !== "tool" || !e.item.toolName || !/(^|__)create_page$/.test(e.item.toolName)) return null;
  if (e.item.status === "failed") return null;
  return /\[page:([A-Za-z0-9_-]+)\]/.exec(outputText(e.item.output))?.[1] ?? null;
}

const isTool = (e: TimelineEntry, name: string) =>
  e.item.kind === "tool" && !!e.item.toolName && new RegExp(`(^|__)${name}$`).test(e.item.toolName);

/** A finished post_brief call: the brief its card shows (read from the call), else null (running or refused). */
export function briefOf(e: TimelineEntry): MorningBrief | null {
  if (!isTool(e, "post_brief") || e.item.status !== "completed") return null;
  return briefFromInput(e.item.input);
}

/** A finished suggest_replies call: the replies core accepted, else null (running or refused). */
export function repliesOf(e: TimelineEntry): string[] | null {
  if (!isTool(e, "suggest_replies") || e.item.status !== "completed") return null;
  const r = readReplies(e.item.input);
  return "replies" in r ? r.replies : null;
}

/** The user's own message (not a teammate's). */
const fromUser = (e: TimelineEntry) => e.item.kind === "user_message" && !e.item.from;

/** Quick replies to draw, and where: before the user message that answered them, or at the end (`before` null). */
export interface ReplyChipsAt {
  entryId: string;
  replies: string[];
  before: string | null;
  /** The reply the user tapped (shown chosen, the others greyed out), else null: the chips can be tapped. */
  chosen: string | null;
}

/**
 * The quick replies (suggest_replies) of the latest turn only. Once the user says anything else they're gone;
 * a tapped reply (`tapped`) stays chosen under its question until the agent starts answering it.
 */
export function replyChipsAt(
  entries: TimelineEntry[],
  tapped: { entryId: string; text: string } | null = null,
): ReplyChipsAt | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const replies = repliesOf(e);
    if (!replies) continue;
    const rest = entries.slice(i + 1);
    const answer = rest.findIndex(fromUser);
    if (answer < 0) {
      // A newer task (a routine, a teammate's message) moved on from the question.
      if (rest.some((x) => x.turnId && x.turnId !== e.turnId)) return null;
      return { entryId: e.id, replies, before: null, chosen: null };
    }
    const said = rest[answer]!;
    if (tapped?.entryId !== e.id || said.item.text !== tapped.text) return null;
    if (rest.slice(answer + 1).some((x) => x.item.kind === "assistant_message" || fromUser(x))) return null;
    return { entryId: e.id, replies, before: said.id, chosen: tapped.text };
  }
  return null;
}

export function isBugReportEntry(e: TimelineEntry) {
  return e.item.kind === "tool" && !!e.item.toolName && /(^|__|[./:])report_bug$/.test(e.item.toolName);
}

/** Where a report_bug call is in the flow: a draft shown to the user, or the submit after their OK. */
export interface BugInfo {
  stage: "draft" | "submit";
  draftId: string | null;
  /** Submit: the draft it sends (for its content). Draft: the submit that sent it, if any. */
  related: TimelineEntry | null;
  /** Draft: the user has written since (clicked a quick reply or typed an answer). */
  answered: boolean;
  /** Draft: the newest draft in this conversation. Only it offers the quick replies. */
  latest: boolean;
}

export function bugStage(e: TimelineEntry): BugInfo["stage"] {
  const input = bugCall(e.item.input);
  if (input.stage) return input.stage;
  if (input.draft_id) return "submit";
  // PR #20's reports had no stage and were saved straight away.
  return /\[artifact:/.test(outputText(e.item.output)) ? "submit" : "draft";
}

export function bugDraftId(e: TimelineEntry): string | null {
  if (bugStage(e) === "submit") return bugCall(e.item.input).draft_id ?? null;
  return /\[bug-draft:([A-Za-z0-9_]+)\]/.exec(outputText(e.item.output))?.[1] ?? null;
}

/** Links each draft with its submit and the user's reply. */
function bugInfos(entries: TimelineEntry[]): Map<string, BugInfo> {
  const out = new Map<string, BugInfo>();
  const drafts = new Map<string, TimelineEntry>();
  let lastDraft: string | null = null;
  for (const e of entries) {
    // A teammate's message isn't the user answering the draft.
    if (e.item.kind === "user_message" && !e.item.from) {
      for (const info of out.values()) if (info.stage === "draft") info.answered = true;
      continue;
    }
    if (!isBugReportEntry(e)) continue;
    const stage = bugStage(e);
    const draftId = bugDraftId(e);
    const info: BugInfo = { stage, draftId, related: null, answered: false, latest: false };
    if (stage === "draft") {
      // Only a draft core accepted (it has an id) can be answered.
      if (draftId && e.item.status === "completed") {
        drafts.set(draftId, e);
        lastDraft = e.id;
      }
    } else if (draftId && drafts.has(draftId)) {
      const draft = drafts.get(draftId)!;
      info.related = draft;
      if (e.item.status === "completed") out.get(draft.id)!.related = e;
    }
    out.set(e.id, info);
  }
  if (lastDraft) out.get(lastDraft)!.latest = true;
  return out;
}

/** The message_agent exchange a team entry started (async handoffs name one in their result), else null. */
export function teamExchangeId(e: TimelineEntry): string | null {
  return isTeamEntry(e) ? exchangeIdIn(outputText(e.item.output)) : null;
}

/**
 * Teammates' replies to this chat's own handoffs, by exchange id: each folds into its "2 messages with Dew" row.
 * Only replies whose handoff is in these entries (an older one stays a message of its own).
 */
export function foldedReplies(entries: TimelineEntry[]): Map<string, TimelineEntry> {
  const asked = new Set<string>();
  const out = new Map<string, TimelineEntry>();
  for (const e of entries) {
    const id = teamExchangeId(e);
    if (id) asked.add(id);
    const from = e.item.kind === "user_message" ? e.item.from : undefined;
    if (from?.reply && from.exchangeId && asked.has(from.exchangeId) && !out.has(from.exchangeId))
      out.set(from.exchangeId, e);
  }
  return out;
}

/** Collapse a flat, seq-ordered timeline into renderable blocks (tool steps are grouped). */
export function toBlocks(entries: TimelineEntry[]): Block[] {
  const out: Block[] = [];
  let group: TimelineEntry[] | null = null;
  const bugs = bugInfos(entries);
  const replies = foldedReplies(entries);
  const folded = new Set([...replies.values()]);
  const flush = () => {
    if (group?.length) out.push({ type: "group", key: `g_${group[0]!.id}`, entries: group });
    group = null;
  };
  for (const e of entries) {
    const k = e.item.kind;
    if (e.request) {
      flush();
      out.push({ type: "request", key: e.id, entry: e });
    } else if (isHelperEntry(e)) {
      flush();
      out.push({ type: "helper", key: e.id, entry: e });
    } else if (briefOf(e)) {
      flush();
      out.push({ type: "brief", key: e.id, entry: e, brief: briefOf(e)! });
    } else if (repliesOf(e)) {
      // Drawn as chips under the turn's last message (replyChipsAt), not as a step.
    } else if (pageArtifactId(e)) {
      flush();
      out.push({ type: "page", key: e.id, entry: e, artifactId: pageArtifactId(e)! });
    } else if (isArtifactEntry(e)) {
      flush();
      out.push({ type: "artifact", key: e.id, entry: e });
    } else if (isBugReportEntry(e)) {
      flush();
      out.push({ type: "bug", key: e.id, entry: e, bug: bugs.get(e.id)! });
    } else if (folded.has(e)) {
      // Shown in its handoff's row.
    } else if (isTeamEntry(e)) {
      flush();
      const id = teamExchangeId(e);
      const reply = id ? replies.get(id) : undefined;
      out.push(reply ? { type: "team", key: e.id, entry: e, reply } : { type: "team", key: e.id, entry: e });
    } else if (ACTIVITY_KINDS.has(k)) {
      if (!group) group = [];
      group.push(e);
    } else {
      flush();
      if (k === "user_message") out.push({ type: "user", key: e.id, entry: e });
      else if (k === "assistant_message") out.push({ type: "assistant", key: e.id, entry: e });
      else if (k === "todo") out.push({ type: "todo", key: e.id, entry: e });
      else out.push({ type: "notice", key: e.id, entry: e });
    }
  }
  flush();
  return out;
}

/** Indexes of blocks in an agent response (the blocks between two user messages) that reports a bug. */
export function bugTurnBlocks(blocks: Block[]): Set<number> {
  const marked = new Set<number>();
  let start = 0;
  const close = (end: number) => {
    if (blocks.slice(start, end).some((b) => b.type === "bug"))
      for (let i = start; i < end; i++) marked.add(i);
  };
  blocks.forEach((b, i) => {
    if (b.type !== "user") return;
    close(i);
    start = i + 1;
  });
  close(blocks.length);
  return marked;
}

/** After this long on one request, the "still working" row says how to steer or stop. */
export const LONG_TURN_MS = 10 * 60_000;

/**
 * Whether the chat needs its own "still working" row while the agent is busy, and since when. Not needed while
 * something at the bottom already shows progress (a step running with its timer, a reply streaming in): only
 * when the agent is busy between steps, or before its first one, which otherwise looked frozen.
 */
export function workingRow(blocks: Block[]): { since: number | null } | null {
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  if (last.type === "group" && last.entries.some((e) => e.item.status === "running")) return null;
  if (last.type === "assistant" && last.entry.item.status === "running") return null;
  return { since: turnStart(blocks) };
}

/**
 * When the work now under way started, read from the chat (a fallback: the app's own record of when the agent
 * became busy wins, see `workingSince`). Messages to an agent have no turn; what it does in reply carries one.
 * The current turn is the newest one, unless messages came after it and nothing of it is still running: then
 * the agent has moved on to those, and the clock starts at the first of them. A turn starts at the message
 * that set it off. So a steer, a queued follow-up or a teammate's note sent mid-turn doesn't reset the clock.
 */
export function turnStart(blocks: Block[]): number | null {
  const entries = blocks.flatMap((b) => (b.type === "group" ? b.entries : [b.entry]));
  if (!entries.length) return null;
  let lastOfTurn = -1;
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i]!.turnId) {
      lastOfTurn = i;
      break;
    }
  const turnId = lastOfTurn >= 0 ? entries[lastOfTurn]!.turnId : null;
  const stillRunning = !!turnId && entries.some((e) => e.turnId === turnId && e.item.status === "running");
  // Messages after the newest turn that the agent has (or will have) moved on to.
  if (!stillRunning) {
    const waiting = entries.slice(lastOfTurn + 1).find((e) => e.item.kind === "user_message");
    if (waiting) return waiting.createdAt || null;
  }
  if (!turnId) return null;
  const first = entries.findIndex((e) => e.turnId === turnId);
  const trigger = entries[first - 1];
  const start =
    trigger && !trigger.turnId && trigger.item.kind === "user_message" ? trigger : entries[first]!;
  return start.createdAt || null;
}

/** A pause this long between two messages starts a new stretch of the chat, with its time over it. */
export const TIME_BREAK_MS = 30 * 60_000;

const startOf = (b: Block) => (b.type === "group" ? b.entries[0]! : b.entry).createdAt;
const endOf = (b: Block) => (b.type === "group" ? b.entries[b.entries.length - 1]! : b.entry).createdAt;

/**
 * Which blocks get a time over them ("Today 9:41 AM"), as in a messaging app: the first one, then any that
 * comes after a long pause or on a new day. Blocks without a time are skipped.
 */
export function timeBreaks(blocks: Block[]): Set<number> {
  const out = new Set<number>();
  let last = 0;
  blocks.forEach((b, i) => {
    const at = startOf(b);
    if (!at) return;
    if (!last || at - last >= TIME_BREAK_MS || new Date(at).toDateString() !== new Date(last).toDateString())
      out.add(i);
    last = Math.max(last, endOf(b) || at);
  });
  return out;
}
