/**
 * "Connect your model" walkthrough through core's API: a real core, a fake home folder on disk, and the
 * mock agentd (Yo's computer). Tokens are obviously fake.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import type { HostEnv } from "../src/connect/hostConnect";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { MockAgentd } from "./mockAgentd";

const TOKEN = "t".repeat(64);
const FAKE_CLAUDE = `sk-ant-oat01-${"FAKE_test_token-".repeat(6)}`;
const FAKE_LOGIN = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "FAKE_id_token_abc",
    access_token: "FAKE_access_abc",
    refresh_token: "FAKE_refresh_abc",
  },
});
type Core = Awaited<ReturnType<typeof startCore>>;

async function until(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

let dataDir: string;
let home: string;
let mock: MockAgentd;
let cores: Core[] = [];
let port = 23800 + Math.floor(Math.random() * 1000);

async function boot(opts: { agentdUrl?: string } = {}) {
  process.env.YO_AGENTD_TOKEN = TOKEN;
  const cfg = {
    ...loadConfig({}),
    dev: false,
    port: port++,
    dataDir,
    agentdUrl: opts.agentdUrl ?? (await mock.listen()),
    computerMode: "remote" as const,
    secrets: "file" as const,
    webDist: null,
  };
  const hostEnv = (): HostEnv => ({ home, path: "", platform: "darwin", hostname: "Fake-Mac.local" });
  const core = await startCore(cfg, { secrets: new MemorySecretStore(), hostEnv });
  cores.push(core);
  return core;
}

const accountOf = (core: Core, provider: "claude" | "codex") =>
  core.store.listAccounts().find((a) => a.provider === provider)!;

/** The secrets the last account.configure for this account sent to Yo's computer. */
const configured = (accountId: string) =>
  (mock.requests as any[]).filter((r) => r.type === "account.configure" && r.accountId === accountId).at(-1)
    ?.secrets;

function writeYoLogin(content = FAKE_LOGIN) {
  fs.mkdirSync(path.join(home, ".yo", "codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".yo", "codex", "auth.json"), content);
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-connect-test-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "yo-connect-home-"));
  mock = new MockAgentd(TOKEN);
  mock.requireLogin = true;
});

afterEach(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("connect.* API", () => {
  it("detects CLIs and sign-ins in the home folder without returning paths", async () => {
    const core = await boot();
    expect(await core.api["connect.detect"]({})).toEqual({
      host: { platform: "darwin", name: "Fake-Mac" },
      claude: { installed: false, signedIn: null },
      codex: { installed: false, signedIn: false, yoLogin: false },
    });
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local", "bin", "claude"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "x" } }));
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), FAKE_LOGIN);
    writeYoLogin();
    const d = await core.api["connect.detect"]({});
    expect(d.claude).toEqual({ installed: true, signedIn: true });
    expect(d.codex).toEqual({ installed: false, signedIn: true, yoLogin: true });
    expect(JSON.stringify(d)).not.toContain(home);
  });

  it("connects Claude with a pasted token; Yo's computer checks it right away", async () => {
    const core = await boot();
    await core.agentd.waitReady(5000);
    const claude = accountOf(core, "claude");
    const stderr = vi.spyOn(process.stderr, "write");
    try {
      const bad = await core.api["connect.claudeToken"]({ token: "sk-ant-api03-FAKEfakeFAKEfake" });
      expect(bad).toEqual({ ok: false, error: expect.stringMatching(/API key/) });
      expect(await core.accounts.getSecrets(claude.id)).toEqual({});

      const r = await core.api["connect.claudeToken"]({ token: `"${FAKE_CLAUDE}"\n` });
      expect(r.ok).toBe(true);
      expect(await core.accounts.getSecrets(claude.id)).toEqual({ claudeOauthToken: FAKE_CLAUDE });
      // Sent to Yo's computer with account.configure, then probed.
      expect(configured(claude.id)).toEqual({ claudeOauthToken: FAKE_CLAUDE });
      await until(() => core.store.getAccount(claude.id)?.status === "unauthenticated");
      // The tokens are never in the result or the logs.
      expect(JSON.stringify(r)).not.toContain(FAKE_CLAUDE);
      expect(stderr.mock.calls.map((c) => String(c[0])).join("")).not.toContain(FAKE_CLAUDE);
    } finally {
      stderr.mockRestore();
    }
  });

  it("saves a login as 'unverified' when Yo's computer isn't there yet, and uses it", async () => {
    // Nothing listens here: Yo's computer doesn't exist yet.
    const core = await boot({ agentdUrl: "http://127.0.0.1:9" });
    const claude = accountOf(core, "claude");
    const codex = accountOf(core, "codex");
    core.store.setDefaultAccount(codex.id); // default is a signed-out account
    const r = await core.api["connect.claudeToken"]({ token: FAKE_CLAUDE });
    expect(r).toMatchObject({ ok: true, account: { id: claude.id, status: "unverified", isDefault: true } });
    expect(core.accounts.resolveFor(null)?.id).toBe(claude.id);
    expect(await core.api["account.list"]({})).toContainEqual(
      expect.objectContaining({ id: claude.id, status: "unverified" }),
    );
  });

  it("imports the dedicated Codex login once, removes it, and seeds Yo's computer with it", async () => {
    const core = await boot();
    await core.agentd.waitReady(5000);
    const codex = accountOf(core, "codex");
    expect(await core.api["connect.codexImport"]({})).toEqual({ state: "waiting" });

    writeYoLogin('{"tokens": {"refresh_to'); // Codex still writing the file
    expect(await core.api["connect.codexImport"]({})).toEqual({ state: "waiting" });

    writeYoLogin();
    const r = await core.api["connect.codexImport"]({});
    expect(r.state).toBe("connected");
    expect(JSON.stringify(r)).not.toContain("FAKE_refresh_abc");
    expect(await core.accounts.getSecrets(codex.id)).toEqual({ codexAuthJson: FAKE_LOGIN });
    expect(configured(codex.id)).toEqual({ codexAuthJson: FAKE_LOGIN });
    // Yo's copy on this machine is gone: only Yo's computer holds the live login now.
    expect(fs.existsSync(path.join(home, ".yo", "codex", "auth.json"))).toBe(false);
    expect(await core.api["connect.codexImport"]({})).toEqual({ state: "waiting" });
  });

  it("explains an unusable Codex login and never touches ~/.codex", async () => {
    const core = await boot();
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), FAKE_LOGIN);
    writeYoLogin(JSON.stringify({ tokens: {} }));
    const r = await core.api["connect.codexImport"]({});
    expect(r).toEqual({ state: "error", error: expect.stringMatching(/Run the sign-in command again/) });
    expect(await core.accounts.getSecrets(accountOf(core, "codex").id)).toEqual({});
    expect(fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8")).toBe(FAKE_LOGIN);
  });

  it("refuses accounts of the wrong or a hidden provider", async () => {
    const core = await boot();
    const codex = accountOf(core, "codex");
    expect(await core.api["connect.claudeToken"]({ token: FAKE_CLAUDE, accountId: codex.id })).toMatchObject({
      ok: false,
    });
    const grok = core.store.createAccount("grok", "Grok");
    writeYoLogin();
    expect(await core.api["connect.codexImport"]({ accountId: grok.id })).toMatchObject({ state: "error" });
    expect(await core.accounts.getSecrets(grok.id)).toEqual({});
  });
});

describe("a login saved before Yo's computer existed", () => {
  it("is checked when the first turn starts, and works", async () => {
    const core = await boot();
    await core.agentd.waitReady(5000);
    const claude = accountOf(core, "claude");
    await (core.accounts as any).setSecrets(claude.id, { claudeOauthToken: FAKE_CLAUDE });
    core.store.updateAccount(claude.id, { status: "unverified" });
    mock.requireLogin = false;
    const agent = core.store.listAgents().find((a) => a.isPrimary)!;
    await core.api["chat.send"]({ agentId: agent.id, text: "hello" });
    await until(() =>
      core.store
        .listTimeline(agent.id)
        .some((e) => e.item.kind === "assistant_message" && e.item.status === "completed"),
    );
    expect(core.store.getAccount(claude.id)?.status).toBe("authenticated");
  });

  it("says what to do when Yo's computer rejects it", async () => {
    const core = await boot();
    await core.agentd.waitReady(5000);
    const claude = accountOf(core, "claude");
    await (core.accounts as any).setSecrets(claude.id, { claudeOauthToken: FAKE_CLAUDE });
    core.store.updateAccount(claude.id, { status: "unverified" });
    const agent = core.store.listAgents().find((a) => a.isPrimary)!;
    await core.api["chat.send"]({ agentId: agent.id, text: "hello" });
    await until(() =>
      core.store
        .listTimeline(agent.id)
        .some((e) => /didn't accept the saved sign-in/.test(JSON.stringify(e.item))),
    );
    expect(mock.count("session.start")).toBe(0);
  });
});
