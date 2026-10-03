/**
 * Settings → Bug reports → "Report a problem": GitHub's bug form (.github/ISSUE_TEMPLATE/bug_report.yml) on the
 * repo reports go to, with the Yo version filled in. For when the agent can't help (no account connected, it
 * won't start) or the user just wants to write it themselves. Needs a GitHub account, like the agent's link.
 */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** github.com/<repo>/issues/new on the bug form; `version` fills its "Yo version" field (id `version`). */
export function bugFormUrl(repo: string, version?: string | null): string | null {
  if (!REPO_RE.test(repo)) return null;
  const q = new URLSearchParams({ template: "bug_report.yml" });
  const v = version?.trim();
  if (v) q.set("version", v.slice(0, 100));
  return `https://github.com/${repo}/issues/new?${q}`;
}
