/** One Yo (docs/one-yo.md): who leads, who is a specialist, and the shapes the app reads. */
import { describe, expect, it } from "vitest";
import { Item } from "./events";
import { isLead, isSpecialist } from "./memoryLabels";
import { isMessageAgentTool, toSpecialistViaYo } from "./team";

describe("isLead and isSpecialist", () => {
  it("only the primary leads; a memory focus doesn't make Pip a lead; helpers never lead", () => {
    expect(isLead({ isPrimary: true, space: "work" })).toBe(true);
    expect(isLead({ isPrimary: true, kind: "agent" })).toBe(true);
    expect(isLead({ isPrimary: false, space: "personal" })).toBe(false);
    expect(isLead({ isPrimary: false, space: null })).toBe(false);
    expect(isLead({ isPrimary: true, kind: "helper" })).toBe(false);
  });

  it("every long-lived agent but the primary is a specialist (kind 'agent' or absent)", () => {
    expect(isSpecialist({ isPrimary: false })).toBe(true);
    expect(isSpecialist({ isPrimary: false, kind: "agent" })).toBe(true);
    expect(isSpecialist({ isPrimary: true })).toBe(false);
    expect(isSpecialist({ isPrimary: false, kind: "helper" })).toBe(false);
  });
});

describe("a message for a specialist goes to Yo", () => {
  it("names the specialist first, once", () => {
    expect(toSpecialistViaYo("Pepe", "take care of pending leads")).toBe("@Pepe take care of pending leads");
    expect(toSpecialistViaYo("Pepe", "  hi  ")).toBe("@Pepe hi");
    expect(toSpecialistViaYo("Pepe", "@pepe already named")).toBe("@pepe already named");
    expect(toSpecialistViaYo("Pepe", "@Pepe, hi")).toBe("@Pepe, hi");
    // Another name that only starts the same isn't "already named".
    expect(toSpecialistViaYo("Pep", "@Pepe hi")).toBe("@Pep @Pepe hi");
    expect(toSpecialistViaYo("Pepe", "")).toBe("@Pepe");
  });
});

describe("exchange items", () => {
  it("message_agent steps are found under any provider prefix", () => {
    expect(isMessageAgentTool("message_agent")).toBe(true);
    expect(isMessageAgentTool("mcp__yo__message_agent")).toBe(true);
    expect(isMessageAgentTool("not_message_agent_x")).toBe(false);
    expect(isMessageAgentTool(undefined)).toBe(false);
  });

  it("Item.exchange carries direction, agent, text and time; older items without it still parse", () => {
    const base = { id: "i1", kind: "tool", status: "completed" } as const;
    const ex = {
      direction: "to",
      agentId: "agt_pepe",
      name: "Pepe",
      text: "Follow up",
      at: 1,
      exchangeId: "xch_1",
    };
    expect(Item.parse({ ...base, exchange: ex }).exchange).toEqual(ex);
    expect(Item.parse(base).exchange).toBeUndefined();
    expect(Item.safeParse({ ...base, exchange: { ...ex, direction: "sideways" } }).success).toBe(false);
  });
});
