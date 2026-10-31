/**
 * One-click bug reports, the sending side: the Settings form and the red card's Send go, encrypted to the bug
 * inbox key, to the bug mailbox on the Yo Phone relay (a fake here, never the real one) with a zip of
 * diagnostics. Checks the envelope, the bundle's files, that nothing secret gets into it, that "Include recent
 * chat" is respected, the size limit, and the retry → prefilled-link fallback.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUG_INBOX_PUBLIC_KEY, newId } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDb } from "../src/db/db";
import { Store } from "../src/db/store";
import { Hub } from "../src/hub";
import { addSecret } from "../src/log";
import { MemorySecretStore, trackSecrets } from "../src/secrets/SecretStore";
import { installHashOf, newBugInboxKeyPair, openBugReport, unpackBugReport } from "../src/tools/bugCrypto";
import { BugReports, MAX_REPORT_BYTES, RETRY_WINDOW_MS, titleFrom } from "../src/tools/bugReports";
import { unzipFiles } from "../src/zipWriter";

const HOME = "/Users/alice";
const RELAY = "https://relay.test";
const INBOX = `${RELAY}/api/relay/bugs`;
/** The test's own bug inbox key pair (the real private key is only on the owner's PC). */
const KP = newBugInboxKeyPair();
/** Secrets planted everywhere a bundle reads from. None may come out. */
const S = {
  stored: "keychain-value-ZXCVBNM-0987", // a SecretStore value no pattern recognizes
  registered: "agentd-token-QWERTY-12345", // registered with addSecret (like the agentd token)
  pat: "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
  anthropic: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
  phoneKey: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA",
  email: "alice.smith@example.com",
  ip: "192.168.1.23",
  home: `${HOME}/Documents/taxes`,
};

/** `env`: what the relay sees. `body` and `zip`: what the owner's Yo gets when it opens it. */
type Post = {
  url: string;
  env: any;
  raw: string;
  body: any;
  zip: Buffer | null;
  headers: Record<string, string>;
};

function fakeInbox(...replies: { status: number; json?: unknown; headers?: Record<string, string> }[]) {
  const posts: Post[] = [];
  let n = 0;
  const f = (async (url: string, init: RequestInit) => {
    const raw = String(init.body);
    const env = JSON.parse(raw);
    const { meta, zip } = unpackBugReport(openBugReport(env, KP.privateKey));
    posts.push({
      url: String(url),
      env,
      raw,
      body: meta,
      zip,
      headers: init.headers as Record<string, string>,
    });
    const r = replies.shift() ?? { status: 200, json: { ok: true, reportId: `YO-ABC${++n}` } };
    return new Response(JSON.stringify(r.json ?? { ok: false }), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, posts };
}

let dataDir: string;
let store: Store;
let hub: Hub;
let secrets: MemorySecretStore;
let now: number;
let logLines: string[];

function agent(name: string) {
  return store.createAgent({
    name,
    role: "",
    instructions: "",
    avatar: { shape: "bubble", color: "yo", eyes: "capsule", accessory: "headset" },
    accountId: null,
    model: null,
    effort: null,
    runtimeMode: "full-access",
    isPrimary: name === "Yo",
    pinned: false,
  });
}

function say(agentId: string, kind: "user_message" | "assistant_message", text: string) {
  store.upsertEntry({
    id: newId("tl"),
    agentId,
    turnId: null,
    item: { id: newId("itm"), kind, status: "completed", text },
  });
}

function reports(f: typeof fetch, extra: Partial<ConstructorParameters<typeof BugReports>[0]> = {}) {
  return new BugReports({
    store,
    hub,
    secrets: trackSecrets(secrets, addSecret),
    dataDir,
    environment: () => ["Yo 0.1.300", "Agent: Yo on claude"],
    githubApi: "https://github.test/api",
    fetch: f,
    homeDirs: [HOME],
    relayUrl: () => `${RELAY}/`,
    inboxPublicKey: KP.publicKey,
    about: () => ({ version: "0.1.300 (build 300-abc)", platform: "Darwin 25.0 (darwin/arm64)" }),
    diagnostics: () => ({
      computer: { mode: "local", note: `token=${S.registered} at ${S.home}` },
      providers: [{ provider: "claude", status: "authenticated", message: `signed in as ${S.email}` }],
    }),
    logTail: (n) => logLines.slice(-n),
    ...extra,
  });
}

const bundleOf = (p: Post) => unzipFiles(p.zip!);
const allText = (p: Post) =>
  [p.raw, JSON.stringify(p.body), ...[...bundleOf(p).values()].map((b) => b.toString("utf8"))].join("\n");

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-bug-inbox-"));
  store = new Store(openMemoryDb());
  hub = new Hub();
  secrets = new MemorySecretStore();
  now = Date.UTC(2026, 9, 8, 12);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  addSecret(S.registered);
  await secrets.set("some-provider-key", S.stored);
  logLines = [
    "2026-10-08T12:00:00.000Z INFO [core] listening",
    `2026-10-08T12:00:01.000Z WARN [phone] link https://yo-phone.vercel.app/#k=${S.phoneKey} from ${S.ip}`,
    `2026-10-08T12:00:02.000Z ERROR [x] failed reading ${S.home}/a.txt with ${S.anthropic}`,
  ];
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Moves the clock (Date only; timers stay real). */
function advance(ms: number) {
  now += ms;
  vi.setSystemTime(now);
}

describe("bug inbox (core)", () => {
  it("sends the Settings form to the inbox with a redacted bundle, without the chat when unchecked", async () => {
    const yo = agent("Yo");
    say(yo.id, "user_message", "Book the dentist");
    const inbox = fakeInbox();
    const br = reports(inbox.f);
    // A SecretStore read registers the value for redaction (the store is tracked in main.ts too).
    expect(await trackSecrets(secrets, addSecret).get("some-provider-key")).toBe(S.stored);

    const res = await br.send({
      report: {
        what_happened: `The calendar showed the wrong day. My key ${S.stored} and mail ${S.email}`,
        expected: "Tuesday",
        steps: ["Open Calendar", `Look at ${S.home}`],
      },
      includeChat: false,
    });
    expect(res).toMatchObject({ status: "sent", reportId: "YO-ABC1" });
    expect(inbox.posts).toHaveLength(1);
    const post = inbox.posts[0]!;
    expect(post.url).toBe(INBOX);
    expect(post.headers.Origin).toBeUndefined();
    expect(post.body).toMatchObject({
      version: "0.1.300 (build 300-abc)",
      platform: "Darwin 25.0 (darwin/arm64)",
      title: "The calendar showed the wrong day. My key [redacted] and mail…",
      expected: "Tuesday",
      steps: ["Open Calendar", "Look at ~/Documents/taxes"],
    });
    // The relay sees an envelope only: a hash of the install id and ciphertext.
    expect(Object.keys(post.env).sort()).toEqual(["ct", "epk", "install", "iv", "v"]);
    expect(post.env.install).toBe(installHashOf(br.installId()));
    expect(post.env.install).toMatch(/^[0-9a-f]{32}$/);
    expect(br.installId()).toMatch(/^inst_[A-Za-z0-9_-]{16,}$/);
    expect(post.raw).not.toContain(br.installId());
    expect(post.raw).not.toContain("calendar");
    expect(Object.keys(post.body).sort()).toEqual(
      ["expected", "platform", "steps", "title", "version", "whatHappened"].sort(),
    );

    const files = bundleOf(post);
    expect([...files.keys()]).toEqual(["report.md", "environment.json", "core-log.txt"]);
    expect(files.get("report.md")!.toString()).toContain("Reported by the user (Settings → Bug reports)");
    const env = JSON.parse(files.get("environment.json")!.toString());
    expect(env.providers[0]).toMatchObject({ provider: "claude", status: "authenticated" });
    expect(files.get("core-log.txt")!.toString()).toContain("INFO [core] listening");
    expect(files.get("core-log.txt")!.toString()).toContain("#k=[redacted]");

    for (const secret of Object.values(S)) expect(allText(post)).not.toContain(secret);

    const art = store.getArtifact(res.artifactId)!;
    expect(art.kind).toBe("bug");
    expect(art.report).toMatchObject({
      status: "sent",
      reportId: "YO-ABC1",
      includeChat: false,
      attempts: 1,
    });
    expect(art.report!.sentAt).toBe(now);

    // The install id is made once.
    await br.send({ report: { what_happened: "Again" }, includeChat: false });
    expect(inbox.posts[1]!.env.install).toBe(post.env.install);
    // A fresh one-time key every time.
    expect(inbox.posts[1]!.env.epk).not.toBe(post.env.epk);
  });

  it("adds the redacted recent chat only when the user leaves it checked", async () => {
    const yo = agent("Yo");
    for (let i = 0; i < 40; i++) say(yo.id, "user_message", `message ${i}`);
    say(yo.id, "assistant_message", `Your token is ${S.pat}; I saved ${S.home}/notes.md for ${S.email}`);
    const inbox = fakeInbox();
    const br = reports(inbox.f);
    await br.send({ report: { what_happened: "It froze" }, agentId: yo.id, includeChat: true });
    const files = bundleOf(inbox.posts[0]!);
    const chat = JSON.parse(files.get("chat-excerpt.json")!.toString());
    expect(chat).toHaveLength(30);
    expect(chat[0].text).toBe("message 11");
    expect(chat.at(-1).text).toBe(
      "Your token is [redacted token]; I saved ~/Documents/taxes/notes.md for [email]",
    );
    for (const secret of Object.values(S)) expect(allText(inbox.posts[0]!)).not.toContain(secret);
    expect(store.getArtifact(store.listArtifacts()[0]!.id)!.report!.includeChat).toBe(true);
  });

  it("previews exactly what Send would send, without saving or sending anything", async () => {
    const yo = agent("Yo");
    say(yo.id, "user_message", "hello");
    const inbox = fakeInbox();
    const br = reports(inbox.f);
    const p = br.preview({
      report: { what_happened: "Settings didn't save.\nMore detail here." },
      includeChat: true,
    });
    expect(p.title).toBe("Settings didn't save.");
    expect(p.files.map((f) => f.name)).toEqual([
      "report.md",
      "environment.json",
      "core-log.txt",
      "chat-excerpt.json",
    ]);
    expect(p.files.every((f) => f.bytes > 0)).toBe(true);
    expect(p.reportMd).toContain("# Bug: Settings didn't save.");
    expect(br.preview({ report: { what_happened: "x" }, includeChat: false }).files).toHaveLength(3);
    expect(inbox.posts).toHaveLength(0);
    expect(store.listArtifacts()).toHaveLength(0);
    expect(() => br.preview({ report: { what_happened: "  " }, includeChat: false })).toThrow(
      /what happened/,
    );
  });

  it("sends a chat draft from the red card once, and the agent can't send it again", async () => {
    const yo = agent("Yo");
    say(yo.id, "user_message", "report this bug");
    const inbox = fakeInbox();
    const br = reports(inbox.f);
    const drafted = await br.handle(yo.id, {
      stage: "draft",
      title: "Old picture",
      what_happened: "The chat shows an old image",
      suspected_cause: "Browser cache",
      suggested_fix: "Content-hash the URL",
      severity: "medium",
    });
    const draftId = /\[bug-draft:(bdr_[A-Za-z0-9]+)\]/.exec(drafted)![1]!;
    const first = await br.send({ draftId, includeChat: true });
    expect(first.status).toBe("sent");
    const body = inbox.posts[0]!.body;
    expect(body.title).toBe("Old picture");
    expect(body.severity).toBe("medium");
    expect(body.agentReport).toContain("## Suspected cause\n\nBrowser cache");
    expect(bundleOf(inbox.posts[0]!).has("chat-excerpt.json")).toBe(true);
    expect(store.getArtifact(first.artifactId)!.report!.draftId).toBe(draftId);
    expect(store.getBugDraft(draftId)!.status).toBe("submitted");

    // A second click returns the same result without sending again.
    expect(await br.send({ draftId, includeChat: true })).toEqual(first);
    expect(inbox.posts).toHaveLength(1);
    say(yo.id, "user_message", "yes");
    await expect(br.handle(yo.id, { stage: "submit", draft_id: draftId })).rejects.toThrow(
      /already submitted as YO-ABC1/,
    );
  });

  it("an agent's submit after a typed yes goes to the inbox too, without the chat", async () => {
    const yo = agent("Yo");
    say(yo.id, "user_message", "report this bug");
    const inbox = fakeInbox();
    const br = reports(inbox.f);
    const drafted = await br.handle(yo.id, { stage: "draft", title: "Crash", what_happened: "It crashed" });
    const draftId = /\[bug-draft:(bdr_[A-Za-z0-9]+)\]/.exec(drafted)![1]!;
    say(yo.id, "user_message", "Yes please");
    const out = await br.handle(yo.id, { stage: "submit", draft_id: draftId });
    expect(out).toMatch(/^Reported: sent to the developer as YO-ABC1 \[artifact:art_/);
    expect(bundleOf(inbox.posts[0]!).has("chat-excerpt.json")).toBe(false);
  });

  it("keeps a report it couldn't send, retries with backoff, and sends it later", async () => {
    agent("Yo");
    const inbox = fakeInbox({ status: 503, json: { ok: false, error: "down" } }, { status: 500 });
    const pushes: any[] = [];
    hub.subscribe((channel, data) => channel === "artifact.new" && pushes.push(data));
    const br = reports(inbox.f);
    const res = await br.send({ report: { what_happened: "Lost my note" }, includeChat: false });
    expect(res.status).toBe("pending");
    let art = store.getArtifact(res.artifactId)!;
    expect(art.report).toMatchObject({
      status: "pending",
      attempts: 1,
      nextTryAt: now + 60_000,
      error: "down",
    });
    expect(pushes.at(-1).report.status).toBe("pending");

    await br.retryPending(); // not due yet
    expect(inbox.posts).toHaveLength(1);
    advance(60_000);
    await br.retryPending(); // 500 again: next wait is 5 minutes
    expect(inbox.posts).toHaveLength(2);
    art = store.getArtifact(res.artifactId)!;
    expect(art.report).toMatchObject({ status: "pending", attempts: 2, nextTryAt: now + 5 * 60_000 });
    advance(5 * 60_000);
    await br.retryPending();
    art = store.getArtifact(res.artifactId)!;
    expect(art.report).toMatchObject({ status: "sent", reportId: "YO-ABC1", attempts: 3 });
    expect(inbox.posts[2]!.zip).toEqual(inbox.posts[0]!.zip);
    expect(pushes.at(-1).report.status).toBe("sent");
    expect(store.pendingBugReports()).toHaveLength(0);
  });

  it("honors Retry-After, and after a day offers the prefilled GitHub link", async () => {
    agent("Yo");
    const busy = { status: 429, json: { ok: false, error: "Too many" }, headers: { "Retry-After": "3600" } };
    const inbox = fakeInbox(busy, ...Array(40).fill({ status: 503 }));
    const br = reports(inbox.f);
    const res = await br.send({ report: { what_happened: "Nothing loads" }, includeChat: false });
    expect(store.getArtifact(res.artifactId)!.report!.nextTryAt).toBe(now + 3_600_000);
    for (let i = 0; i < 30 && store.pendingBugReports().length; i++) {
      advance(4 * 60 * 60 * 1000);
      await br.retryPending();
    }
    const art = store.getArtifact(res.artifactId)!;
    expect(art.report!.status).toBe("failed");
    expect(now - art.createdAt).toBeGreaterThanOrEqual(RETRY_WINDOW_MS - 4 * 60 * 60 * 1000);
    expect(art.issue!.url).toMatch(
      /^https:\/\/github\.com\/JuniorSua\/yo\/issues\/new\?title=Nothing%20loads/,
    );
    expect((await br.send({ report: { what_happened: "x" }, includeChat: false })).status).toBe("pending");
  });

  it("gives up at once when the inbox refuses the report (4xx)", async () => {
    agent("Yo");
    const inbox = fakeInbox({ status: 400, json: { ok: false, error: "title is required" } });
    const res = await reports(inbox.f).send({ report: { what_happened: "x" }, includeChat: false });
    expect(res.status).toBe("failed");
    expect(res.fallbackUrl).toMatch(/^https:\/\/github\.com\//);
    expect(store.getArtifact(res.artifactId)!.report!.error).toBe("title is required");
  });

  it("treats a network error as 'try again later'", async () => {
    agent("Yo");
    const f = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const res = await reports(f).send({ report: { what_happened: "x" }, includeChat: false });
    expect(res.status).toBe("pending");
  });

  it("files directly on GitHub when the owner stored a token, and uses the link when the inbox is off", async () => {
    agent("Yo");
    await secrets.set("github-issues-token", "github_pat_owner_token_123456");
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/x/y/issues/7" }), {
        status: 201,
      });
    }) as unknown as typeof fetch;
    const res = await reports(f).send({ report: { what_happened: "x" }, includeChat: true });
    expect(res).toMatchObject({ status: "filed", issueNumber: 7 });
    expect(calls).toEqual(["https://github.test/api/repos/JuniorSua/yo/issues"]);

    await secrets.delete("github-issues-token");
    const off = fakeInbox();
    const offRes = await reports(off.f, { relayUrl: () => "" }).send({
      report: { what_happened: "y" },
      includeChat: false,
    });
    expect(offRes.status).toBe("failed");
    expect(offRes.fallbackUrl).toContain("/issues/new?");
    expect(off.posts).toHaveLength(0);
  });

  it("keeps a report under the mailbox's size: trims the log first, then the chat", async () => {
    const yo = agent("Yo");
    // Random-looking text doesn't compress: 400 lines of 2 KB is ~800 KB of log, 30 items of ~4 KB of chat.
    const noise = (n: number, seed: number) => {
      let x = seed;
      let s = "";
      while (s.length < n) {
        x = (x * 1103515245 + 12345) % 2 ** 31;
        s += x.toString(36);
      }
      return s.slice(0, n);
    };
    logLines = Array.from({ length: 400 }, (_, i) => `line ${i} ${noise(2000, i + 1)}`);
    for (let i = 0; i < 30; i++) say(yo.id, "user_message", noise(3900, 1000 + i));
    const inbox = fakeInbox();
    const br = reports(inbox.f);

    await br.send({ report: { what_happened: "Huge" }, agentId: yo.id, includeChat: true });
    let post = inbox.posts[0]!;
    let files = bundleOf(post);
    expect(post.raw.length).toBeLessThan(600 * 1024);
    expect(JSON.stringify(post.body).length + 1 + post.zip!.length).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    // 100 lines of log (~200 KB) still fit with the whole chat.
    expect(files.get("core-log.txt")!.toString().trim().split("\n")).toHaveLength(100);
    expect(JSON.parse(files.get("chat-excerpt.json")!.toString())).toHaveLength(30);

    // Even 100 lines are too much: no log at all, and the chat still goes.
    logLines = Array.from({ length: 400 }, (_, i) => `line ${i} ${noise(8000, i + 7)}`);
    await br.send({ report: { what_happened: "Huger" }, agentId: yo.id, includeChat: true });
    post = inbox.posts[1]!;
    files = bundleOf(post);
    expect(post.raw.length).toBeLessThan(600 * 1024);
    expect(files.get("core-log.txt")!.toString()).toBe("(nothing logged yet)\n");
    expect(JSON.parse(files.get("chat-excerpt.json")!.toString())).toHaveLength(30);
  });

  it("sends to the owner's public key by default", async () => {
    agent("Yo");
    const inbox: string[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      inbox.push(String(init.body));
      return new Response(JSON.stringify({ ok: true, reportId: "YO-ABCDEF" }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await reports(f, { inboxPublicKey: undefined }).send({
      report: { what_happened: "x" },
      includeChat: false,
    });
    expect(res.status).toBe("sent");
    // Only the real private key opens it; the test's doesn't.
    expect(() => openBugReport(JSON.parse(inbox[0]!), KP.privateKey)).toThrow(/couldn't be opened/);
    expect(BUG_INBOX_PUBLIC_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("makes a short title from what happened", () => {
    expect(titleFrom("  It broke \n details")).toBe("It broke");
    const long = titleFrom("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(81);
    expect(long.endsWith("…")).toBe(true);
  });
});
