/**
 * "Connect your model" walkthrough through core's API: a real core, a fake home folder on disk, and the
 * mock agentd (Yo's computer). Tokens are obviously fake.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

/** A Codex login left in the old walkthrough's folder (an older Yo asked for one there). */
function writeYoLogin(content = FAKE_LOGIN) {
  fs.mkdirSync(path.join(home, ".yo", "codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".yo", "codex", "auth.json"), content);
}

/** Every `account.login` push core sends to the app. */
function capture(core: Core) {
  const pushes: { channel: string; data: any }[] = [];
  core.hub.subscribe((channel, data) => pushes.push({ channel, data }));
  return pushes;
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
      codex: { installed: false, signedIn: false },
    });
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local", "bin", "claude"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "x" } }));
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), FAKE_LOGIN);
    writeYoLogin();
    const d = await core.api["connect.detect"]({});
    expect(d.claude).toEqual({ installed: true, signedIn: true });
    expect(d.codex).toEqual({ installed: false, signedIn: true });
    expect(JSON.stringify(d)).not.toContain(home);
  });

  it("imports nothing: Claude and ChatGPT both sign in on Yo's computer", async () => {
    const core = await boot();
    expect((core.api as Record<string, unknown>)["connect.claudeToken"]).toBeUndefined();
    expect((core.api as Record<string, unknown>)["connect.codexImport"]).toBeUndefined();
  });

  it("ChatGPT signs in on ChatGPT's page: the address the browser lands on goes to Yo's computer", async () => {
    const core = await boot();
    await core.agentd.waitReady(5000);
    const pushes = capture(core);
    const codex = accountOf(core, "codex");
    await core.api["account.login.start"]({ id: codex.id, restart: true });
    await until(() => pushes.some((p) => p.channel === "account.login" && p.data.url));
    expect(mock.last("auth.login.start")).toMatchObject({ provider: "codex", method: "codex-browser" });
    const prompt = pushes.find((p) => p.channel === "account.login" && p.data.url)!.data;
    expect(prompt).toMatchObject({ phase: "prompt", needsInput: true });
    expect(prompt.userCode).toBeUndefined();
    await core.api["account.login.input"]({
      id: codex.id,
      input: `http://127.0.0.1:1455/auth/callback?code=good&state=s${mock.loginStarts}`,
    });
    await until(() => core.store.getAccount(codex.id)!.status === "authenticated");
    // Codex keeps the sign-in on Yo's computer: core stores nothing.
    expect(await core.accounts.getSecrets(codex.id)).toEqual({});
  });

  it("ChatGPT with a one-time code when asked, and on an older Yo's computer", async () => {
    const core = await boot();
    await core.agentd.waitReady(5000);
    const pushes = capture(core);
    const codex = accountOf(core, "codex");
    await core.api["account.login.start"]({ id: codex.id, restart: true, method: "code" });
    await until(() => pushes.some((p) => p.channel === "account.login" && p.data.userCode));
    expect(mock.last("auth.login.start")).toMatchObject({ provider: "codex", method: "codex-device-code" });
    await until(() => core.store.getAccount(codex.id)!.status === "authenticated");

    // A computer from before the sign-in page refuses "codex-browser": core asks for a code instead.
    mock.noCodexBrowser = true;
    pushes.length = 0;
    await core.api["account.login.start"]({ id: codex.id, restart: true });
    await until(() => pushes.some((p) => p.channel === "account.login" && p.data.userCode));
    expect(mock.last("auth.login.start")).toMatchObject({ method: "codex-device-code" });
    expect(pushes.some((p) => p.channel === "account.login" && p.data.phase === "error")).toBe(false);
  });

  it("a ChatGPT login an older Yo imported keeps working: it still goes to Yo's computer", async () => {
    const core = await boot();
    await core.agentd.waitReady(5000);
    const codex = accountOf(core, "codex");
    await (core.accounts as any).secrets.set(
      `account:${codex.id}`,
      JSON.stringify({ codexAuthJson: FAKE_LOGIN }),
    );
    await core.accounts.configure(codex.id);
    expect(configured(codex.id)).toEqual({ codexAuthJson: FAKE_LOGIN });
  });

  it("leaves a login in the old walkthrough's folder alone (never read, never removed)", async () => {
    const core = await boot();
    writeYoLogin();
    expect((await core.api["connect.detect"]({})).codex).toEqual({ installed: false, signedIn: false });
    expect(fs.readFileSync(path.join(home, ".yo", "codex", "auth.json"), "utf8")).toBe(FAKE_LOGIN);
    expect(await core.accounts.getSecrets(accountOf(core, "codex").id)).toEqual({});
  });
});

/** A token saved by an older Yo's "paste a token" flow (Yo no longer takes new ones). */
const saveLegacyToken = (core: Core, id: string) =>
  (core.accounts as any).secrets.set(`account:${id}`, JSON.stringify({ claudeOauthToken: FAKE_CLAUDE }));

describe("a legacy Claude token saved before Yo's computer existed", () => {
  it("is checked when the first turn starts, and works", async () => {
    const core = await boot();
    await core.agentd.waitReady(5000);
    const claude = accountOf(core, "claude");
    await saveLegacyToken(core, claude.id);
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
    await saveLegacyToken(core, claude.id);
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
