/** The team in the prompt (docs/one-yo.md): Yo's routing, a specialist's report-to-Yo rule, the notes between them. */
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

describe("# Your team (One Yo: docs/one-yo.md)", () => {
  it("tells Yo it's the only agent the user talks to, lists each specialist's job, and how to route", () => {
    const p = buildSystemAppend(ctx({ name: "Yo", isPrimary: true }, [{ ...YO, you: true }, DEW, PICO]));
    expect(p).toContain("You are Sam's main assistant and the only agent they talk to");
    const team = section(p, "Your team");
    expect(team).toContain(
      "You're the main agent and the only one Sam talks to: you decide who does what. You run on Claude · Sonnet 5.5.",
    );
    expect(team).toContain("- Dew (Research): working · ChatGPT · GPT-5.5");
    expect(team).toContain("- Pico (Builder): asleep (a message wakes them) · Claude · Opus 5");
    expect(team).not.toContain("- Yo");
    // The routing rules.
    expect(team).toContain("- Do quick or general things yourself.");
    expect(team).toContain(
      "- Hand work to the specialist whose job fits with `message_agent`, and tell Sam in one line",
    );
    expect(team).toContain('When a message names one first ("@Dew …"), Sam means it for them: pass it on.');
    expect(team).toContain("- Use helpers for parallel one-offs no specialist owns.");
    expect(team).toContain(
      "- When a recurring area has no specialist, suggest one; add it with `create_agent` only after Sam says yes",
    );
    expect(team).toContain("- When a specialist reports back, tell Sam what matters in a few lines");
    expect(team).toContain("Use `wait: true` only when you can't finish without the answer.");
    // Helpers stay as the task layer, and the lead still supervises.
    expect(p).toContain("# Helpers\nHelpers are your task layer");
    expect(p).toContain("# Leading the team");
    expect(p).not.toContain("# Reporting to Yo");
    for (const old of ["front door", "teammate", "# Teammates", "# Other agents"])
      expect(p).not.toContain(old);
  });

  it("stays short however big the team is", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...DEW, name: `Mate${i}` }));
    const team = section(buildSystemAppend(ctx({ name: "Yo", isPrimary: true }, many)), "Your team");
    expect(team.split("\n").length).toBeLessThanOrEqual(17);
    expect(team).toContain("- Mate7 (Research)");
    expect(team).not.toContain("Mate8");
    expect(team).toContain("- …and 4 more");
  });

  it("a specialist works for Yo: the user talks to Yo, and it reports back to Yo with message_agent", () => {
    const p = buildSystemAppend(
      ctx({ name: "Dew", role: "Research", isPrimary: false }, [YO, { ...DEW, you: true }, PICO]),
    );
    expect(p).toContain(
      "You're Dew, a specialist on Yo's team (your job: Research), working for Sam inside the app \"Yo\". Sam talks to Yo, not to you. You get work from Yo and report back to Yo with `message_agent` when done or blocked. Keep reports short.",
    );
    const team = section(p, "Your team");
    expect(team).toContain(
      "You're Dew, a specialist on Yo's team (your job: Research). You run on ChatGPT · GPT-5.5. Yo is the main agent: Sam talks only to Yo, and Yo hands you work.",
    );
    expect(team).toContain("- Yo (main agent, your work assistant): idle · Claude · Sonnet 5.5");
    expect(team).toContain("- Pico (Builder)");
    const report = section(p, "Reporting to Yo");
    expect(report).toContain("your final message is your report: it goes back to Yo by itself");
    expect(report).toContain('tell Yo with `message_agent` (to: "Yo")');
    expect(report).toContain("Approval cards (`request_approval` and the like) still go to Sam directly.");
    expect(p).toContain("(Sam sees it comes from you; most updates belong in your report to Yo)");
    // No front-door tools or chat-only habits.
    for (const no of [
      "# Helpers",
      "# Leading the team",
      "# Playbooks",
      "# Yo Phone",
      "suggest_replies",
      "post_brief",
    ])
      expect(p).not.toContain(no);
  });

  it("Pip, with a memory focus, is a specialist like any other", () => {
    const pip: TeamMember = { ...PICO, name: "Pip", role: "your personal-time agent" };
    const p = buildSystemAppend(ctx({ name: "Dew", isPrimary: false }, [YO, pip, { ...DEW, you: true }]));
    expect(section(p, "Your team")).toContain("- Pip (your personal-time agent): asleep");
    const asPip = buildSystemAppend({
      ...ctx({ name: "Pip", role: "your personal-time agent", isPrimary: false }, [
        YO,
        { ...pip, you: true },
      ]),
      agent: {
        id: "agt_pip",
        name: "Pip",
        role: "your personal-time agent",
        instructions: "",
        isPrimary: false,
        space: "personal",
      },
    });
    expect(asPip).toContain("You're Pip, a specialist on Yo's team");
    expect(asPip).not.toContain("# Helpers");
  });

  it("Yo with no specialists yet knows what one is and how one is added", () => {
    const team = section(buildSystemAppend(ctx({ name: "Yo", isPrimary: true }, [])), "Your team");
    expect(team).toContain(
      "You're the main agent and the only one Sam talks to. You have no specialists yet.",
    );
    expect(team).toContain("it works for you and reports back to you");
    expect(team).toContain("add it with `create_agent` only after Sam says yes");
  });

  it("the team-changed line lists the others, not the agent itself", () => {
    expect(teamNewsLine([{ ...YO, you: true }, DEW])).toBe(
      "[Your team changed. Now: Dew (Research): working · ChatGPT · GPT-5.5]",
    );
    expect(teamNewsLine([{ ...YO, you: true }])).toBe("[Your team changed: you have no specialists now]");
  });
});

describe("notes between Yo and its specialists", () => {
  const from = { name: "Pico", role: "", exchangeId: "xch_1" };
  it("an async request: the answer goes back later, and an FYI can be answered with NO_RESPONSE", () => {
    const n = teammateNote(from, "Sam");
    expect(n).toMatch(/^\[Message from Pico, another of Sam's Yo agents/);
    expect(n).toContain(
      "has carried on with their work: your final message is sent back to them as your report",
    );
    expect(n).toContain("reply exactly NO_RESPONSE");
    expect(n.indexOf("]")).toBe(n.length - 1);
  });

  it("Yo's handoff to a specialist is work passed on from the user, with the same approvals", () => {
    const n = teammateNote({ name: "Yo", role: "", exchangeId: "xch_2", lead: true }, "Sam");
    expect(n).toMatch(/^\[Work from Yo, the main agent, who passes on what Sam wants/);
    expect(n).toContain("check with Sam (request_approval) before anything consequential");
    expect(n.indexOf("]")).toBe(n.length - 1);
  });

  it("wait: true says the asker is waiting", () => {
    expect(teammateNote({ ...from, waiting: true }, "Sam")).toContain(
      "Pico is waiting: your final message is sent back to them as your reply",
    );
  });

  it("a report wakes Yo to relay it concisely, marked as the specialist's words", () => {
    const n = teammateNote({ name: "Dew", role: "Research", exchangeId: null, reply: true }, "Sam");
    expect(n).toMatch(/^\[Reply from Dew \(Research\) to the message you sent them earlier\./);
    expect(n).toContain("not Sam's instructions");
    expect(n).toContain("tell Sam what matters from it in a few plain lines");
    // One bracketed note: nothing inside closes it early.
    expect(n.indexOf("]")).toBe(n.length - 1);
  });

  it("a new specialist's first turn: hello, its job, ONE ask_user question, then a line to Yo", () => {
    const t = teammateIntro({ role: "Research", by: "Yo", userName: "Sam" });
    expect(t).toMatch(
      /^\[From the Yo app, not a message from Sam: you've just joined Yo's team as a specialist \(Yo added you\)\./,
    );
    expect(t).toContain("Say hello in 1–2 short lines");
    expect(t).toContain("what you'll take care of as their Research");
    expect(t).toContain("ONE multiple-choice question about your job with `ask_user`");
    expect(t).toContain("`remember` it, and tell Yo in one line with `message_agent`");
  });
});
