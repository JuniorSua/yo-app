import { CLAUDE_ASK_FIXTURE, createFakeClaudeQuery, createReplayClaudeQuery } from "@yo/testkit";
import { describe, expect, it } from "vitest";
import { account, recorder, sessionInput, shape } from "../shared/testUtil";
import {
  buildClaudeEnv,
  CLAUDE_FALLBACK_MODELS,
  type ClaudeQueryFn,
  createClaudeAdapter,
} from "./ClaudeAdapter";
import { CLAUDE_DISALLOWED_TOOLS } from "./mapping";

const TOKEN = "sk-ant-oat01-SECRETsecretSECRETsecretSECRETsecret0123456789abcdef";

function setup(opts: { secrets?: Record<string, string> } = {}) {
  const rec = recorder();
  const fake = createFakeClaudeQuery();
  const adapter = createClaudeAdapter(
    { emit: rec.emit, log: rec.log },
    { query: fake.query as unknown as ClaudeQueryFn, executablePath: "/nonexistent/claude" },
  );
  const acc = account("claude", { claudeOauthToken: TOKEN, ...opts.secrets });
  return { rec, fake, adapter, acc };
}

const turnDone = (turnId: string) => (e: { type: string; turnId?: string }) =>
  e.type === "turn.completed" && e.turnId === turnId;

describe("ClaudeAdapter", () => {
  it("starts a session with the expected SDK options", async () => {
    const { fake, adapter, acc } = setup();
    const input = sessionInput(acc, {
      model: "claude-sonnet-5-5",
      effort: "high",
      runtimeMode: "approval-required",
    });
    const { resumed } = await adapter.startSession(input);
    expect(resumed).toBe(false);
    const o = fake.calls[0]!.options;
    expect(o.cwd).toBe(input.cwd);
    expect(o.model).toBe("claude-sonnet-5-5");
    expect(o.effort).toBe("high");
    expect(o.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: input.systemAppend });
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.includePartialMessages).toBe(true);
    expect(o.permissionMode).toBe("default");
    expect(o.disallowedTools).toEqual(CLAUDE_DISALLOWED_TOOLS);
    expect(o.disallowedTools).toContain("CronCreate");
    expect(o.settings).toEqual({ autoMemoryEnabled: false });
    expect(o.mcpServers.browser).toMatchObject({
      type: "stdio",
      command: "playwright-mcp",
      args: ["--cdp-endpoint", "http://127.0.0.1:9301"],
    });
    expect(o.mcpServers.yo.env).toEqual({ YO_AGENT: "agt_1" });
    expect(o.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(o.resume).toBeUndefined();
    expect(o.hooks.PreToolUse[0].matcher).toBe("AskUserQuestion");
    // env
    expect(o.env.CLAUDE_CONFIG_DIR).toBe(acc.configDir);
    expect(o.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(o.env.DISABLE_AUTOUPDATER).toBe("1");
    expect(o.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(o.env.MCP_TOOL_TIMEOUT).toBe("86400000");
    expect(o.env.DISPLAY).toBe(":7");
    expect(o.env.ANTHROPIC_API_KEY).toBeUndefined();
    await adapter.dispose();
  });

  it("strips ANTHROPIC_API_KEY from the child env unless the account uses it", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-hostkeyhostkeyhostkeyhostkey";
    process.env.OPENAI_API_KEY = "sk-proj-hostkeyhostkeyhostkeyhostkey";
    try {
      const oauth = buildClaudeEnv(account("claude", { claudeOauthToken: TOKEN }));
      expect(oauth.ANTHROPIC_API_KEY).toBeUndefined();
      expect(oauth.OPENAI_API_KEY).toBeUndefined();
      const api = buildClaudeEnv(account("claude", { anthropicApiKey: "sk-ant-api03-accountkeyaccountkey" }));
      expect(api.ANTHROPIC_API_KEY).toBe("sk-ant-api03-accountkeyaccountkey");
      expect(api.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("maps a full turn to normalized events (full-access)", async () => {
    const { rec, adapter, acc } = setup();
    await adapter.startSession(sessionInput(acc));
    const start = rec.events.length;
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "shop for me" }]);
    const done = await rec.waitFor(turnDone("t1"));
    const evs = rec.events.slice(start);
    expect(shape(evs)).toEqual([
      "turn.started",
      "state:running",
      "item.started:assistant_message",
      "delta:text",
      "delta:text",
      "item.completed:assistant_message",
      "item.started:command",
      "item.completed:command",
      "item.started:browser",
      "item.completed:browser",
      "item.started:todo",
      "item.completed:todo",
      "item.started:assistant_message",
      "delta:text",
      "item.completed:assistant_message",
      "turn.completed:completed",
      "state:idle",
    ]);
    const completed = evs
      .filter((e) => e.type === "item.completed")
      .map((e) => (e.type === "item.completed" ? e.item : null));
    expect(completed[0]).toMatchObject({ kind: "assistant_message", text: "Hello there" });
    expect(completed[1]).toMatchObject({
      kind: "command",
      title: "Ran `ls -la`",
      output: "file1\nfile2",
      status: "completed",
    });
    expect(completed[2]).toMatchObject({
      kind: "browser",
      title: "Opened amazon.com",
      image: "iVBORw0KGgo=",
    });
    expect(completed[3]).toMatchObject({
      kind: "todo",
      todos: [
        { text: "Open Amazon", status: "completed" },
        { text: "Find the item", status: "in_progress" },
      ],
    });
    expect(done).toMatchObject({
      type: "turn.completed",
      status: "completed",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 },
    });
    const started = rec.events.find((e) => e.type === "session.started");
    const sessionId = started?.type === "session.started" ? started.resumeCursor?.sessionId : undefined;
    expect(sessionId).toBeTruthy();
    expect(done.type === "turn.completed" && done.resumeCursor).toEqual({ sessionId });
    await adapter.dispose();
  });

  it("round-trips a tool approval (approval-required)", async () => {
    const { rec, adapter, acc } = setup();
    await adapter.startSession(sessionInput(acc, { runtimeMode: "approval-required" }));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "list files" }]);
    const opened = await rec.waitFor((e) => e.type === "request.opened");
    if (opened.type !== "request.opened") throw new Error();
    expect(opened.request).toMatchObject({
      kind: "tool_approval",
      toolName: "Bash",
      input: { command: "ls -la" },
    });
    expect(rec.events.at(-1)).toEqual({ type: "session.state", state: "waiting" });
    await adapter.respond("s1", { requestId: opened.request.requestId, decision: "deny", message: "no" });
    // The browser MCP call asks next.
    const nav = await rec.waitFor(
      (e) => e.type === "request.opened" && e.request.toolName === "mcp__browser__browser_navigate",
    );
    if (nav.type !== "request.opened") throw new Error();
    expect(nav.request.title).toBe("Claude wants to use mcp__browser__browser_navigate");
    await adapter.respond("s1", { requestId: nav.request.requestId, decision: "allow" });
    await rec.waitFor(turnDone("t1"));
    const cmd = rec.events.find((e) => e.type === "item.completed" && e.item.kind === "command");
    expect(cmd).toMatchObject({ item: { status: "failed" } });
    expect(rec.events).toContainEqual({
      type: "request.resolved",
      requestId: opened.request.requestId,
      decision: "deny",
    });
    await adapter.dispose();
  });

  it("allowAlways passes the SDK's permission suggestions back", async () => {
    const { rec, adapter, acc } = setup();
    await adapter.startSession(sessionInput(acc, { runtimeMode: "approval-required" }));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "list files" }]);
    const opened = await rec.waitFor((e) => e.type === "request.opened");
    if (opened.type !== "request.opened") throw new Error();
    await adapter.respond("s1", { requestId: opened.request.requestId, decision: "allowAlways" });
    const nav = await rec.waitFor((e) => e.type === "request.opened" && e.request.toolName !== "Bash");
    if (nav.type !== "request.opened") throw new Error();
    await adapter.respond("s1", { requestId: nav.request.requestId, decision: "allow" });
    await rec.waitFor(turnDone("t1"));
    expect(rec.events.find((e) => e.type === "item.completed" && e.item.kind === "command")).toMatchObject({
      item: { status: "completed", output: "file1\nfile2" },
    });
    await adapter.dispose();
  });

  it("turns AskUserQuestion into a user_input request in full-access mode (PreToolUse hook)", async () => {
    const { rec, adapter, acc } = setup();
    await adapter.startSession(sessionInput(acc, { runtimeMode: "full-access" }));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "ask me" }]);
    const opened = await rec.waitFor((e) => e.type === "request.opened");
    if (opened.type !== "request.opened") throw new Error();
    expect(opened.request).toMatchObject({
      kind: "user_input",
      title: "Which color?",
      questions: [
        {
          question: "Which color?",
          header: "Color",
          options: [{ label: "Red" }, { label: "Blue" }],
          multiSelect: false,
        },
      ],
    });
    await adapter.respond("s1", {
      requestId: opened.request.requestId,
      decision: "allow",
      answers: { "Which color?": "Blue" },
    });
    await rec.waitFor(turnDone("t1"));
    const texts = rec.events.flatMap((e) =>
      e.type === "item.completed" && e.item.kind === "assistant_message" ? [e.item.text] : [],
    );
    expect(texts).toContain("You picked Blue");
    await adapter.dispose();
  });

  it("interrupts a running turn", async () => {
    const { rec, adapter, acc } = setup();
    await adapter.startSession(sessionInput(acc));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "interrupt me" }]);
    await rec.waitFor((e) => e.type === "content.delta");
    await adapter.interrupt("s1");
    const done = await rec.waitFor(turnDone("t1"));
    expect(done).toMatchObject({ status: "interrupted" });
    expect(rec.events.at(-1)).toEqual({ type: "session.state", state: "idle" });
    await adapter.dispose();
  });

  it("resumes from a cursor and changes model / permission mode", async () => {
    const { fake, adapter, acc } = setup();
    const cursor = { sessionId: "11111111-2222-3333-4444-555555555555" };
    const r = await adapter.startSession(sessionInput(acc, { resumeCursor: cursor }));
    expect(r.resumed).toBe(true);
    const call = fake.calls[0]!;
    expect(call.options.resume).toBe(cursor.sessionId);
    expect(call.options.sessionId).toBeUndefined();
    await adapter.setSession!("s1", { model: "claude-opus-5-5", runtimeMode: "approval-required" });
    expect(call.query.model).toBe("claude-opus-5-5");
    expect(call.query.permissionMode).toBe("default");
    await adapter.dispose();
  });

  it("never leaks the OAuth token into emitted events", async () => {
    const { rec, adapter, acc } = setup();
    await adapter.startSession(sessionInput(acc));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "leak the token" }]);
    await rec.waitFor(turnDone("t1"));
    const json = JSON.stringify(rec.events);
    expect(json).not.toContain(TOKEN);
    expect(json).toContain("[redacted]");
    expect(rec.logs.join("\n")).not.toContain(TOKEN);
    await adapter.dispose();
  });

  it("emits rate_limit events", async () => {
    const { rec, adapter, acc } = setup();
    await adapter.startSession(sessionInput(acc));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "rate" }]);
    await rec.waitFor(turnDone("t1"));
    const rl = rec.events.filter((e) => e.type === "rate_limit");
    expect(rl[0]).toMatchObject({ info: { status: "limited", resetsAt: 1790000000000, utilization: 1 } });
    await adapter.dispose();
  });

  it("probes via SDK initialization without sending a prompt", async () => {
    const { fake, adapter, acc } = setup();
    const st = await adapter.probe(acc);
    expect(st).toMatchObject({
      status: "authenticated",
      email: "fake@example.com",
      plan: "Claude Max",
      provider: "claude",
    });
    expect(fake.calls[0]!.prompts).toHaveLength(0);
    expect(fake.calls[0]!.options.persistSession).toBe(false);
    const models = await adapter.listModels(acc);
    expect(models.map((m) => m.id)).toEqual(["default", "opus", "haiku"]);
    expect(models[0]).toMatchObject({ isDefault: true, efforts: ["low", "medium", "high"] });
    expect(CLAUDE_FALLBACK_MODELS.find((m) => m.isDefault)?.id).toBe("claude-sonnet-5-5");
  });

  it("replays a recorded live session (AskUserQuestion, Haiku 4.5)", async () => {
    const rec = recorder();
    const replay = createReplayClaudeQuery(CLAUDE_ASK_FIXTURE);
    const adapter = createClaudeAdapter(
      { emit: rec.emit, log: rec.log },
      { query: replay.query as unknown as ClaudeQueryFn },
    );
    await adapter.startSession(sessionInput(account("claude")));
    const start = rec.events.length;
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "ask" }]);
    await rec.waitFor(turnDone("t1"));
    expect(shape(rec.events.slice(start))).toEqual([
      "turn.started",
      "state:running",
      "item.started:tool",
      "rate_limit",
      "item.completed:tool",
      "item.started:assistant_message",
      "delta:text",
      "item.completed:assistant_message",
      "turn.completed:completed",
      "state:idle",
    ]);
    const msg = rec.events.find((e) => e.type === "item.completed" && e.item.kind === "assistant_message");
    expect(msg).toMatchObject({ item: { text: "Blue" } });
    await adapter.dispose();
  });
});
