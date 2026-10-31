/** Work & Personal in the prompt: the space section, lead agents, memory heading, the message clock. */
import { DEFAULT_SETTINGS, type Memory, type Space } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { buildSystemAppend, messageClock, type PromptContext } from "./PromptBuilder";

const NOW = new Date("2026-10-13T19:00:00Z");
const mem = (content: string): Memory => ({
  id: "mem_1",
  agentId: null,
  content,
  createdAt: NOW.getTime(),
  updatedAt: NOW.getTime(),
});
const HOURS = "Mon–Fri 11:00 AM–7:00 PM";

function ctx(
  agent: { name: string; isPrimary: boolean; space?: Space | null },
  extra: Partial<PromptContext> = {},
): PromptContext {
  return {
    agent: { id: `agt_${agent.name}`, role: "", instructions: "", ...agent },
    team: [],
    settings: { ...DEFAULT_SETTINGS, userName: "Sam" },
    memories: [mem("Lives in Miami")],
    scratchpad: "",
    routines: [],
    priorConversation: [],
    now: NOW,
    ...extra,
  };
}

describe("the space section", () => {
  it("tells Pip it's the Personal agent, with Yo handling Work, and its priorities include improving Yo", () => {
    const p = buildSystemAppend(
      ctx(
        { name: "Pip", isPrimary: false, space: "personal" },
        { spaces: { hours: HOURS, counterpart: { name: "Yo", role: "your work assistant" } } },
      ),
    );
    expect(p).toContain("# Your space: Personal");
    expect(p).toContain(
      `You are Sam's Personal agent, for the time outside work hours (${HOURS}). Yo handles Work.`,
    );
    expect(p).toContain("hobbies and side projects");
    expect(p).toContain("`report_bug`");
    expect(p).toContain("for something that needs Yo's context, ask Yo with `message_agent`");
    expect(p).toContain("you're shown Personal and Everywhere facts");
    expect(p).toContain("everywhere for core facts about Sam");
    expect(p).toContain("# What you know about Sam (long-term memory: Personal and Everywhere)");
    // The space comes right after who the agent is.
    expect(p.indexOf("# Your space")).toBeLessThan(p.indexOf("# Your computer"));
  });

  it("tells Yo it's the Work agent, with Pip for Personal time", () => {
    const p = buildSystemAppend(
      ctx(
        { name: "Yo", isPrimary: true, space: "work" },
        { spaces: { hours: HOURS, counterpart: { name: "Pip", role: "your personal-time agent" } } },
      ),
    );
    expect(p).toContain(`You are Sam's Work agent, for Sam's work hours (${HOURS}). Pip handles Personal.`);
    expect(p).toContain("their job: projects, meetings, email, deadlines");
    expect(p).not.toContain("hobbies and side projects");
    expect(p).toContain("(long-term memory: Work and Everywhere)");
  });

  it("leaves out the counterpart when there is none", () => {
    const p = buildSystemAppend(
      ctx({ name: "Yo", isPrimary: true, space: "work" }, { spaces: { hours: HOURS, counterpart: null } }),
    );
    expect(p).toContain("# Your space: Work");
    expect(p).not.toContain("handles Personal");
    expect(p).not.toContain("'s context, ask");
  });

  it("isn't there with spaces off, even for an agent that has a space", () => {
    const off = buildSystemAppend(ctx({ name: "Yo", isPrimary: true, space: "work" }));
    const before = buildSystemAppend(ctx({ name: "Yo", isPrimary: true }));
    expect(off).toBe(before);
    expect(off).not.toContain("# Your space");
    expect(off).toContain("# What you know about Sam (long-term memory)\n");
  });
});

describe("a space's agent is a lead", () => {
  it("Pip gets what the main agent gets: helpers, playbooks, Yo Phone and the life map", () => {
    const p = buildSystemAppend(
      ctx(
        { name: "Pip", isPrimary: false, space: "personal" },
        { spaces: { hours: HOURS, counterpart: { name: "Yo", role: "" } } },
      ),
    );
    expect(p).toContain("You are Sam's main assistant.");
    expect(p).toContain("# Helpers");
    expect(p).toContain("# Playbooks");
    expect(p).toContain("# Yo Phone");
    expect(p).toContain("# Areas, goals and new agents");
    expect(p).not.toContain("# Teammates");
  });

  it("a plain teammate (Pepe) is not", () => {
    const p = buildSystemAppend(
      ctx(
        { name: "Pepe", isPrimary: false, space: null },
        { team: [{ name: "Yo", role: "", status: "idle", model: "Claude · Sonnet 5.5", main: true }] },
      ),
    );
    expect(p).not.toContain("main assistant");
    expect(p).toContain("# Your team\nYo is the main agent");
    expect(p).not.toContain("# Helpers");
    expect(p).not.toContain("# Your space");
  });
});

describe("messageClock", () => {
  it("says which time it is when spaces are on, and nothing more when they're off", () => {
    const at = new Date("2026-10-14T01:12:00Z");
    expect(messageClock(at, "America/New_York", "personal")).toBe(
      "[Tue, Oct 13, 2026, 9:12 PM · personal time]",
    );
    expect(messageClock(at, "America/New_York", "work")).toBe("[Tue, Oct 13, 2026, 9:12 PM · work time]");
    expect(messageClock(at, "America/New_York")).toBe("[Tue, Oct 13, 2026, 9:12 PM]");
  });
});
