/** Pure helpers for the "Report a problem" form (components/BugReportDialog.tsx) and the red draft card. */
import type { Artifact, BugReportSend, BugReportSent } from "@yo/contracts";

/** Said next to every "Open on GitHub": the in-app inbox is private, a GitHub issue is not. */
export const GITHUB_PUBLIC = "GitHub issues are public: anyone can read them, so leave out anything private.";

/** What the form sends. A draft from the chat sends its own fields; the form sends what the user typed. */
export function sendParams(
  o: { draftId?: string; agentId?: string | null },
  f: { what: string; expected: string; steps: string },
  includeChat: boolean,
): BugReportSend {
  if (o.draftId) return { draftId: o.draftId, includeChat };
  // One step per line; "1." / "-" / "•" in front are dropped (the report numbers them).
  const steps = f.steps
    .split("\n")
    .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter(Boolean);
  return {
    report: {
      what_happened: f.what.trim(),
      ...(f.expected.trim() ? { expected: f.expected.trim() } : {}),
      ...(steps.length ? { steps } : {}),
    },
    ...(o.agentId ? { agentId: o.agentId } : {}),
    includeChat,
  };
}

/** A sent report's outcome, from its artifact (after a reload, or a retry that finished later). */
export function artifactResult(art: Artifact): BugReportSent | null {
  const filed = typeof art.issue?.number === "number";
  if (!filed && !art.report) return null;
  return {
    status: filed ? "filed" : (art.report?.status ?? "failed"),
    artifactId: art.id,
    ...(art.report?.reportId ? { reportId: art.report.reportId } : {}),
    ...(filed ? { issueNumber: art.issue!.number } : {}),
    ...(!filed && art.issue?.url ? { fallbackUrl: art.issue.url } : {}),
  };
}

/** The line shown after Send. */
export function sentMessage(r: BugReportSent): string {
  switch (r.status) {
    case "sent":
      return `Thanks! Sent as ${r.reportId}. The Yo team will look at it.`;
    case "filed":
      return `Thanks! Filed as issue #${r.issueNumber}.`;
    case "pending":
      return "Saved. Yo couldn't reach the bug inbox just now, so it will keep trying for up to a day.";
    default:
      return "It couldn't be sent. You can still open it on GitHub, or download it from Artifacts to keep a copy.";
  }
}

export function sizeLabel(n: number): string {
  return n < 1024 ? `${n} B` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
