import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCodexCommand } from "@yo/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { account, recorder, sessionInput, shape, tempDir } from "../shared/testUtil";
import { createCodexAdapter } from "./CodexAdapter";
import { buildCodexConfigToml, mcpConfigOverrides, tomlString } from "./config";

const API_KEY = "sk-proj-SECRETsecretSECRETsecretSECRETsecret";
let logFile: string;

beforeEach(() => {
  logFile = join(tempDir("yo-codexlog-"), "log.jsonl");
  process.env.FAKE_CODEX_LOG = logFile;
});
afterEach(() => {
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_AUTH;
});

function requests(): { method: string; params: Record<string, any>; argv: string[] }[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function setup() {
  const rec = recorder();
  const adapter = createCodexAdapter({ emit: rec.emit, log: rec.log }, { command: fakeCodexCommand() });
  return { rec, adapter };
}

const turnDone = (turnId: string) => (e: { type: string; turnId?: string }) =>
  e.type === "turn.completed" && e.turnId === turnId;

describe("codex config", () => {
  it("generates a hardened config.toml with MCP servers", () => {
    const toml = buildCodexConfigToml({
      mcpServers: [
        {
          name: "browser",
          command: "playwright-mcp",
          args: ["--cdp-endpoint", 'http://127.0.0.1:9301 "x"'],
          env: { DISPLAY: ":7" },
        },
      ],
    });
    expect(toml).toContain('cli_auth_credentials_store = "file"');
    expect(toml).toContain('sandbox_mode = "danger-full-access"');
    for (const f of [
      "computer_use",
      "browser_use",
      "browser_use_external",
      "apps",
      "plugins",
      "remote_plugin",
      "memories",
    ]) {
      expect(toml).toContain(`\n${f} = false\n`);
    }
    expect(toml).toContain("[mcp_servers.browser]");
    expect(toml).toContain('args = ["--cdp-endpoint", "http://127.0.0.1:9301 \\"x\\""]');
    expect(toml).toContain('env = { DISPLAY = ":7" }');
    expect(toml).toContain("tool_timeout_sec = 86400");
    expect(tomlString('a\\b"\n')).toBe('"a\\\\b\\"\\n"');
  });

  it("builds per-process -c overrides", () => {
    expect(mcpConfigOverrides([{ name: "yo", command: "node", args: ["a.js"] }])).toEqual([
      "-c",
      'mcp_servers.yo.command="node"',
      "-c",
      'mcp_servers.yo.args=["a.js"]',
      "-c",
      "mcp_servers.yo.startup_timeout_sec=60",
      "-c",
      "mcp_servers.yo.tool_timeout_sec=86400",
    ]);
  });
});

describe("CodexAdapter (fake app-server)", () => {
  it("starts a thread and maps a full turn", async () => {
    const { rec, adapter } = setup();
    const acc = account("codex");
    const input = sessionInput(acc, { model: "gpt-6.1-sol", effort: "high" });
    const r = await adapter.startSession(input);
    expect(r.resumed).toBe(false);
    expect(readFileSync(join(acc.configDir, "config.toml"), "utf8")).toContain("[mcp_servers.yo]");
    const start = rec.events.length;
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "hello" }]);
    const done = await rec.waitFor(turnDone("t1"));
    const evs = rec.events.slice(start);
    expect(shape(evs)).toEqual([
      "turn.started",
      "state:running",
      "item.started:reasoning",
      "delta:reasoning",
      "item.completed:reasoning",
      "item.started:assistant_message",
      "delta:text",
      "delta:text",
      "delta:text",
      "item.completed:assistant_message",
      "item.started:todo",
      "item.started:command",
      "delta:command_output",
      "item.completed:command",
      "item.started:browser",
      "item.completed:browser",
      "rate_limit",
      "item.completed:todo",
      "turn.completed:completed",
      "state:idle",
    ]);
    const items = evs.flatMap((e) => (e.type === "item.completed" ? [e.item] : []));
    expect(items.find((i) => i.kind === "assistant_message")?.text).toBe("Hello from Codex");
    expect(items.find((i) => i.kind === "command")).toMatchObject({
      title: "Ran `ls -la`",
      output: "file1\nfile2\n",
      status: "completed",
    });
    expect(items.find((i) => i.kind === "browser")).toMatchObject({
      title: "Opened amazon.com",
      output: "Navigated to amazon.com",
    });
    expect(items.find((i) => i.kind === "todo")?.todos).toEqual([
      { text: "List files", status: "in_progress" },
      { text: "Summarize", status: "pending" },
    ]);
    expect(evs.find((e) => e.type === "rate_limit")).toMatchObject({
      info: { status: "warning", utilization: 0.85, resetsAt: 1790000000000 },
    });
    expect(done).toMatchObject({
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10 },
      resumeCursor: { threadId: "thr_fake_1" },
    });

    const reqs = requests();
    const ts = reqs.find((q) => q.method === "thread/start")!;
    expect(ts.params).toMatchObject({
      model: "gpt-6.1-sol",
      cwd: input.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: input.systemAppend,
    });
    expect(ts.argv).toContain("app-server");
    expect(ts.argv).toContain('mcp_servers.browser.args=["--cdp-endpoint", "http://127.0.0.1:9301"]');
    const turn = reqs.find((q) => q.method === "turn/start")!;
    expect(turn.params).toMatchObject({
      threadId: "thr_fake_1",
      effort: "high",
      input: [{ type: "text", text: "hello" }],
    });
    await adapter.dispose();
  });

  it("round-trips a command approval (approval-required → untrusted)", async () => {
    const { rec, adapter } = setup();
    await adapter.startSession(sessionInput(account("codex"), { runtimeMode: "approval-required" }));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "list" }]);
    const opened = await rec.waitFor((e) => e.type === "request.opened");
    if (opened.type !== "request.opened") throw new Error();
    expect(opened.request).toMatchObject({
      kind: "tool_approval",
      title: "Run `ls -la`",
      detail: "List the directory",
    });
    await adapter.respond("s1", { requestId: opened.request.requestId, decision: "deny" });
    await rec.waitFor(turnDone("t1"));
    expect(rec.events.find((e) => e.type === "item.completed" && e.item.kind === "command")).toMatchObject({
      item: { status: "failed" },
    });
    expect(requests().find((q) => q.method === "thread/start")!.params.approvalPolicy).toBe("untrusted");
    await adapter.dispose();
  });

  it("auto mode approves Codex requests without asking", async () => {
    const { rec, adapter } = setup();
    await adapter.startSession(sessionInput(account("codex"), { runtimeMode: "auto" }));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "list" }]);
    await rec.waitFor(turnDone("t1"));
    expect(rec.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(rec.events.find((e) => e.type === "item.completed" && e.item.kind === "command")).toMatchObject({
      item: { status: "completed" },
    });
    await adapter.dispose();
  });

  it("round-trips item/tool/requestUserInput", async () => {
    const { rec, adapter } = setup();
    await adapter.startSession(sessionInput(account("codex")));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "ask me" }]);
    const opened = await rec.waitFor((e) => e.type === "request.opened");
    if (opened.type !== "request.opened") throw new Error();
    expect(opened.request).toMatchObject({
      kind: "user_input",
      questions: [{ question: "Which color?", header: "Color" }],
    });
    await adapter.respond("s1", {
      requestId: opened.request.requestId,
      decision: "allow",
      answers: { "Which color?": "Blue" },
    });
    await rec.waitFor(turnDone("t1"));
    expect(
      rec.events.find((e) => e.type === "item.completed" && e.item.kind === "assistant_message"),
    ).toMatchObject({
      item: { text: "You picked Blue" },
    });
    await adapter.dispose();
  });

  it("interrupts a running turn", async () => {
    const { rec, adapter } = setup();
    await adapter.startSession(sessionInput(account("codex")));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "interrupt me" }]);
    await rec.waitFor((e) => e.type === "content.delta");
    await adapter.interrupt("s1");
    expect(await rec.waitFor(turnDone("t1"))).toMatchObject({ status: "interrupted" });
    expect(requests().some((q) => q.method === "turn/interrupt")).toBe(true);
    await adapter.dispose();
  });

  it("resumes a thread from the cursor and falls back to a new thread", async () => {
    const { rec, adapter } = setup();
    const acc = account("codex");
    expect(
      (await adapter.startSession(sessionInput(acc, { resumeCursor: { threadId: "thr_old" } }))).resumed,
    ).toBe(true);
    expect(rec.events.find((e) => e.type === "session.started")).toMatchObject({
      resumeCursor: { threadId: "thr_old" },
    });
    expect(requests().find((q) => q.method === "thread/resume")!.params).toMatchObject({
      threadId: "thr_old",
      developerInstructions: expect.any(String),
    });
    expect(
      (
        await adapter.startSession(
          sessionInput(acc, { sessionKey: "s2", resumeCursor: { threadId: "thr_missing" } }),
        )
      ).resumed,
    ).toBe(false);
    await adapter.dispose();
  });

  it("never leaks the API key into events", async () => {
    const { rec, adapter } = setup();
    await adapter.startSession(sessionInput(account("codex", { openaiApiKey: API_KEY })));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "leak" }]);
    await rec.waitFor(turnDone("t1"));
    const json = JSON.stringify(rec.events);
    expect(json).toContain("OPENAI_API_KEY=[redacted]");
    expect(json).not.toContain(API_KEY);
    await adapter.dispose();
  });

  it("probes account, lists models and logs in with a device code", async () => {
    const { adapter } = setup();
    const acc = account("codex");
    expect(await adapter.probe(acc)).toMatchObject({
      status: "authenticated",
      email: "fake@example.com",
      plan: "ChatGPT Pro",
    });
    process.env.FAKE_CODEX_AUTH = "none";
    expect(await adapter.probe(acc)).toMatchObject({ status: "unauthenticated" });
    const models = await adapter.listModels(acc);
    expect(models).toEqual([
      {
        id: "gpt-6.1-sol",
        label: "GPT-6.1 Sol",
        description: "Flagship",
        isDefault: true,
        efforts: ["low", "high"],
      },
      { id: "gpt-5.5", label: "GPT-5.5", description: "Older" },
    ]);
    const prompts: unknown[] = [];
    const result = await new Promise(
      (resolve) => void adapter.login(acc, { prompt: (p) => prompts.push(p), result: resolve }),
    );
    expect(prompts[0]).toMatchObject({
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      needsInput: false,
    });
    expect(result).toEqual({ ok: true });
    expect(requests().find((q) => q.method === "account/login/start")!.params).toEqual({
      type: "chatgptDeviceCode",
    });
  });

  it("reports not_installed when the CLI is missing", async () => {
    const rec = recorder();
    const adapter = createCodexAdapter({ emit: rec.emit, log: rec.log }, { command: ["/nonexistent/codex"] });
    expect(await adapter.probe(account("codex"))).toMatchObject({ status: "not_installed" });
  });
});
