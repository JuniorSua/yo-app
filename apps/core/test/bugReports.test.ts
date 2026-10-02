/**
 * report_bug: draft → the user's OK → submit, the refusals, GitHub filing (fake fetch, never the real API),
 * the prefilled-link fallback, and redaction.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newId } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/db";
import { Store } from "../src/db/store";
import { Hub } from "../src/hub";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { BugReports, consentOf, DEFAULT_ISSUE_REPO, newIssueUrl, redact } from "../src/tools/bugReports";

const HOME = "/Users/alice";

const DRAFT = {
  stage: "draft",
  title: "Chat shows an old image after overwrite",
  what_happened: `The redone desk at ${HOME}/desk.png still showed $76,022`,
  expected: "The new message shows $74,168",
  steps: ["Embed desk.png", "Overwrite desk.png", "Embed it again"],
  evidence: "GET /files?path=desk.png -> 200 (cached)\nAuthorization: Bearer abcdefghijklmnop1234",
  suspected_cause: "The image URL is the same for both versions, so the browser shows its cached copy.",
  suggested_fix: "Snapshot each embedded picture by content hash and serve it immutable.",
  area: "chat",
  severity: "medium",
};

type Call = { url: string; init: RequestInit; body: any };

function fakeGithub(...replies: { status: number; json: unknown }[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    const r = replies.shift() ?? {
      status: 201,
      json: { number: 1, html_url: "https://github.com/x/y/issues/1" },
    };
    return new Response(JSON.stringify(r.json), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

let dataDir: string;
let store: Store;
let hub: Hub;
let secrets: MemorySecretStore;
let pushes: { channel: string; data: any }[];

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

function userSays(agentId: string, text: string, title?: string) {
  store.upsertEntry({
    id: newId("usr"),
    agentId,
    turnId: null,
    item: { id: newId("itm"), kind: "user_message", status: "completed", text, ...(title ? { title } : {}) },
  });
}

function reports(fetchImpl?: typeof fetch) {
  return new BugReports({
    store,
    hub,
    secrets,
    dataDir,
    environment: () => ["Yo 0.1.0", "Agent: Yo on claude (haiku)"],
    githubApi: "https://github.test/api",
    fetch: fetchImpl ?? (fakeGithub().f as typeof fetch),
    homeDirs: [HOME],
  });
}

const draftIdOf = (text: string) => /\[bug-draft:(bdr_[A-Za-z0-9]+)\]/.exec(text)![1]!;
const artifactIdOf = (text: string) => /\[artifact:(art_[A-Za-z0-9]+)\]/.exec(text)![1]!;
const readArtifact = (id: string) => fs.readFileSync(store.artifactFile(id)!.storedPath, "utf8");

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-bugs-"));
  store = new Store(openMemoryDb());
  hub = new Hub();
  secrets = new MemorySecretStore();
  pushes = [];
  hub.subscribe((channel, data) => pushes.push({ channel, data }));
});

afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("report_bug", () => {
  it("drafts without sending anything, then files the approved report on GitHub", async () => {
    const yo = agent("Yo");
    const gh = fakeGithub({
      status: 201,
      json: { number: 123, html_url: "https://github.com/JuniorSua/yo/issues/123" },
    });
    await secrets.set("github-issues-token", "github_pat_fake");
    const br = reports(gh.f);
    userSays(yo.id, "Report this bug for me");

    const drafted = await br.handle(yo.id, DRAFT);
    expect(drafted).toContain("Nothing has been sent");
    expect(drafted).toContain("Would you like me to report it?");
    expect(gh.calls).toHaveLength(0);
    expect(store.listArtifacts()).toHaveLength(0);
    const draftId = draftIdOf(drafted);

    userSays(yo.id, "Report it");
    const filed = await br.handle(yo.id, { stage: "submit", draft_id: draftId });
    expect(filed).toContain("filed as GitHub issue #123 (https://github.com/JuniorSua/yo/issues/123)");

    expect(gh.calls).toHaveLength(1);
    const call = gh.calls[0]!;
    expect(call.url).toBe(`https://github.test/api/repos/${DEFAULT_ISSUE_REPO}/issues`);
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer github_pat_fake");
    expect(call.body.title).toBe(DRAFT.title);
    expect(call.body.labels).toEqual(["bug", "from-yo"]);
    expect(call.body.body).toContain("## Suggested fix\n\nSnapshot each embedded picture");
    // Redacted before it left: no bearer token, no personal home path.
    expect(call.body.body).not.toContain("abcdefghijklmnop1234");
    expect(call.body.body).not.toContain(HOME);
    expect(call.body.body).toContain("~/desk.png");

    const art = store.getArtifact(artifactIdOf(filed))!;
    expect(art.kind).toBe("bug");
    expect(art.title).toBe(`Bug: ${DRAFT.title}`);
    expect(art.issue).toEqual({ number: 123, url: "https://github.com/JuniorSua/yo/issues/123" });
    expect(pushes.find((p) => p.channel === "artifact.new")!.data.issue.number).toBe(123);

    const md = readArtifact(art.id);
    expect(md).toContain(`# Bug: ${DRAFT.title}`);
    expect(md).toContain("Severity: medium · Area: chat");
    expect(md).toContain("## What happened\n\nThe redone desk at ~/desk.png still showed $76,022");
    expect(md).toContain("1. Embed desk.png\n2. Overwrite desk.png\n3. Embed it again");
    expect(md).toContain("## Suspected cause\n\nThe image URL is the same");
    expect(md).toContain("## Environment\n\n- Yo 0.1.0\n- Agent: Yo on claude (haiku)");
    expect(md).toContain("Authorization: [redacted]");
    expect(md).not.toContain("Left blank for the developer");

    // Once only.
    userSays(yo.id, "Thanks");
    await expect(br.handle(yo.id, { stage: "submit", draft_id: draftId })).rejects.toThrow(
      /already submitted as issue #123/,
    );
  });

  it("refuses a submit the user hasn't answered, said no to, or that belongs to another conversation", async () => {
    const yo = agent("Yo");
    const other = agent("Shopper");
    const gh = fakeGithub();
    await secrets.set("github-issues-token", "github_pat_fake");
    const br = reports(gh.f);
    userSays(yo.id, "Look into why the picture is old");
    const draftId = draftIdOf(await br.handle(yo.id, DRAFT));

    await expect(br.handle(yo.id, { stage: "submit" })).rejects.toThrow(/needs the draft_id/);
    await expect(br.handle(yo.id, { stage: "submit", draft_id: "bdr_nope" })).rejects.toThrow(
      /no bug report draft bdr_nope in this conversation/,
    );
    // No message from the user since the draft.
    await expect(br.handle(yo.id, { stage: "submit", draft_id: draftId })).rejects.toThrow(
      /hasn't answered yet/,
    );
    // A routine's prompt is not the user's OK.
    userSays(yo.id, "Daily check", "Routine · Morning");
    await expect(br.handle(yo.id, { stage: "submit", draft_id: draftId })).rejects.toThrow(
      /hasn't answered yet/,
    );
    // Another agent (another conversation) can't submit it, even after its own user message.
    userSays(other.id, "yes");
    await expect(br.handle(other.id, { stage: "submit", draft_id: draftId })).rejects.toThrow(
      /in this conversation/,
    );
    // The card's "Not now".
    userSays(yo.id, "Not now");
    await expect(br.handle(yo.id, { stage: "submit", draft_id: draftId })).rejects.toThrow(/said no/);
    expect(gh.calls).toHaveLength(0);
    expect(store.listArtifacts()).toHaveLength(0);

    // Changing their mind later counts.
    userSays(yo.id, "Okay, go ahead and report it");
    await expect(br.handle(yo.id, { stage: "submit", draft_id: draftId })).resolves.toContain("issue #1");
  });

  it("needs a title and what happened to draft, and treats a call without a stage as a draft", async () => {
    const yo = agent("Yo");
    const br = reports();
    await expect(br.handle(yo.id, { stage: "draft", title: "x" })).rejects.toThrow(/title and what_happened/);
    await expect(br.handle(yo.id, { stage: "later" })).rejects.toThrow(/report_bug: stage/);
    const legacy = await br.handle(yo.id, { title: "Old schema", what_happened: "No stage given" });
    expect(legacy).toContain("[bug-draft:");
  });

  it("applies corrections passed with the submit", async () => {
    const yo = agent("Yo");
    const br = reports();
    await secrets.set("github-issues-token", "github_pat_fake");
    const draftId = draftIdOf(await br.handle(yo.id, DRAFT));
    userSays(yo.id, "Yes, but it's high severity");
    const out = await br.handle(yo.id, { stage: "submit", draft_id: draftId, severity: "high" });
    expect(out).toContain("Applied your changes to: severity");
    expect(readArtifact(artifactIdOf(out))).toContain("Severity: high");
  });

  it("without a GitHub token: saves it and offers a prefilled new-issue link", async () => {
    const yo = agent("Yo");
    const gh = fakeGithub();
    const br = reports(gh.f);
    const draftId = draftIdOf(await br.handle(yo.id, DRAFT));
    userSays(yo.id, "yes please");
    const out = await br.handle(yo.id, { stage: "submit", draft_id: draftId });
    expect(out).toContain("wasn't sent: GitHub filing isn't set up");
    expect(out).toContain("Open on GitHub");
    expect(gh.calls).toHaveLength(0);
    const art = store.getArtifact(artifactIdOf(out))!;
    expect(art.issue!.number).toBeUndefined();
    const url = new URL(art.issue!.url);
    expect(url.origin + url.pathname).toBe(`https://github.com/${DEFAULT_ISSUE_REPO}/issues/new`);
    expect(url.searchParams.get("title")).toBe(DRAFT.title);
    expect(url.searchParams.get("labels")).toBe("bug,from-yo");
    expect(url.searchParams.get("body")).toContain("## Suggested fix");
    expect(url.searchParams.get("body")).not.toContain("abcdefghijklmnop1234");
  });

  it("falls back to the link when GitHub refuses, and retries without labels on 422", async () => {
    const yo = agent("Yo");
    await secrets.set("github-issues-token", "github_pat_bad");
    const bad = fakeGithub({ status: 401, json: { message: "Bad credentials" } });
    const br = reports(bad.f);
    const d1 = draftIdOf(await br.handle(yo.id, DRAFT));
    userSays(yo.id, "Report it");
    const out = await br.handle(yo.id, { stage: "submit", draft_id: d1 });
    expect(out).toContain("filing it on GitHub failed: GitHub answered 401 (Bad credentials)");
    expect(store.getArtifact(artifactIdOf(out))!.issue!.url).toContain("/issues/new?");

    const picky = fakeGithub(
      { status: 422, json: { message: "Validation Failed" } },
      { status: 201, json: { number: 7, html_url: "https://github.com/JuniorSua/yo/issues/7" } },
    );
    const br2 = reports(picky.f);
    const d2 = draftIdOf(await br2.handle(yo.id, DRAFT));
    userSays(yo.id, "Report it");
    expect(await br2.handle(yo.id, { stage: "submit", draft_id: d2 })).toContain("issue #7");
    expect(picky.calls.map((c) => c.body.labels)).toEqual([["bug", "from-yo"], undefined]);
  });

  it("stores the token write-only and validates the repo", async () => {
    const br = reports();
    expect(await br.status()).toEqual({
      configured: false,
      repo: DEFAULT_ISSUE_REPO,
      defaultRepo: DEFAULT_ISSUE_REPO,
    });
    const s = await br.configure({ token: " github_pat_secret ", repo: "https://github.com/me/my-yo.git" });
    expect(s).toEqual({ configured: true, repo: "me/my-yo", defaultRepo: DEFAULT_ISSUE_REPO });
    expect(JSON.stringify(s)).not.toContain("secret");
    expect(await secrets.get("github-issues-token")).toBe("github_pat_secret");
    await expect(br.configure({ repo: "not a repo" })).rejects.toThrow(/owner\/name/);
    await expect(br.configure({ token: "has spaces in it" })).rejects.toThrow(/GitHub token/);
    expect(await br.configure({ token: null, repo: null })).toMatchObject({
      configured: false,
      repo: DEFAULT_ISSUE_REPO,
    });
  });
});

describe("consent and double filing", () => {
  it("reads replies to 'Would you like me to report it?'", () => {
    const table: [string, "yes" | "no" | "unclear"][] = [
      ["Report it", "yes"],
      ["yes", "yes"],
      ["Yes please", "yes"],
      ["YEAH", "yes"],
      ["yep.", "yes"],
      ["sure", "yes"],
      ["ok", "yes"],
      ["Okay, go ahead", "yes"],
      ["go ahead", "yes"],
      ["Do it!", "yes"],
      ["file it", "yes"],
      ["please submit it", "yes"],
      ["send it", "yes"],
      ["please do", "yes"],
      ["Sounds good", "yes"],
      ["👍", "yes"],
      ["Yes, but change the title to 'Old picture after redo'", "yes"],
      ["yes and mark it high severity", "yes"],
      ["Not now", "no"],
      ["no", "no"],
      ["No, don't report it", "no"],
      ["not yet", "no"],
      ["hold off", "no"],
      ["don't", "no"],
      ["ok but don't send it yet", "unclear"],
      ["yes, but wait until tomorrow", "unclear"],
      ["sure, later", "unclear"],
      ["ok?", "unclear"],
      ["Should we report it?", "unclear"],
      ["What would the report say?", "unclear"],
      ["Also, can you check my calendar", "unclear"],
      ["thanks", "unclear"],
      ["okayish", "unclear"],
      ["Yesterday it worked", "unclear"],
      ["", "unclear"],
    ];
    for (const [reply, want] of table) expect([reply, consentOf(reply)]).toEqual([reply, want]);
  });

  it("only the latest reply counts, and only one sent after the drafting turn ended", async () => {
    const yo = agent("Yo");
    const br = reports();
    userSays(yo.id, "Report this bug");
    store.createTurn({ id: "trn_1", agentId: yo.id, sessionId: null, trigger: "user" });
    const draftId = draftIdOf(await br.handle(yo.id, DRAFT));
    // Typed while the agent was still working (before it asked): doesn't count, and the turn is still running.
    userSays(yo.id, "yes");
    await expect(br.handle(yo.id, { stage: "submit", draft_id: draftId })).rejects.toThrow(
      /hasn't answered yet/,
    );
    await new Promise((r) => setTimeout(r, 5));
    store.finishTurn("trn_1", "completed");
    await expect(br.handle(yo.id, { stage: "submit", draft_id: draftId })).rejects.toThrow(
      /hasn't answered yet/,
    );
    await new Promise((r) => setTimeout(r, 5));
    userSays(yo.id, "yes");
    userSays(yo.id, "hmm, what would it say?");
    await expect(br.handle(yo.id, { stage: "submit", draft_id: draftId })).rejects.toThrow(
      /isn't a clear yes.*Would you like me to report it\?/,
    );
    userSays(yo.id, "Report it");
    await expect(br.handle(yo.id, { stage: "submit", draft_id: draftId })).resolves.toContain("[artifact:");
  });

  it("files once when two submits race", async () => {
    const yo = agent("Yo");
    await secrets.set("github-issues-token", "github_pat_fake");
    const calls: string[] = [];
    const slow = (async (url: string) => {
      calls.push(String(url));
      await new Promise((r) => setTimeout(r, 30));
      return new Response(
        JSON.stringify({ number: 9, html_url: "https://github.com/JuniorSua/yo/issues/9" }),
        {
          status: 201,
        },
      );
    }) as unknown as typeof fetch;
    const br = reports(slow);
    const draftId = draftIdOf(await br.handle(yo.id, DRAFT));
    userSays(yo.id, "Report it");
    const results = await Promise.allSettled([
      br.handle(yo.id, { stage: "submit", draft_id: draftId }),
      br.handle(yo.id, { stage: "submit", draft_id: draftId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/already submitted|being submitted/);
    expect(calls).toHaveLength(1);
    expect(store.listArtifacts()).toHaveLength(1);
    expect(store.getBugDraft(draftId)!.status).toBe("submitted");
  });

  it("gives the draft back when saving fails, so a retry works", async () => {
    const yo = agent("Yo");
    const notADir = path.join(dataDir, "file");
    fs.writeFileSync(notADir, "x");
    const broken = new BugReports({ store, hub, secrets, dataDir: notADir, environment: () => [] });
    const draftId = draftIdOf(await broken.handle(yo.id, DRAFT));
    userSays(yo.id, "yes");
    await expect(broken.handle(yo.id, { stage: "submit", draft_id: draftId })).rejects.toThrow();
    expect(store.getBugDraft(draftId)!.status).toBe("draft");
    await expect(reports().handle(yo.id, { stage: "submit", draft_id: draftId })).resolves.toContain(
      "[artifact:",
    );
  });

  it("still saves the report when the secret store fails", async () => {
    const yo = agent("Yo");
    const br = reports();
    secrets.get = async () => {
      throw new Error("keychain locked");
    };
    const draftId = draftIdOf(await br.handle(yo.id, DRAFT));
    userSays(yo.id, "yes");
    const out = await br.handle(yo.id, { stage: "submit", draft_id: draftId });
    expect(out).toContain("filing it on GitHub failed: keychain locked");
    expect(store.listArtifacts()).toHaveLength(1);
    expect(store.getBugDraft(draftId)!.status).toBe("submitted");
  });
});

describe("redaction", () => {
  it("removes obvious secrets and home folders", () => {
    const text = [
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "pat github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      "anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "openai sk-proj-ABCDEFGHIJKLMNOPQRST",
      "curl -H 'Authorization: Bearer abc.def.ghi-jkl'",
      "Cookie: session=abc123; theme=dark",
      'config {"api_key": "AKIAXXXX1234", "password":"hunter22"}',
      "url https://x.test/?access_token=zzzzzzzz&q=1",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "aws AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
      "paths /Users/alice/Library/Logs/yo.log and /home/agent/desk.png and C:\\Users\\Alice\\yo.txt",
      "keep https://example.com/home/page and max_tokens=4000 and a token expired",
    ].join("\n");
    const out = redact(text, ["/Users/alice"]);
    for (const secret of [
      "ghp_abc",
      "github_pat_11",
      "sk-ant-api03",
      "sk-proj-",
      "abc.def.ghi",
      "session=abc123",
      "AKIAXXXX1234",
      "hunter22",
      "zzzzzzzz",
      "eyJhbGci",
      "AKIAIOSFODNN7EXAMPLE",
      "b3BlbnNzaC1rZXktdjEAAAAA",
      "/Users/alice",
      "/home/agent",
      "C:\\Users\\Alice",
    ])
      expect(out).not.toContain(secret);
    expect(out).toContain("~/Library/Logs/yo.log");
    expect(out).toContain("~/desk.png");
    expect(out).toContain("~\\yo.txt");
    expect(out).toContain('"password":"[redacted]"');
    expect(out).toContain("https://example.com/home/page");
    expect(out).toContain("max_tokens=4000");
    expect(out).toContain("a token expired");
  });

  it("hides emails, LAN and Tailscale addresses but keeps loopback, public IPs and versions", () => {
    const text = [
      "mail jane.doe+yo@mail.example.org and ops@lan.home.example.net",
      "lan 192.168.1.20:7777, 10.0.0.5. and 172.20.3.4",
      "tailscale 100.101.102.103 at homepc.tail1234.ts.net",
      "keep 127.0.0.1, localhost:5173, 8.8.8.8, 172.32.0.1, 100.128.0.1, 192.169.0.1",
      "versions 10.2.3.4.5 and v1.2.3.4-beta and node 22.10.0 and 999.168.1.1",
    ].join("\n");
    const out = redact(text, []);
    for (const leak of [
      "jane.doe+yo@mail.example.org",
      "ops@lan.home.example.net",
      "192.168.1.20",
      "10.0.0.5",
      "172.20.3.4",
      "100.101.102.103",
      "tail1234.ts.net",
    ])
      expect(out).not.toContain(leak);
    expect(out).toContain("mail [email] and [email]");
    expect(out).toContain("lan [private address]:7777, [private address]. and [private address]");
    expect(out).toContain("tailscale [private address] at [tailnet host]");
    expect(out).toContain("keep 127.0.0.1, localhost:5173, 8.8.8.8, 172.32.0.1, 100.128.0.1, 192.169.0.1");
    expect(out).toContain("versions 10.2.3.4.5 and v1.2.3.4-beta and node 22.10.0 and 999.168.1.1");
  });

  it("keeps prefilled links under the limit and says where the full report is", () => {
    const body = `## What happened\n\n${"Ünïcode 🐞 line\n".repeat(2000)}`;
    const url = newIssueUrl("JuniorSua/yo", "Huge report", body, 7000);
    expect(url.length).toBeLessThanOrEqual(7000);
    const got = new URL(url).searchParams.get("body")!;
    expect(got).toContain("The full report is saved in Yo's Artifacts");
    expect(got.startsWith("## What happened")).toBe(true);
    expect(newIssueUrl("JuniorSua/yo", "Small", "short")).toContain("body=short");
  });
});
