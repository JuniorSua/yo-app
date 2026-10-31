/**
 * A model sign-in that stops working (C7): a Claude Code or ChatGPT sign-in inside Yo's computer expires.
 * The account must stop saying "Connected", the user gets one plain message (never "run /login"), and signing in
 * again gets Yo going with the new sign-in. A real core against the mock agentd.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { startCore } from "../src/main";
import { SIGN_IN_EXPIRED_MESSAGE, signInHealth } from "../src/orchestrator/AccountService";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { MockAgentd } from "./mockAgentd";

const TOKEN = "t".repeat(64);
type Core = Awaited<ReturnType<typeof startCore>>;

async function until(fn: () => boolean | Promise<boolean>, ms = 5000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let dataDir: string;
let mock: MockAgentd;
let cores: Core[] = [];
let port = 24900 + Math.floor(Math.random() * 1000);

async function boot() {
  process.env.YO_AGENTD_TOKEN = TOKEN;
  const cfg = {
    ...loadConfig({}),
    dev: false,
    port: port++,
    dataDir,
    agentdUrl: await mock.listen(),
    computerMode: "remote" as const,
    secrets: "file" as const,
    webDist: null,
  };
  const core = await startCore(cfg, { secrets: new MemorySecretStore() });
  cores.push(core);
  await core.agentd.waitReady(5000);
  return core;
}

/** Claude Code's own sign-in on Yo's computer: Yo shows Claude's link, the user pastes back Claude's code. */
async function signInClaude(core: Core, id: string) {
  const n = mock.loginStarts;
  await core.api["account.login.start"]({ id, restart: true });
  await until(() => mock.loginStarts === n + 1, 5000, "sign-in started");
  await core.api["account.login.input"]({ id, input: `code#s${n + 1}` });
}

const claudeOf = (core: Core) => core.store.listAccounts().find((a) => a.provider === "claude")!;
const primary = (core: Core) => core.store.listAgents().find((a) => a.isPrimary)!;
const notices = (core: Core, agentId: string) =>
  core.store
    .listTimeline(agentId)
    .filter((e) => e.item.kind === "notice")
    .map((e) => e.item.text ?? "");

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-signin-test-"));
  mock = new MockAgentd(TOKEN);
});

afterEach(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("an expired model sign-in", () => {
  it("marks the account 'sign in again' at the first failed task, and stays marked until the user signs in", async () => {
    const core = await boot();
    const claude = claudeOf(core);
    await signInClaude(core, claude.id);
    await until(() => core.store.getAccount(claude.id)?.status === "authenticated", 5000, "connected");
    expect(core.store.getAccount(claude.id)!.signInExpired).toBe(false);
    // Claude Code keeps the sign-in on Yo's computer: Yo holds no token.
    expect(await core.accounts.getSecrets(claude.id)).toEqual({});

    const pushed: { status: string; signInExpired?: boolean }[] = [];
    core.hub.subscribe((channel, data) => {
      if (channel === "account.updated" && (data as { id: string }).id === claude.id)
        pushed.push(data as never);
    });
    const agent = primary(core);
    // Pinned to Claude (unpinned, Yo would move on to another connected plan, here the mock's ChatGPT).
    core.store.updateAgent(agent.id, { accountId: claude.id });
    await core.api["chat.send"]({ agentId: agent.id, text: "expired" });
    await until(() => core.store.getAccount(claude.id)?.signInExpired === true, 5000, "marked expired");

    const acc = core.store.getAccount(claude.id)!;
    expect(acc.status).toBe("unauthenticated");
    expect(acc.message).toBe(SIGN_IN_EXPIRED_MESSAGE);
    // The UI hears about it right away (no refresh needed).
    expect(pushed.some((a) => a.status === "unauthenticated" && a.signInExpired)).toBe(true);
    // One plain message, not two, and nothing about running /login.
    await until(() => notices(core, agent.id).length > 0, 5000, "notice");
    await new Promise((r) => setTimeout(r, 100));
    const shown = notices(core, agent.id);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(/Sign in again/);
    expect(shown.join("\n")).not.toMatch(/\/login/);

    // A check that only sees a saved sign-in (Claude can't ask its server for free) doesn't flip it back.
    await core.accounts.refreshAll();
    expect(core.store.getAccount(claude.id)).toMatchObject({
      status: "unauthenticated",
      signInExpired: true,
    });

    // The next message says what to do instead of failing deep inside the provider.
    await core.api["chat.send"]({ agentId: agent.id, text: "hello again" });
    await until(() => notices(core, agent.id).length > 1, 5000, "second notice");
    expect(notices(core, agent.id).at(-1)).toMatch(
      /Claude's sign-in has expired.*Settings → Accounts.*Sign in again/,
    );

    // Signing in again: connected, and the session that held the old sign-in is replaced.
    const starts = mock.requests.filter((r) => r.type === "session.start").length;
    await signInClaude(core, claude.id);
    await until(() => core.store.getAccount(claude.id)?.status === "authenticated", 5000, "reconnected");
    expect(core.store.getAccount(claude.id)!.signInExpired).toBe(false);
    await core.api["chat.send"]({ agentId: agent.id, text: "back" });
    await until(
      () => core.store.listTimeline(agent.id).some((e) => e.item.text === "echo: back"),
      5000,
      "reply after signing in again",
    );
    expect(mock.requests.filter((r) => r.type === "session.start").length).toBe(starts + 1);
  });

  it("is cleared by a check that asked the provider's server, and set by one that was refused", async () => {
    const core = await boot();
    const claude = claudeOf(core);
    await until(() => core.store.getAccount(claude.id)?.status === "authenticated", 5000, "connected");
    core.accounts.markSignInExpired(claude.id);
    expect(core.store.getAccount(claude.id)).toMatchObject({
      status: "unauthenticated",
      signInExpired: true,
    });

    mock.probeResult = { status: "authenticated", verified: true, plan: "Claude Max" };
    await core.accounts.refresh(claude.id);
    expect(core.store.getAccount(claude.id)).toMatchObject({ status: "authenticated", signInExpired: false });

    mock.probeResult = { status: "unauthenticated", verified: true };
    await core.accounts.refresh(claude.id);
    expect(core.store.getAccount(claude.id)).toMatchObject({
      status: "unauthenticated",
      signInExpired: true,
    });
  });

  it("forgets the account's sign-in health when the account is removed", async () => {
    const core = await boot();
    const extra = await core.accounts.add("claude");
    core.accounts.markSignInExpired(extra.id);
    await core.accounts.remove(extra.id);
    expect(core.store.getKv(`accountSignIn:${extra.id}`)).toBeNull();
  });
});

describe("what a sign-in check means", () => {
  const ok = { status: "authenticated" as const };
  it("believes a server-checked answer either way", () => {
    expect(
      signInHealth({ status: "unauthenticated", signInExpired: true }, { ...ok, verified: true }),
    ).toEqual({
      status: "authenticated",
      message: null,
      expired: false,
    });
    expect(
      signInHealth(
        { status: "authenticated", signInExpired: false },
        { status: "unauthenticated", verified: true },
      ),
    ).toMatchObject({ status: "unauthenticated", expired: true });
  });

  it("doesn't let a saved-token check undo a turned-down sign-in", () => {
    expect(signInHealth({ status: "unauthenticated", signInExpired: true }, ok)).toMatchObject({
      status: "unauthenticated",
      expired: true,
    });
    expect(signInHealth({ status: "authenticated", signInExpired: false }, ok)).toMatchObject({
      status: "authenticated",
      expired: false,
    });
  });

  it("never calls a never-connected account expired", () => {
    expect(
      signInHealth(
        { status: "unknown", signInExpired: false },
        { status: "unauthenticated", verified: true },
      ),
    ).toMatchObject({ status: "unauthenticated", expired: false });
  });
});
