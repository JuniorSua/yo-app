/**
 * BugInbox, the receiving end on the owner's Yo: lists the bug mailbox, opens each report with the private key,
 * saves the bundle, files a GitHub issue (or comments on a recent duplicate) and acks only what's on GitHub.
 * The last test runs the whole path: BugReports → the real relay (memory store) → BugInbox → a fake GitHub.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BugEnvelope } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreCredFor } from "../src/channels/phoneCrypto";
import { openMemoryDb } from "../src/db/db";
import { Store } from "../src/db/store";
import { Hub } from "../src/hub";
import { addSecret, recentLogLines } from "../src/log";
import { MemorySecretStore, trackSecrets } from "../src/secrets/SecretStore";
import { installHashOf, newBugInboxKeyPair, packBugReport, sealBugReport } from "../src/tools/bugCrypto";
import { BugInbox, KEEP_BUNDLES } from "../src/tools/bugInbox";
import { BugReports } from "../src/tools/bugReports";
import { zipFiles } from "../src/zipWriter";

const RELAY = "https://relay.test";
const GH = "https://github.test/api";
const REGISTER_KEY = "register-key-for-tests-0123456789";
const KP = newBugInboxKeyPair();
const INSTALL = installHashOf("inst_abcdefghijklmnopqrstuv");

let dataDir: string;
let store: Store;
let secrets: MemorySecretStore;
let n = 0;

type Item = BugEnvelope & { id: string; at: number };

function report(
  meta: Record<string, unknown>,
  opts: { install?: string; at?: number; zip?: Buffer | null } = {},
) {
  n += 1;
  const zip =
    opts.zip === undefined
      ? zipFiles([
          { name: "report.md", data: `# Bug: ${meta.title}\n` },
          { name: "core-log.txt", data: "hello\n" },
        ])
      : opts.zip;
  const env = sealBugReport(packBugReport(meta, zip), KP.publicKey, opts.install ?? INSTALL);
  return { id: `YO-TEST${String(n).padStart(2, "0")}`, at: opts.at ?? Date.now(), ...env } as Item;
}

const meta = (title: string, extra: Record<string, unknown> = {}) => ({
  version: "0.1.400",
  platform: "Darwin 25.0 (darwin/arm64)",
  title,
  whatHappened: `${title}, then nothing`,
  ...extra,
});

/** A mailbox like the relay's, checking the core credential, plus a GitHub that files issues. */
function fakes() {
  const mailbox: Item[] = [];
  const issues: { number: number; title: string; body: string; labels?: string[] }[] = [];
  const comments: { issue: number; body: string }[] = [];
  const calls: string[] = [];
  const gh = { failNext: 0, status: 503 };
  let cred = "";
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u}`);
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (u.startsWith(RELAY)) {
      cred ||= await coreCredFor(REGISTER_KEY, "bugs");
      if (headers["X-Yo-Core"] !== cred) return new Response("{}", { status: 401 });
      if (u === `${RELAY}/api/relay/bugs` && method === "GET")
        return Response.json({ items: mailbox.slice(0, 5), ...(mailbox.length > 5 ? { more: true } : {}) });
      if (u === `${RELAY}/api/relay/bugs/ack` && method === "POST") {
        const { ids } = JSON.parse(String(init.body));
        for (const id of ids) {
          const i = mailbox.findIndex((m) => m.id === id);
          if (i >= 0) mailbox.splice(i, 1);
        }
        return Response.json({ ok: true });
      }
    }
    if (u.startsWith(GH)) {
      if (headers.Authorization !== "Bearer owner-test-github-token-123")
        return new Response("{}", { status: 401 });
      if (gh.failNext > 0) {
        gh.failNext -= 1;
        return Response.json({ message: "Server Error" }, { status: gh.status });
      }
      const body = JSON.parse(String(init.body));
      const c = /\/repos\/JuniorSua\/yo\/issues\/(\d+)\/comments$/.exec(u);
      if (c) {
        const issue = Number(c[1]);
        if (!issues.some((i) => i.number === issue)) return Response.json({}, { status: 404 });
        comments.push({ issue, body: body.body });
        return Response.json({ id: 1 }, { status: 201 });
      }
      if (u === `${GH}/repos/JuniorSua/yo/issues`) {
        const number = 100 + issues.length;
        issues.push({ number, ...body });
        return Response.json(
          { number, html_url: `https://github.com/JuniorSua/yo/issues/${number}` },
          { status: 201 },
        );
      }
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, mailbox, issues, comments, calls, gh };
}

function inbox(f: typeof fetch, extra: Partial<ConstructorParameters<typeof BugInbox>[0]> = {}) {
  return new BugInbox({
    store,
    secrets: trackSecrets(secrets, addSecret),
    dataDir,
    relayUrl: () => RELAY,
    repo: () => "JuniorSua/yo",
    githubApi: GH,
    fetch: f,
    publicKey: KP.publicKey,
    ...extra,
  });
}

async function keys() {
  await secrets.set("bug-inbox-key", KP.privateKey);
  await secrets.set("phone-register-key", REGISTER_KEY);
  await secrets.set("github-issues-token", "owner-test-github-token-123");
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-bug-inbox-"));
  store = new Store(openMemoryDb());
  secrets = new MemorySecretStore();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("BugInbox (owner's core)", () => {
  it("is off without the bug inbox key or the relay's register key, and never calls the relay", async () => {
    const fx = fakes();
    const bi = inbox(fx.f);
    expect(await bi.pollOnce()).toBeNull();
    await secrets.set("bug-inbox-key", KP.privateKey);
    expect(await bi.pollOnce()).toBeNull();
    await secrets.delete("bug-inbox-key");
    await secrets.set("phone-register-key", REGISTER_KEY);
    expect(await bi.pollOnce()).toBeNull();
    expect(fx.calls).toEqual([]);
    expect(await bi.status()).toMatchObject({ enabled: false, keySet: false, registerKeySet: true });
    await bi.start();
    expect((await bi.status()).nextPollAt).toBeNull();
    bi.stop();
  });

  it("starts by itself when the second key arrives after start", async () => {
    await secrets.set("bug-inbox-key", KP.privateKey);
    const fx = fakes();
    const bi = inbox(fx.f, { pollMs: 60_000 });
    await bi.start();
    expect((await bi.status()).nextPollAt).toBeNull();
    await secrets.set("phone-register-key", REGISTER_KEY); // `yo-ops phone key`
    expect((await bi.status()).enabled).toBe(true);
    await vi.waitFor(() => expect(fx.calls).toEqual([`GET ${RELAY}/api/relay/bugs`]));
    await Promise.all([bi.status(), bi.status(), bi.status()]);
    await new Promise((r) => setTimeout(r, 30));
    expect(fx.calls).toHaveLength(1); // one timer, not one per status check
    bi.stop();
  });

  it("files each report as an issue with labels, the report, the bundle's place, then acks it", async () => {
    await keys();
    const fx = fakes();
    const a = report(
      meta("Calendar shows the wrong day", { expected: "Tuesday", steps: ["Open it"], severity: "high" }),
    );
    const b = report(meta("Ping @someone <!-- hidden -->"), { zip: null });
    fx.mailbox.push(a, b);
    const bi = inbox(fx.f);
    expect(await bi.pollOnce()).toBe(true);

    expect(fx.issues).toHaveLength(2);
    const [i1, i2] = fx.issues;
    expect(i1!.title).toBe("Calendar shows the wrong day");
    expect(i1!.labels).toEqual(["bug", "from-yo", "user-report"]);
    expect(i1!.body).toContain(`<!-- yo:user-report ${a.id} -->`);
    expect(i1!.body).toContain(
      `**${a.id}** · Yo 0.1.400 · Darwin 25.0 (darwin/arm64) · install \`${INSTALL}\``,
    );
    expect(i1!.body).toContain("Severity: high");
    expect(i1!.body).toContain("## Expected\n\nTuesday");
    expect(i1!.body).toContain("1. Open it");
    expect(i1!.body).toContain(`Bundle: Home PC core-data/bug-reports/${a.id}.zip`);
    expect(i1!.body).toContain("- `report.md`");
    expect(i1!.body).toContain("- `core-log.txt`");
    // Untrusted text can't ping anyone or hide anything.
    expect(i2!.title).not.toMatch(/@someone/);
    expect(i2!.title).toContain("&lt;!--");
    expect(i2!.body).toContain("_No diagnostics bundle was attached._");

    const saved = path.join(dataDir, "bug-reports", `${a.id}.zip`);
    expect(fs.existsSync(saved)).toBe(true);
    expect(fs.statSync(saved).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dataDir, "bug-reports", `${b.id}.zip`))).toBe(false);

    expect(fx.mailbox).toHaveLength(0);
    expect(fx.calls.filter((c) => c.endsWith("/bugs/ack"))).toHaveLength(1);
    expect(await bi.status()).toMatchObject({ enabled: true, pending: 0, filed: 2, lastError: null });
  });

  it("leaves reports in the mailbox when GitHub fails, and files them on a later poll", async () => {
    await keys();
    const fx = fakes();
    fx.mailbox.push(report(meta("One")), report(meta("Two")));
    fx.gh.failNext = 1; // the first issue POST: the rest of the poll waits too
    const bi = inbox(fx.f);
    expect(await bi.pollOnce()).toBe(false);
    expect(fx.mailbox).toHaveLength(2);
    expect(fx.calls.some((c) => c.endsWith("/bugs/ack"))).toBe(false);
    expect(await bi.status()).toMatchObject({
      pending: 2,
      lastError: expect.stringMatching(/GitHub answered 503/),
    });

    fx.gh.failNext = 0;
    expect(await bi.pollOnce()).toBe(true);
    expect(fx.issues.map((i) => i.title)).toEqual(["One", "Two"]);
    expect(fx.mailbox).toHaveLength(0);
  });

  it("acks only the reports that made it when GitHub fails halfway", async () => {
    await keys();
    const fx = fakes();
    const one = report(meta("One"));
    const two = report(meta("Two"));
    fx.mailbox.push(one, two);
    const real = fx.f;
    let posts = 0;
    const f = (async (url: string, init: RequestInit = {}) => {
      if (String(url) === `${GH}/repos/JuniorSua/yo/issues` && ++posts === 2)
        return Response.json({}, { status: 502 });
      return real(url, init);
    }) as unknown as typeof fetch;
    expect(await inbox(f).pollOnce()).toBe(false);
    expect(fx.issues.map((i) => i.title)).toEqual(["One"]);
    expect(fx.mailbox.map((m) => m.id)).toEqual([two.id]);
  });

  it("never files twice when an ack is lost", async () => {
    await keys();
    const fx = fakes();
    fx.mailbox.push(report(meta("Once")));
    const real = fx.f;
    let dropAck = true;
    const f = (async (url: string, init: RequestInit = {}) => {
      if (String(url).endsWith("/bugs/ack") && dropAck) {
        dropAck = false;
        throw new TypeError("fetch failed");
      }
      return real(url, init);
    }) as unknown as typeof fetch;
    const bi = inbox(f);
    await bi.pollOnce();
    expect(fx.mailbox).toHaveLength(1);
    await bi.pollOnce();
    expect(fx.mailbox).toHaveLength(0);
    expect(fx.issues).toHaveLength(1);
  });

  it("waits (without acking) when there's no GitHub token", async () => {
    await keys();
    await secrets.delete("github-issues-token");
    const fx = fakes();
    fx.mailbox.push(report(meta("x")));
    const bi = inbox(fx.f);
    expect(await bi.pollOnce()).toBe(false);
    expect(fx.mailbox).toHaveLength(1);
    expect((await bi.status()).lastError).toMatch(/No GitHub token/);
  });

  it("the same install and a near-identical title within 2 h → a comment on the first issue", async () => {
    await keys();
    const fx = fakes();
    const t = Date.UTC(2026, 9, 8, 12);
    fx.mailbox.push(report(meta("Calendar shows the wrong day!"), { at: t }));
    const bi = inbox(fx.f);
    await bi.pollOnce();
    fx.mailbox.push(report(meta("calendar shows the WRONG day"), { at: t + 60 * 60_000 }));
    fx.mailbox.push(
      report(meta("Calendar shows the wrong day"), { at: t + 60 * 60_000, install: "f".repeat(32) }),
    );
    fx.mailbox.push(report(meta("Calendar shows the wrong day"), { at: t + 3 * 60 * 60_000 }));
    await bi.pollOnce();
    expect(fx.issues).toHaveLength(3); // the first, the other install's, and the one 3 h later
    expect(fx.comments).toHaveLength(1);
    expect(fx.comments[0]!.issue).toBe(fx.issues[0]!.number);
    expect(fx.comments[0]!.body).toMatch(/^\*\*Reported again: YO-/);
    expect(fx.mailbox).toHaveLength(0);
  });

  it("drops a report it can't open (tampered, or for another key) without filing it", async () => {
    await keys();
    const fx = fakes();
    const good = report(meta("Good"));
    const tampered = report(meta("Bad"));
    const ct = Buffer.from(tampered.ct, "base64url");
    ct[0]! ^= 1;
    tampered.ct = ct.toString("base64url");
    const other = { ...report(meta("Other")), install: "e".repeat(32) }; // header changed: AAD fails
    fx.mailbox.push(tampered, other, good);
    expect(await inbox(fx.f).pollOnce()).toBe(true);
    expect(fx.issues.map((i) => i.title)).toEqual(["Good"]);
    expect(fx.mailbox).toHaveLength(0);
  });

  it("keeps the newest 200 bundles", async () => {
    await keys();
    const dir = path.join(dataDir, "bug-reports");
    fs.mkdirSync(dir, { recursive: true });
    const old = Date.now() / 1000 - 10_000;
    for (let i = 0; i < KEEP_BUNDLES; i++) {
      const file = path.join(dir, `YO-OLD${String(i).padStart(3, "0")}.zip`);
      fs.writeFileSync(file, "x");
      fs.utimesSync(file, old + i, old + i);
    }
    const fx = fakes();
    const r = report(meta("New"));
    fx.mailbox.push(r);
    await inbox(fx.f).pollOnce();
    const names = fs.readdirSync(dir);
    expect(names).toHaveLength(KEEP_BUNDLES);
    expect(names).toContain(`${r.id}.zip`);
    expect(names).not.toContain("YO-OLD000.zip");
    expect(names).toContain("YO-OLD001.zip");
  });

  it("only accepts the private key that matches the public key, and never logs it", async () => {
    await secrets.set("phone-register-key", REGISTER_KEY);
    const fx = fakes();
    const bi = inbox(fx.f, { pollMs: 60_000 });
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
      writes.push(String(s));
      return true;
    });
    try {
      await expect(bi.configure({ privateKey: "nope" })).rejects.toThrow(/isn't a bug inbox key/);
      await expect(bi.configure({ privateKey: newBugInboxKeyPair().privateKey })).rejects.toThrow(
        /doesn't match/,
      );
      const s = await bi.configure({ privateKey: ` ${KP.privateKey}\n` });
      expect(s).toMatchObject({ enabled: true, keySet: true });
      expect(await secrets.get("bug-inbox-key")).toBe(KP.privateKey);
      await new Promise((r) => setTimeout(r, 20)); // the first poll runs right away
      expect(fx.calls[0]).toBe(`GET ${RELAY}/api/relay/bugs`);
      expect(JSON.stringify(s)).not.toContain(KP.privateKey);
      expect(await bi.configure({ privateKey: null })).toMatchObject({ enabled: false, keySet: false });
    } finally {
      spy.mockRestore();
      bi.stop();
    }
    for (const line of [...writes, ...recentLogLines(1000)]) expect(line).not.toContain(KP.privateKey);
  });

  it("backs off after a failure, then polls at the normal pace again", async () => {
    await keys();
    const fx = fakes();
    let down = true;
    const f = (async (url: string, init?: RequestInit) =>
      down && String(url).startsWith(RELAY)
        ? new Response("{}", { status: 502 })
        : fx.f(url, init)) as typeof fetch;
    // A frozen clock: nextPollAt - T is exactly the wait it chose. Real (short) timers.
    const T = 1_000_000;
    const bi = inbox(f, { pollMs: 200, now: () => T });
    await bi.start();
    await vi.waitFor(async () => expect((await bi.status()).nextPollAt).toBe(T + 400));
    expect((await bi.status()).lastError).toMatch(/502/);
    await vi.waitFor(async () => expect((await bi.status()).nextPollAt).toBe(T + 800), { timeout: 2000 });
    down = false;
    await vi.waitFor(async () => expect((await bi.status()).lastError).toBeNull(), { timeout: 4000 });
    await vi.waitFor(async () => expect((await bi.status()).nextPollAt).toBe(T + 200));
    bi.stop();
  });
});

describe("end to end: a Yo sends, the relay holds it, the owner's Yo files it", () => {
  it("BugReports → relay (memory store) → BugInbox → GitHub", async () => {
    // The real relay, loaded at runtime (it's plain JS in phone/).
    const relayMod: any = await import(new URL("../../../phone/api/relay.js", import.meta.url).href);
    const memMod: any = await import(new URL("../../../phone/lib/memoryStore.js", import.meta.url).href);
    const relay = relayMod.createRelay(memMod.createMemoryStore(), { registerKey: REGISTER_KEY });
    const fx = fakes();
    const f = (async (url: string, init: RequestInit = {}) =>
      String(url).startsWith(RELAY)
        ? relay(new Request(String(url), init as any))
        : fx.f(url, init)) as typeof fetch;

    // A friend's Yo (no keys at all) sends a report.
    const friendStore = new Store(openMemoryDb());
    const yo = friendStore.createAgent({
      name: "Yo",
      role: "",
      instructions: "",
      avatar: { shape: "bubble", color: "yo", eyes: "capsule", accessory: "headset" },
      accountId: null,
      model: null,
      effort: null,
      runtimeMode: "full-access",
      isPrimary: true,
      pinned: false,
    });
    const friendDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-friend-"));
    const sender = new BugReports({
      store: friendStore,
      hub: new Hub(),
      secrets: new MemorySecretStore(),
      dataDir: friendDir,
      environment: () => ["Yo 0.1.400"],
      fetch: f,
      relayUrl: () => RELAY,
      inboxPublicKey: KP.publicKey,
      about: () => ({ version: "0.1.400", platform: "Linux 6.1 (linux/x64)" }),
      logTail: () => ["a log line"],
    });
    const sent = await sender.send({
      report: { what_happened: "The app froze on Send" },
      agentId: yo.id,
      includeChat: false,
    });
    expect(sent.status).toBe("sent");
    expect(sent.reportId).toMatch(/^YO-[A-Z0-9]{6}$/);

    // The owner's Yo picks it up.
    await keys();
    const bi = inbox(f);
    expect(await bi.pollOnce()).toBe(true);
    expect(fx.issues).toHaveLength(1);
    expect(fx.issues[0]!.title).toBe("The app froze on Send");
    expect(fx.issues[0]!.body).toContain(`<!-- yo:user-report ${sent.reportId} -->`);
    expect(fx.issues[0]!.body).toContain("Linux 6.1 (linux/x64)");
    expect(fs.existsSync(path.join(dataDir, "bug-reports", `${sent.reportId}.zip`))).toBe(true);
    // Acked: the mailbox is empty now.
    const list = await relay(
      new Request(`${RELAY}/api/relay/bugs`, {
        headers: { "X-Yo-Core": await coreCredFor(REGISTER_KEY, "bugs") },
      }),
    );
    expect(await list.json()).toEqual({ items: [] });
    fs.rmSync(friendDir, { recursive: true, force: true });
  });
});
