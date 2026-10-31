#!/usr/bin/env -S node --import tsx
/**
 * Fake `codex` CLI speaking the subset of the app-server JSON-RPC protocol that Yo uses.
 *
 *   node --import tsx fake-codex-appserver.ts --version
 *   node --import tsx fake-codex-appserver.ts app-server [-c k=v ...]
 *
 * Scripted turn behavior (by prompt text):
 *   default     → streams "Hello from Codex", runs `ls` (asks approval unless approvalPolicy=never),
 *                 updates the plan, reports token usage + rate limits, completes.
 *   "ask"       → item/tool/requestUserInput, echoes the answer.
 *   "interrupt" → streams slowly until turn/interrupt, completes as interrupted.
 *   "wedge"     → starts a message and never ends the turn, even when interrupted (a stuck tool call).
 *   "startwedge" → turn/start never replies.
 *   "slowfail"  → turn/start fails after 100 ms.
 *   "leak"      → command output contains OPENAI_API_KEY / CODEX_HOME contents (secret redaction tests).
 *   "expired"   → ChatGPT turns the saved login down: an `unauthorized` error, then a failed turn.
 * Sign-in: a device code (FAKE_CODEX_DEVICE=timeout → ChatGPT never confirms it), or the browser sign-in (see
 * startBrowserLogin).
 * Env: FAKE_CODEX_LOG=<file> appends every client request (JSONL); FAKE_CODEX_AUTH=none → signed out;
 *      FAKE_CODEX_AUTH=expired → the saved login is there but a refresh is refused (account/read with
 *      refreshToken:true answers account:null, as Codex 0.162 does); FAKE_CODEX_AUTH=offline → a refresh fails
 *      with a network error, the saved login still reads fine.
 */
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("codex-cli 0.159.2-fake\n");
  process.exit(0);
}
if (!argv.includes("app-server")) {
  process.stderr.write(`fake codex: unsupported args ${argv.join(" ")}\n`);
  process.exit(2);
}

type Json = Record<string, unknown>;
const logFile = process.env.FAKE_CODEX_LOG;
const send = (msg: Json) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method: string, params: Json) => send({ method, params });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let serverReqId = 1000;
const waiting = new Map<number, (result: unknown) => void>();
function serverRequest(method: string, params: Json): Promise<Json> {
  const id = serverReqId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve as (r: unknown) => void));
}

let threadId = "";
let approvalPolicy = "on-request";
let turnCounter = 0;
let interruptRequested: (() => void) | undefined;

function textOf(input: unknown): string {
  return Array.isArray(input) ? input.map((p) => (p as Json).text ?? "").join(" ") : "";
}

async function runTurn(turnId: string, text: string) {
  const base = { threadId, turnId };
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } });

  if (/expired/i.test(text)) {
    const error = {
      message:
        "unexpected status 401 Unauthorized: Your authentication token has expired. Please try signing in again.",
      codexErrorInfo: "unauthorized",
      additionalDetails: null,
    };
    notify("error", { ...base, error, willRetry: false });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "failed", items: [], error } });
    return;
  }

  if (/wedge/i.test(text)) {
    notify("item/started", {
      ...base,
      item: { type: "agentMessage", id: "msg_wedged", text: "", phase: null },
      startedAtMs: Date.now(),
    });
    return;
  }

  if (/interrupt/i.test(text)) {
    notify("item/started", {
      ...base,
      item: { type: "agentMessage", id: "msg_slow", text: "", phase: null },
      startedAtMs: Date.now(),
    });
    let stop = false;
    const stopped = new Promise<void>((r) => {
      interruptRequested = () => {
        stop = true;
        r();
      };
    });
    for (let i = 0; i < 200 && !stop; i++) {
      notify("item/agentMessage/delta", { ...base, itemId: "msg_slow", delta: "." });
      await Promise.race([sleep(20), stopped]);
    }
    interruptRequested = undefined;
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "interrupted", items: [], error: null },
    });
    return;
  }

  if (/ask/i.test(text)) {
    const res = await serverRequest("item/tool/requestUserInput", {
      ...base,
      itemId: "ask_1",
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: "q_color",
          header: "Color",
          question: "Which color?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Red", description: "Warm" },
            { label: "Blue", description: "Cool" },
          ],
        },
      ],
    });
    const answers = (res.answers ?? {}) as Record<string, { answers: string[] }>;
    const picked = answers.q_color?.answers?.[0] ?? "nothing";
    notify("item/started", {
      ...base,
      item: { type: "agentMessage", id: "msg_ans", text: "" },
      startedAtMs: Date.now(),
    });
    notify("item/agentMessage/delta", { ...base, itemId: "msg_ans", delta: `You picked ${picked}` });
    notify("item/completed", {
      ...base,
      item: { type: "agentMessage", id: "msg_ans", text: `You picked ${picked}` },
      completedAtMs: Date.now(),
    });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [], error: null } });
    return;
  }

  // Reasoning + streamed agent message.
  notify("item/started", {
    ...base,
    item: { type: "reasoning", id: "rsn_1", summary: [], content: [] },
    startedAtMs: Date.now(),
  });
  notify("item/reasoning/summaryTextDelta", {
    ...base,
    itemId: "rsn_1",
    delta: "Thinking about files",
    summaryIndex: 0,
  });
  notify("item/completed", {
    ...base,
    item: { type: "reasoning", id: "rsn_1", summary: ["Thinking about files"], content: [] },
    completedAtMs: Date.now(),
  });

  notify("item/started", {
    ...base,
    item: { type: "agentMessage", id: "msg_1", text: "" },
    startedAtMs: Date.now(),
  });
  for (const d of ["Hello", " from", " Codex"]) {
    notify("item/agentMessage/delta", { ...base, itemId: "msg_1", delta: d });
    await sleep(5);
  }
  notify("item/completed", {
    ...base,
    item: { type: "agentMessage", id: "msg_1", text: "Hello from Codex" },
    completedAtMs: Date.now(),
  });

  notify("turn/plan/updated", {
    ...base,
    explanation: null,
    plan: [
      { step: "List files", status: "inProgress" },
      { step: "Summarize", status: "pending" },
    ],
  });

  // Command with approval.
  const leak = /leak/i.test(text);
  const command = leak ? "env | grep KEY" : "ls -la";
  const cmdItem = {
    type: "commandExecution",
    id: "cmd_1",
    command,
    cwd: "/tmp",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    source: "agent",
    processId: null,
  };
  notify("item/started", { ...base, item: cmdItem, startedAtMs: Date.now() });
  let accepted = true;
  if (approvalPolicy !== "never") {
    const res = await serverRequest("item/commandExecution/requestApproval", {
      ...base,
      itemId: "cmd_1",
      startedAtMs: Date.now(),
      environmentId: null,
      kind: "commandExecution",
      command,
      cwd: "/tmp",
      reason: "List the directory",
    });
    accepted = res.decision === "accept" || res.decision === "acceptForSession";
  }
  if (accepted) {
    const out = leak ? `OPENAI_API_KEY=${process.env.OPENAI_API_KEY ?? ""}\n` : "file1\nfile2\n";
    notify("item/commandExecution/outputDelta", { ...base, itemId: "cmd_1", delta: out });
    notify("item/completed", {
      ...base,
      item: { ...cmdItem, status: "completed", aggregatedOutput: out, exitCode: 0 },
      completedAtMs: Date.now(),
    });
  } else {
    notify("item/completed", {
      ...base,
      item: { ...cmdItem, status: "declined" },
      completedAtMs: Date.now(),
    });
  }

  notify("item/started", {
    ...base,
    item: {
      type: "mcpToolCall",
      id: "mcp_1",
      server: "browser",
      tool: "browser_navigate",
      status: "inProgress",
      arguments: { url: "https://www.amazon.com/" },
      result: null,
      error: null,
    },
    startedAtMs: Date.now(),
  });
  notify("item/completed", {
    ...base,
    item: {
      type: "mcpToolCall",
      id: "mcp_1",
      server: "browser",
      tool: "browser_navigate",
      status: "completed",
      arguments: { url: "https://www.amazon.com/" },
      result: {
        content: [{ type: "text", text: "Navigated to amazon.com" }],
        structuredContent: null,
        _meta: null,
      },
      error: null,
    },
    completedAtMs: Date.now(),
  });

  notify("thread/tokenUsage/updated", {
    ...base,
    tokenUsage: {
      total: {
        totalTokens: 150,
        inputTokens: 120,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 0,
        outputTokens: 30,
        reasoningOutputTokens: 5,
      },
      last: {
        totalTokens: 150,
        inputTokens: 120,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 0,
        outputTokens: 30,
        reasoningOutputTokens: 5,
      },
      modelContextWindow: 200000,
    },
  });
  notify("account/rateLimits/updated", {
    rateLimits: {
      limitId: null,
      limitName: null,
      primary: { usedPercent: 85, windowDurationMins: 300, resetsAt: 1790000000 },
      secondary: null,
      rateLimitReachedType: null,
    },
  });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [], error: null } });
}

async function handle(msg: Json) {
  const id = msg.id as number | string | undefined;
  const method = msg.method as string | undefined;
  if (id !== undefined && !method) {
    const w = waiting.get(id as number);
    if (w) {
      waiting.delete(id as number);
      w(msg.result ?? {});
    }
    return;
  }
  if (logFile && method) appendFileSync(logFile, `${JSON.stringify({ method, params: msg.params, argv })}\n`);
  if (id === undefined) return; // notification (initialized)
  const params = (msg.params ?? {}) as Json;
  const reply = (result: unknown) => send({ id, result });
  switch (method) {
    case "initialize":
      return reply({
        userAgent: "fake/0.0.0",
        codexHome: process.env.CODEX_HOME ?? "",
        platformFamily: "unix",
        platformOs: "linux",
      });
    case "account/read": {
      const auth = process.env.FAKE_CODEX_AUTH;
      const refresh = params.refreshToken === true;
      if (auth === "offline" && refresh)
        return send({
          id,
          error: {
            code: -32603,
            message: "failed to refresh token while getting account: error sending request for url",
          },
        });
      return reply(
        auth === "none" || (auth === "expired" && refresh)
          ? { account: null, requiresOpenaiAuth: true }
          : {
              account: { type: "chatgpt", email: "fake@example.com", planType: "pro" },
              requiresOpenaiAuth: true,
            },
      );
    }
    case "model/list":
      return reply({
        data: [
          {
            id: "gpt-6.1-sol",
            model: "gpt-6.1-sol",
            displayName: "GPT-6.1 Sol",
            description: "Flagship",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "" },
              { reasoningEffort: "high", description: "" },
            ],
            defaultReasoningEffort: "high",
            isDefault: true,
          },
          {
            id: "gpt-5.5",
            model: "gpt-5.5",
            displayName: "GPT-5.5",
            description: "Older",
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "medium",
            isDefault: false,
          },
          {
            id: "hidden",
            model: "hidden",
            displayName: "Hidden",
            description: "",
            hidden: true,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "low",
            isDefault: false,
          },
        ],
        nextCursor: null,
      });
    case "account/login/start":
      if (params.type === "apiKey") return reply({ type: "apiKey" });
      if (params.type === "chatgpt") return startBrowserLogin(reply);
      if (process.env.FAKE_CODEX_DEVICE === "timeout") {
        reply({
          type: "chatgptDeviceCode",
          loginId: "login-1",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
        });
        setTimeout(
          () =>
            notify("account/login/completed", {
              loginId: "login-1",
              success: false,
              error: "device auth timed out after 15 minutes",
              onboardingEntrypoint: null,
            }),
          100,
        );
        return;
      }
      reply({
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      });
      setTimeout(
        () =>
          notify("account/login/completed", {
            loginId: "login-1",
            success: true,
            error: null,
            onboardingEntrypoint: null,
          }),
        100,
      );
      return;
    case "account/login/cancel":
    case "account/logout":
      return reply({});
    case "thread/start":
      threadId = "thr_fake_1";
      approvalPolicy = String(params.approvalPolicy ?? "on-request");
      return reply({
        thread: { id: threadId },
        model: params.model ?? "gpt-6.1-sol",
        modelProvider: "openai",
        reasoningEffort: null,
      });
    case "thread/resume":
      if (params.threadId === "thr_missing")
        return send({ id, error: { code: -32600, message: "thread not found" } });
      threadId = String(params.threadId);
      approvalPolicy = String(params.approvalPolicy ?? "on-request");
      return reply({
        thread: { id: threadId },
        model: params.model ?? "gpt-6.1-sol",
        modelProvider: "openai",
        reasoningEffort: null,
      });
    case "turn/start": {
      if (/startwedge/i.test(textOf(params.input))) return;
      if (/slowfail/i.test(textOf(params.input))) {
        setTimeout(() => send({ id, error: { code: -32000, message: "turn failed to start" } }), 100);
        return;
      }
      if (params.approvalPolicy) approvalPolicy = String(params.approvalPolicy);
      const turnId = `turn_${++turnCounter}`;
      reply({ turn: { id: turnId, status: "inProgress", items: [], error: null } });
      void runTurn(turnId, textOf(params.input));
      return;
    }
    case "turn/steer":
      return reply({ turnId: params.expectedTurnId });
    case "turn/interrupt":
      reply({});
      interruptRequested?.();
      return;
    default:
      return send({ id, error: { code: -32601, message: `fake codex: unknown method ${method}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  void handle(JSON.parse(line) as Json);
});
rl.on("close", () => process.exit(0));

/**
 * Codex's browser sign-in: a sign-in server on a free local port (Codex uses 1455) and a link whose redirect_uri
 * points at it. The callback with `code=good` and the right state signs in; any other code fails like a refused
 * token exchange; a wrong state is a 400 and the sign-in keeps waiting. Callback hits are logged without the code.
 * Like the real Codex, a good sign-in redirects to /success and only reports completion once that page is loaded.
 */
function startBrowserLogin(reply: (r: unknown) => void) {
  const state = "FAKE_STATE_123";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const code = url.searchParams.get("code");
    if (logFile)
      appendFileSync(
        logFile,
        `${JSON.stringify({ method: "login/callback", params: { path: url.pathname, hasCode: !!code }, argv })}\n`,
      );
    if (url.pathname === "/success") {
      res.writeHead(200).end("Signed in to Codex");
      server.close();
      notify("account/login/completed", {
        loginId: "login-browser",
        success: true,
        error: null,
        onboardingEntrypoint: null,
      });
      return;
    }
    if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state) {
      res.writeHead(400).end("State mismatch");
      return;
    }
    if (code === "good") {
      res.writeHead(302, { location: "/success?plan_type=plus" }).end();
      return;
    }
    res.writeHead(500).end("Token exchange failed");
    server.close();
    notify("account/login/completed", {
      loginId: "login-browser",
      success: false,
      error: "Login server error: token exchange failed",
      onboardingEntrypoint: null,
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    const redirect = `http://localhost:${port}/auth/callback`;
    reply({
      type: "chatgpt",
      loginId: "login-browser",
      authUrl: `https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_fake&redirect_uri=${encodeURIComponent(redirect)}&state=${state}&originator=yo`,
    });
  });
  server.unref();
}
