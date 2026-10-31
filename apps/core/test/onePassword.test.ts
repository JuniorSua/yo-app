/**
 * 1Password end to end in core, with a fake 1Password (no real account) and the fake agentd: connecting, the
 * agents' search and fill tools, the approval card, the audit, the errors, and that no secret (the token, a
 * username, a password, a code) reaches the model, the chat, the timeline, logs, bug reports or prompts.
 * Every value here is made up.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiPushChannel, LoginSite } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { recentLogLines, redact } from "../src/log";
import { startCore } from "../src/main";
import type { BackendFactory, LoginSecrets, VaultInfo } from "../src/onepassword/backend";
import { looksLikeToken, TOKEN_KEY } from "../src/onepassword/OnePassword";
import { buildHelperSystemAppend, buildSystemAppend } from "../src/orchestrator/PromptBuilder";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { redact as redactBugReport } from "../src/tools/bugReports";
import { MockAgentd } from "./mockAgentd";

const TOKEN = "t".repeat(64);
const OP_TOKEN = "ops_FAKEtokenFAKEtokenFAKEtoken0123456789";
const USERNAME = "made-up-user@example.com";
const PASSWORD = "Fake-Passw0rd-Never-Real-77";
const CODE = "482913";

async function until(fn: () => boolean | Promise<boolean>, ms = 5000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A pretend 1Password: one vault, two logins. Counts calls; can turn the token down or go offline. */
class FakeOnePassword {
  calls: string[] = [];
  tokens: string[] = [];
  fail: string | null = null;
  vaults: VaultInfo[] = [{ id: "vltYo", title: "Yo", items: 2 }];
  items: (LoginSecrets & { id: string })[] = [
    {
      id: "itmGithub",
      title: "GitHub",
      sites: [{ url: "https://github.com", mode: "anywhere" }],
      username: USERNAME,
      password: PASSWORD,
      oneTimeCode: CODE,
    },
    {
      id: "itmBank",
      title: "Bank",
      sites: [{ url: "https://bank.example.com", mode: "exact" }],
      username: "someone",
      password: "another-fake-password",
    },
  ];

  factory: BackendFactory = async (token) => {
    this.tokens.push(token);
    if (this.fail) throw new Error(this.fail);
    const guard = (what: string) => {
      this.calls.push(what);
      if (this.fail) throw new Error(this.fail);
    };
    return {
      vaults: async () => {
        guard("vaults");
        return this.vaults;
      },
      logins: async (vaultId) => {
        guard(`logins:${vaultId}`);
        return this.items.map((i) => ({
          vaultId,
          itemId: i.id,
          title: i.title,
          sites: i.sites as LoginSite[],
        }));
      },
      login: async (_vaultId, itemId) => {
        guard(`login:${itemId}`);
        const { id: _id, ...item } = this.items.find((i) => i.id === itemId)!;
        return item;
      },
    };
  };
}

let dataDir: string;
let mock: MockAgentd;
let agentdUrl: string;
let op: FakeOnePassword;
let cores: Awaited<ReturnType<typeof startCore>>[] = [];
let port = 18900 + Math.floor(Math.random() * 500);

async function boot(opts: { userWaitMs?: number } = {}) {
  process.env.YO_AGENTD_TOKEN = TOKEN;
  const cfg = {
    ...loadConfig({}),
    dev: false,
    port: port++,
    dataDir,
    agentdUrl,
    computerMode: "remote" as const,
    secrets: "file" as const,
    webDist: null,
  };
  const core = await startCore(cfg, {
    secrets: new MemorySecretStore(),
    onePasswordBackend: op.factory,
    userWaitMs: opts.userWaitMs,
  });
  cores.push(core);
  await core.agentd.waitReady(5000);
  await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
  return core;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-1p-test-"));
  mock = new MockAgentd(TOKEN);
  agentdUrl = await mock.listen();
  op = new FakeOnePassword();
});

afterEach(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

type Core = Awaited<ReturnType<typeof startCore>>;
const primary = (core: Core) => core.store.listAgents().find((a) => a.isPrimary)!;

/** Run a Yo tool call from the agent's session and return its result text. */
async function tool(core: Core, name: string, args: Record<string, unknown>) {
  const agent = primary(core);
  const before = core.store.listTimeline(agent.id).length;
  await core.api["chat.send"]({ agentId: agent.id, text: `tool ${name} ${JSON.stringify(args)}` });
  let reply = "";
  await until(
    () => {
      const r = core.store
        .listTimeline(agent.id)
        .slice(before)
        .find((e) => e.item.kind === "assistant_message" && e.item.text?.startsWith("tool: "));
      reply = r?.item.text?.slice(6) ?? "";
      return !!r;
    },
    5000,
    `${name} result`,
  );
  return reply;
}

const REF = "1p:vltYo/itmGithub";

describe("1Password: connecting", () => {
  it("checks the token with 1Password, keeps it only in the SecretStore, and shows the vaults", async () => {
    const core = await boot();
    const pushes: { channel: ApiPushChannel; data: any }[] = [];
    core.hub.subscribe((channel, data) => pushes.push({ channel, data }));
    expect((await core.api["onePassword.status"]({})).state).toBe("off");

    await expect(core.api["onePassword.connect"]({ token: "not-a-token" })).rejects.toThrow(
      /starts with ops_/,
    );
    op.fail = "invalid service account token, please make sure you provide a valid token";
    await expect(core.api["onePassword.connect"]({ token: OP_TOKEN })).rejects.toThrow(
      /turned the token down/,
    );
    expect((await core.api["onePassword.status"]({})).connected).toBe(false);

    op.fail = null;
    const s = await core.api["onePassword.connect"]({ token: ` ${OP_TOKEN} ` });
    expect(s).toMatchObject({
      connected: true,
      state: "ok",
      vaults: [{ id: "vltYo", title: "Yo", items: 2 }],
    });
    expect(op.tokens.at(-1)).toBe(OP_TOKEN);
    expect(pushes.some((p) => p.channel === "onePassword.updated" && p.data.connected)).toBe(true);
    // The token is in the SecretStore, and nowhere in the database or what Settings gets.
    expect(JSON.stringify(s)).not.toContain(OP_TOKEN);
    core.store.getSettings(); // flush
    const dbFiles = fs.readdirSync(dataDir).filter((f) => /\.(db|sqlite)/.test(f));
    expect(dbFiles.length).toBeGreaterThan(0);
    for (const f of dbFiles)
      expect(fs.readFileSync(path.join(dataDir, f)).toString("latin1")).not.toContain(OP_TOKEN);

    // Test reads the vaults again; a revoked token shows on the card instead of throwing.
    op.fail = "Unauthorized: token revoked";
    const t = await core.api["onePassword.test"]({});
    expect(t).toMatchObject({ connected: true, state: "error" });
    expect(t.lastError).toMatch(/revoked/);

    const off = await core.api["onePassword.disconnect"]({});
    expect(off).toMatchObject({ connected: false, state: "off", vaults: [] });
    expect(recentLogLines().join("\n")).not.toContain(OP_TOKEN);
  });

  it("refuses a service account that can't see any vault", async () => {
    op.vaults = [];
    const core = await boot();
    await expect(core.api["onePassword.connect"]({ token: OP_TOKEN })).rejects.toThrow(/can't see any vault/);
    expect(core.onePassword.connected).toBe(false);
  });
});

describe("1Password: the agents' tools", () => {
  it("search returns names, websites and refs; fill asks, types the login through agentd and reports no values", async () => {
    const core = await boot();
    const agent = primary(core);
    expect(await tool(core, "onepassword_search", { query: "github.com" })).toMatch(
      /isn't connected.*Settings/,
    );
    await core.api["onePassword.connect"]({ token: OP_TOKEN });

    const found = await tool(core, "onepassword_search", { query: "https://www.github.com/login" });
    expect(found).toContain(`"GitHub" — github.com — vault Yo — item_ref ${REF}`);
    expect(found).not.toContain("Bank");
    // Cached: a second search doesn't ask 1Password again.
    const calls = op.calls.length;
    expect(await tool(core, "onepassword_search", { query: "" })).toContain("Bank");
    expect(op.calls.length).toBe(calls);

    // Fill: a dry run finds the page, then the card.
    mock.fillPage = ["username", "password"];
    const filling = tool(core, "onepassword_fill", { item_ref: REF });
    await until(() => core.store.pendingRequests().length === 1, 5000, "1Password card");
    const card = core.store.pendingRequests()[0]!;
    expect(card.request).toMatchObject({
      kind: "tool_approval",
      toolName: "yo:1password",
      title: "Sign in to github.com with 1Password?",
    });
    expect(card.request!.detail).toBe(
      'Yo types the username and password from your 1Password login "GitHub" into the page on github.com and submits it. Yo never sees them.',
    );
    const dry = mock.requests.filter((r) => r.type === "browser.fillLogin");
    expect(dry).toHaveLength(1);
    expect(JSON.stringify(dry)).not.toContain(PASSWORD);

    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: card.request!.requestId,
      decision: "allowAlways",
    });
    const result = await filling;
    expect(result).toBe(
      'Filled the username and password from the 1Password login "GitHub" on github.com and submitted the form. Take a snapshot to see the result. If the page now asks for a one-time code, call onepassword_fill again.',
    );
    const real = mock.last("browser.fillLogin")!;
    expect(real).toMatchObject({
      agentId: agent.id,
      dryRun: false,
      sites: [{ url: "https://github.com", mode: "anywhere" }],
      fields: [
        { kind: "username", value: USERNAME },
        { kind: "password", value: PASSWORD },
      ],
    });
    expect(core.store.listRules().map((r) => r.match)).toContain("yo:1password:github.com");

    // Audit: which login, where, what.
    expect(core.store.listActivity(agent.id).map((a) => a.summary)).toContain(
      'Used 1Password login "GitHub" on github.com (username and password)',
    );
    expect((await core.api["onePassword.status"]({})).recent[0]).toMatchObject({
      item: "GitHub",
      site: "github.com",
      fields: ["username", "password"],
      agentName: "Yo",
    });

    // The code step: "always allow" on github.com covers it, no second card.
    mock.fillPage = ["one_time_code"];
    expect(await tool(core, "onepassword_fill", { item_ref: REF })).toContain("Filled the one-time code");
    expect(mock.last("browser.fillLogin")!.fields).toEqual([{ kind: "one_time_code", value: CODE }]);
    expect(core.store.pendingRequests()).toHaveLength(0);

    // Nothing secret anywhere the model, the user's chat, logs or a bug report could see.
    const secrets = [OP_TOKEN, USERNAME, PASSWORD, CODE];
    const seen = JSON.stringify({
      timeline: core.store.listTimeline(agent.id),
      activity: core.store.listActivity(agent.id, 500),
      status: await core.api["onePassword.status"]({}),
      prompts: [...mock.sessions.values()].map((s) => s.systemAppend),
      turns: mock.turnTexts,
      logs: recentLogLines(1000),
    });
    for (const s of secrets) expect(seen).not.toContain(s);
    // And if a value ever were quoted (a page echoing it into an error, say), logs and bug reports scrub it.
    const quoted = `login failed for ${USERNAME} with ${PASSWORD}; token ${OP_TOKEN}`;
    for (const out of [redact(quoted), redactBugReport(quoted)])
      for (const s of [USERNAME, PASSWORD, OP_TOKEN]) expect(out).not.toContain(s);
  });

  it("a denied card fills nothing; the agent is told plainly", async () => {
    const core = await boot();
    const agent = primary(core);
    await core.api["onePassword.connect"]({ token: OP_TOKEN });
    const filling = tool(core, "onepassword_fill", { item_ref: REF });
    await until(() => core.store.pendingRequests().length === 1);
    const card = core.store.pendingRequests()[0]!;
    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: card.request!.requestId,
      decision: "deny",
    });
    expect(await filling).toMatch(/^DENIED by the user: don't sign in to github\.com/);
    expect(mock.requests.filter((r) => r.type === "browser.fillLogin" && !r.dryRun)).toHaveLength(0);
  });

  it("an unanswered card expires without filling", async () => {
    const core = await boot({ userWaitMs: 300 });
    await core.api["onePassword.connect"]({ token: OP_TOKEN });
    expect(await tool(core, "onepassword_fill", { item_ref: REF })).toMatch(
      /didn't answer in time, so nothing was filled/,
    );
    expect(mock.requests.filter((r) => r.type === "browser.fillLogin" && !r.dryRun)).toHaveLength(0);
  });

  it("clear errors: no field on the page, a bad ref, an older computer, a revoked token", async () => {
    const core = await boot();
    await core.api["onePassword.connect"]({ token: OP_TOKEN });
    mock.fillPage = [];
    expect(await tool(core, "onepassword_fill", { item_ref: REF })).toMatch(
      /doesn't show a username, password or one-time code field.*request_takeover/,
    );
    expect(await tool(core, "onepassword_fill", { item_ref: "op://Yo/GitHub/password" })).toMatch(
      /isn't an item_ref from onepassword_search/,
    );
    expect(await tool(core, "onepassword_fill", { item_ref: "1p:otherVault/itmGithub" })).toMatch(
      /can't open that vault/,
    );
    mock.fillPage = ["password"];
    mock.fillUnsupported = true;
    expect(await tool(core, "onepassword_fill", { item_ref: REF })).toMatch(/computer needs an update/);
    mock.fillUnsupported = false;

    op.fail = "AuthExpired: token revoked";
    expect(await tool(core, "onepassword_fill", { item_ref: REF })).toMatch(/turned the token down/);
    expect(await core.api["onePassword.status"]({})).toMatchObject({ state: "error" });
    op.fail = "error sending request: dns error";
    expect(await tool(core, "onepassword_fill", { item_ref: REF })).toMatch(/Couldn't reach 1Password/);
  });
});

describe("1Password: redaction and prompts", () => {
  it("service account tokens are scrubbed from logs and bug reports by their shape", () => {
    const token = "ops_eyJGQUtFIjoidG9rZW4ifQFAKEfake0123";
    expect(looksLikeToken(token)).toBe(true);
    expect(redact(`saving ${token} now`)).toBe("saving [redacted] now");
    expect(redactBugReport(`token=${token}`)).not.toContain(token);
    expect(redactBugReport(`see ${token}`)).toBe("see [redacted]");
    expect(TOKEN_KEY).toBe("onepassword:token");
  });

  it("agents are told to use 1Password for sign-ins only when it's connected", () => {
    const base = {
      settings: { userName: "Alex", timezone: "UTC" } as any,
      memories: [],
      now: new Date(0),
    };
    const ctx = {
      ...base,
      agent: {
        id: "a",
        name: "Yo",
        role: "",
        instructions: "",
        isPrimary: true,
        space: null,
        kind: "agent",
      } as any,
      team: [],
      scratchpad: "",
      routines: [],
      priorConversation: [],
    };
    expect(buildSystemAppend(ctx)).not.toContain("onepassword_fill");
    const on = buildSystemAppend({ ...ctx, onePassword: { vaults: ["Yo"] } });
    expect(on).toContain("1Password is connected (vault: Yo)");
    expect(on).toContain("You never see the values");
    const helper = buildHelperSystemAppend({
      ...base,
      helper: { id: "h", name: "Helper" },
      parent: { id: "a", name: "Yo" },
      brief: "Sign in to GitHub",
      onePassword: { vaults: ["Yo", "Work"] },
    });
    expect(helper).toContain("1Password is connected (vaults: Yo, Work)");
  });
});
