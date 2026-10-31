/**
 * BugInbox: the receiving end of one-click bug reports, on the owner's Yo only (docs/phone/PROTOCOL.md, "Bug mailbox").
 *
 * Every Yo encrypts its reports to the owner's bug-inbox public key and drops them in the bug mailbox on the Yo
 * Phone relay (./bugReports.ts). This service is on only when this core holds both the matching private key
 * (`bug-inbox-key`, loaded with `yo-ops.mjs bugs key`) and Yo Phone's register key (the relay's core credential
 * for the mailbox), so in practice only the owner's core ever runs it. Every few minutes it:
 *
 *   1. lists the mailbox and decrypts each report;
 *   2. saves the bundle zip under <dataDir>/bug-reports/<reportId>.zip (the newest 200 are kept);
 *   3. files a GitHub issue with the core's `github-issues-token` (labels bug, from-yo, user-report), or, when the
 *      same install sent a near-identical title within 2 hours, comments on that issue instead;
 *   4. acks the report only once it's on GitHub. When GitHub fails, it stays in the mailbox and the next poll
 *      (later, with backoff) tries again.
 *
 * Reports are untrusted input: their text is neutralized (no @mentions, no hidden HTML comments) and capped, the
 * zip is only listed (never unpacked) here, and nothing from a report is logged.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BUG_INBOX_PUBLIC_KEY,
  type BugEnvelope,
  type BugInboxApiMethods,
  type BugInboxStatus,
} from "@yo/contracts";
import { coreCredFor } from "../channels/phoneCrypto";
import type { Store } from "../db/store";
import { logger } from "../log";
import type { SecretStore } from "../secrets/SecretStore";
import { bugInboxPublicKeyOf, bugKeyFingerprint, openBugReport, unpackBugReport } from "./bugCrypto";
import { BUG_MAILBOX_PATH, CAP, createGithubIssue } from "./bugReports";

const log = logger("bug-inbox");

export const BUG_INBOX_KEY = "bug-inbox-key";
/** Yo Phone's: the relay's HMAC key, from which the mailbox's core credential is made. */
const REGISTER_KEY = "phone-register-key";
const TOKEN_KEY = "github-issues-token";
/** The relay's reserved box name for the bug mailbox's core credential (phone/lib/crypto.js BUGS_BOX). */
const BUGS_BOX = "bugs";
const FILED_KV = "_bugInboxFiled";
const RECENT_KV = "_bugInboxRecent";
const ID_RE = /^YO-[A-Z0-9]{6}$/;

export const POLL_MS = 5 * 60_000;
export const MAX_BACKOFF_MS = 60 * 60_000;
export const KEEP_BUNDLES = 200;
export const DEDUPE_MS = 2 * 60 * 60_000;
export const USER_REPORT_LABELS = ["bug", "from-yo", "user-report"];
/** Report ids already filed (so a lost ack never files twice), and recent titles per install (dedupe). */
const KEEP_FILED = 500;
const KEEP_RECENT = 300;

type Item = BugEnvelope & { id: string; at: number };
type Filed = Record<string, { issue: number; at: number }>;
type Recent = Record<string, { issue: number; at: number }>;

export interface BugInboxDeps {
  store: Store;
  secrets: SecretStore;
  dataDir: string;
  /** Yo Phone's relay (the bug mailbox lives there). */
  relayUrl: () => string;
  /** "owner/name" the issues go to (Settings → Bug reports → Repository). */
  repo: () => string;
  githubApi?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** The key reports are encrypted to. Default: BUG_INBOX_PUBLIC_KEY (tests use their own pair). */
  publicKey?: string;
  pollMs?: number;
}

/* ------------------------------- issue text -------------------------------- */

/** Report text is untrusted: no @mentions (they'd notify people) and no HTML comments that hide text. */
export function neutral(s: unknown): string {
  return String(s)
    .replace(/@(?=[A-Za-z0-9-])/g, "@​")
    .replace(/<!--/g, "&lt;!--");
}

/** Normalized title for "the same report again": case, spacing, punctuation and numbers don't matter. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[0-9]+/g, "#")
    .replace(/[^a-z#]+/g, " ")
    .trim()
    .slice(0, 100);
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Names and sizes from a zip's central directory. Nothing is decompressed. */
export function zipListing(
  buf: Buffer,
  max = 50,
): { entries: { name: string; size: number }[]; count: number } {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: { name: string; size: number }[] = [];
  for (let n = 0; n < count && entries.length < max; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("broken zip");
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf
      .subarray(p + 46, p + 46 + nameLen)
      .toString("utf8")
      .replace(/[^\w./ -]/g, "_")
      .slice(0, 120);
    entries.push({ name, size });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return { entries, count };
}

/** The report's fields, checked and capped (it came from someone else's computer). */
interface Fields {
  version: string;
  platform: string;
  title: string;
  whatHappened: string;
  expected?: string;
  steps?: string[];
  severity?: string;
  area?: string;
  agentReport?: string;
}

function fieldsOf(meta: Record<string, unknown>): Fields {
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const title = s(meta.title, CAP.title).replace(/\s+/g, " ") || "Bug report";
  const f: Fields = {
    version: s(meta.version, CAP.version) || "unknown",
    platform: s(meta.platform, CAP.platform) || "unknown",
    title,
    whatHappened: s(meta.whatHappened, CAP.whatHappened) || title,
  };
  const expected = s(meta.expected, CAP.expected);
  if (expected) f.expected = expected;
  if (Array.isArray(meta.steps)) {
    const steps = meta.steps
      .slice(0, CAP.steps)
      .map((x) => s(x, CAP.step))
      .filter(Boolean);
    if (steps.length) f.steps = steps;
  }
  if (typeof meta.severity === "string" && /^(low|medium|high|critical)$/.test(meta.severity))
    f.severity = meta.severity;
  const area = s(meta.area, CAP.area);
  if (area) f.area = area;
  const agentReport = s(meta.agentReport, CAP.agentReport);
  if (agentReport) f.agentReport = agentReport;
  return f;
}

function bundleSection(id: string, zip: Buffer | null): string {
  if (!zip) return "_No diagnostics bundle was attached._";
  let list = "";
  try {
    const { entries, count } = zipListing(zip);
    list = entries.map((e) => `- \`${e.name}\` (${kb(e.size)})`).join("\n");
    if (count > entries.length) list += `\n- …and ${count - entries.length} more`;
  } catch {
    list = "_The zip's file list couldn't be read._";
  }
  return `Bundle: Home PC core-data/bug-reports/${id}.zip (${kb(zip.length)})\n\n${list}`;
}

export function issueBody(f: Fields, meta: { reportId: string; install: string; zip: Buffer | null }) {
  const sec = (h: string, body: string | undefined) => (body ? `## ${h}\n\n${neutral(body)}\n` : "");
  const tags = [f.severity && `Severity: ${f.severity}`, f.area && `Area: ${neutral(f.area)}`]
    .filter(Boolean)
    .join(" · ");
  return [
    `<!-- yo:user-report ${meta.reportId} -->`,
    `**${meta.reportId}** · Yo ${neutral(f.version)} · ${neutral(f.platform)} · install \`${meta.install}\`${tags ? `\n${tags}` : ""}\n`,
    sec("What happened", f.whatHappened),
    sec("Expected", f.expected),
    sec("Steps to reproduce", f.steps?.map((s, i) => `${i + 1}. ${s}`).join("\n")),
    sec("What Yo's agent found", f.agentReport),
    `## Diagnostics bundle\n\n${bundleSection(meta.reportId, meta.zip)}\n`,
    "_Sent through Yo's bug mailbox: redacted and encrypted on the reporter's computer, opened by the maintainer's Yo. The triage helper's `fetch` copies the bundle from the PC._",
  ]
    .filter(Boolean)
    .join("\n");
}

function commentBody(f: Fields, meta: { reportId: string; install: string; zip: Buffer | null }) {
  return [
    `**Reported again: ${meta.reportId}** · Yo ${neutral(f.version)} · ${neutral(f.platform)} · same install \`${meta.install}\``,
    "",
    `## What happened\n\n${neutral(f.whatHappened)}`,
    f.expected ? `\n## Expected\n\n${neutral(f.expected)}` : "",
    `\n## Diagnostics bundle\n\n${bundleSection(meta.reportId, meta.zip)}`,
  ].join("\n");
}

/* --------------------------------- service --------------------------------- */

export class BugInbox {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private stopped = true;
  private failures = 0;
  private lastPollAt: number | null = null;
  private nextPollAt: number | null = null;
  private lastError: string | null = null;
  private pending = 0;
  private filed = 0;
  private more = false;
  private ticking = false;
  private starting = false;
  private readonly publicKey: string;

  constructor(private d: BugInboxDeps) {
    this.publicKey = d.publicKey ?? BUG_INBOX_PUBLIC_KEY;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  private get fetch() {
    return this.d.fetch ?? fetch;
  }

  private mailbox(): string {
    return `${this.d.relayUrl().trim().replace(/\/+$/, "")}${BUG_MAILBOX_PATH}`;
  }

  private async keys(): Promise<{ privateKey: string; registerKey: string } | null> {
    const [privateKey, registerKey] = await Promise.all([
      this.d.secrets.get(BUG_INBOX_KEY).catch(() => null),
      this.d.secrets.get(REGISTER_KEY).catch(() => null),
    ]);
    return privateKey && registerKey ? { privateKey, registerKey } : null;
  }

  /** `bugInbox.*` (owner-only, yo-ops.mjs `bugs`). */
  get api(): {
    [M in keyof BugInboxApiMethods]: (
      p: BugInboxApiMethods[M]["params"],
    ) => Promise<BugInboxApiMethods[M]["result"]>;
  } {
    return {
      "bugInbox.status": () => this.status(),
      "bugInbox.configure": (p) => this.configure(p),
    };
  }

  /** Starts polling if both keys are there. Safe to call again (after a key changes). */
  async start(): Promise<void> {
    this.stopped = false;
    if (this.timer || this.ticking || this.starting) return;
    this.starting = true;
    try {
      if (!(await this.keys())) {
        log.debug("off (no bug inbox key or no relay register key)");
        return;
      }
      if (this.stopped || this.timer || this.ticking) return;
      log.info(`on: polling ${this.mailbox()} every ${Math.round((this.d.pollMs ?? POLL_MS) / 1000)} s`);
      this.schedule(0);
    } finally {
      this.starting = false;
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextPollAt = null;
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    this.nextPollAt = this.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
    this.timer.unref?.();
  }

  private async tick() {
    this.ticking = true;
    const ok = await this.pollOnce(); // never throws
    // Cleared in the same step that schedules the next poll, so status() can't start a second timer in between.
    this.ticking = false;
    if (ok === null) {
      // The keys went away: off until configured again.
      this.nextPollAt = null;
      return;
    }
    this.failures = ok ? 0 : this.failures + 1;
    const every = this.d.pollMs ?? POLL_MS;
    // More waiting than one poll returns: go again soon.
    if (ok && this.more) this.schedule(1000);
    else this.schedule(ok ? every : Math.min(every * 2 ** this.failures, MAX_BACKOFF_MS));
  }

  async status(): Promise<BugInboxStatus> {
    const [privateKey, registerKey, token] = await Promise.all(
      [BUG_INBOX_KEY, REGISTER_KEY, TOKEN_KEY].map((k) => this.d.secrets.get(k).catch(() => null)),
    );
    // The relay key can arrive after start (`yo-ops phone key`): the next status check starts polling.
    if (privateKey && registerKey && !this.stopped && !this.timer && !this.ticking) await this.start();
    return {
      enabled: !!(privateKey && registerKey),
      keySet: !!privateKey,
      registerKeySet: !!registerKey,
      githubTokenSet: !!token,
      relayUrl: this.d.relayUrl(),
      repo: this.d.repo(),
      lastPollAt: this.lastPollAt,
      pending: this.pending,
      filed: this.filed,
      lastError: this.lastError,
      nextPollAt: this.nextPollAt,
    };
  }

  /** Saves (after checking it matches the public key every Yo encrypts to) or forgets the private key. */
  async configure(p: { privateKey: string | null }): Promise<BugInboxStatus> {
    if (p.privateKey === null) {
      await this.d.secrets.delete(BUG_INBOX_KEY);
      this.stop();
      this.lastError = null;
      return this.status();
    }
    const key = String(p.privateKey ?? "").trim();
    let pub: string;
    try {
      pub = bugInboxPublicKeyOf(key);
    } catch {
      throw new Error("That isn't a bug inbox key (expected 43 base64url characters).");
    }
    if (pub !== this.publicKey)
      throw new Error(
        `That key doesn't match the bug inbox public key Yo encrypts reports to (fingerprint ${bugKeyFingerprint(this.publicKey)}).`,
      );
    await this.d.secrets.set(BUG_INBOX_KEY, key);
    this.lastError = null;
    this.stop();
    await this.start();
    return this.status();
  }

  /**
   * One poll: list, decrypt, file, ack. Returns true when everything it saw is dealt with, false when something
   * has to wait (GitHub or the relay failed), null when the inbox is off. Never throws.
   */
  async pollOnce(): Promise<boolean | null> {
    if (this.polling) return true;
    this.polling = true;
    try {
      const keys = await this.keys();
      if (!keys) return null;
      const cred = await coreCredFor(keys.registerKey, BUGS_BOX);
      const res = await this.fetch(this.mailbox(), {
        headers: { "X-Yo-Core": cred, "User-Agent": "Yo-core" },
        signal: AbortSignal.timeout(60_000),
      });
      this.lastPollAt = this.now();
      if (!res.ok) throw new Error(`The bug mailbox answered ${res.status}.`);
      const body = (await res.json()) as { items?: unknown; more?: boolean };
      const items = (Array.isArray(body.items) ? body.items : []).filter(
        (i): i is Item => typeof i?.id === "string" && ID_RE.test(i.id),
      );
      if (!items.length) {
        this.pending = 0;
        this.lastError = null;
        return true;
      }
      const token = await this.d.secrets.get(TOKEN_KEY).catch(() => null);
      if (!token) {
        this.pending = items.length;
        this.lastError = "No GitHub token to file reports with (Settings → Bug reports → Advanced).";
        return false;
      }
      const done: string[] = [];
      let error: string | null = null;
      for (const item of items) {
        try {
          if (await this.handle(item, keys.privateKey, token)) done.push(item.id);
        } catch (err: any) {
          error = `Filing ${item.id} failed: ${String(err?.message ?? err).slice(0, 200)}`;
          log.warn(error);
          break; // GitHub is having trouble: the rest wait for the next poll too
        }
      }
      if (done.length) await this.ack(done);
      this.pending = items.length - done.length;
      this.lastError = error;
      this.more = !error && !!body.more;
      return !error;
    } catch (err: any) {
      this.lastError = String(err?.message ?? err).slice(0, 200);
      log.warn(`polling the bug mailbox failed: ${this.lastError}`);
      return false;
    } finally {
      this.polling = false;
    }
  }

  /** Opens and files one report. True when it can be acked; throws when GitHub failed (try again later). */
  private async handle(item: Item, privateKey: string, token: string): Promise<boolean> {
    const filed = this.d.store.getKv<Filed>(FILED_KV) ?? {};
    if (filed[item.id]) return true; // filed before, but the ack didn't go through
    let report: ReturnType<typeof unpackBugReport>;
    try {
      report = unpackBugReport(openBugReport(item, privateKey));
    } catch {
      // Not for us or tampered with: it can never be opened, so it's dropped.
      log.warn(`report ${item.id} couldn't be opened; dropping it`);
      return true;
    }
    const f = fieldsOf(report.meta);
    const install = /^[0-9a-f]{32}$/.test(item.install) ? item.install : "unknown";
    const meta = { reportId: item.id, install, zip: report.zip };
    if (report.zip) this.saveBundle(item.id, report.zip);

    const at = Number.isFinite(item.at) ? item.at : this.now();
    const dedupeKey = `${install}:${titleKey(f.title)}`;
    const recent = this.d.store.getKv<Recent>(RECENT_KV) ?? {};
    const prev = recent[dedupeKey];
    const api = (this.d.githubApi ?? "https://api.github.com").replace(/\/$/, "");
    const repo = this.d.repo();
    let issue: number | null = null;
    if (prev && Math.abs(at - prev.at) < DEDUPE_MS) {
      const r = await this.fetch(`${api}/repos/${repo}/issues/${prev.issue}/comments`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Yo-bug-inbox",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ body: commentBody(f, meta).slice(0, 60_000) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok) issue = prev.issue;
      // The first issue is gone (deleted, transferred): file this one on its own.
      else if (r.status !== 404 && r.status !== 410) throw new Error(`GitHub answered ${r.status}`);
    }
    if (issue === null) {
      const created = await createGithubIssue({
        api,
        repo,
        token,
        title: neutral(f.title).slice(0, 200),
        body: issueBody(f, meta),
        fetch: this.fetch,
        labels: USER_REPORT_LABELS,
      });
      issue = created.number;
      recent[dedupeKey] = { issue, at };
      this.d.store.setKv(RECENT_KV, newest(recent, KEEP_RECENT));
      log.info(`${item.id} filed as #${issue}`);
    } else {
      log.info(`${item.id} added to #${issue} (reported again)`);
    }
    filed[item.id] = { issue, at: this.now() };
    this.d.store.setKv(FILED_KV, newest(filed, KEEP_FILED));
    this.filed += 1;
    return true;
  }

  private async ack(ids: string[]) {
    const keys = await this.keys();
    if (!keys) return;
    try {
      const res = await this.fetch(`${this.mailbox()}/ack`, {
        method: "POST",
        headers: {
          "X-Yo-Core": await coreCredFor(keys.registerKey, BUGS_BOX),
          "Content-Type": "application/json",
          "User-Agent": "Yo-core",
        },
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) log.warn(`acking ${ids.length} report(s) failed: ${res.status}`);
    } catch (err: any) {
      // They're recorded as filed, so the next poll just acks them again.
      log.warn(`acking ${ids.length} report(s) failed: ${err?.message ?? err}`);
    }
  }

  /** <dataDir>/bug-reports/<id>.zip, readable only by this user; the newest KEEP_BUNDLES are kept. */
  private saveBundle(id: string, zip: Buffer) {
    try {
      const dir = path.join(this.d.dataDir, "bug-reports");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, `${id}.zip`), zip, { mode: 0o600 });
      const all = fs
        .readdirSync(dir)
        .filter((n) => /^YO-[A-Z0-9]+\.zip$/.test(n))
        .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t || b.n.localeCompare(a.n));
      for (const old of all.slice(KEEP_BUNDLES)) fs.rmSync(path.join(dir, old.n), { force: true });
    } catch (err) {
      log.warn(`couldn't save the bundle of ${id}`, err);
    }
  }
}

/** The `keep` most recent entries of a map of { at }. */
function newest<T extends { at: number }>(m: Record<string, T>, keep: number): Record<string, T> {
  const entries = Object.entries(m);
  if (entries.length <= keep) return m;
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, keep));
}
