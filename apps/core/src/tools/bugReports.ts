/**
 * report_bug: the agent investigates, drafts a report (facts + suspected cause + suggested fix), asks the user
 * "Would you like me to report it?", and only then submits it. Consent is enforced here, not by the prompt:
 * a submit needs a draft from the same conversation and a message from the user after it.
 *
 * Submitted reports are saved as red artifacts and sent, with a zip of diagnostics, to the bug mailbox on the Yo
 * Phone relay, encrypted to the owner's bug-inbox key (./bugCrypto.ts): only the owner's Yo can open them, and it
 * files them on GitHub (./bugInbox.ts). Nobody needs a GitHub account. The user can also send one themselves
 * (Settings → Bug reports → Report a problem, or Send on the red draft card), which is when "Include recent chat"
 * applies. If the mailbox can't take it, Yo retries for up to a day, then offers the old prefilled "new issue"
 * link. A GitHub token in Settings (the owner's) files issues directly instead. Everything is redacted first.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Artifact,
  BUG_INBOX_PUBLIC_KEY,
  type BugEnvelope,
  type BugReportFiling,
  type BugReportPreview,
  type BugReportSend,
  type BugReportSent,
  ReportBugInput,
} from "@yo/contracts";
import type { BugDraft, Store } from "../db/store";
import type { Hub } from "../hub";
import { logger, redact as redactKnownSecrets } from "../log";
import type { SecretStore } from "../secrets/SecretStore";
import { type ZipEntry, zipFiles } from "../zipWriter";
import { installHashOf, packBugReport, sealBugReport } from "./bugCrypto";

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
  [/\bxai-[A-Za-z0-9]{16,}/g, "[redacted key]"],
  // 1Password service account tokens.
  [/\bops_[A-Za-z0-9_\-.=+/]{20,}/g, "[redacted token]"],
  // Yo Phone links carry their key in the fragment.
  [/#k=[A-Za-z0-9_~.%-]+/g, "#k=[redacted]"],
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

/**
 * Strip obvious secrets, personal paths, emails and private network addresses before a report leaves the machine.
 * Every secret Yo knows by value (SecretStore values, the agentd token, channel keys: log.ts addSecret) goes first.
 */
export function redact(text: string, homeDirs: string[] = [os.homedir()]): string {
  let out = redactKnownSecrets(text);
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
export function bugReportBody(
  f: Fields,
  meta: { agentName: string; when: Date; environment: string[]; source?: "agent" | "user" },
) {
  const section = (h: string, body: string | undefined) =>
    `## ${h}\n\n${body?.trim() || "_Not provided._"}\n`;
  const evidence = f.evidence?.trim();
  const fence = evidence?.includes("```") ? "~~~~" : "```";
  const tags = [f.severity && `Severity: ${f.severity}`, f.area && `Area: ${f.area}`]
    .filter(Boolean)
    .join(" · ");
  return [
    REPORT_MARKER,
    `${meta.source === "user" ? "Reported by the user (Settings → Bug reports)" : `Reported by ${meta.agentName} (Yo's agent)`} on ${meta.when.toISOString()}${meta.source === "user" ? "" : ", after the user approved it"}.${tags ? `\n${tags}` : ""}\n`,
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
  /** Default: ISSUE_LABELS. */
  labels?: string[];
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
        ...(labels ? { labels: o.labels ?? ISSUE_LABELS } : {}),
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

/* ------------------------------ the bug mailbox ------------------------------ */

/** How long a report waits for the mailbox before the card offers the prefilled link instead. */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Waits between tries: 1 min, 5 min, 15 min, 30 min, 1 h, 2 h, then every 4 h. */
const BACKOFF_MS = [1, 5, 15, 30, 60, 120, 240].map((m) => m * 60_000);
const INSTALL_KEY = "bugInstallId";
const INSTALL_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CHAT_ITEMS = 30;
const LOG_LINES = 400;
/** The mailbox route on the Yo Phone relay. */
export const BUG_MAILBOX_PATH = "/api/relay/bugs";
/** Field caps for the report's text (the receiving core enforces them again: ./bugInbox.ts). */
export const CAP = {
  title: 140,
  whatHappened: 10_000,
  expected: 5_000,
  steps: 30,
  step: 1_000,
  area: 40,
  agentReport: 30_000,
  version: 80,
  platform: 120,
};
/**
 * Text fields + bundle zip, before encryption. The relay takes 600 KB of JSON and base64url adds a third, so the
 * report must stay under ~460 KB; the bundle is trimmed (log first, then chat) to fit.
 */
export const MAX_REPORT_BYTES = 450_000;

type Delivery =
  | { status: "filed"; issue: { url: string; number: number } }
  | { status: "sent"; reportId: string }
  | { status: "pending"; error: string }
  | { status: "failed"; url: string; reason: string };

type Report = NonNullable<Artifact["report"]>;

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
  /**
   * The Yo Phone relay (the same one Yo Phone uses), which holds the bug mailbox. Empty or absent: off, reports
   * get the prefilled GitHub link.
   */
  relayUrl?: () => string;
  /** Who can open the reports. Default: the owner's BUG_INBOX_PUBLIC_KEY (tests use their own pair). */
  inboxPublicKey?: string;
  /** For the report: "0.1.312 (build 312-abc)" and "Darwin 25.0 (darwin/arm64)". */
  about?: () => { version: string; platform: string };
  /** The bundle's environment.json: versions, modes and states only (it's redacted again anyway). */
  diagnostics?: () => Record<string, unknown>;
  /** The last lines core logged, for core-log.txt. */
  logTail?: (n: number) => string[];
  now?: () => number;
}

/** A short title from the first line of what happened (the Settings form has no title field). */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0]!.replace(/\s+/g, " ").trim();
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : 80)}…`;
}

const clip = (s: unknown, n: number) =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n)}…` : s) : undefined;

export class BugReports {
  private timer: ReturnType<typeof setInterval> | null = null;
  private retrying = false;

  constructor(private d: BugReportDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** The bug mailbox's URL, or "" when there's no relay. */
  private inbox(): string {
    const relay = this.d.relayUrl?.().trim().replace(/\/+$/, "") ?? "";
    return relay ? `${relay}${BUG_MAILBOX_PATH}` : "";
  }

  /** Where issues go: Settings → Bug reports → Repository, or the default. */
  repo(): string {
    const r = this.d.store.getKv<string>(REPO_KEY);
    return r && REPO_RE.test(r) ? r : DEFAULT_ISSUE_REPO;
  }

  /** Retries reports the mailbox couldn't take (on start, then every minute). */
  start(everyMs = 60_000) {
    if (this.timer || !this.inbox()) return;
    void this.retryPending();
    this.timer = setInterval(() => void this.retryPending(), everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A random id for this Yo, made once. Only a hash of it leaves (rate limits, "same report again"). */
  installId(): string {
    const have = this.d.store.getKv<string>(INSTALL_KEY);
    if (typeof have === "string" && INSTALL_RE.test(have)) return have;
    const id = `inst_${randomBytes(16).toString("base64url")}`;
    this.d.store.setKv(INSTALL_KEY, id);
    return id;
  }

  async status(): Promise<BugReportFiling> {
    return {
      inbox: !!this.inbox(),
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

  /** The agent's submit, after the user said yes in the chat. Recent chat isn't attached (they didn't pick it). */
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
      const as = art?.issue?.number
        ? ` as issue #${art.issue.number}`
        : art?.report?.reportId
          ? ` as ${art.report.reportId}`
          : "";
      throw new Error(`This report was already submitted${as}. Don't submit it again.`);
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
      saved = this.save(agentId, fields, "agent");
    } catch (err) {
      this.d.store.releaseBugDraft(draft.id);
      throw err;
    }
    // From here the report exists: it is submitted whatever happens next (the last resort is the link).
    this.d.store.markBugDraftSubmitted(draft.id, saved.art.id);
    const { art, out } = await this.deliver(agentId, saved, fields, {
      includeChat: false,
      draftId: draft.id,
    });
    const edits = changed.length ? ` Applied your changes to: ${changed.join(", ")}.` : "";
    switch (out.status) {
      case "filed":
        return `Reported: filed as GitHub issue #${out.issue.number} (${out.issue.url}) [artifact:${art.id}].${edits} Tell the user it's filed, in one short sentence.`;
      case "sent":
        return `Reported: sent to the developer as ${out.reportId} [artifact:${art.id}].${edits} Tell the user it's sent, in one short sentence.`;
      case "pending":
        return `Saved the bug report [artifact:${art.id}]. Yo's bug inbox couldn't take it right now, so Yo will keep trying for up to a day; there's nothing else to do.${edits} Tell the user that in one short sentence.`;
      default:
        return `Saved the bug report [artifact:${art.id}], but it wasn't sent: ${out.reason} The red card has an "Open on GitHub" button that opens a prefilled issue for the user to submit.${edits} Tell them that in one short sentence. If they'd rather paste the report somewhere themselves, give its text in a fenced code block so the chat shows a Copy button.`;
    }
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

  /* ---------------------- the user's own Send (form, card) --------------------- */

  /** A chat draft, or the Settings form's fields (with the conversation whose chat may go along). */
  private resolve(p: BugReportSend): { agentId: string; fields: Fields; draft: BugDraft | null } {
    if (p.draftId) {
      const draft = this.d.store.getBugDraft(p.draftId);
      if (!draft) throw new Error("That bug report draft is gone.");
      return { agentId: draft.agentId, fields: draft.fields, draft };
    }
    const what = p.report?.what_happened?.trim();
    if (!what) throw new Error("Say what happened first.");
    const fields = clean({
      title: p.report?.title?.trim() || titleFrom(what),
      what_happened: what,
      expected: p.report?.expected,
      steps: p.report?.steps,
    });
    return { agentId: this.agentFor(p.agentId), fields, draft: null };
  }

  private agentFor(id?: string): string {
    if (id && this.d.store.getAgent(id)) return id;
    const agents = this.d.store.listAgents();
    const a = agents.find((x) => x.isPrimary) ?? agents[0];
    if (!a) throw new Error("Finish setting up Yo first.");
    return a.id;
  }

  /** Exactly what Send would send. Nothing is saved or sent. */
  preview(p: BugReportSend): BugReportPreview {
    const { agentId, fields, draft } = this.resolve(p);
    const { title, md } = this.render(agentId, fields, draft ? "agent" : "user", new Date(this.now()));
    const files = this.bundleFiles(agentId, md, !!p.includeChat);
    return {
      title,
      reportMd: md,
      files: files.map((f) => ({ name: f.name, bytes: Buffer.byteLength(f.data) })),
    };
  }

  /** The user pressed Send: that click is the consent (and says whether the recent chat goes too). */
  async send(p: BugReportSend): Promise<BugReportSent> {
    const { agentId, fields, draft } = this.resolve(p);
    if (draft) {
      if (draft.status === "submitted") {
        const art = draft.artifactId ? this.d.store.getArtifact(draft.artifactId) : null;
        if (art) return this.result(art);
      }
      if (!this.d.store.claimBugDraft(draft.id)) throw new Error("This report is already being sent.");
    }
    let saved: ReturnType<BugReports["save"]>;
    try {
      saved = this.save(agentId, fields, draft ? "agent" : "user");
    } catch (err) {
      if (draft) this.d.store.releaseBugDraft(draft.id);
      throw err;
    }
    if (draft) this.d.store.markBugDraftSubmitted(draft.id, saved.art.id);
    const { art } = await this.deliver(agentId, saved, fields, {
      includeChat: !!p.includeChat,
      draftId: draft?.id,
    });
    return this.result(art);
  }

  private result(art: Artifact): BugReportSent {
    const r = art.report;
    const filed = typeof art.issue?.number === "number";
    return {
      status: filed ? "filed" : (r?.status ?? "failed"),
      artifactId: art.id,
      ...(r?.reportId ? { reportId: r.reportId } : {}),
      ...(filed ? { issueNumber: art.issue!.number } : {}),
      ...(!filed && art.issue?.url ? { fallbackUrl: art.issue.url } : {}),
    };
  }

  /* ------------------------------ saving / sending ----------------------------- */

  /** The redacted title, issue body and markdown of a report. */
  private render(agentId: string, fields: Fields, source: "agent" | "user", when: Date) {
    const title = redact(fields.title ?? "Untitled bug", this.d.homeDirs).slice(0, CAP.title);
    const body = redact(
      bugReportBody(fields, {
        agentName: this.d.store.getAgent(agentId)?.name ?? "Yo",
        when,
        environment: this.d.environment(agentId),
        source,
      }),
      this.d.homeDirs,
    );
    return { title, body, md: bugReportMarkdown(title, body) };
  }

  /** Writes the redacted report to Artifacts. */
  private save(agentId: string, fields: Fields, source: "agent" | "user") {
    const now = new Date(this.now());
    const { title, body, md } = this.render(agentId, fields, source, now);
    const dir = path.join(this.d.dataDir, "artifacts");
    fs.mkdirSync(dir, { recursive: true });
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50) || "bug";
    const name = `bug-${now.toISOString().slice(0, 10)}-${slug}.md`;
    const stored = path.join(dir, `${now.getTime()}-${Math.random().toString(36).slice(2, 6)}-${name}`);
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
    return { art, title, body, md, stored };
  }

  /**
   * Sends a saved report: as a GitHub issue when the owner stored a token, else (encrypted, with the bundle) to
   * the bug mailbox, else (no relay) the prefilled link. Updates the artifact and tells the UI.
   */
  private async deliver(
    agentId: string,
    saved: ReturnType<BugReports["save"]>,
    fields: Fields,
    o: { includeChat: boolean; draftId?: string },
  ): Promise<{ art: Artifact; out: Delivery }> {
    const { art, title, body, md, stored } = saved;
    const repo = this.repo();
    const link = (reason: string): Extract<Delivery, { status: "failed" }> => ({
      status: "failed",
      url: newIssueUrl(repo, title, body),
      reason,
    });
    let out: Delivery;
    let tokenError = "";
    const token = await this.d.secrets.get(TOKEN_KEY).catch((err: any) => {
      tokenError = String(err?.message ?? err);
      return null;
    });
    if (token) {
      try {
        const issue = await createGithubIssue({
          api: this.d.githubApi ?? "https://api.github.com",
          repo,
          token,
          title,
          body,
          fetch: this.d.fetch ?? fetch,
        });
        out = { status: "filed", issue: { url: issue.url, number: issue.number } };
        this.d.store.setArtifactIssue(art.id, issue);
      } catch (err: any) {
        log.warn(`filing ${art.id} on ${repo} failed`, err);
        out = link(`filing it on GitHub failed: ${err?.message ?? err}.`);
        this.d.store.setArtifactIssue(art.id, { url: out.url });
      }
    } else if (!this.inbox()) {
      out = link(
        tokenError
          ? `filing it on GitHub failed: ${tokenError}.`
          : "GitHub filing isn't set up (Settings → Bug reports).",
      );
      this.d.store.setArtifactIssue(art.id, { url: out.url });
    } else {
      const meta = JSON.stringify(this.payload(title, fields));
      fs.writeFileSync(`${stored}.inbox.json`, meta);
      fs.writeFileSync(`${stored}.zip`, this.bundle(agentId, md, o.includeChat, Buffer.byteLength(meta)));
      const report: Report = {
        status: "pending",
        attempts: 0,
        includeChat: o.includeChat,
        ...(o.draftId ? { draftId: o.draftId } : {}),
      };
      this.d.store.setArtifactReport(art.id, report);
      out = await this.attempt(this.d.store.getArtifact(art.id)!, report);
    }
    const updated = this.d.store.getArtifact(art.id) ?? art;
    this.d.hub.push("artifact.new", updated);
    this.d.store.addActivity({
      agentId,
      kind: "system",
      summary:
        out.status === "filed"
          ? `Bug reported as issue #${out.issue.number}: ${title}`
          : out.status === "sent"
            ? `Bug report sent as ${out.reportId}: ${title}`
            : out.status === "pending"
              ? `Bug report saved, will retry: ${title}`
              : `Bug report saved: ${title}`,
      ref: art.id,
    });
    return { art: updated, out };
  }

  /**
   * The report's text fields (saved next to the artifact until it's sent). Every text is redacted and cut to
   * CAP. The install id stays here: only its hash goes out (the envelope's `install`).
   */
  private payload(title: string, f: Fields) {
    const about = this.d.about?.() ?? {
      version: "unknown",
      platform: `${process.platform}/${process.arch}`,
    };
    const r = (s: string, n: number) => redact(s, this.d.homeDirs).slice(0, n);
    const agentReport = [
      f.evidence && `## Evidence\n\n~~~~\n${f.evidence}\n~~~~`,
      f.suspected_cause && `## Suspected cause\n\n${f.suspected_cause}`,
      f.suggested_fix && `## Suggested fix\n\n${f.suggested_fix}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      installId: this.installId(),
      version: about.version.slice(0, CAP.version) || "unknown",
      platform: about.platform.slice(0, CAP.platform) || "unknown",
      title: title.slice(0, CAP.title),
      whatHappened: r(f.what_happened ?? title, CAP.whatHappened),
      ...(f.expected ? { expected: r(f.expected, CAP.expected) } : {}),
      ...(f.steps?.length ? { steps: f.steps.slice(0, CAP.steps).map((s) => r(s, CAP.step)) } : {}),
      ...(f.severity ? { severity: f.severity } : {}),
      ...(f.area ? { area: r(f.area, CAP.area) } : {}),
      ...(agentReport ? { agentReport: r(agentReport, CAP.agentReport) } : {}),
    };
  }

  /** Strings anywhere in a value, redacted. */
  private redactDeep<T>(v: T): T {
    if (typeof v === "string") return redact(v, this.d.homeDirs) as T;
    if (Array.isArray(v)) return v.map((x) => this.redactDeep(x)) as T;
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.redactDeep(x)])) as T;
    return v;
  }

  /** The last items of a conversation, without pictures, each field cut short. */
  private chatExcerpt(agentId: string, items = CHAT_ITEMS) {
    return this.d.store.listTimeline(agentId, undefined, items).map((e) =>
      this.redactDeep({
        at: new Date(e.createdAt).toISOString(),
        kind: e.item.kind,
        status: e.item.status,
        ...(e.item.from ? { from: "another agent" } : {}),
        title: clip(e.item.title, 300),
        text: clip(e.item.text, 4000),
        tool: e.item.toolName,
        input: e.item.input === undefined ? undefined : clip(JSON.stringify(e.item.input), 2000),
        output: clip(e.item.output, 2000),
      }),
    );
  }

  /** The bundle's files: report.md, environment.json, core-log.txt and (if allowed) chat-excerpt.json. */
  private bundleFiles(
    agentId: string,
    md: string,
    includeChat: boolean,
    logLines = LOG_LINES,
    chatItems = CHAT_ITEMS,
  ): ZipEntry[] {
    const env = {
      generatedAt: new Date(this.now()).toISOString(),
      ...(this.d.diagnostics?.() ?? {}),
    };
    const lines = (logLines > 0 ? (this.d.logTail?.(logLines) ?? []) : []).map((l) =>
      redact(l, this.d.homeDirs),
    );
    const files: ZipEntry[] = [
      { name: "report.md", data: md },
      { name: "environment.json", data: `${JSON.stringify(this.redactDeep(env), null, 2)}\n` },
      { name: "core-log.txt", data: lines.length ? `${lines.join("\n")}\n` : "(nothing logged yet)\n" },
    ];
    if (includeChat && chatItems > 0)
      files.push({
        name: "chat-excerpt.json",
        data: `${JSON.stringify(this.chatExcerpt(agentId, chatItems), null, 2)}\n`,
      });
    return files;
  }

  /**
   * The zip, small enough that it and the text fields (`metaBytes`) fit in one mailbox item: a shorter log, then
   * no log, then a shorter chat, then no chat, and at worst report.md alone.
   */
  private bundle(agentId: string, md: string, includeChat: boolean, metaBytes = 0): Buffer {
    const when = new Date(this.now());
    const fits = (zip: Buffer) => metaBytes + 1 + zip.length <= MAX_REPORT_BYTES;
    const steps: [number, number][] = [
      [LOG_LINES, CHAT_ITEMS],
      [100, CHAT_ITEMS],
      [0, CHAT_ITEMS],
      [0, 10],
      [0, 0],
    ];
    for (const [logLines, chatItems] of steps) {
      if (!includeChat && chatItems !== CHAT_ITEMS) break;
      const zip = zipFiles(this.bundleFiles(agentId, md, includeChat, logLines, chatItems), when);
      if (fits(zip)) return zip;
    }
    return zipFiles([{ name: "report.md", data: md }], when);
  }

  /** One try at the mailbox (encrypted afresh each time); records the outcome on the artifact. */
  private async attempt(art: Artifact, report: Report): Promise<Delivery> {
    const file = this.d.store.artifactFile(art.id);
    const attempts = (report.attempts ?? 0) + 1;
    const now = this.now();
    let payload: Record<string, unknown> | null = null;
    let zip: Buffer | null = null;
    try {
      payload = JSON.parse(fs.readFileSync(`${file!.storedPath}.inbox.json`, "utf8"));
      zip = fs.existsSync(`${file!.storedPath}.zip`) ? fs.readFileSync(`${file!.storedPath}.zip`) : null;
    } catch {
      /* the files are gone: give up below */
    }
    const envelope = payload ? this.seal(payload, zip) : null;
    const res = envelope
      ? await this.post(envelope)
      : ({ ok: false, retry: false, error: "The saved report is missing." } as const);
    if (res.ok) {
      this.d.store.setArtifactReport(art.id, {
        status: "sent",
        reportId: res.reportId,
        sentAt: now,
        attempts,
        ...(report.draftId ? { draftId: report.draftId } : {}),
        ...(report.includeChat !== undefined ? { includeChat: report.includeChat } : {}),
      });
      log.info(`bug report ${art.id} sent as ${res.reportId}`);
      return { status: "sent", reportId: res.reportId };
    }
    if (res.retry && now - art.createdAt < RETRY_WINDOW_MS) {
      const wait = Math.max(BACKOFF_MS[attempts - 1] ?? BACKOFF_MS.at(-1)!, res.retryAfterMs ?? 0);
      this.d.store.setArtifactReport(art.id, {
        ...report,
        status: "pending",
        attempts,
        nextTryAt: Math.min(now + wait, art.createdAt + RETRY_WINDOW_MS),
        error: res.error,
      });
      log.warn(`bug report ${art.id} not sent yet (try ${attempts}): ${res.error}`);
      return { status: "pending", error: res.error };
    }
    // Out of tries (or the mailbox refused it): the prefilled link and the download are what's left.
    let title = art.title.replace(/^Bug: /, "");
    let body = "";
    try {
      const md = fs.readFileSync(file!.storedPath, "utf8");
      const head = bugReportMarkdown(title, "");
      body = md.startsWith(head) ? md.slice(head.length) : md;
    } catch {
      title ||= "Bug report";
    }
    const url = newIssueUrl(this.repo(), title, body);
    this.d.store.setArtifactIssue(art.id, { url });
    const { nextTryAt: _n, ...rest } = report;
    this.d.store.setArtifactReport(art.id, { ...rest, status: "failed", attempts, error: res.error });
    log.warn(`bug report ${art.id} wasn't sent: ${res.error}`);
    return { status: "failed", url, reason: `${res.error}` };
  }

  /**
   * The report encrypted to the owner's bug-inbox key. The install id is replaced by its hash in the envelope's
   * header. A bundle saved by an older Yo that's too big for the mailbox goes without it.
   */
  private seal(payload: Record<string, unknown>, zip: Buffer | null): BugEnvelope | null {
    const { installId, ...meta } = payload;
    let plain = packBugReport(meta, zip);
    if (plain.length > MAX_REPORT_BYTES) plain = packBugReport(meta, null);
    try {
      return sealBugReport(
        plain,
        this.d.inboxPublicKey ?? BUG_INBOX_PUBLIC_KEY,
        installHashOf(typeof installId === "string" ? installId : this.installId()),
      );
    } catch (err) {
      log.warn("couldn't encrypt a bug report", err);
      return null;
    }
  }

  /** POST to the bug mailbox. Never throws. */
  private async post(
    body: BugEnvelope,
  ): Promise<
    { ok: true; reportId: string } | { ok: false; retry: boolean; retryAfterMs?: number; error: string }
  > {
    try {
      const res = await (this.d.fetch ?? fetch)(this.inbox(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Yo-core" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; reportId?: unknown; error?: unknown };
      if (res.ok && j.ok && typeof j.reportId === "string" && /^YO-[A-Z0-9]{4,12}$/.test(j.reportId))
        return { ok: true, reportId: j.reportId };
      const error =
        typeof j.error === "string" && j.error
          ? j.error.slice(0, 200)
          : `Yo's bug inbox answered ${res.status}.`;
      const after = Number(res.headers.get("retry-after"));
      const retryAfterMs =
        Number.isFinite(after) && after > 0 ? Math.min(after, 24 * 60 * 60) * 1000 : undefined;
      // Busy, down or an odd answer: try again later. Any other 4xx means it would be refused again.
      const retry = res.ok || res.status === 429 || res.status === 408 || res.status >= 500;
      return { ok: false, retry, ...(retryAfterMs ? { retryAfterMs } : {}), error };
    } catch {
      return { ok: false, retry: true, error: "Yo's bug inbox couldn't be reached." };
    }
  }

  /** Sends the reports that are due again; past a day they fall back to the link. */
  async retryPending(): Promise<void> {
    if (this.retrying || !this.inbox()) return;
    this.retrying = true;
    try {
      for (const art of this.d.store.pendingBugReports()) {
        const report = art.report!;
        const overdue = this.now() - art.createdAt >= RETRY_WINDOW_MS;
        if (!overdue && (report.nextTryAt ?? 0) > this.now()) continue;
        const out = await this.attempt(art, report);
        const updated = this.d.store.getArtifact(art.id);
        if (updated) this.d.hub.push("artifact.new", updated);
        if (out.status !== "pending")
          this.d.store.addActivity({
            agentId: art.agentId,
            kind: "system",
            summary:
              out.status === "sent"
                ? `Bug report sent as ${out.reportId}: ${art.title.replace(/^Bug: /, "")}`
                : `Bug report couldn't be sent: ${art.title.replace(/^Bug: /, "")}`,
            ref: art.id,
          });
      }
    } catch (err) {
      log.warn("retrying bug reports failed", err);
    } finally {
      this.retrying = false;
    }
  }
}
