import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeGrokCommand } from "@yo/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { account, recorder, sessionInput, shape, tempDir } from "../shared/testUtil";
import { createGrokAdapter } from "./GrokAdapter";
import { askResponse, parseGrokModels } from "./mapping";

let logFile: string;
beforeEach(() => {
  logFile = join(tempDir("yo-groklog-"), "log.jsonl");
  process.env.FAKE_GROK_LOG = logFile;
});
afterEach(() => {
  delete process.env.FAKE_GROK_LOG;
  delete process.env.FAKE_GROK_AUTH;
});

function requests(): { method: string; params?: Record<string, any>; argv?: string[]; outcome?: any }[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function setup() {
  const rec = recorder();
  const adapter = createGrokAdapter({ emit: rec.emit, log: rec.log }, { command: fakeGrokCommand() });
  return { rec, adapter };
}

const turnDone = (turnId: string) => (e: { type: string; turnId?: string }) =>
  e.type === "turn.completed" && e.turnId === turnId;

describe("grok mapping", () => {
  it("parses `grok models` output", () => {
    const out =
      "You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n";
    expect(parseGrokModels(out)).toEqual({
      authenticated: false,
      models: [
        { id: "grok-4.6", label: "Grok 4.6", isDefault: true },
        { id: "grok-4.5", label: "Grok 4.5" },
      ],
    });
  });

  it("builds x.ai ask_user_question responses", () => {
    const params = {
      questions: [{ question: "Pick?", options: [{ label: "A" }, { label: "B" }], multiSelect: true }],
    };
    expect(askResponse(params, { "Pick?": "A, B" })).toEqual({
      outcome: "accepted",
      answers: { "Pick?": ["A", "B"] },
    });
    expect(askResponse(params, undefined)).toEqual({ outcome: "cancelled" });
  });
});

describe("GrokAdapter (fake ACP agent)", () => {
  it("creates a session with rules/MCP and maps a full turn (approval-required)", async () => {
    const { rec, adapter } = setup();
    const acc = account("grok");
    const input = sessionInput(acc, { runtimeMode: "approval-required", model: "grok-4.6" });
    expect((await adapter.startSession(input)).resumed).toBe(false);
    const start = rec.events.length;
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "hello" }]);
    const opened = await rec.waitFor((e) => e.type === "request.opened");
    if (opened.type !== "request.opened") throw new Error();
    expect(opened.request).toMatchObject({
      kind: "tool_approval",
      title: "Run `ls -la`",
      input: { command: "ls -la" },
    });
    await adapter.respond("s1", { requestId: opened.request.requestId, decision: "allowAlways" });
    const done = await rec.waitFor(turnDone("t1"));
    expect(shape(rec.events.slice(start))).toEqual([
      "turn.started",
      "state:running",
      "item.started:reasoning",
      "delta:reasoning",
      "item.completed:reasoning",
      "item.started:assistant_message",
      "delta:text",
      "delta:text",
      "delta:text",
      "item.completed:todo",
      "item.completed:assistant_message",
      "item.started:command",
      "request.opened:tool_approval",
      "state:waiting",
      "request.resolved",
      "state:running",
      "item.completed:command",
      "item.started:browser",
      "item.completed:browser",
      "item.started:assistant_message",
      "delta:text",
      "item.completed:assistant_message",
      "turn.completed:completed",
      "state:idle",
    ]);
    const items = rec.events.flatMap((e) => (e.type === "item.completed" ? [e.item] : []));
    expect(items.find((i) => i.kind === "command")).toMatchObject({
      output: "file1\nfile2",
      status: "completed",
    });
    expect(items.find((i) => i.kind === "browser")).toMatchObject({ title: "Clicked 'Add to cart'" });
    expect(items.find((i) => i.kind === "todo")?.todos).toEqual([
      { text: "List files", status: "in_progress" },
      { text: "Report", status: "pending" },
    ]);
    expect(done).toMatchObject({
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 4 },
      resumeCursor: { sessionId: "ses_fake_1" },
    });

    const reqs = requests();
    const init = reqs.find((r) => r.method === "initialize")!;
    expect(init.argv).toEqual(["agent", "--model", "grok-4.6", "stdio"]);
    const ns = reqs.find((r) => r.method === "session/new")!;
    expect(ns.params).toMatchObject({ cwd: input.cwd, _meta: { rules: input.systemAppend } });
    expect(ns.params!.mcpServers).toContainEqual({
      name: "yo",
      command: "node",
      args: ["/opt/yo/yo-mcp.js"],
      env: [{ name: "YO_AGENT", value: "agt_1" }],
    });
    expect(reqs.find((r) => r.method === "permission.result")!.outcome).toEqual({
      outcome: "selected",
      optionId: "always",
    });
    await adapter.dispose();
  });

  it("full-access runs with --always-approve / yoloMode and never asks", async () => {
    const { rec, adapter } = setup();
    await adapter.startSession(sessionInput(account("grok"), { runtimeMode: "full-access" }));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "go" }]);
    await rec.waitFor(turnDone("t1"));
    expect(rec.events.some((e) => e.type === "request.opened")).toBe(false);
    const reqs = requests();
    expect(reqs.find((r) => r.method === "initialize")!.argv).toContain("--always-approve");
    expect(reqs.find((r) => r.method === "session/new")!.params!._meta).toMatchObject({ yoloMode: true });
    await adapter.dispose();
  });

  it("denied permission fails the tool", async () => {
    const { rec, adapter } = setup();
    await adapter.startSession(sessionInput(account("grok"), { runtimeMode: "approval-required" }));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "go" }]);
    const opened = await rec.waitFor((e) => e.type === "request.opened");
    if (opened.type !== "request.opened") throw new Error();
    await adapter.respond("s1", { requestId: opened.request.requestId, decision: "deny" });
    await rec.waitFor(turnDone("t1"));
    expect(rec.events.find((e) => e.type === "item.completed" && e.item.kind === "command")).toMatchObject({
      item: { status: "failed", output: "Permission denied" },
    });
    await adapter.dispose();
  });

  it("round-trips x.ai ask_user_question", async () => {
    const { rec, adapter } = setup();
    await adapter.startSession(sessionInput(account("grok")));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "ask me" }]);
    const opened = await rec.waitFor((e) => e.type === "request.opened");
    if (opened.type !== "request.opened") throw new Error();
    expect(opened.request).toMatchObject({ kind: "user_input", questions: [{ question: "Which color?" }] });
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

  it("interrupts via session/cancel", async () => {
    const { rec, adapter } = setup();
    await adapter.startSession(sessionInput(account("grok")));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "interrupt me" }]);
    await rec.waitFor((e) => e.type === "content.delta");
    await adapter.interrupt("s1");
    expect(await rec.waitFor(turnDone("t1"))).toMatchObject({ status: "interrupted" });
    expect(requests().some((r) => r.method === "session/cancel")).toBe(true);
    await adapter.dispose();
  });

  it("queues a second turn sent mid-turn", async () => {
    const { rec, adapter } = setup();
    await adapter.startSession(sessionInput(account("grok")));
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "go" }]);
    await adapter.sendTurn("s1", "t2", [{ type: "text", text: "ask" }]);
    await rec.waitFor(turnDone("t1"));
    const opened = await rec.waitFor((e) => e.type === "request.opened" && e.request.kind === "user_input");
    if (opened.type !== "request.opened") throw new Error();
    expect(opened.turnId).toBe("t2");
    await adapter.respond("s1", { requestId: opened.request.requestId, decision: "deny" });
    await rec.waitFor(turnDone("t2"));
    await adapter.dispose();
  });

  it("resumes with session/resume", async () => {
    const { rec, adapter } = setup();
    expect(
      (await adapter.startSession(sessionInput(account("grok"), { resumeCursor: { sessionId: "ses_old" } })))
        .resumed,
    ).toBe(true);
    expect(requests().find((r) => r.method === "session/resume")!.params).toMatchObject({
      sessionId: "ses_old",
    });
    expect(rec.events.find((e) => e.type === "session.started")).toMatchObject({
      resumeCursor: { sessionId: "ses_old" },
    });
    await adapter.dispose();
  });

  it("uses a per-account GROK_HOME and never leaks the API key", async () => {
    const { rec, adapter } = setup();
    const key = "xai-SECRETsecretSECRETsecretSECRETsecret";
    const acc = account("grok", { xaiApiKey: key });
    await adapter.startSession(sessionInput(acc));
    expect(requests().find((r) => r.method === "authenticate")!.params).toEqual({ methodId: "xai.api_key" });
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: `echo ${key}` }]);
    await rec.waitFor(turnDone("t1"));
    expect(JSON.stringify(rec.events)).not.toContain(key);
    await adapter.dispose();
  });

  it("reports sign-in errors, probes and lists models, and runs device login", async () => {
    const { adapter } = setup();
    const acc = account("grok");
    expect(await adapter.probe(acc)).toMatchObject({ status: "authenticated", cliVersion: "1.0.44-fake" });
    const models = await adapter.listModels(acc);
    expect(models[0]).toEqual({
      id: "grok-4.6",
      label: "Grok 4.6",
      description: "Latest",
      isDefault: true,
      efforts: ["high", "low"],
    });
    const prompts: unknown[] = [];
    const r = await new Promise(
      (resolve) => void adapter.login(acc, { prompt: (p) => prompts.push(p), result: resolve }),
    );
    expect(prompts[0]).toMatchObject({
      url: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234",
      userCode: "WXYZ-1234",
    });
    expect(r).toEqual({ ok: true });
    process.env.FAKE_GROK_AUTH = "none";
    expect(await adapter.probe(acc)).toMatchObject({ status: "unauthenticated" });
    await expect(adapter.startSession(sessionInput(acc))).rejects.toThrow(/not signed in/i);
  });
});
