import { describe, expect, it } from "vitest";
import {
  CreateAgentInput,
  MessageAgentInput,
  normalizePlaybook,
  ReportBugInput,
  StartHelperInput,
  toolAllowed,
  toolsFor,
  YO_TOOLS,
} from "./tools";

const reportBug = YO_TOOLS.find((t) => t.name === "report_bug")!;
const schema = reportBug.inputSchema as {
  properties: Record<string, { enum?: string[] }>;
  required: string[];
  additionalProperties: boolean;
};

describe("report_bug tool", () => {
  it("is two-stage: draft, ask the user, then submit with the draft id", () => {
    expect(schema.required).toEqual(["stage"]);
    expect(schema.properties.stage!.enum).toEqual(["draft", "submit"]);
    expect(schema.properties.severity!.enum).toEqual(["low", "medium", "high", "critical"]);
    for (const k of ["draft_id", "suspected_cause", "suggested_fix", "area", "evidence", "steps"])
      expect(schema.properties[k]).toBeDefined();
    expect(schema.additionalProperties).toBe(false);
    expect(reportBug.description).toContain("Would you like me to report it?");
    expect(reportBug.description).toMatch(/Investigate first/);
  });

  it("parses what core receives, including calls from an older computer image", () => {
    expect(
      ReportBugInput.parse({
        stage: "draft",
        title: "Old image",
        what_happened: "x",
        steps: ["a", 2],
        suspected_cause: "cache",
        suggested_fix: "bust it",
        severity: "high",
      }),
    ).toMatchObject({ stage: "draft", steps: ["a", "2"], severity: "high" });
    // PR #20's schema had no stage: still valid (core treats it as a draft).
    expect(ReportBugInput.parse({ title: "t", what_happened: "w" }).stage).toBeUndefined();
    expect(ReportBugInput.safeParse({ stage: "send" }).success).toBe(false);
    expect(ReportBugInput.safeParse({ stage: "draft", severity: "urgent" }).success).toBe(false);
  });
});

describe("tool sets", () => {
  const names = (set?: string) => toolsFor(set).map((t) => t.name);
  it("helpers lose the team, routine, scratchpad, ledger and helper tools", () => {
    const helper = names("helper");
    for (const t of [
      "start_helper",
      "check_helpers",
      "stop_helper",
      "message_agent",
      "create_agent",
      "schedule_task",
      "cancel_task",
      "scratchpad_write",
      "task_add",
    ])
      expect(helper).not.toContain(t);
    for (const t of ["remember", "ask_user", "request_approval", "request_takeover", "playbook_list"])
      expect(helper).toContain(t);
    expect(names("primary")).toEqual(expect.arrayContaining(["start_helper", "message_agent", "task_add"]));
    // Yo keeps create_agent (approval card) only for the life map's rare permanent-agent suggestion.
    expect(names("primary")).toContain("create_agent");
    expect(names("agent")).toContain("create_agent");
    expect(names("agent")).not.toContain("start_helper");
    // Yo Phone links: the main agent only.
    for (const t of ["create_phone_link", "turn_off_phone"]) {
      expect(names("primary")).toContain(t);
      expect(names("agent")).not.toContain(t);
      expect(names("helper")).not.toContain(t);
    }
    // No tool set (an older core) or an unknown one: everything, as before.
    expect(names()).toEqual(YO_TOOLS.map((t) => t.name));
    expect(names("bogus")).toEqual(YO_TOOLS.map((t) => t.name));
    expect(toolAllowed("helper", "message_agent")).toBe(false);
    expect(toolAllowed("helper", "remember")).toBe(true);
    expect(toolAllowed("helper", "mcp__browser__x")).toBe(true);
  });

  it("reads start_helper calls and playbook paths", () => {
    expect(StartHelperInput.parse({ brief: " Get a quote ", title: "Quote" })).toEqual({
      brief: "Get a quote",
      title: "Quote",
    });
    expect(StartHelperInput.safeParse({ brief: "  " }).success).toBe(false);
    expect(normalizePlaybook("work/desk-quote.md")).toBe("work/desk-quote.md");
    expect(normalizePlaybook("~/Shared/playbooks/work/desk-quote.md")).toBe("work/desk-quote.md");
    expect(normalizePlaybook("../secrets.md")).toBeNull();
    expect(normalizePlaybook("work/notes.txt")).toBeNull();
    expect(normalizePlaybook(".history/old.md")).toBeNull();
  });
});

describe("team tools", () => {
  it("message_agent and create_agent are offered with the arguments core reads", () => {
    const names = YO_TOOLS.map((t) => t.name);
    expect(names).toContain("message_agent");
    expect(names).toContain("create_agent");
    expect(MessageAgentInput.parse({ to: " Pepe ", message: "hi" })).toEqual({ to: "Pepe", message: "hi" });
    expect(MessageAgentInput.safeParse({ to: "Pepe", message: "  " }).success).toBe(false);
    expect(MessageAgentInput.safeParse({ to: "Pepe", message: "hi", wait: "no" }).success).toBe(false);
    expect(CreateAgentInput.parse({ name: "Pepe", role: "Head of Polestar" }).name).toBe("Pepe");
    expect(CreateAgentInput.safeParse({ name: "" }).success).toBe(false);
  });
});
