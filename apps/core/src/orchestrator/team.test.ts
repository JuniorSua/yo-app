/** The team in the prompt: the `# Your team` roster, the teammate notes and a new teammate's first turn. */
import { DEFAULT_SETTINGS } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import {
  buildSystemAppend,
  type PromptContext,
  type TeamMember,
  teammateIntro,
  teammateNote,
  teamNewsLine,
} from "./PromptBuilder";

const NOW = new Date("2026-10-30T15:00:00Z");

const YO: TeamMember = {
  name: "Yo",
  role: "your work assistant",
  status: "idle",
  model: "Claude · Sonnet 5.5",
  main: true,
};
const DEW: TeamMember = {
  name: "Dew",
  role: "Research",
  status: "working",
  model: "ChatGPT · GPT-5.5",
  main: false,
};
const PICO: TeamMember = {
  name: "Pico",
  role: "Builder",
  status: "asleep",
  model: "Claude · Opus 5",
  main: false,
};

function ctx(agent: { name: string; role?: string; isPrimary: boolean }, team: TeamMember[]): PromptContext {
  return {
    agent: { id: `agt_${agent.name}`, role: "", instructions: "", space: null, ...agent },
    team,
    settings: { ...DEFAULT_SETTINGS, userName: "Sam" },
    memories: [],
    scratchpad: "",
    routines: [],
    priorConversation: [],
    now: NOW,
  };
}

/** One prompt section (sections are separated by a blank line). */
const section = (prompt: string, heading: string) =>
  prompt.split("\n\n").find((s) => s.startsWith(`# ${heading}`)) ?? "";

describe("# Your team", () => {
  it("tells the main agent it's the front door, lists each teammate's job, status and model, and how to route", () => {
    const p = buildSystemAppend(ctx({ name: "Yo", isPrimary: true }, [{ ...YO, you: true }, DEW, PICO]));
    const team = section(p, "Your team");
    expect(team).toContain("You're the main agent: Sam's front door. You run on Claude · Sonnet 5.5.");
    expect(team).toContain("- Dew (Research): working · ChatGPT · GPT-5.5");
    expect(team).toContain("- Pico (Builder): asleep (a message wakes them) · Claude · Opus 5");
    expect(team).not.toContain("- Yo");
    expect(team).toContain("The main agent is the front door.");
    expect(team).toContain(
      "Route work to the teammate whose job fits with `message_agent`, and don't do a teammate's job yourself.",
    );
    expect(team).toContain("`message_agent` returns at once");
    expect(team).toContain("Use `wait: true` only when you can't finish without the answer.");
    expect(team).toContain("`create_agent` adds a teammate");
    // Helpers stay as the task layer, and the lead still supervises.
    expect(p).toContain("# Helpers\nHelpers are your task layer");
    expect(p).toContain("# Leading the team");
    // No single-assistant framing left.
    for (const old of ["# Teammates", "# Other agents", "one assistant", "only agent"])
      expect(p).not.toContain(old);
  });

  it("stays about 10 lines however big the team is", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...DEW, name: `Mate${i}` }));
    const team = section(buildSystemAppend(ctx({ name: "Yo", isPrimary: true }, many)), "Your team");
    expect(team.split("\n").length).toBeLessThanOrEqual(10);
    expect(team).toContain("- Mate4 (Research)");
    expect(team).not.toContain("Mate5");
    expect(team).toContain("- …and 7 more");
  });

  it("tells a teammate who the main agent is and what its own job is", () => {
    const p = buildSystemAppend(
      ctx({ name: "Dew", role: "Research", isPrimary: false }, [YO, { ...DEW, you: true }, PICO]),
    );
    const team = section(p, "Your team");
    expect(team).toContain(
      "Yo is the main agent: Sam's front door. You're Dew, a teammate (your job: Research). You run on ChatGPT · GPT-5.5.",
    );
    expect(team).toContain("- Yo (main agent, your work assistant): idle · Claude · Sonnet 5.5");
    expect(team).toContain("- Pico (Builder)");
    expect(team).toContain("don't do a teammate's job yourself");
    expect(p).not.toContain("# Helpers");
    expect(p).not.toContain("# Leading the team");
  });

  it("names both main agents for a teammate when Work and Personal each have one", () => {
    const pip: TeamMember = { ...YO, name: "Pip", role: "your personal assistant" };
    const team = section(
      buildSystemAppend(ctx({ name: "Dew", isPrimary: false }, [YO, pip, { ...DEW, you: true }])),
      "Your team",
    );
    expect(team).toContain("Yo and Pip are the main agents: Sam's front door.");
  });

  it("a main agent with no teammates yet knows how one is added", () => {
    const team = section(buildSystemAppend(ctx({ name: "Yo", isPrimary: true }, [])), "Your team");
    expect(team).toContain("You're the main agent: Sam's front door, and you have no teammates yet.");
    expect(team).toContain("add it with `create_agent`");
    expect(team).toContain("asks Sam one question about its job");
  });

  it("the team-changed line lists the others, not the agent itself", () => {
    expect(teamNewsLine([{ ...YO, you: true }, DEW])).toBe(
      "[Your team changed. Now: Dew (Research): working · ChatGPT · GPT-5.5]",
    );
    expect(teamNewsLine([{ ...YO, you: true }])).toBe("[Your team changed: you have no teammates now]");
  });
});

describe("teammate notes", () => {
  const from = { name: "Yo", role: "", exchangeId: "xch_1" };
  it("an async request: the answer goes back later, and an FYI can be answered with NO_RESPONSE", () => {
    const n = teammateNote(from, "Sam");
    expect(n).toMatch(/^\[Message from your teammate Yo, another of Sam's Yo agents/);
    expect(n).toContain(
      "has carried on with their work: your final message is sent back to them as your reply",
    );
    expect(n).toContain("reply exactly NO_RESPONSE");
    expect(n.indexOf("]")).toBe(n.length - 1);
  });

  it("wait: true says the asker is waiting", () => {
    expect(teammateNote({ ...from, waiting: true }, "Sam")).toContain(
      "Yo is waiting: your final message is sent back to them as your reply",
    );
  });

  it("a reply wakes the asker to tell the user, marked as a teammate's words", () => {
    const n = teammateNote({ name: "Dew", role: "Research", exchangeId: null, reply: true }, "Sam");
    expect(n).toMatch(/^\[Reply from your teammate Dew \(Research\) to the message you sent them earlier\./);
    expect(n).toContain("not Sam's instructions");
    expect(n).toContain("tell Sam what matters from it");
    // One bracketed note: nothing inside closes it early.
    expect(n.indexOf("]")).toBe(n.length - 1);
  });

  it("a new teammate's first turn: hello in 1-2 lines, its job, and ONE ask_user question", () => {
    const t = teammateIntro({ role: "Research", by: "Yo", userName: "Sam" });
    expect(t).toMatch(
      /^\[From the Yo app, not a message from Sam: you've just joined Sam's team \(Yo added you\)\./,
    );
    expect(t).toContain("Say hello to Sam in 1–2 short lines");
    expect(t).toContain("what you'll take care of as their Research");
    expect(t).toContain("ONE multiple-choice question about your job with `ask_user`");
    expect(t).toContain("`remember` it");
  });
});
