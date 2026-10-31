import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_ASK_FIXTURE, createFakeClaudeQuery, createReplayClaudeQuery } from "@yo/testkit";
import { describe, expect, it } from "vitest";
import { account, recorder, sessionInput, shape, tempDir } from "../shared/testUtil";
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

  it("gives a server with its own tool limit (the browser, #114) that limit, others 24h", async () => {
    const { fake, adapter, acc } = setup();
    const input = sessionInput(acc);
    input.mcpServers = input.mcpServers.map((s) =>
      s.name === "browser" ? { ...s, toolTimeoutMs: 120_000 } : s,
    );
    await adapter.startSession(input);
    const o = fake.calls[0]!.options;
    expect(o.mcpServers.browser.timeout).toBe(120_000);
    expect(o.mcpServers.yo.timeout).toBe(86_400_000);
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
      // Signed in with Claude Code itself: its config dir holds the sign-in, no token is passed.
      const own = buildClaudeEnv(account("claude"));
      expect(own.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(own.CLAUDE_CONFIG_DIR).toBeTruthy();
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

  it("reports an expired sign-in once, in plain words, without the CLI's '/login' line", async () => {
    const { rec, adapter, acc } = setup();
    await adapter.startSession(sessionInput(acc));
    const start = rec.events.length;
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "expired" }]);
    const done = await rec.waitFor(turnDone("t1"));
    const evs = rec.events.slice(start);
    const errors = evs.filter((e) => e.type === "runtime.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ auth: true, fatal: false });
    expect((errors[0] as { message: string }).message).toMatch(/Sign in again/);
    expect(done).toMatchObject({ status: "failed" });
    expect((done as { error?: string }).error).toMatch(/Sign in again/);
    // Nothing tells the user to run a command they can't run.
    expect(JSON.stringify(evs)).not.toMatch(/\/login|Invalid API key/);
    expect(evs.some((e) => e.type === "item.completed")).toBe(false);
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

  it("re-sends a sub-agent's parent step as a sign of life, at most once a minute (#114)", async () => {
    const rec = recorder();
    const fixture = readFileSync(CLAUDE_ASK_FIXTURE, "utf8").split("\n").filter(Boolean);
    const init = fixture.find((l) => l.includes('"subtype":"init"'))!;
    const result = fixture.find((l) => l.includes('"type":"result"'))!;
    const sub = (type: string, content: unknown[]) =>
      JSON.stringify({
        type,
        message: { id: `msg_sub_${Math.random()}`, role: type, content },
        parent_tool_use_id: "toolu_task",
      });
    const lines = [
      init,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_top",
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_task", name: "Task", input: { description: "Research" } }],
        },
        parent_tool_use_id: null,
      }),
      sub("assistant", [{ type: "tool_use", id: "toolu_sub1", name: "Bash", input: { command: "ls" } }]),
      sub("user", [{ type: "tool_result", tool_use_id: "toolu_sub1", content: "a.txt" }]),
      sub("assistant", [{ type: "text", text: "done" }]),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_task", content: "ok" }],
        },
        parent_tool_use_id: null,
      }),
      result,
    ];
    const file = join(tempDir("yo-subagent-"), "subagent.jsonl");
    writeFileSync(file, `${lines.join("\n")}\n`);
    const replay = createReplayClaudeQuery(file);
    const adapter = createClaudeAdapter(
      { emit: rec.emit, log: rec.log },
      { query: replay.query as unknown as ClaudeQueryFn },
    );
    await adapter.startSession(sessionInput(account("claude")));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "research" }]);
    await rec.waitFor(turnDone("t1"));
    const updates = rec.events.filter((e) => e.type === "item.updated" && e.item.id === "toolu_task");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ turnId: "t1", item: { status: "running", toolName: "Task" } });
    await adapter.dispose();
  });

  it("restarts a session whose interrupted turn never ends, instead of folding the next message into it", async () => {
    // A wedged CLI (#114): it never answers the interrupt and never ends the turn.
    const rec = recorder();
    const queries: { closed: boolean; aborted: () => boolean }[] = [];
    const wedged = ((params: { options?: { abortController?: AbortController } }) => {
      const state = { closed: false, aborted: () => !!params.options?.abortController?.signal.aborted };
      queries.push(state);
      let wake = () => {};
      return {
        async *[Symbol.asyncIterator]() {
          while (!state.closed) await new Promise<void>((r) => (wake = r));
        },
        interrupt: () => new Promise(() => {}),
        close: () => {
          state.closed = true;
          wake();
        },
      };
    }) as unknown as ClaudeQueryFn;
    const adapter = createClaudeAdapter(
      { emit: rec.emit, log: rec.log },
      { query: wedged, interruptAckMs: 20, stuckInterruptMs: 30 },
    );
    await adapter.startSession(sessionInput(account("claude")));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "open the sheet" }]);
    // The interrupt returns even though the CLI never answers it.
    await adapter.interrupt("s1");
    expect(rec.logs.some((l) => /claude interrupt failed: claude interrupt timed out/.test(l))).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    const before = rec.events.length;
    await expect(adapter.sendTurn("s1", "t2", [{ type: "text", text: "continue" }])).rejects.toThrow(
      /unknown session s1/,
    );
    expect(adapter.hasSession("s1")).toBe(false);
    expect(queries[0]).toMatchObject({ closed: true });
    expect(queries[0]!.aborted()).toBe(true);
    // Core already closed the turn: nothing that would fail its retry (session.exited, turn.completed).
    expect(rec.events.slice(before)).toEqual([]);
    await adapter.dispose();
  });

  it("still folds a message sent right after an interrupt into the turn (it may be ending)", async () => {
    const { rec, adapter, acc } = setup();
    await adapter.startSession(sessionInput(acc));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "interrupt me" }]);
    await rec.waitFor((e) => e.type === "content.delta");
    await adapter.interrupt("s1");
    await adapter.sendTurn("s1", "t2", [{ type: "text", text: "and then this" }]);
    expect(adapter.hasSession("s1")).toBe(true);
    await adapter.dispose();
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
