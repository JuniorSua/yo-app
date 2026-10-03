import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiPushChannel } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { startCore } from "../src/main";
import { CATCHUP_WINDOW_MS } from "../src/scheduler/Scheduler";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { MockAgentd } from "./mockAgentd";

const TOKEN = "t".repeat(64);

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
let agentdUrl: string;
let cores: Awaited<ReturnType<typeof startCore>>[] = [];
let port = 17800 + Math.floor(Math.random() * 1000);

async function boot(
  opts: { dev?: boolean; webDist?: string; lostTurnGraceMs?: number; autoSleepCheckMs?: number } = {},
) {
  process.env.YO_AGENTD_TOKEN = TOKEN;
  const cfg = {
    ...loadConfig({}),
    dev: opts.dev ?? false,
    port: port++,
    dataDir,
    agentdUrl,
    computerMode: "remote" as const,
    secrets: "file" as const,
    webDist: opts.webDist ?? null,
  };
  const core = await startCore(cfg, {
    secrets: new MemorySecretStore(),
    lostTurnGraceMs: opts.lostTurnGraceMs,
    autoSleepCheckMs: opts.autoSleepCheckMs,
  });
  cores.push(core);
  await core.agentd.waitReady(5000);
  return core;
}

function capture(core: Awaited<ReturnType<typeof startCore>>) {
  const pushes: { channel: ApiPushChannel; data: any }[] = [];
  core.hub.subscribe((channel, data) => pushes.push({ channel, data }));
  return pushes;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-core-test-"));
  mock = new MockAgentd(TOKEN);
  agentdUrl = await mock.listen();
});

afterEach(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const primary = (core: Awaited<ReturnType<typeof startCore>>) =>
  core.store.listAgents().find((a) => a.isPrimary)!;

describe("yo-core", () => {
  it("creates the primary agent and default accounts on first run", async () => {
    const core = await boot();
    const boot1 = await core.api.bootstrap({});
    expect(boot1.agents).toHaveLength(1);
    expect(boot1.agents[0]!.name).toBe("Yo");
    // Only the providers Yo offers (ENABLED_PROVIDERS): no Grok account is created.
    expect(boot1.accounts.map((a) => a.provider).sort()).toEqual(["claude", "codex"]);
    expect(core.store.listAccounts().map((a) => a.provider)).not.toContain("grok");
    expect(boot1.accounts.find((a) => a.isDefault)?.provider).toBe("claude");
    await until(() => core.store.listAccounts().every((a) => a.status === "authenticated"), 5000, "probe");
  });

  it("hides a Grok account from an older Yo and moves its agents to the default account", async () => {
    const core1 = await boot();
    await until(() => core1.store.listAccounts().every((a) => a.status === "authenticated"));
    const claude = core1.store.listAccounts().find((a) => a.provider === "claude")!;
    // What an older Yo left behind: a signed-in Grok account that is the default, with the main agent on it.
    const grok = core1.store.createAccount("grok", "Grok");
    core1.store.updateAccount(grok.id, {
      status: "authenticated",
      models: [{ id: "grok-4", label: "Grok 4" }],
    });
    core1.store.setDefaultAccount(grok.id);
    const agent = primary(core1);
    core1.store.updateAgent(agent.id, { accountId: grok.id, model: "grok-4", effort: "high" });

    // Even before the boot-time repair, a turn never runs on Grok and never sends it a Grok model id.
    await core1.api["chat.send"]({ agentId: agent.id, text: "still pinned" });
    await until(() => core1.orchestrator.activityOf(agent.id) === "done", 5000, "turn on fallback");
    const first = mock.last("session.start")!;
    expect(first.provider).toBe("claude");
    expect(first.accountId).toBe(claude.id);
    expect(first.model).toBeUndefined();
    await core1.shutdown();
    cores = [];

    const configured = mock.requests.length;
    const core2 = await boot();
    const b = await core2.api.bootstrap({});
    expect(b.accounts.map((a) => a.provider).sort()).toEqual(["claude", "codex"]);
    expect(b.accounts.find((a) => a.isDefault)?.id).toBe(claude.id);
    expect(await core2.api["account.list"]({})).not.toContainEqual(expect.objectContaining({ id: grok.id }));
    // The agent is back on the default account with provider defaults; the Grok account is kept, hidden.
    expect(core2.store.getAgent(agent.id)).toMatchObject({ accountId: null, model: null, effort: null });
    expect(core2.store.getAccount(grok.id)?.provider).toBe("grok");
    expect(core2.accounts.resolveFor(grok.id)?.id).toBe(claude.id);
    // Never configured, probed or offered: every route that could reach it refuses with a clear error.
    await until(() => core2.store.listAccounts().some((a) => a.status === "authenticated"));
    expect(
      mock.requests.slice(configured).some((r) => "accountId" in r && (r as any).accountId === grok.id),
    ).toBe(false);
    await expect(core2.api["account.add"]({ provider: "grok" })).rejects.toThrow(/isn't available/);
    await expect(core2.api["account.login.start"]({ id: grok.id })).rejects.toThrow(/isn't available/);
    await expect(core2.api["account.setDefault"]({ id: grok.id })).rejects.toThrow(/isn't available/);
    await expect(core2.api["account.setApiKey"]({ id: grok.id, key: "x" })).rejects.toThrow(
      /isn't available/,
    );
    await expect(core2.api["agent.update"]({ id: agent.id, patch: { accountId: grok.id } })).rejects.toThrow(
      /isn't available/,
    );
    expect(await core2.api["models.list"]({ accountId: grok.id })).toEqual([]);

    await core2.api["chat.send"]({ agentId: agent.id, text: "after the update" });
    await until(() =>
      core2.store.listTimeline(agent.id).some((e) => e.item.text === "echo: after the update"),
    );
    expect(mock.last("session.start")!.provider).toBe("claude");
  });

  it("streams a reply into the timeline", async () => {
    const core = await boot();
    const pushes = capture(core);
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "hello there" });
    await until(() =>
      core.store
        .listTimeline(agent.id)
        .some((e) => e.item.kind === "assistant_message" && e.item.status === "completed"),
    );
    const tl = core.store.listTimeline(agent.id);
    expect(tl.map((e) => e.item.kind)).toEqual(["user_message", "assistant_message"]);
    expect(tl[1]!.item.text).toBe("echo: hello there");
    // The model sees when each message was sent (a native session can last for days)...
    expect(mock.turnTexts.at(-1)).toMatch(
      /^\[\w{3}, \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M\] hello there$/,
    );
    // ...while the chat shows exactly what was typed.
    expect(tl[0]!.item.text).toBe("hello there");
    expect(tl[1]!.source?.provider).toBe("claude");
    expect(pushes.some((p) => p.channel === "timeline.delta")).toBe(true);
    await until(() => core.orchestrator.activityOf(agent.id) === "done");
    expect(core.store.getAgent(agent.id)!.unread).toBe(1);
    expect(pushes.some((p) => p.channel === "notify" && p.data.kind === "done")).toBe(true);
    // Session start carried persona in systemAppend.
    expect(mock.last("session.start")!.systemAppend).toContain("You are Yo");
  });

  it("queues messages sent while a turn is running", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
    await until(() => mock.count("turn.send") === 1);
    const res = await core.api["chat.send"]({ agentId: agent.id, text: "second" });
    expect(res.turnId).toBe("queued");
    expect(core.orchestrator.activityOf(agent.id)).toBe("working");
    await core.api["chat.interrupt"]({ agentId: agent.id });
    await until(() => core.orchestrator.activityOf(agent.id) !== "working", 10000, "interrupt");
    // Interrupt clears the queue.
    expect(mock.count("turn.send")).toBe(1);
  });

  it("round-trips ask_user through a timeline card", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "ask me" });
    await until(() => core.store.pendingRequests().length === 1, 5000, "pending ask");
    expect(core.orchestrator.activityOf(agent.id)).toBe("waiting");
    const req = core.store.pendingRequests()[0]!;
    expect(req.request!.kind).toBe("user_input");
    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: req.request!.requestId,
      decision: "allow",
      answers: { q: "B" },
    });
    await until(() =>
      core.store.listTimeline(agent.id).some((e) => e.item.text === "got The user answered: B"),
    );
    expect(core.store.getEntry(req.id)!.request!.status).toBe("answered");
  });

  it("handles provider approvals and remembers 'always allow'", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "approve this" });
    await until(() => core.store.pendingRequests().length === 1);
    const req = core.store.pendingRequests()[0]!;
    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: req.request!.requestId,
      decision: "allowAlways",
    });
    await until(() => core.store.listTimeline(agent.id).some((e) => e.item.text === "decision allowAlways"));
    expect(core.store.listRules()).toEqual([expect.objectContaining({ match: "Bash", decision: "allow" })]);
    // Second time the rule answers automatically.
    await core.api["chat.send"]({ agentId: agent.id, text: "approve again" });
    await until(() => core.store.listTimeline(agent.id).some((e) => e.item.text === "decision allow"));
    expect(core.store.pendingRequests()).toHaveLength(0);
  });

  it("saves memories via the remember tool and seeds them into new sessions", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "remember User loves window seats" });
    await until(() => core.store.listMemories().length === 1);
    await until(() => core.orchestrator.activityOf(agent.id) === "done");
    await core.api["agent.newSession"]({ id: agent.id });
    await core.api["chat.send"]({ agentId: agent.id, text: "hi" });
    await until(() => mock.count("session.start") === 2);
    const sys = mock.last("session.start")!.systemAppend;
    expect(sys).toContain("User loves window seats");
    // Fresh session gets Yo's transcript for continuity.
    expect(sys).toContain("Conversation so far");
  });

  it("resumes the native session after a core restart", async () => {
    const core1 = await boot();
    await until(() => core1.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core1);
    await core1.api["chat.send"]({ agentId: agent.id, text: "first" });
    await until(() => core1.orchestrator.activityOf(agent.id) === "done");
    await core1.shutdown();
    cores = [];
    const core2 = await boot();
    await until(() => mock.count("session.stop") >= 1, 5000, "stale session stop");
    await until(() => core2.store.listAccounts().some((a) => a.status === "authenticated"));
    await core2.api["chat.send"]({ agentId: agent.id, text: "second" });
    await until(() => core2.store.listTimeline(agent.id).some((e) => e.item.text === "echo: second"));
    const start = mock.last("session.start")!;
    expect(start.resumeCursor).toMatchObject({ sessionId: expect.stringContaining("native-") });
    expect(
      core2.store.listTimeline(agent.id).filter((e) => e.item.kind === "assistant_message"),
    ).toHaveLength(2);
  });

  it("starts fresh (seeded from history) when the stored conversation is gone, e.g. after moving computers", async () => {
    const core1 = await boot();
    await until(() => core1.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core1);
    await core1.api["chat.send"]({ agentId: agent.id, text: "on the old computer" });
    await until(() => core1.orchestrator.activityOf(agent.id) === "done");
    await core1.shutdown();
    cores = [];
    mock.forgetConversations = true;
    const core2 = await boot();
    await until(() => core2.store.listAccounts().some((a) => a.status === "authenticated"));
    await core2.api["chat.send"]({ agentId: agent.id, text: "on the new computer" });
    await until(() =>
      core2.store.listTimeline(agent.id).some((e) => e.item.text === "echo: on the new computer"),
    );
    await until(() => core2.orchestrator.activityOf(agent.id) === "done");
    const starts = mock.requests.filter((r) => r.type === "session.start") as any[];
    expect(starts.at(-2).resumeCursor).toBeDefined();
    expect(starts.at(-1).resumeCursor).toBeUndefined();
    expect(starts.at(-1).systemAppend).toContain("on the old computer");
    const tl = core2.store.listTimeline(agent.id);
    // No scary error notices, and the user's message isn't duplicated.
    expect(tl.filter((e) => e.item.kind === "notice")).toHaveLength(0);
    expect(tl.filter((e) => e.item.kind === "user_message")).toHaveLength(2);
    expect(core2.orchestrator.activityOf(agent.id)).toBe("done");
  });

  it("/compact: summarizes, drops the heavy session, and seeds the next one from the summary", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["agent.compact"]({ id: agent.id });
    expect(core.store.listTimeline(agent.id).at(-1)!.item.text).toMatch(/Nothing to compact/);

    await core.api["chat.send"]({ agentId: agent.id, text: "plan the lisbon trip" });
    await until(() => core.orchestrator.activityOf(agent.id) === "done");
    core.store.clearUnread(agent.id);
    const sessionBefore = core.orchestrator.sessionKeyOf(agent.id);
    await core.api["agent.compact"]({ id: agent.id, focus: "flight times" });
    await until(
      () =>
        core.store.listTimeline(agent.id).some((e) => /^Compacted our conversation/.test(e.item.text ?? "")),
      5000,
      "compaction",
    );
    // The summary never shows up as a chat message, and compacting doesn't ping the user.
    const tl = core.store.listTimeline(agent.id);
    expect(tl.filter((e) => e.item.kind === "assistant_message")).toHaveLength(1);
    expect(core.store.getAgent(agent.id)!.unread).toBe(0);
    expect((mock.last("turn.send") as any).input[0].text).toContain("Pay special attention to: flight times");
    const summary = core.store.getContextSummary(agent.id)!;
    expect(summary.summary).toContain("compacting this conversation");
    expect(core.store.getSession(sessionBefore!)!.endedAt).toBeTruthy();
    expect(core.orchestrator.sessionKeyOf(agent.id)).toBeNull();

    await core.api["chat.send"]({ agentId: agent.id, text: "book it" });
    await until(() => core.store.listTimeline(agent.id).some((e) => e.item.text === "echo: book it"));
    const start = mock.last("session.start")!;
    expect(start.resumeCursor).toBeUndefined();
    expect(start.systemAppend).toContain("# Summary of the earlier conversation");
    // Only messages after the compaction are replayed (none yet besides the one being sent).
    expect(start.systemAppend).not.toContain("# Most recent messages");
    expect(start.systemAppend).not.toContain("echo: plan the lisbon trip");
  });

  it("auto-compacts once a conversation gets heavy", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    mock.usageContextTokens = 150_000;
    await core.api["chat.send"]({ agentId: agent.id, text: "a very long task" });
    await until(
      () => core.store.listTimeline(agent.id).some((e) => /about 150k tokens/.test(e.item.text ?? "")),
      5000,
      "auto compaction",
    );
    expect(
      core.store.listTimeline(agent.id).some((e) => e.item.kind === "notice" && e.item.status === "failed"),
    ).toBe(false);
    expect(core.store.getContextSummary(agent.id)).not.toBeNull();
    await until(() => core.orchestrator.activityOf(agent.id) !== "working");
  });

  it("replays missed events after a connection drop without duplicates", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "one" });
    await until(() => core.orchestrator.activityOf(agent.id) === "done");
    mock.drop();
    await until(() => !core.agentd.connected);
    await until(() => core.agentd.connected, 8000, "reconnect");
    expect(mock.last("hello")!.resume.length).toBeGreaterThan(0);
    const assistants = core.store.listTimeline(agent.id).filter((e) => e.item.kind === "assistant_message");
    expect(assistants).toHaveLength(1);
  });

  it("starts a fresh seeded session when the agent switches provider", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().every((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "on claude" });
    await until(() => core.orchestrator.activityOf(agent.id) === "done");
    const codex = core.store.listAccounts().find((a) => a.provider === "codex")!;
    await core.api["agent.update"]({ id: agent.id, patch: { accountId: codex.id, model: "gpt-6" } });
    await core.api["chat.send"]({ agentId: agent.id, text: "on codex" });
    await until(() => core.store.listTimeline(agent.id).some((e) => e.item.text === "echo: on codex"));
    const start = mock.last("session.start")!;
    expect(start.provider).toBe("codex");
    expect(start.resumeCursor).toBeUndefined();
    expect(start.systemAppend).toContain("on claude");
    expect(
      core.store
        .listTimeline(agent.id)
        .some((e) => e.item.kind === "notice" && /Switched to ChatGPT/.test(e.item.text ?? "")),
    ).toBe(true);
  });

  it("fires due routines, catches up recent misses, and skips stale ones", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    const r = await core.api["routine.create"]({
      agentId: agent.id,
      name: "Morning brief",
      prompt: "brief me",
      cron: "0 8 * * *",
    });
    expect(r.nextRunAt).toBeGreaterThan(Date.now());
    const stale = await core.api["routine.create"]({
      agentId: agent.id,
      name: "Stale",
      prompt: "old",
      cron: "0 9 * * *",
    });
    core.store.updateRoutine(r.id, { nextRunAt: Date.now() - 60 * 60 * 1000 });
    core.store.updateRoutine(stale.id, { nextRunAt: Date.now() - CATCHUP_WINDOW_MS - 1000 });
    core.scheduler.tick();
    await until(
      () => core.store.listTimeline(agent.id).some((e) => e.item.text === "echo: brief me"),
      5000,
      "routine run",
    );
    expect(core.store.listTimeline(agent.id).some((e) => e.item.text === "echo: old")).toBe(false);
    expect(core.store.getRoutine(r.id)!.nextRunAt).toBeGreaterThan(Date.now());
    expect(core.store.getRoutine(stale.id)!.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("keeps a single card when agentd reconnects while a question is pending", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "ask me" });
    await until(() => core.store.pendingRequests().length === 1, 5000, "pending ask");
    mock.drop(); // agentd re-pushes the unanswered call when the control socket comes back
    await until(() => mock.count("hello") >= 2, 8000, "reconnect");
    await new Promise((r) => setTimeout(r, 300));
    expect(core.store.pendingRequests()).toHaveLength(1);
    const req = core.store.pendingRequests()[0]!;
    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: req.request!.requestId,
      decision: "allow",
      answers: { q: "A" },
    });
    await until(() =>
      core.store.listTimeline(agent.id).some((e) => e.item.text === "got The user answered: A"),
    );
  });

  it("expires pending cards and closes running steps when the provider exits mid-task", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "ask me" });
    await until(() => core.store.pendingRequests().length === 1, 5000, "pending ask");
    const card = core.store.pendingRequests()[0]!;
    mock.exitSession(mock.sessionKeyOf(agent.id)!);
    await until(() => core.store.pendingRequests().length === 0, 5000, "card expired");
    expect(core.store.getEntry(card.id)!.request!.status).toBe("expired");
    expect(core.orchestrator.activityOf(agent.id)).not.toBe("waiting");
    expect(core.orchestrator.isBusy()).toBe(false);
    const turnId = card.turnId!;
    expect(
      core.store.listTimeline(agent.id).filter((e) => e.turnId === turnId && e.item.status === "running"),
    ).toEqual([]);
  });

  it("shows text streamed so far to a client that reconnects mid-reply", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "half the first part of a reply" });
    const streamed = () =>
      core.api["timeline.list"]({ agentId: agent.id }).then((tl) =>
        tl.find((e) => e.item.kind === "assistant_message" && e.item.status === "running"),
      );
    await until(async () => (await streamed())?.item.text === "the first part of a reply", 5000, "live text");
    // The stored row itself only gets the text once the message completes.
    const row = core.store.listTimeline(agent.id).find((e) => e.item.kind === "assistant_message")!;
    expect(row.item.text ?? "").toBe("");
  });

  it("auto-sleep runs on its own when core doesn't manage the computer (the home PC setup)", async () => {
    const core = await boot({ autoSleepCheckMs: 50 }); // computerMode "remote", like the PC
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "hello there" });
    await until(() => core.orchestrator.activityOf(agent.id) === "done", 5000, "reply");
    await core.api["settings.update"]({ autoSleepMinutes: 0.005 }); // 0.3 s
    await until(() => mock.count("computer.hibernate") > 0, 5000, "auto-sleep");
    expect(mock.last("computer.hibernate")?.agentId).toBe(agent.id);
  });

  it("auto-sleep puts idle computers to sleep in any computer mode, never a busy or just-woken one", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    // Busy: a reply that is still streaming keeps its computer awake, however long the idle limit.
    await core.api["chat.send"]({ agentId: agent.id, text: "half the first part of a reply" });
    const reply = () => core.store.listTimeline(agent.id).find((e) => e.item.kind === "assistant_message");
    await until(
      () => core.orchestrator.liveText(reply()?.id ?? "") === "the first part of a reply",
      5000,
      "busy",
    );
    expect(await core.orchestrator.sleepIdle(0)).toEqual([]);
    expect(mock.count("computer.hibernate")).toBe(0);
    // Idle past the limit: put to sleep (this is the path the 1-minute auto-sleep timer takes).
    mock.exitSession(mock.sessionKeyOf(agent.id)!);
    await until(() => !core.orchestrator.isBusy(), 5000, "idle");
    expect(await core.orchestrator.sleepIdle(0)).toEqual([agent.id]);
    expect(mock.last("computer.hibernate")?.agentId).toBe(agent.id);
    expect(core.orchestrator.activityOf(agent.id)).not.toBe("working");
    // Already asleep: nothing more to do.
    expect(await core.orchestrator.sleepIdle(0)).toEqual([]);
    // Woken by hand: counts as use, so it isn't put straight back to sleep.
    await core.api["computer.wake"]({ agentId: agent.id });
    expect(await core.orchestrator.sleepIdle(60_000)).toEqual([]);
    expect(mock.count("computer.hibernate")).toBe(1);
  });

  it("keeps the text streamed so far when the provider exits mid-reply", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "half the first part of a reply" });
    const reply = () => core.store.listTimeline(agent.id).find((e) => e.item.kind === "assistant_message");
    await until(
      () => core.orchestrator.liveText(reply()?.id ?? "") === "the first part of a reply",
      5000,
      "live",
    );
    mock.exitSession(mock.sessionKeyOf(agent.id)!);
    await until(() => reply()?.item.status === "failed", 5000, "closed");
    expect(reply()!.item.text).toBe("the first part of a reply");
  });

  it("tells the chat when core restarted during a task, and closes what it left running", async () => {
    const core1 = await boot();
    await until(() => core1.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core1);
    await core1.api["chat.send"]({ agentId: agent.id, text: "half working on it" });
    await until(() => core1.store.listTimeline(agent.id).some((e) => e.item.kind === "assistant_message"));
    await core1.shutdown();
    cores = [];
    const core2 = await boot();
    const tl = core2.store.listTimeline(agent.id);
    expect(
      tl.some((e) => e.item.kind === "notice" && /Yo restarted during this task/.test(e.item.text ?? "")),
    ).toBe(true);
    expect(tl.filter((e) => e.item.status === "running")).toEqual([]);
  });

  it("keeps a routine quiet when it has nothing to report", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    const pushes = capture(core);
    const r = await core.api["routine.create"]({
      agentId: agent.id,
      name: "Watch prices",
      prompt: "quiet",
      cron: "0 8 * * *",
    });
    core.store.updateRoutine(r.id, { nextRunAt: Date.now() - 60 * 1000 });
    core.scheduler.tick();
    await until(
      () =>
        core.store.listTimeline(agent.id).some((e) => e.item.text === "Routine ran: nothing new to report."),
      5000,
      "quiet routine",
    );
    await until(() => core.orchestrator.activityOf(agent.id) !== "working");
    expect(pushes.some((p) => p.channel === "notify" && p.data.agentId === agent.id)).toBe(false);
    expect(core.store.getAgent(agent.id)!.unread).toBe(0);
    expect(core.store.listTimeline(agent.id).some((e) => e.item.text === "NO_RESPONSE")).toBe(false);
  });

  it("does not keep tool screenshots in the timeline", async () => {
    const core = await boot();
    const agent = primary(core);
    const e = core.store.upsertEntry({
      id: "shot",
      agentId: agent.id,
      turnId: null,
      item: {
        id: "i1",
        kind: "tool",
        status: "completed",
        toolName: "screenshot",
        image: "iVBORw0KGgo=",
      } as any,
    });
    expect(e.item.image).toBeUndefined();
    const raw = core.store.db.prepare("SELECT item_json FROM timeline WHERE id = 'shot'").get() as any;
    expect(raw.item_json).not.toContain("iVBORw0KGgo");
  });

  it("serves the UI with a CSP that allows its inline theme script, and filters pushes by channel", async () => {
    const web = fs.mkdtempSync(path.join(os.tmpdir(), "yo-web-test-"));
    const inline = "\n      document.documentElement.className = 'dark';\n    ";
    fs.writeFileSync(
      path.join(web, "index.html"),
      `<!doctype html><html><head><script>${inline}</script><script type="module" src="./a.js"></script></head></html>`,
    );
    const core = await boot({ dev: true, webDist: web });
    const res = await fetch(`http://127.0.0.1:${core.cfg.port}/`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const hash = (await import("node:crypto")).createHash("sha256").update(inline).digest("base64");
    expect(csp).toContain(`'sha256-${hash}'`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const { default: WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${core.cfg.port}/ws?channels=notify`);
    const got: string[] = [];
    ws.on("message", (raw) => got.push(JSON.parse(raw.toString()).push));
    await new Promise((r) => ws.on("open", r));
    core.hub.push("activity.new", {
      id: "a",
      agentId: null,
      kind: "x",
      summary: "s",
      ref: null,
      ts: 0,
    } as any);
    core.hub.push("notify", { agentId: null, title: "t", body: "b", kind: "info" });
    await until(() => got.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual(["notify"]);
    ws.close();
    fs.rmSync(web, { recursive: true, force: true });
  });

  it("no model: the message says where to connect one, and connecting clears the error", async () => {
    mock.requireLogin = true; // nothing signed in
    const core = await boot();
    await until(() => core.store.listAccounts().every((a) => a.status === "unauthenticated"), 5000, "probe");
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "hi" });
    await until(() => core.orchestrator.activityOf(agent.id) === "error", 5000, "refused");
    const texts = () => core.store.listTimeline(agent.id).map((e) => e.item.text ?? "");
    expect(texts().some((t) => /isn't connected yet\. Connect .* in Settings → Accounts/.test(t))).toBe(true);
    expect(mock.count("turn.send")).toBe(0);

    await core.api["connect.claudeToken"]({ token: `sk-ant-oat01-${"FAKE_core_token-".repeat(6)}` });
    await until(() => core.orchestrator.activityOf(agent.id) !== "error", 5000, "error cleared");
    expect(texts().some((t) => /A model is connected now/.test(t))).toBe(true);
  });

  it("a permission change reaches the running session before the next message", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "hi" });
    await until(() => core.orchestrator.activityOf(agent.id) === "done", 5000, "first turn");
    const started = mock.last("session.start")!;
    expect(started.runtimeMode).toBe("full-access");
    await core.api["agent.update"]({ id: agent.id, patch: { runtimeMode: "approval-required" } });
    await core.api["chat.send"]({ agentId: agent.id, text: "again" });
    await until(() => mock.count("turn.send") === 2, 5000, "second turn");
    expect(mock.last("session.set")).toMatchObject({
      sessionKey: started.sessionKey,
      runtimeMode: "approval-required",
    });
    // Once is enough: the session now runs in that mode.
    await until(() => core.orchestrator.activityOf(agent.id) === "done", 5000, "second turn done");
    await core.api["chat.send"]({ agentId: agent.id, text: "third" });
    await until(() => mock.count("turn.send") === 3, 5000, "third turn");
    expect(mock.count("session.set")).toBe(1);
  });

  describe("after agentd reconnects", () => {
    const lostNotice = (core: Awaited<ReturnType<typeof startCore>>, agentId: string) =>
      core.store.listTimeline(agentId).some((e) => /lost connection to my computer/.test(e.item.text ?? ""));

    for (const reportsLive of [true, false]) {
      it(`keeps a turn that is waiting on a provider approval (${reportsLive ? "agentd lists live sessions" : "older agentd"})`, async () => {
        mock.reportLiveSessions = reportsLive;
        const core = await boot({ lostTurnGraceMs: 300 });
        await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
        const agent = primary(core);
        await core.api["chat.send"]({ agentId: agent.id, text: "approve this" });
        await until(() => core.store.pendingRequests().length === 1, 5000, "pending approval");
        mock.drop(); // a network blip: agentd and the provider session carry on
        await until(() => mock.count("hello") >= 2, 8000, "reconnect");
        await new Promise((r) => setTimeout(r, 800));
        expect(lostNotice(core, agent.id)).toBe(false);
        expect(core.orchestrator.activityOf(agent.id)).toBe("waiting");
        const req = core.store.pendingRequests()[0]!;
        await core.api["request.respond"]({
          agentId: agent.id,
          requestId: req.request!.requestId,
          decision: "allow",
        });
        await until(() => core.store.listTimeline(agent.id).some((e) => e.item.text === "decision allow"));
      });
    }

    it("keeps a quiet turn on a session that survived", async () => {
      const core = await boot({ lostTurnGraceMs: 300 });
      await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
      const agent = primary(core);
      await core.api["chat.send"]({ agentId: agent.id, text: "slow" }); // e.g. a long command with no output
      await until(() => mock.count("turn.send") === 1);
      mock.drop();
      await until(() => mock.count("hello") >= 2, 8000, "reconnect");
      await new Promise((r) => setTimeout(r, 800));
      expect(lostNotice(core, agent.id)).toBe(false);
      expect(core.orchestrator.activityOf(agent.id)).toBe("working");
    });

    it('a computer that comes up after "Do this later" counts as set up', async () => {
      const core = await boot();
      core.store.updateSettings({ computerSetup: "later" });
      const pushes = capture(core);
      mock.drop(); // e.g. the first message woke it
      await until(() => core.store.getSettings().computerSetup === "done", 8000, "set up");
      expect(pushes.some((p) => p.channel === "settings.updated" && p.data.computerSetup === "done")).toBe(
        true,
      );
    });

    for (const reportsLive of [true, false]) {
      it(`keeps a long turn that had to wake the computer first (${reportsLive ? "agentd lists live sessions" : "older agentd"})`, async () => {
        mock.reportLiveSessions = reportsLive;
        const core = await boot({ lostTurnGraceMs: 300 });
        await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
        const agent = primary(core);
        await core.api["chat.send"]({ agentId: agent.id, text: "hi" });
        await until(() => core.orchestrator.activityOf(agent.id) === "done", 5000, "first turn");
        // The computer went to sleep (auto-sleep): its sessions are gone. The next message wakes it.
        mock.restart();
        await until(() => !core.agentd.connected, 5000, "disconnect");
        await core.api["chat.send"]({ agentId: agent.id, text: "slow" }); // a long task, quiet for a while
        await until(() => mock.count("turn.send") === 2, 8000, "sent after the wake-up");
        await new Promise((r) => setTimeout(r, 900));
        expect(lostNotice(core, agent.id)).toBe(false);
        expect(core.orchestrator.activityOf(agent.id)).toBe("working");
      });
    }

    it("ends a turn whose session didn't survive an agentd restart", async () => {
      const core = await boot({ lostTurnGraceMs: 300 });
      await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
      const agent = primary(core);
      await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
      await until(() => mock.count("turn.send") === 1);
      mock.restart();
      await until(() => lostNotice(core, agent.id), 8000, "lost notice");
      await until(() => core.orchestrator.activityOf(agent.id) !== "working");
    });
  });

  it("rejects cross-origin websocket connections", async () => {
    // Dev mode lets a session-less loopback client in, so this exercises the Origin check alone.
    const core = await boot({ dev: true });
    const { default: WebSocket } = await import("ws");
    const url = `ws://127.0.0.1:${core.cfg.port}/ws`;
    const bad = new WebSocket(url, { headers: { Origin: "https://evil.example" } });
    const badResult = await new Promise<string>((resolve) => {
      bad.on("open", () => resolve("open"));
      bad.on("error", () => resolve("rejected"));
      bad.on("unexpected-response", () => resolve("rejected"));
    });
    expect(badResult).toBe("rejected");
    const good = new WebSocket(url, { headers: { Origin: `http://127.0.0.1:${core.cfg.port}` } });
    const reply = await new Promise<any>((resolve) => {
      good.on("open", () => good.send(JSON.stringify({ id: "1", method: "bootstrap", params: {} })));
      good.on("message", (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.id === "1") resolve(f);
      });
    });
    good.close();
    expect(reply.result.agents[0].name).toBe("Yo");
  });

  it("signs in without races: non-blocking start, same link on re-click, refresh can't clobber, bad code errors", async () => {
    mock.requireLogin = true;
    const core = await boot();
    const pushes = capture(core);
    const claude = core.store.listAccounts().find((a) => a.provider === "claude")!;
    await until(() => core.store.getAccount(claude.id)!.status === "unauthenticated");
    await core.api["account.login.start"]({ id: claude.id });
    expect(core.store.getAccount(claude.id)!.status).toBe("signing_in");
    await until(() => pushes.some((p) => p.channel === "account.login" && p.data.url));
    // Re-clicking Connect re-shows the SAME link instead of restarting (restart would invalidate PKCE).
    await core.api["account.login.start"]({ id: claude.id });
    expect(mock.loginStarts).toBe(1);
    const urls = pushes.filter((p) => p.channel === "account.login" && p.data.url).map((p) => p.data.url);
    expect(new Set(urls).size).toBe(1);
    // A status refresh (e.g. on reconnect) must not reset "signing_in".
    await core.accounts.refresh(claude.id);
    expect(core.store.getAccount(claude.id)!.status).toBe("signing_in");
    // Wrong code -> clear error; account back to unauthenticated.
    await core.api["account.login.input"]({ id: claude.id, input: "wrong" });
    await until(() => pushes.some((p) => p.channel === "account.login" && p.data.phase === "error"));
    await until(() => core.store.getAccount(claude.id)!.status === "unauthenticated");
    // Try again (restart) -> fresh link -> right code -> authenticated + token stored.
    await core.api["account.login.start"]({ id: claude.id, restart: true });
    await until(() => mock.loginStarts === 2);
    await until(() => pushes.some((p) => p.channel === "account.login" && p.data.url?.endsWith("s2")));
    await core.api["account.login.input"]({ id: claude.id, input: "code#s2" });
    await until(() => core.store.getAccount(claude.id)!.status === "authenticated", 5000, "authenticated");
    expect(await core.accounts.getSecrets(claude.id)).toEqual({ claudeOauthToken: "sk-ant-oat01-test" });
    expect(core.store.defaultAccount()!.id).toBe(claude.id);
  });

  it("starting sign-in while the computer is off returns immediately and boots it", async () => {
    mock.requireLogin = true;
    const core = await boot();
    const claude = core.store.listAccounts().find((a) => a.provider === "claude")!;
    await until(() => core.store.getAccount(claude.id)!.status === "unauthenticated");
    let booted = false;
    core.accounts.ensureComputer = async () => {
      booted = true;
    };
    mock.drop();
    await until(() => !core.agentd.connected);
    const t0 = Date.now();
    await core.api["account.login.start"]({ id: claude.id });
    expect(Date.now() - t0).toBeLessThan(500);
    await until(() => core.agentd.connected, 8000, "reconnect");
    await until(() => mock.loginStarts === 1, 8000, "login started after boot");
    expect(booted).toBe(true);
  });

  it("gives every existing worker a headset (migration 2) without touching uploaded images", async () => {
    const { openDb } = await import("../src/db/db");
    // Seed agents on a migrated DB, then roll back migration 2 and reopen so it runs against them.
    const db1 = openDb(dataDir);
    db1
      .prepare("INSERT INTO agents (id, name, avatar_json, created_at) VALUES (?,?,?,?)")
      .run(
        "a1",
        "Hat",
        JSON.stringify({ shape: "hex", color: "cobalt", eyes: "round", accessory: "crown" }),
        1,
      );
    db1
      .prepare("INSERT INTO agents (id, name, avatar_json, created_at) VALUES (?,?,?,?)")
      .run(
        "a2",
        "Photo",
        JSON.stringify({ shape: "bubble", color: "yo", eyes: "capsule", accessory: "none", image: "data:x" }),
        2,
      );
    // Roll back migration 2 and everything after it (later ones re-run cleanly).
    db1.exec(
      "DELETE FROM _migrations WHERE version >= 2; DROP TABLE IF EXISTS context_summaries; ALTER TABLE artifacts DROP COLUMN kind; ALTER TABLE device_grants DROP COLUMN app; ALTER TABLE artifacts DROP COLUMN issue_json;",
    );
    db1.close();
    const db2 = openDb(dataDir);
    const rows = db2.prepare("SELECT id, avatar_json FROM agents ORDER BY id").all() as {
      id: string;
      avatar_json: string;
    }[];
    db2.close();
    expect(JSON.parse(rows[0]!.avatar_json).accessory).toBe("headset");
    expect(JSON.parse(rows[1]!.avatar_json).accessory).toBe("none");
  });

  it("fires each scheduled occurrence once, even with duplicate ticks or a second core", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    let fired = 0;
    core.scheduler.setFire(async () => {
      fired++;
    });
    const r = core.scheduler.create({
      agentId: agent.id,
      name: "Daily",
      prompt: "go",
      cron: "0 8 * * *",
      runAt: null,
    });
    const due = Date.now() - 1000;
    core.store.updateRoutine(r.id, { nextRunAt: due });
    // A second process sharing the database claims the same occurrence first.
    expect(core.store.claimRoutineRun(r.id, due)).toBe(true);
    core.scheduler.tick();
    await new Promise((res) => setTimeout(res, 50));
    expect(fired).toBe(0);

    const due2 = Date.now() - 500;
    core.store.updateRoutine(r.id, { nextRunAt: due2 });
    core.scheduler.tick();
    core.scheduler.tick();
    await until(() => fired === 1);
    await new Promise((res) => setTimeout(res, 50));
    expect(fired).toBe(1);
  });

  it("reports a routine that was claimed but never started instead of re-running it", async () => {
    const core = await boot();
    const agent = primary(core);
    const r = core.scheduler.create({
      agentId: agent.id,
      name: "Report",
      prompt: "go",
      cron: "0 8 * * *",
      runAt: null,
    });
    core.store.claimRoutineRun(r.id, 12345);
    let fired = 0;
    core.scheduler.setFire(async () => {
      fired++;
    });
    core.scheduler.stop();
    core.scheduler.start(60_000);
    expect(core.store.claimedRoutineRuns()).toHaveLength(0);
    expect(
      core.store.listActivity(agent.id).some((e) => /didn't start \(Yo restarted\)/.test(e.summary)),
    ).toBe(true);
    expect(fired).toBe(0);
  });

  it("snapshots chat pictures per version: a redone file at the same path gets a new URL, old messages keep theirs", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    const imagesOf = () =>
      core.store
        .listTimeline(agent.id)
        .filter((e) => e.item.kind === "assistant_message" && e.item.status === "completed")
        .map((e) => e.item.images ?? {});

    mock.files.set("/home/agent/desk.png", "RED");
    await core.api["chat.send"]({ agentId: agent.id, text: "![Desk](/home/agent/desk.png)" });
    await until(
      () => imagesOf().length === 1 && !!imagesOf()[0]!["/home/agent/desk.png"],
      5000,
      "first snapshot",
    );
    mock.files.set("/home/agent/desk.png", "BLUE");
    await until(() => core.orchestrator.activityOf(agent.id) !== "working");
    await core.api["chat.send"]({ agentId: agent.id, text: "again ![Desk](/home/agent/desk.png)" });
    await until(
      () => imagesOf().length === 2 && !!imagesOf()[1]!["/home/agent/desk.png"],
      5000,
      "second snapshot",
    );

    const [first, second] = imagesOf().map((m) => m["/home/agent/desk.png"]!);
    expect(first).not.toBe(second);
    const fs = await import("node:fs");
    expect(fs.readFileSync(path.join(dataDir, "chat-images", first!), "utf8")).toBe("RED");
    expect(fs.readFileSync(path.join(dataDir, "chat-images", second!), "utf8")).toBe("BLUE");
  });

  it("bug reports: drafted in the chat, refused until the user answers, then filed on GitHub", async () => {
    const filed: { url: string; body: any }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      filed.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({ number: 42, html_url: "https://github.com/JuniorSua/yo/issues/42" }),
        {
          status: 201,
        },
      );
    }) as unknown as typeof fetch;
    process.env.YO_AGENTD_TOKEN = TOKEN;
    const core = await startCore(
      {
        ...loadConfig({}),
        port: port++,
        dataDir,
        agentdUrl,
        computerMode: "remote",
        secrets: "file",
        webDist: null,
        githubApi: "https://github.test",
      },
      { secrets: new MemorySecretStore(), fetch: fakeFetch },
    );
    cores.push(core);
    await core.agentd.waitReady(5000);
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    expect((await core.api["bugReports.status"]({})).configured).toBe(false);
    await core.api["bugReports.configure"]({ token: "github_pat_fake" });
    const agent = primary(core);
    const replies = () =>
      core.store
        .listTimeline(agent.id)
        .filter((e) => e.item.kind === "assistant_message" && e.item.status === "completed")
        .map((e) => String(e.item.text));

    await core.api["chat.send"]({
      agentId: agent.id,
      text: `tool report_bug ${JSON.stringify({
        stage: "draft",
        title: "Chat shows an old image",
        what_happened: "Redone desk still showed $76,022",
        suspected_cause: "Same URL, cached",
        suggested_fix: "Snapshot by hash",
      })}`,
    });
    await until(() => replies().some((t) => t.includes("[bug-draft:")), 5000, "draft");
    const draftId = /\[bug-draft:(bdr_[A-Za-z0-9]+)\]/.exec(replies().at(-1)!)![1]!;
    expect(core.store.listArtifacts()).toHaveLength(0);
    expect(mock.last("session.start")!.systemAppend).toContain("Would you like me to report it?");

    // The agent tries to submit on its own, without a reply from the user: refused.
    const sessionKey = mock.sessionKeyOf(agent.id)!;
    const early = await mock.forgeToolCall(agent.id, sessionKey, "report_bug", {
      stage: "submit",
      draft_id: draftId,
    });
    expect(early).toMatch(/^Error: Not sent: the user hasn't answered yet/);

    // Another agent can't submit this conversation's draft.
    const other = await core.api["agent.create"]({
      name: "Scout",
      role: "",
      instructions: "",
      avatar: { shape: "bubble", color: "yo", eyes: "capsule", accessory: "headset" },
    });
    await core.api["chat.send"]({ agentId: other.id, text: "yes" });
    await until(() => !!mock.sessionKeyOf(other.id), 5000, "other session");
    const stolen = await mock.forgeToolCall(other.id, mock.sessionKeyOf(other.id)!, "report_bug", {
      stage: "submit",
      draft_id: draftId,
    });
    expect(stolen).toMatch(/no bug report draft .* in this conversation/);
    expect(filed).toHaveLength(0);

    // A reply that isn't a yes doesn't count.
    await until(() => core.orchestrator.activityOf(agent.id) !== "working");
    await core.api["chat.send"]({ agentId: agent.id, text: "what would it say?" });
    await until(() => replies().some((t) => t === "echo: what would it say?"), 5000, "question");
    const unclear = await mock.forgeToolCall(agent.id, sessionKey, "report_bug", {
      stage: "submit",
      draft_id: draftId,
    });
    expect(unclear).toMatch(/isn't a clear yes/);

    // The user says yes (the card's "Report it"), then the agent submits.
    await until(() => core.orchestrator.activityOf(agent.id) !== "working");
    await core.api["chat.send"]({ agentId: agent.id, text: "Report it" });
    await until(() => replies().some((t) => t === "echo: Report it"), 5000, "yes");
    const ok = await mock.forgeToolCall(agent.id, sessionKey, "report_bug", {
      stage: "submit",
      draft_id: draftId,
    });
    expect(ok).toContain("issue #42");
    expect(filed).toHaveLength(1);
    expect(filed[0]!.url).toBe("https://github.test/repos/JuniorSua/yo/issues");
    expect(filed[0]!.body.body).toContain("## Suggested fix\n\nSnapshot by hash");
    expect(filed[0]!.body.body).toContain("Agent: Yo on claude");
    const art = core.store.listArtifacts().find((a) => a.kind === "bug")!;
    expect(art.issue).toEqual({ number: 42, url: "https://github.com/JuniorSua/yo/issues/42" });
    expect(ok).toContain(`[artifact:${art.id}]`);
    const md = (await import("node:fs")).readFileSync(core.store.artifactFile(art.id)!.storedPath, "utf8");
    expect(md).toContain("# Bug: Chat shows an old image");
    expect(md).toContain("## Suspected cause\n\nSame URL, cached");
  });
});
