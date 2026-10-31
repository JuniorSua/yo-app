import { type AgentView, agentForSpace, isLead, type Space } from "@yo/contracts";
import { sortAgents } from "../stores/app";
import { activeHelpers, presenceTone } from "./presence";

/** How a roster row reads: the words under the name and what the row shows beside it. */
export type RosterTone = "thinking" | "working" | "waiting" | "control" | "error" | "idle" | "asleep";

export interface RosterState {
  tone: RosterTone;
  /** One short line under the name: "Thinking…", "Working on Compare prices", "Waiting for you", "Idle", "Asleep". */
  line: string;
}

/**
 * The sidebar row's live state, in the same words everywhere (Dots-style): what it's doing now, never its last
 * message. Busy helpers count for the agent that started them (their own names stay inside its chat).
 */
export function rosterState(agent: AgentView, agents: Record<string, AgentView>): RosterState {
  const tone = presenceTone(agent);
  switch (tone) {
    case "control":
      return { tone: "control", line: "You have control" };
    case "waiting":
      return { tone: "waiting", line: "Waiting for you" };
    case "error":
      return { tone: "error", line: "Something went wrong" };
    case "working": {
      const task = agent.todos.find((t) => t.status === "in_progress")?.text;
      if (task) return { tone: "working", line: `Working on ${lowerFirst(task)}` };
      // What it's doing for another agent ("For Yo: checking flights"), when core says.
      if (agent.statusLine) return { tone: "working", line: agent.statusLine };
      return { tone: "thinking", line: "Thinking…" };
    }
    case "sleeping":
      return { tone: "asleep", line: "Asleep" };
    default: {
      const helpers = activeHelpers(agents, agent.id).length;
      if (helpers)
        return { tone: "working", line: helpers === 1 ? "1 helper working" : `${helpers} helpers working` };
      return { tone: "idle", line: "Idle" };
    }
  }
}

/** "Compare three stores" → "compare three stores" (keeps "MacBook", "AirPods" and other names as they are). */
function lowerFirst(text: string): string {
  const t = text.trim();
  return /^[A-Z][a-z]/.test(t) && !/^[A-Z][a-z]+[A-Z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

/**
 * The team in the sidebar: the space's main agent first (Yo in Work, Pip in Personal), then every teammate.
 * The other space's main agent is one switch away; helpers never join the roster.
 */
export function roster(
  agents: Record<string, AgentView>,
  space: Space,
  spacesAvailable: boolean,
): AgentView[] {
  const all = sortAgents(agents);
  if (!spacesAvailable) return all;
  const lead = agentForSpace(all, space, true);
  return all.filter((a) => a === lead || !isLead(a));
}
