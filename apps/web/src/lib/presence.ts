import { type AgentView, isLead, type TimelineEntry } from "@yo/contracts";

/** What an assistant is up to, in a few words: the chat header and Today's "Now" rows. */
export type PresenceTone = "working" | "waiting" | "sleeping" | "idle" | "done" | "error" | "control";

/** Yo's one-off helpers that are still busy (their own names never show outside Yo's chat). */
export function activeHelpers(agents: Record<string, AgentView>, parentId: string): AgentView[] {
  return Object.values(agents).filter(
    (a) =>
      a.kind === "helper" &&
      a.parentId === parentId &&
      !a.archivedAt &&
      (a.activity === "working" || a.activity === "waiting"),
  );
}

/** Title of the step running right now in the current turn ("Opened amazon.com"), or "". */
export function runningStep(entries: readonly TimelineEntry[] | undefined): string {
  if (!entries) return "";
  for (let i = entries.length - 1; i >= 0; i--) {
    const { kind, status, title } = entries[i]!.item;
    if (kind === "user_message") return "";
    if (status === "running" && title && kind !== "todo" && kind !== "notice") return title;
  }
  return "";
}

/** The most recent things the user asked Yo (newest first), for the palette's "Recent requests". */
export function recentRequests(entries: readonly TimelineEntry[] | undefined, limit = 5): TimelineEntry[] {
  return (entries ?? [])
    .filter((e) => e.item.kind === "user_message" && !e.item.from && e.item.text)
    .slice(-limit)
    .reverse();
}

export function presenceTone(agent: AgentView): PresenceTone {
  if (agent.computer.lease === "user") return "control";
  if (agent.activity === "sleeping") return "sleeping";
  if (agent.activity === "idle" && (agent.computer.state === "hibernated" || agent.computer.state === "off"))
    return "sleeping";
  return agent.activity;
}

const plural = (n: number, one: string) => (n === 1 ? `1 ${one}` : `${n} ${one}s`);

/** One calm line under the assistant's name: what it's doing right now. */
export function presenceLine({
  agent,
  tone,
  step,
  helpers,
  waitingOn,
  asking,
}: {
  agent: AgentView;
  tone: PresenceTone;
  /** Title of the step running now (runningStep). */
  step: string;
  helpers: AgentView[];
  /** Title of the first request waiting for the user's OK, if any. */
  waitingOn?: string;
  /** That request is a question (an answer is wanted), not an approval. */
  asking?: boolean;
}): string {
  const inProgress = agent.todos.find((t) => t.status === "in_progress")?.text;
  const helperLine = helpers.length
    ? `${plural(helpers.length, "helper")} working${helpers[0]?.preview ? ` · ${helpers[0].preview}` : ""}`
    : "";
  switch (tone) {
    case "control":
      return "You have his computer. He’s paused until you hand it back";
    case "waiting":
      return waitingOn
        ? `${asking ? "Waiting for your answer" : "Waiting for your OK"} · ${waitingOn}`
        : "Waiting for your answer in the chat";
    case "error":
      return agent.preview || "Something went wrong. Ask again, or check Settings";
    case "working": {
      // A raw shell command ("Running `ls ~/Downloads`…") stays behind the steps: the plan's words, or plain ones.
      const calm = step.includes("`") ? inProgress || agent.statusLine || "Running a command" : step;
      return calm || inProgress || agent.statusLine || helperLine || "Working on your request";
    }
    case "sleeping":
      return helperLine || "Resting. He wakes up when you ask for something";
    case "done":
      return helperLine || "Finished. Have a look below";
    default:
      return helperLine || (isLead(agent) ? "Ready when you are" : agent.role);
  }
}
