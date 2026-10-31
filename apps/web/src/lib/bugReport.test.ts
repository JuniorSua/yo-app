import type { Artifact } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { artifactResult, sendParams, sentMessage, sizeLabel } from "./bugReport";

const ART: Artifact = {
  id: "art_1",
  agentId: "agt_1",
  title: "Bug: x",
  path: "bug-reports/x.md",
  mime: "text/markdown",
  size: 10,
  createdAt: 1,
  kind: "bug",
};

describe("bug report form", () => {
  it("sends a chat draft by id, with only the chat choice", () => {
    expect(
      sendParams({ draftId: "bdr_1", agentId: "agt_1" }, { what: "ignored", expected: "", steps: "" }, false),
    ).toEqual({ draftId: "bdr_1", includeChat: false });
  });

  it("sends the form's fields, steps one per line without their bullets", () => {
    expect(
      sendParams(
        { agentId: "agt_1" },
        { what: "  It froze \n", expected: " ", steps: "1. Open it\n\n- Click Save\n• Wait\n3) Done" },
        true,
      ),
    ).toEqual({
      report: { what_happened: "It froze", steps: ["Open it", "Click Save", "Wait", "Done"] },
      agentId: "agt_1",
      includeChat: true,
    });
    expect(sendParams({ agentId: null }, { what: "x", expected: "y", steps: "" }, false)).toEqual({
      report: { what_happened: "x", expected: "y" },
      includeChat: false,
    });
  });

  it("reads the outcome off the artifact", () => {
    expect(artifactResult(ART)).toBeNull();
    expect(artifactResult({ ...ART, report: { status: "sent", reportId: "YO-ABC123" } })).toEqual({
      status: "sent",
      artifactId: "art_1",
      reportId: "YO-ABC123",
    });
    expect(artifactResult({ ...ART, issue: { number: 4, url: "https://github.com/a/b/issues/4" } })).toEqual({
      status: "filed",
      artifactId: "art_1",
      issueNumber: 4,
    });
    expect(
      artifactResult({
        ...ART,
        report: { status: "failed" },
        issue: { url: "https://github.com/a/b/issues/new" },
      }),
    ).toEqual({ status: "failed", artifactId: "art_1", fallbackUrl: "https://github.com/a/b/issues/new" });
  });

  it("says where it went in plain words", () => {
    expect(sentMessage({ status: "sent", artifactId: "a", reportId: "YO-ABC123" })).toBe(
      "Thanks! Sent as YO-ABC123. The Yo team will look at it.",
    );
    expect(sentMessage({ status: "pending", artifactId: "a" })).toMatch(/keep trying for up to a day/);
    expect(sentMessage({ status: "failed", artifactId: "a" })).toMatch(/open it on GitHub/);
    expect(sentMessage({ status: "filed", artifactId: "a", issueNumber: 9 })).toBe(
      "Thanks! Filed as issue #9.",
    );
    expect([sizeLabel(900), sizeLabel(2048), sizeLabel(1)]).toEqual(["900 B", "2 KB", "1 B"]);
  });
});
