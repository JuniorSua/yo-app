import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCodexCommand } from "@yo/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { account, recorder, sessionInput, shape, tempDir } from "../shared/testUtil";
import { CODE_NOT_CONFIRMED, createCodexAdapter, loginFailure, successPage } from "./CodexAdapter";
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

  it("gives a server with its own tool limit (the browser, #114) that limit", () => {
    const browser = { name: "browser", command: "playwright-mcp", args: [], toolTimeoutMs: 120_000 };
    expect(mcpConfigOverrides([browser])).toContain("mcp_servers.browser.tool_timeout_sec=120");
    const toml = buildCodexConfigToml({
      mcpServers: [browser, { name: "yo", command: "node", args: ["a.js"] }],
    });
    const section = (name: string) => toml.split(`[mcp_servers.${name}]`)[1]!.split("\n[")[0]!;
    expect(section("browser")).toContain("tool_timeout_sec = 120\n");
    expect(section("yo")).toContain("tool_timeout_sec = 86400\n");
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

  it("restarts an interrupted session whose turn never ends", async () => {
    const rec = recorder();
    const adapter = createCodexAdapter(
      { emit: rec.emit, log: rec.log },
      { command: fakeCodexCommand(), stuckInterruptMs: 0 },
    );
    const input = sessionInput(account("codex"));
    await adapter.startSession(input);
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "wedge" }]);
    await adapter.interrupt("s1");
    const before = rec.events.length;
    await expect(adapter.sendTurn("s1", "t2", [{ type: "text", text: "continue" }])).rejects.toThrow(
      /unknown session s1/,
    );
    expect(adapter.hasSession("s1")).toBe(false);
    expect(rec.events.slice(before)).toEqual([]);
    await adapter.startSession({ ...input, resumeCursor: { threadId: "thr_old" } });
    await adapter.sendTurn("s1", "t2", [{ type: "text", text: "continue" }]);
    expect(await rec.waitFor(turnDone("t2"))).toMatchObject({ status: "completed" });
    expect(requests().some((q) => q.method === "turn/steer")).toBe(false);
    await adapter.dispose();
  });

  it("bounds Stop while the CLI never acknowledges turn/start", async () => {
    const rec = recorder();
    const adapter = createCodexAdapter(
      { emit: rec.emit, log: rec.log },
      { command: fakeCodexCommand(), interruptAckMs: 20 },
    );
    await adapter.startSession(sessionInput(account("codex")));
    const sending = expect(
      adapter.sendTurn("s1", "t1", [{ type: "text", text: "startwedge" }]),
    ).rejects.toThrow(/exited/);
    await adapter.interrupt("s1");
    expect(rec.logs.some((line) => line.includes("codex interrupt timed out"))).toBe(true);
    await adapter.dispose();
    await sending;
  });

  it("unblocks Stop and steering when the pending turn fails to start", async () => {
    const { rec, adapter } = setup();
    await adapter.startSession(sessionInput(account("codex")));
    const sending = expect(
      adapter.sendTurn("s1", "t1", [{ type: "text", text: "slowfail" }]),
    ).rejects.toThrow("turn failed to start");
    const steering = expect(
      adapter.sendTurn("s1", "t2", [{ type: "text", text: "continue" }]),
    ).rejects.toThrow("task ended");
    await Promise.all([sending, steering, adapter.interrupt("s1")]);
    expect(await rec.waitFor(turnDone("t1"))).toMatchObject({ status: "failed" });
    expect(requests().some((q) => q.method === "turn/interrupt" || q.method === "turn/steer")).toBe(false);
    await adapter.sendTurn("s1", "t3", [{ type: "text", text: "hello" }]);
    expect(await rec.waitFor(turnDone("t3"))).toMatchObject({ status: "completed" });
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

  it("browser sign-in: only the address ChatGPT sends the browser to, with this sign-in's state, is handed on", async () => {
    const { adapter, rec } = setup();
    const acc = account("codex");
    const prompts: { url?: string; needsInput: boolean; userCode?: string }[] = [];
    let result: unknown;
    const handle = await adapter.login(
      acc,
      { prompt: (p) => prompts.push(p), result: (r) => (result = r) },
      { method: "codex-browser" },
    );
    expect(requests().find((q) => q.method === "account/login/start")!.params).toEqual({ type: "chatgpt" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ needsInput: true });
    expect(prompts[0]!.userCode).toBeUndefined();
    const auth = new URL(prompts[0]!.url!);
    const redirect = auth.searchParams.get("redirect_uri")!;
    const state = auth.searchParams.get("state")!;
    const landed = (q: string) => `${redirect}?${q}`;

    // Not the address, or from another sign-in: refused in plain words, never forwarded, still waiting.
    await expect(handle.input("http://evil.example/auth/callback?code=good&state=x")).rejects.toThrow(
      /isn't the address/,
    );
    await expect(handle.input(landed("code=good&state=OTHER"))).rejects.toThrow(/earlier sign-in/);
    expect(requests().filter((q) => q.method === "login/callback")).toHaveLength(0);
    expect(result).toBeUndefined();

    // The right one: Codex's sign-in server on Yo's computer gets it and signs in.
    await handle.input(`  ${landed(`code=good&scope=openid&state=${state}`)}\n`);
    await vi.waitFor(() => expect(result).toEqual({ ok: true }));
    // Codex only reports the sign-in once its /success page is loaded, so Yo loads it too.
    expect(requests().filter((q) => q.method === "login/callback")).toEqual([
      expect.objectContaining({ params: { path: "/auth/callback", hasCode: true } }),
      expect.objectContaining({ params: { path: "/success", hasCode: false } }),
    ]);
    // The code never reaches a log.
    expect(JSON.stringify(rec.logs)).not.toContain("code=good");
    // Over: a late paste says so.
    await expect(handle.input(landed(`code=good&state=${state}`))).rejects.toThrow(/has ended/);
  });

  it("browser sign-in: a code ChatGPT turns down ends the sign-in with a plain reason", async () => {
    const { adapter } = setup();
    const prompts: { url?: string }[] = [];
    let result: { ok: boolean; message?: string } | undefined;
    const handle = await adapter.login(
      account("codex"),
      { prompt: (p) => prompts.push(p), result: (r) => (result = r) },
      { method: "codex-browser" },
    );
    const auth = new URL(prompts[0]!.url!);
    await handle.input(
      `${auth.searchParams.get("redirect_uri")}?code=bad&state=${auth.searchParams.get("state")}`,
    );
    await vi.waitFor(() => expect(result).toBeDefined());
    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(/^ChatGPT didn't accept that sign-in/),
    });
  });

  it("device code: a code ChatGPT never confirms points at the setting that's probably off", async () => {
    process.env.FAKE_CODEX_DEVICE = "timeout";
    try {
      const { adapter } = setup();
      const result = await new Promise(
        (resolve) => void adapter.login(account("codex"), { prompt() {}, result: resolve }),
      );
      expect(result).toEqual({ ok: false, message: CODE_NOT_CONFIRMED });
      expect(CODE_NOT_CONFIRMED).toMatch(/security settings/);
    } finally {
      delete process.env.FAKE_CODEX_DEVICE;
    }
  });

  it("follows Codex's redirect to its /success page, and only on the same sign-in server", () => {
    const cb = "http://127.0.0.1:1455/auth/callback?code=x&state=y";
    const r = (status: number, location?: string) => ({
      status,
      headers: new Headers(location ? { location } : {}),
    });
    expect(successPage(cb, r(302, "/success?plan_type=plus"))).toBe(
      "http://127.0.0.1:1455/success?plan_type=plus",
    );
    expect(successPage(cb, r(302, "http://127.0.0.1:1455/success"))).toBe("http://127.0.0.1:1455/success");
    expect(successPage(cb, r(302, "http://evil.example/success"))).toBeNull();
    expect(successPage(cb, r(302, "http://127.0.0.1:9999/success"))).toBeNull();
    expect(successPage(cb, r(302, "/auth/callback?again=1"))).toBeNull();
    expect(successPage(cb, r(200))).toBeNull();
    expect(successPage(cb, r(400, "/success"))).toBeNull();
  });

  it("explains why a sign-in failed without anything secret", () => {
    expect(loginFailure("device auth timed out after 15 minutes", true)).toBe(CODE_NOT_CONFIRMED);
    expect(loginFailure("Login was not completed", false)).toBe("Sign-in canceled.");
    expect(loginFailure(null, false)).toBe("Sign-in failed.");
    // What Codex 0.159 really says for a code ChatGPT turns down.
    expect(
      loginFailure(
        "Login server error: Token exchange failed: token endpoint returned status 401 Unauthorized: Could not validate your token.",
        false,
      ),
    ).toMatch(/^ChatGPT didn't accept that sign-in\. Press Try again/);
    expect(loginFailure("Login server error: Sign-in failed: workspace not allowed", false)).toBe(
      "ChatGPT's sign-in didn't finish: Sign-in failed: workspace not allowed",
    );
    expect(loginFailure(`Login server error: bad key ${API_KEY}`, false)).not.toContain(API_KEY);
  });

  it("reports an expired ChatGPT sign-in once, in plain words, flagged for core", async () => {
    const { rec, adapter } = setup();
    await adapter.startSession(sessionInput(account("codex")));
    const start = rec.events.length;
    await adapter.sendTurn("s1", "t1", [{ type: "text", text: "expired" }]);
    const done = await rec.waitFor(turnDone("t1"));
    const errors = rec.events.slice(start).filter((e) => e.type === "runtime.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ auth: true });
    expect(done).toMatchObject({ status: "failed" });
    expect((done as { error?: string }).error).toMatch(/ChatGPT's sign-in has expired.*Sign in again/);
    expect(JSON.stringify(rec.events.slice(start))).not.toMatch(/401/);
    await adapter.dispose();
  });

  it("checks the login with ChatGPT's server when no task is using it", async () => {
    const { adapter } = setup();
    const acc = account("codex", { codexAuthJson: '{"tokens":{}}' });
    expect(await adapter.probe(acc)).toMatchObject({ status: "authenticated", verified: true });
    expect(
      requests()
        .filter((q) => q.method === "account/read")
        .at(-1)!.params,
    ).toEqual({ refreshToken: true });

    process.env.FAKE_CODEX_AUTH = "expired";
    const st = await adapter.probe(acc);
    expect(st).toMatchObject({ status: "unauthenticated", verified: true });
    expect(st.message).toMatch(/expired/);

    // Offline: no verdict from the server, so the saved login stands (unverified), never "signed out".
    process.env.FAKE_CODEX_AUTH = "offline";
    const off = await adapter.probe(acc);
    expect(off).toMatchObject({ status: "authenticated" });
    expect(off.verified).toBeUndefined();
  });

  it("doesn't refresh a login a running task is using", async () => {
    const { adapter } = setup();
    const acc = account("codex");
    await adapter.startSession(sessionInput(acc));
    process.env.FAKE_CODEX_AUTH = "expired";
    expect(await adapter.probe(acc)).toMatchObject({ status: "authenticated" });
    expect(
      requests()
        .filter((q) => q.method === "account/read")
        .at(-1)!.params,
    ).toEqual({ refreshToken: false });
    await adapter.dispose();
  });

  it("reports not_installed when the CLI is missing", async () => {
    const rec = recorder();
    const adapter = createCodexAdapter({ emit: rec.emit, log: rec.log }, { command: ["/nonexistent/codex"] });
    expect(await adapter.probe(account("codex"))).toMatchObject({ status: "not_installed" });
  });
});
