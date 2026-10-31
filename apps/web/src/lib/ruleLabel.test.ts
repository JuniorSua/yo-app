import { describe, expect, it } from "vitest";
import { chipText, ruleLabel } from "./ruleLabel";

describe("ruleLabel", () => {
  it("names Yo's approval categories in plain words", () => {
    expect(ruleLabel("yo:purchase")).toBe("Purchases");
    expect(ruleLabel("message")).toBe("Sending messages");
  });
  it("names a 1Password site rule", () => {
    expect(ruleLabel("yo:1password:github.com")).toBe("1Password sign-ins on github.com");
  });
  it("names common computer tools", () => {
    expect(ruleLabel("mcp__playwright__browser_navigate")).toBe("Opening web pages");
    expect(ruleLabel("Bash")).toBe("Running commands");
  });
  it("cleans up anything else", () => {
    expect(ruleLabel("mcp__gmail__send_draft")).toBe("Send draft");
    expect(ruleLabel("mcp__my_server__do_thing")).toBe("Do thing");
    expect(ruleLabel("yo:create_agent")).toBe("Create agent");
    expect(ruleLabel("__")).toBe("__");
  });
});

describe("chipText", () => {
  it("drops the field name where the value says it all", () => {
    expect(chipText("category", "purchase")).toEqual({ value: "Purchase" });
    expect(chipText("recipient", "ana@example.com")).toEqual({ label: "To", value: "ana@example.com" });
    expect(chipText("total", "$189.99")).toEqual({ label: "Total", value: "$189.99" });
  });
});
