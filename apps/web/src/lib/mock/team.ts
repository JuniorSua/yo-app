/**
 * The team in mock mode: async handoffs between agents, a new teammate's hello, and the older consolidation.
 *
 * Chat keywords (said to any agent, naming a teammate):
 *   "ask Dew to research X" (or "ask / check with / tell / message <teammate> …")
 *             an async handoff, like core's message_agent: a "Messaged Dew" row at once ("Sent to Dew … (exchange
 *             xch_…)") and the asker carries on. Dew works on it in its own chat (the roster shows Dew working),
 *             then its reply lands in the asker's chat as a message from Dew (`from.reply`, same exchange id)
 *             a few seconds later in fast mode, and the asker sums it up.
 *   "… and wait"
 *             message_agent with wait: true: the row waits for Dew, then shows the reply inline.
 * A teammate made with `introduce: true` (the New agent dialog, or "add … agent named X") starts at once: it says
 * hello and asks one multiple-choice question about its job.
 *
 * Consolidation: `team.consolidatePlan` / `team.consolidate` (the 0.1 "Yo is now one assistant" dialog). Yo 2's
 * core never offers anyone, and neither does the mock unless asked. `&mockConsolidate=…` picks the team:
 *   (absent)  no dialog: the plan is always empty, so the other scenarios and screenshots are untouched
 *   1         the usual extra agents are consolidation candidates, plus Pepe, who is never offered (the owner
 *             hands him over by hand)
 *   solo      only Yo and Pip, the Work and Personal agents (a new user, or the owner's friend): nothing to
 *             consolidate
 *   fail      like 1, but the first attempt can't copy the files (Yo's computer is off) and the second works
 */
import type {
  AgentView,
  ConsolidationAgentResult,
  ConsolidationPlan,
  ConsolidationResult,
  Memory,
  Routine,
  UserQuestion,
} from "@yo/contracts";
import type { SeedState } from "./data";

/* ---------------------------------------- async handoffs ---------------------------------------- */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The teammate a message asks for ("ask Dew to…"), by whole name; never the speaker, a helper or archived. */
export function handoffTarget(
  text: string,
  agents: readonly AgentView[],
  selfId: string,
): AgentView | undefined {
  if (!/\b(ask|check with|tell|message)\b/i.test(text)) return undefined;
  return agents.find(
    (a) =>
      a.id !== selfId &&
      a.kind !== "helper" &&
      !a.archivedAt &&
      new RegExp(`\\b${escapeRe(a.name)}\\b`, "i").test(text),
  );
}

/** "… and wait": message_agent with wait: true. */
export const handoffWaits = (text: string) => /\band wait\b/i.test(text);

/** What to hand over: "ask Dew to research flights to Lisbon" → "research flights to Lisbon". */
export function handoffTopic(text: string, teammate: string): string {
  return text
    .replace(/^.*?\b(ask|check with|tell|message)\b\s*(the\s+)?/i, "")
    .replace(new RegExp(`^${escapeRe(teammate)}\\s*(about|whether|if|to)?\\s*`, "i"), "")
    .replace(/\s*\band wait\b/i, "")
    .replace(/[?.!]+$/, "")
    .trim();
}

const VERB = /^(research|find|look into|check|compare|draft|write|build|get|book|plan|price)\b/i;

/** The topic without its verb, for the replies ("research flights to Lisbon" → "flights to Lisbon"). */
const subject = (topic: string) => topic.replace(VERB, "").trim() || topic || "that";

/** The message the asker writes to its teammate: self-contained, one ask. */
export function handoffMessage(teammate: string, topic: string): string {
  const ask = VERB.test(topic) ? topic : `look into ${topic || "this"}`;
  return `Hi ${teammate}! Could you ${ask} for me? A short answer with anything that's still open is perfect.`;
}

/** Core's message_agent answer for an async handoff (see Orchestrator.messageAgent). */
export function handoffAck(teammate: string, exchangeId: string, busy: boolean): string {
  const now = busy ? ` ${teammate} is busy with another task, so yours is next in line.` : "";
  return `Sent to ${teammate}.${now} Carry on with your own work: their reply comes to you as a new message when they finish. (exchange ${exchangeId})`;
}

/** What the asker tells the user right after handing it over. */
export const handoffSaid = (teammate: string) =>
  `I've handed this to ${teammate}. I'll tell you what ${teammate} finds.`;

/** The teammate's reply (its final message, which goes back to the asker). */
export function handoffReply(topic: string): string {
  return `Here's what I found on ${subject(topic)}:\n\n- **Best pick:** confirmed, with times and prices checked today.\n- **Worth knowing:** two of the options book up by Thursday.\n- **Still open:** one small follow-up, which I've noted for Friday.`;
}

/** The asker's one-line summary once the reply comes in. */
export const handoffSummary = (teammate: string, topic: string) =>
  `${teammate} got back to me on ${subject(topic)}: the best pick is confirmed, and one small follow-up is left for Friday.`;

/** A new teammate's hello, its one question about the job, and what it says once answered. */
export function teammateHello(a: Pick<AgentView, "name" | "role">): {
  hello: string;
  question: UserQuestion;
  next: (answer: string) => string;
} {
  const role = a.role.trim();
  const job = role.toLowerCase();
  const options = /research/.test(job)
    ? ["Prices and deals", "Places and venues", "News in your field"]
    : /build|code|site/.test(job)
      ? ["Your website", "Small tools and scripts", "Fixing what's broken"]
      : /inbox|mail/.test(job)
        ? ["Reply drafts", "Sorting and labels", "A daily summary"]
        : /writ/.test(job)
          ? ["Emails and messages", "Posts and articles", "Docs and notes"]
          : ["Errands and bookings", "Keeping track of things", "Research"];
  return {
    hello: `Hi, I'm ${a.name}${role ? `, your ${role} teammate` : ""}! I work in my own chat and on my own screen, and I'll let Yo know when something's ready.`,
    question: {
      question: "What should I focus on first?",
      header: "First focus",
      options: options.map((label) => ({ label })),
      multiSelect: false,
    },
    next: (answer) => `Got it: ${answer.toLowerCase()} first. I've saved that, and I'm ready when you are.`,
  };
}

/* ----------------------------------------- consolidation ----------------------------------------- */

export type MockConsolidate = "off" | "on" | "solo" | "fail";

export function mockConsolidateScenario(q: URLSearchParams): MockConsolidate {
  const v = q.get("mockConsolidate");
  return v === "1" ? "on" : v === "solo" || v === "fail" ? v : "off";
}

/** Agents the owner hands over by hand, like core's `settings.consolidateSkip`. */
const SKIP = ["pepe"];

export class MockTeam {
  /** Test hook: how many times the dialog's "Move everything" asked core to consolidate. */
  consolidateCalls = 0;
  private failures = 0;

  constructor(
    readonly scenario: MockConsolidate,
    private s: SeedState,
    private emit: {
      removed: (id: string) => void;
      memory: (m: Memory) => void;
      routine: (r: Routine) => void;
    },
  ) {
    // Core still creates Pip for a new user, so "solo" keeps the Work and Personal agents.
    if (scenario === "solo") this.s.agents = this.s.agents.filter((a) => a.isPrimary || a.space);
    if (scenario === "fail") this.failures = 1;
    if (scenario === "on" || scenario === "fail") {
      const base = this.s.agents.find((a) => !a.isPrimary && !a.space && a.kind !== "helper");
      if (base)
        this.s.agents.push({
          ...base,
          id: "agt_pepe",
          name: "Pepe",
          role: "Works the desk",
          unread: 0,
          preview: null,
        });
    }
  }

  private candidates() {
    if (this.scenario === "off") return [];
    // Like core's Consolidator: the Work and Personal agents (Yo, Pip) are never folded in.
    return this.s.agents.filter((a) => !a.isPrimary && !a.space && !SKIP.includes(a.name.toLowerCase()));
  }

  plan(): ConsolidationPlan {
    const primary = this.s.agents.find((a) => a.isPrimary);
    return {
      primaryId: primary?.id ?? null,
      agents: this.candidates().map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        memories: this.s.memories.filter((m) => m.agentId === a.id).length,
        routines: this.s.routines.filter((r) => r.agentId === a.id).length,
      })),
    };
  }

  consolidate(agentIds: string[]): ConsolidationResult {
    this.consolidateCalls++;
    const primary = this.s.agents.find((a) => a.isPrimary)!;
    const wanted = new Set(this.candidates().map((a) => a.id));
    const agents: ConsolidationAgentResult[] = [];
    for (const id of new Set(agentIds)) {
      const a = this.s.agents.find((x) => x.id === id);
      if (!a || !wanted.has(id)) {
        agents.push({
          agentId: id,
          name: a?.name ?? "Unknown agent",
          status: "skipped",
          memories: 0,
          routines: 0,
          files: null,
        });
        continue;
      }
      if (this.failures > 0) {
        agents.push({
          agentId: id,
          name: a.name,
          status: "pending",
          memories: 0,
          routines: 0,
          files: null,
          error: "Yo's computer isn't running. Start it and try again.",
        });
        continue;
      }
      let memories = 0;
      for (const m of this.s.memories)
        if (m.agentId === id) {
          m.agentId = primary.id;
          memories++;
          this.emit.memory(m);
        }
      let routines = 0;
      for (const r of this.s.routines)
        if (r.agentId === id) {
          r.agentId = primary.id;
          routines++;
          this.emit.routine(r);
        }
      this.s.agents = this.s.agents.filter((x) => x.id !== id);
      this.emit.removed(id);
      agents.push({
        agentId: id,
        name: a.name,
        status: "done",
        memories,
        routines,
        files: { dir: `from-${a.name.replace(/\s+/g, "-")}`, copied: 12, skipped: 3, failed: 0 },
      });
    }
    if (agents.some((a) => a.status === "pending")) this.failures = 0;
    return { primaryId: primary.id, agents };
  }
}
