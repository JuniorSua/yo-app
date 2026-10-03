/**
 * report_bug: the agent investigates, drafts a report (facts + suspected cause + suggested fix), asks the user
 * "Would you like me to report it?", and only then submits it. Consent is enforced here, not by the prompt:
 * a submit needs a draft from the same conversation and a message from the user after it.
 *
 * Submitted reports are saved as red artifacts and filed as GitHub issues when the owner stored a token
 * (Settings → Bug reports); otherwise the card offers a prefilled "new issue" link. Both are redacted first.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Artifact, type BugReportFiling, ReportBugInput } from "@yo/contracts";
import type { BugDraft, Store } from "../db/store";
import type { Hub } from "../hub";
import { logger } from "../log";
import type { SecretStore } from "../secrets/SecretStore";

const log = logger("bug-reports");

declare const __YO_PUBLIC__: boolean | undefined;
/** Public builds (from JuniorSua/yo-app) file to the public repo; the maintainer's builds to the private one. */
export const PUBLIC_ISSUE_REPO = "JuniorSua/yo-app";
export const DEFAULT_ISSUE_REPO =
  typeof __YO_PUBLIC__ === "boolean" && __YO_PUBLIC__ ? PUBLIC_ISSUE_REPO : "JuniorSua/yo";
export const ISSUE_LABELS = ["bug", "from-yo"];
/**
 * First line of every report's body (invisible on GitHub). The labels in a prefilled link only stick for people
 * who can triage the repo, so the public repo's issues workflow (.github/workflows/issues.yml) looks for this
 * marker to label a report a user filed with their own account `bug` + `from-yo`.
 */
export const REPORT_MARKER = "<!-- yo:bug-report -->";
const TOKEN_KEY = "github-issues-token";
const REPO_KEY = "bugReportRepo";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** GitHub caps issue bodies at 65,536 characters. */
const MAX_ISSUE_BODY = 60_000;
/** Browsers and GitHub cope with long links, but stay well under the ~8 KB many proxies allow. */
const MAX_URL = 7000;

/* -------------------------------- redaction -------------------------------- */

const SECRETS: [RegExp, string][] = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    "[redacted private key]",
  ],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted token]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted token]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted key]"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "[redacted key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted token]"],
  // Header-style values: everything after "Cookie:" / "Authorization:" on that line.
  [/\b((?:set-)?cookie|authorization|x-api-key)(\s*[:=]\s*)[^\n]+/gi, "$1$2[redacted]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]"],
  // key=value / "key": "value" for secret-looking names.
  [
    /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|session[_-]?id|private[_-]?key|client[_-]?secret))(["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi,
    "$1$2[redacted]",
  ],
];

/** LAN (RFC 1918) and Tailscale (100.64.0.0/10) addresses. Loopback and public addresses are kept. */
function isPrivateIp(a: number, b: number): boolean {
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Strip obvious secrets, personal paths, emails and private network addresses before a report leaves the machine. */
export function redact(text: string, homeDirs: string[] = [os.homedir()]): string {
  let out = text;
  for (const [re, rep] of SECRETS) out = out.replace(re, rep);
  for (const h of homeDirs) if (h && h.length > 1) out = out.split(h).join("~");
  return (
    out
      .replace(/(?<![\w.])\/(?:Users|home)\/[^/\s"'`)\]]+/g, "~")
      .replace(/(?<![\w.])[A-Za-z]:\\Users\\[^\\\s"'`)\]]+/g, "~")
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, "[email]")
      .replace(/\b(?:[A-Za-z0-9-]+\.)+ts\.net\b/gi, "[tailnet host]")
      // Whole dotted quads only (not part of a longer version string like 10.1.2.3.4).
      .replace(/(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w]|\.\d)/g, (m, a, b, c, d) =>
        [a, b, c, d].every((n) => Number(n) <= 255) && isPrivateIp(Number(a), Number(b))
          ? "[private address]"
          : m,
      )
  );
}

/* -------------------------------- the report ------------------------------- */

type Fields = ReportBugInput;

const TEXT_FIELDS = [
  "title",
  "what_happened",
  "expected",
  "evidence",
  "suspected_cause",
  "suggested_fix",
  "area",
] as const;

function clean(f: Fields): Fields {
  const out: Fields = {};
  for (const k of TEXT_FIELDS) {
    const v = f[k]?.trim();
    if (v) out[k] = k === "title" ? v.replace(/\s+/g, " ").slice(0, 140) : v.slice(0, 20_000);
  }
  const steps = (f.steps ?? []).map((s) => s.trim()).filter(Boolean);
  if (steps.length) out.steps = steps.slice(0, 30);
  if (f.severity) out.severity = f.severity;
  return out;
}

/** Markdown of a report: the body of the GitHub issue (and, with the title on top, the saved artifact). */
export function bugReportBody(f: Fields, meta: { agentName: string; when: Date; environment: string[] }) {
  const section = (h: string, body: string | undefined) =>
    `## ${h}\n\n${body?.trim() || "_Not provided._"}\n`;
  const evidence = f.evidence?.trim();
  const fence = evidence?.includes("```") ? "~~~~" : "```";
  const tags = [f.severity && `Severity: ${f.severity}`, f.area && `Area: ${f.area}`]
    .filter(Boolean)
    .join(" · ");
  return [
    REPORT_MARKER,
    `Reported by ${meta.agentName} (Yo's agent) on ${meta.when.toISOString()}, after the user approved it.${tags ? `\n${tags}` : ""}\n`,
    section("What happened", f.what_happened),
    section("Expected", f.expected),
    section("Steps to reproduce", f.steps?.map((s, i) => `${i + 1}. ${s}`).join("\n")),
    section("Evidence", evidence ? `${fence}\n${evidence}\n${fence}` : ""),
    section("Suspected cause", f.suspected_cause),
    section("Suggested fix", f.suggested_fix),
    section("Environment", meta.environment.map((l) => `- ${l}`).join("\n")),
  ].join("\n");
}

export function bugReportMarkdown(title: string, body: string) {
  return `# Bug: ${title}\n\n${body}`;
}

/** github.com/<repo>/issues/new prefilled with the report, cut to keep the link under `max` characters. */
export function newIssueUrl(repo: string, title: string, body: string, max = MAX_URL): string {
  const make = (b: string) =>
    `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&labels=${ISSUE_LABELS.join(",")}&body=${encodeURIComponent(b)}`;
  const full = make(body);
  if (full.length <= max) return full;
  const note = "\n\n_…cut to fit in a link. The full report is saved in Yo's Artifacts._";
  const cut = (n: number) => body.slice(0, n).replace(/[\uD800-\uDBFF]$/, "");
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (make(cut(mid) + note).length <= max) lo = mid;
    else hi = mid - 1;
  }
  return make(cut(lo) + note);
}

/** POST /repos/{repo}/issues. Throws with GitHub's message on failure. */
export async function createGithubIssue(o: {
  api: string;
  repo: string;
  token: string;
  title: string;
  body: string;
  fetch: typeof fetch;
}): Promise<{ number: number; url: string }> {
  const post = (labels: boolean) =>
    o.fetch(`${o.api.replace(/\/$/, "")}/repos/${o.repo}/issues`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${o.token}`,
        "Content-Type": "application/json",
        "User-Agent": "Yo-bug-reports",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title: o.title,
        body: o.body.slice(0, MAX_ISSUE_BODY),
        ...(labels ? { labels: ISSUE_LABELS } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  let res = await post(true);
  // 422 = validation (e.g. labels this token may not create): file it without them rather than not at all.
  if (res.status === 422) res = await post(false);
  if (!res.ok) {
    const msg = await res
      .json()
      .then((j) => (j as { message?: string }).message ?? "")
      .catch(() => "");
    throw new Error(`GitHub answered ${res.status}${msg ? ` (${String(msg).slice(0, 120)})` : ""}`);
  }
  const j = (await res.json()) as { number?: number; html_url?: string };
  if (typeof j.number !== "number" || !j.html_url) throw new Error("GitHub's reply had no issue number");
  return { number: j.number, url: j.html_url };
}

/* ------------------------------ draft / submit ------------------------------ */

/** A yes, possibly followed by edits ("Yes, but change the title to …"). The card's [Report it] is one. */
const YES =
  /^\s*(?:(?:yes|yeah|yep|yup|sure|ok|okay)\b|(?:please\s+)?(?:go ahead|do it|report it|file it|submit it|send it|please do|sounds good)\b|👍)/iu;
/** Anything that holds it back, anywhere in the reply ("ok, but don't send it yet"). */
const HOLD =
  /\b(?:no|nope|nah|don'?t|do not|not (?:now|yet)|hold off|wait|stop|cancel|never ?mind|later)\b|\b(?:yes|ok|okay|sure)\b[^.!,]*\bbut\s+(?:not|first|wait)\b/i;

/** How a reply to "Would you like me to report it?" reads. Questions and anything unclear aren't a yes. */
export function consentOf(reply: string): "yes" | "no" | "unclear" {
  const t = reply.trim();
  if (YES.test(t) && !HOLD.test(t.replace(YES, "")) && !/\?\s*$/.test(t)) return "yes";
  if (/^\s*(?:no|nope|nah|not now|not yet|don'?t|do not|hold off|cancel|never ?mind)\b/i.test(t)) return "no";
  return "unclear";
}

export interface BugReportDeps {
  store: Store;
  hub: Hub;
  secrets: SecretStore;
  dataDir: string;
  /** Lines for the report's Environment section (Yo version, OS, agent and provider). */
  environment: (agentId: string) => string[];
  /** GitHub REST base (tests point it at a fake). */
  githubApi?: string;
  fetch?: typeof fetch;
  homeDirs?: string[];
}

export class BugReports {
  constructor(private d: BugReportDeps) {}

  private repo(): string {
    const r = this.d.store.getKv<string>(REPO_KEY);
    return r && REPO_RE.test(r) ? r : DEFAULT_ISSUE_REPO;
  }

  async status(): Promise<BugReportFiling> {
    return {
      configured: !!(await this.d.secrets.get(TOKEN_KEY)),
      repo: this.repo(),
      defaultRepo: DEFAULT_ISSUE_REPO,
    };
  }

  async configure(p: { token?: string | null; repo?: string | null }): Promise<BugReportFiling> {
    if (p.repo !== undefined) {
      const repo = (p.repo ?? "")
        .trim()
        .replace(/^https?:\/\/github\.com\//, "")
        .replace(/\.git$|\/$/g, "");
      if (repo && !REPO_RE.test(repo)) throw new Error('Repository must look like "owner/name".');
      this.d.store.setKv(REPO_KEY, repo || null);
    }
    if (p.token !== undefined) {
      const token = (p.token ?? "").trim();
      if (!token) await this.d.secrets.delete(TOKEN_KEY);
      else if (/\s/.test(token) || token.length > 400)
        throw new Error("That doesn't look like a GitHub token.");
      else await this.d.secrets.set(TOKEN_KEY, token);
    }
    return this.status();
  }

  async handle(agentId: string, args: Record<string, unknown>): Promise<string> {
    const parsed = ReportBugInput.safeParse(args);
    if (!parsed.success)
      throw new Error(
        `report_bug: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`,
      );
    const input = parsed.data;
    const stage = input.stage ?? (input.draft_id ? "submit" : "draft");
    return stage === "submit" ? this.submit(agentId, input) : this.draft(agentId, input);
  }

  private draft(agentId: string, input: Fields): string {
    const fields = clean(input);
    if (!fields.title || !fields.what_happened)
      throw new Error("A bug report needs at least a title and what_happened.");
    const draft = this.d.store.addBugDraft(agentId, fields);
    this.d.store.addActivity({
      agentId,
      kind: "system",
      summary: `Bug report drafted: ${fields.title}`,
      ref: draft.id,
    });
    return [
      `Draft saved [bug-draft:${draft.id}]. Nothing has been sent.`,
      `The user sees it as a red draft card with "Report it" and "Not now" buttons.`,
      `Now tell them in a few plain words what you found and the fix you recommend, ask "Would you like me to report it?", and end your turn.`,
      `If they say yes, call report_bug with stage "submit" and draft_id "${draft.id}" (pass only fields they asked you to change). If they say no, don't report it.`,
    ].join(" ");
  }

  private async submit(agentId: string, input: Fields & { draft_id?: string }): Promise<string> {
    const id = input.draft_id?.trim();
    if (!id)
      throw new Error('submit needs the draft_id from your draft. Call report_bug with stage "draft" first.');
    const draft = this.d.store.getBugDraft(id);
    if (!draft || draft.agentId !== agentId)
      throw new Error(
        `There's no bug report draft ${id} in this conversation. Draft it first (stage "draft") and ask the user.`,
      );
    if (draft.status === "submitted") {
      const art = draft.artifactId ? this.d.store.getArtifact(draft.artifactId) : null;
      throw new Error(
        `This report was already submitted${art?.issue?.number ? ` as issue #${art.issue.number}` : ""}. Don't submit it again.`,
      );
    }
    if (draft.status === "submitting")
      throw new Error("This report is being submitted right now. Don't submit it again.");
    this.checkConsent(agentId, draft);
    // Claim it before the first await: a parallel submit of the same draft is refused instead of filing twice.
    if (!this.d.store.claimBugDraft(draft.id))
      throw new Error("This report is already being submitted. Don't submit it again.");

    const { fields, changed } = this.merge(draft, input);
    let saved: ReturnType<BugReports["save"]>;
    try {
      saved = this.save(agentId, fields);
    } catch (err) {
      this.d.store.releaseBugDraft(draft.id);
      throw err;
    }
    const { art, title, body } = saved;
    // From here the report exists: it is submitted whatever happens with GitHub (the fallback is the link).
    this.d.store.markBugDraftSubmitted(draft.id, art.id);
    const filed = await this.file(title, body, art);
    const updated = this.d.store.setArtifactIssue(art.id, filed.issue) ?? art;
    this.d.hub.push("artifact.new", updated);
    this.d.store.addActivity({
      agentId,
      kind: "system",
      summary: filed.issue.number
        ? `Bug reported as issue #${filed.issue.number}: ${fields.title}`
        : `Bug report saved: ${fields.title}`,
      ref: art.id,
    });
    const edits = changed.length ? ` Applied your changes to: ${changed.join(", ")}.` : "";
    if (filed.issue.number)
      return `Reported: filed as GitHub issue #${filed.issue.number} (${filed.issue.url}) [artifact:${art.id}].${edits} Tell the user it's filed, in one short sentence.`;
    return `Saved the bug report [artifact:${art.id}], but it wasn't sent: ${filed.reason} The red card has an "Open on GitHub" button that opens a prefilled issue for the user to submit.${edits} Tell them that in one short sentence.`;
  }

  /**
   * The user's latest message after the question must be a yes. "After the question" = after the turn that drafted
   * the report ended (a message typed while the agent was still working doesn't count).
   */
  private checkConsent(agentId: string, draft: BugDraft) {
    const ask =
      'Ask them "Would you like me to report it?", end your turn, and submit only after they say yes.';
    const turnEnd = this.d.store.turnEndAt(agentId, draft.createdAt);
    if (turnEnd === null) throw new Error(`Not sent: the user hasn't answered yet. ${ask}`);
    const replies = this.d.store
      .userMessagesAfter(agentId, draft.afterSeq)
      .filter((m) => turnEnd === undefined || m.at >= turnEnd);
    const latest = replies.at(-1);
    if (!latest) throw new Error(`Not sent: the user hasn't answered yet. ${ask}`);
    const consent = consentOf(latest.text);
    if (consent === "no")
      throw new Error("Not sent: the user said no. Don't report it unless they ask again.");
    if (consent !== "yes")
      throw new Error(`Not sent: the user's latest message isn't a clear yes to reporting it. ${ask}`);
  }

  /** The draft, plus any corrections passed with the submit. */
  private merge(draft: BugDraft, input: Fields) {
    const edits = clean(input);
    const fields: Fields = { ...draft.fields };
    const changed: string[] = [];
    for (const [k, v] of Object.entries(edits) as [keyof Fields, never][]) {
      if (JSON.stringify(fields[k]) === JSON.stringify(v)) continue;
      fields[k] = v;
      changed.push(k);
    }
    return { fields, changed };
  }

  /** Writes the redacted report to Artifacts. */
  private save(agentId: string, fields: Fields) {
    const title = redact(fields.title ?? "Untitled bug", this.d.homeDirs);
    const now = new Date();
    const body = redact(
      bugReportBody(fields, {
        agentName: this.d.store.getAgent(agentId)?.name ?? "Yo",
        when: now,
        environment: this.d.environment(agentId),
      }),
      this.d.homeDirs,
    );
    const md = bugReportMarkdown(title, body);
    const dir = path.join(this.d.dataDir, "artifacts");
    fs.mkdirSync(dir, { recursive: true });
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50) || "bug";
    const name = `bug-${now.toISOString().slice(0, 10)}-${slug}.md`;
    const stored = path.join(dir, `${Date.now()}-${name}`);
    fs.writeFileSync(stored, md);
    const art = this.d.store.addArtifact({
      agentId,
      title: `Bug: ${title}`,
      path: `bug-reports/${name}`,
      mime: "text/markdown",
      size: Buffer.byteLength(md),
      storedPath: stored,
      kind: "bug",
    });
    return { art, title, body };
  }

  /** Files the (already redacted) report on GitHub, or falls back to a prefilled new-issue link. */
  private async file(
    title: string,
    body: string,
    art: Artifact,
  ): Promise<{ issue: NonNullable<Artifact["issue"]>; reason: string }> {
    const repo = this.repo();
    const fallback = (reason: string) => ({
      issue: { url: newIssueUrl(repo, title, body) },
      reason,
    });
    try {
      const token = await this.d.secrets.get(TOKEN_KEY);
      if (!token) return fallback("GitHub filing isn't set up (Settings → Bug reports).");
      const issue = await createGithubIssue({
        api: this.d.githubApi ?? "https://api.github.com",
        repo,
        token,
        title,
        body,
        fetch: this.d.fetch ?? fetch,
      });
      return { issue, reason: "" };
    } catch (err: any) {
      log.warn(`filing ${art.id} on ${repo} failed`, err);
      return fallback(`filing it on GitHub failed: ${err?.message ?? err}.`);
    }
  }
}
