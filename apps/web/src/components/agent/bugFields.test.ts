import { describe, expect, it } from "vitest";
import { bugCall, outputText } from "./bugFields";

describe("bugCall", () => {
  it("keeps well-formed input", () => {
    expect(
      bugCall({
        stage: "draft",
        title: " Old image ",
        steps: ["a", "b"],
        severity: "high",
        draft_id: "bdr_1",
      }),
    ).toEqual({ stage: "draft", title: "Old image", steps: ["a", "b"], severity: "high", draft_id: "bdr_1" });
  });

  it("coerces or drops malformed fields instead of throwing", () => {
    expect(
      bugCall({
        stage: "later",
        title: { text: "x" },
        what_happened: 42,
        expected: ["array"],
        steps: "first\nsecond\n",
        evidence: null,
        suspected_cause: true,
        suggested_fix: "",
        draft_id: { id: 1 },
      }),
    ).toEqual({ what_happened: "42", steps: ["first", "second"], suspected_cause: "true" });
    expect(bugCall({ steps: [1, null, { a: 1 }, " two "] }).steps).toEqual(["1", "two"]);
    for (const bad of [null, undefined, "text", 7, ["a"], true]) expect(bugCall(bad)).toEqual({});
    expect(bugCall({ title: "x".repeat(500) }).title).toHaveLength(200);
  });

  it("reads tool output only when it's text", () => {
    expect(outputText("ok")).toBe("ok");
    expect(outputText(undefined)).toBe("");
    expect(outputText({ text: "x" })).toBe("");
  });
});
