import { describe, expect, it } from "vitest";
import { ReportBugInput, YO_TOOLS } from "./tools";

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
