import type { TimelineEntry } from "@yo/contracts";
import { bugCall, outputText } from "./bugFields";

export type Block =
  | { type: "user"; key: string; entry: TimelineEntry }
  | { type: "assistant"; key: string; entry: TimelineEntry }
  | { type: "group"; key: string; entries: TimelineEntry[] }
  | { type: "todo"; key: string; entry: TimelineEntry }
  | { type: "request"; key: string; entry: TimelineEntry }
  | { type: "artifact"; key: string; entry: TimelineEntry }
  | { type: "bug"; key: string; entry: TimelineEntry; bug: BugInfo }
  | { type: "notice"; key: string; entry: TimelineEntry };

const ACTIVITY_KINDS = new Set(["reasoning", "command", "file_change", "tool", "browser", "web"]);

export function isArtifactEntry(e: TimelineEntry) {
  return e.item.kind === "tool" && !!e.item.toolName && /(^|__)save_artifact$/.test(e.item.toolName);
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
    if (e.item.kind === "user_message") {
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

/** Collapse a flat, seq-ordered timeline into renderable blocks (tool steps are grouped). */
export function toBlocks(entries: TimelineEntry[]): Block[] {
  const out: Block[] = [];
  let group: TimelineEntry[] | null = null;
  const bugs = bugInfos(entries);
  const flush = () => {
    if (group?.length) out.push({ type: "group", key: `g_${group[0]!.id}`, entries: group });
    group = null;
  };
  for (const e of entries) {
    const k = e.item.kind;
    if (e.request) {
      flush();
      out.push({ type: "request", key: e.id, entry: e });
    } else if (isArtifactEntry(e)) {
      flush();
      out.push({ type: "artifact", key: e.id, entry: e });
    } else if (isBugReportEntry(e)) {
      flush();
      out.push({ type: "bug", key: e.id, entry: e, bug: bugs.get(e.id)! });
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
