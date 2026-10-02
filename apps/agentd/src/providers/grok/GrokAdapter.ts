/**
 * Grok adapter: the Grok Build CLI speaks ACP over stdio (`grok agent [--always-approve] stdio`).
 * One `grok agent stdio` process per session (per-agent env/DISPLAY), GROK_HOME per account.
 *
 * Verified against grok 1.0.44 (initialize/_meta.modelState, session/new `_meta.rules|yoloMode|autoMode`,
 * `grok models`, `grok login --device-auth`); prompt/tool flows are built from the ACP schema,
 * x.ai docs and T3 Code's GrokAcpSupport.ts / AcpSessionRuntime.ts / XAiAcpExtension.ts (MIT).
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type {
  Client,
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AuthStatus, InputPart, Item, RuntimeMode } from "@yo/contracts";
import type {
  AccountContext,
  AdapterFactory,
  EmitFn,
  LoginCallbacks,
  LoginHandle,
  ProviderAdapter,
  RespondInput,
  SessionStartInput,
} from "../ProviderAdapter";
import { stripAnsi } from "../shared/ansi";
import { buildChildEnv, redact, secretValues } from "../shared/env";
import { EventSink } from "../shared/events";
import { runCollect } from "../shared/process";
import {
  deferred,
  errMessage,
  isRecord,
  newItemId,
  oneLine,
  parseVersion,
  str,
  withTimeout,
} from "../shared/util";
import { AcpProcess, resolveGrokCommand } from "./acp";
import {
  askQuestionsToYo,
  askResponse,
  classifyGrokTool,
  modelsFromInitializeMeta,
  parseGrokModels,
  todosFromPlan,
  toolCallOutput,
} from "./mapping";

export interface GrokAdapterOptions {
  /** Command + leading args (default: YO_GROK_BIN, ~/.grok/bin/grok, or `grok`). */
  command?: string[];
  clientVersion?: string;
}

const XAI_RATE_LIMITED = -32003;

function toAcpPrompt(parts: InputPart[]) {
  return parts.map((p) =>
    p.type === "text"
      ? { type: "text" as const, text: p.text }
      : { type: "image" as const, mimeType: p.mediaType, data: p.data },
  );
}

function toAcpMcp(specs: SessionStartInput["mcpServers"]): McpServer[] {
  return specs.map((s) => ({
    name: s.name,
    command: s.command,
    args: s.args,
    env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })),
  }));
}

interface OpenStream {
  item: Item;
  text: string;
}

interface GrokSession {
  key: string;
  input: SessionStartInput;
  sink: EventSink;
  proc: AcpProcess;
  sessionId: string;
  runtimeMode: RuntimeMode;
  loading: boolean;
  active?: { turnId: string; promptId: string; interrupted: boolean; done: boolean };
  queue: { turnId: string; parts: InputPart[] }[];
  pending: Map<string, { resolve(r: RespondInput): void }>;
  tools: Map<string, Item>;
  message?: OpenStream;
  thought?: OpenStream;
  planItemId?: string;
  stopped: boolean;
}

export function createGrokAdapter(
  deps: { emit: EmitFn; log: (msg: string) => void },
  options: GrokAdapterOptions = {},
): ProviderAdapter {
  const sessions = new Map<string, GrokSession>();
  /** ACP sessionId → Yo session (one process per session, but notifications carry sessionId). */
  const bySessionId = new Map<string, GrokSession>();
  const log = (m: string) => deps.log(redact(m));
  const command = () => resolveGrokCommand(options.command);

  function grokEnv(account: AccountContext, extra: Record<string, string> = {}) {
    return buildChildEnv(extra, {
      GROK_HOME: account.configDir,
      // Yo owns memory.
      GROK_MEMORY: "0",
      GROK_AGENT_DASHBOARD: "0",
      // MCP startup (npx cold starts). Per-tool timeout for ACP-provided servers stays at Grok's default (6000s).
      GROK_MCP_STARTUP_TIMEOUT_SECS: "60",
      XAI_API_KEY: account.secrets.xaiApiKey,
      NO_COLOR: "1",
    });
  }

  async function runCli(account: AccountContext, args: string[], timeoutMs = 20_000) {
    const [cmd, ...pre] = command();
    return runCollect(cmd!, [...pre, ...args], { env: grokEnv(account), timeoutMs });
  }

  function spawnAgent(
    account: AccountContext,
    opts: {
      runtimeMode?: RuntimeMode;
      model?: string;
      effort?: string;
      env?: Record<string, string>;
      cwd?: string;
    },
    client: Client,
  ): AcpProcess {
    const [cmd, ...pre] = command();
    const agentFlags = [
      ...(opts.runtimeMode === "full-access" ? ["--always-approve"] : []),
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.effort ? ["--reasoning-effort", opts.effort] : []),
    ];
    return new AcpProcess({
      command: cmd!,
      args: [...pre, "agent", ...agentFlags, "stdio"],
      env: grokEnv(account, opts.env),
      cwd: opts.cwd ?? tmpdir(),
      client,
      log,
    });
  }

  async function initialize(proc: AcpProcess) {
    return withTimeout(
      proc.conn.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "yo", version: options.clientVersion ?? "0.1.0" },
      }),
      20_000,
      "grok initialize",
    );
  }

  const noopClient: Client = {
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: async () => {},
  };

  const adapter: ProviderAdapter = {
    kind: "grok",

    async version() {
      const [cmd, ...pre] = command();
      const r = await runCollect(cmd!, [...pre, "--version"], { timeoutMs: 10_000 });
      if (r.spawnError || r.code !== 0) return null;
      return parseVersion(r.stdout);
    },

    async probe(account): Promise<AuthStatus> {
      const base = { accountId: account.accountId, provider: "grok" as const };
      const cliVersion = (await adapter.version().catch(() => null)) ?? undefined;
      if (!cliVersion) return { ...base, status: "not_installed", message: "Grok CLI (grok) not found." };
      if (account.secrets.xaiApiKey)
        return { ...base, status: "authenticated", cliVersion, label: "xAI API key" };
      // `grok models` reports login state without starting the agent or any login flow.
      const r = await runCli(account, ["models"]);
      if (r.timedOut || r.code !== 0) {
        return { ...base, status: "unknown", cliVersion, message: "Could not check Grok sign-in." };
      }
      const parsed = parseGrokModels(`${r.stdout}\n${r.stderr}`);
      if (parsed.authenticated === true)
        return { ...base, status: "authenticated", cliVersion, label: "Grok account" };
      if (parsed.authenticated === false) {
        return { ...base, status: "unauthenticated", cliVersion, message: "Not signed in to Grok." };
      }
      return { ...base, status: "unknown", cliVersion };
    },

    async listModels(account) {
      // initialize never authenticates, so this cannot trigger a login.
      try {
        const proc = spawnAgent(account, {}, noopClient);
        try {
          const init = await initialize(proc);
          const models = modelsFromInitializeMeta(init._meta);
          if (models.length) return models;
        } finally {
          proc.close();
        }
      } catch (err) {
        log(`grok initialize for models failed: ${errMessage(err)}`);
      }
      const r = await runCli(account, ["models"]);
      return r.code === 0 ? parseGrokModels(r.stdout).models : [];
    },

    async login(account, cb: LoginCallbacks): Promise<LoginHandle> {
      if (account.secrets.xaiApiKey) {
        cb.result({ ok: true, message: "Using the xAI API key." });
        return { input() {}, cancel() {} };
      }
      const [cmd, ...pre] = command();
      const env = grokEnv(account);
      delete env.DISPLAY;
      delete env.WAYLAND_DISPLAY;
      env.BROWSER = "true";
      const child = spawn(cmd!, [...pre, "login", "--device-auth"], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let prompted = false;
      let done = false;
      const finish = (r: Parameters<LoginCallbacks["result"]>[0]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (child.exitCode === null) child.kill("SIGTERM");
        cb.result(r);
      };
      const timer = setTimeout(() => finish({ ok: false, message: "Sign-in timed out." }), 15 * 60_000);
      timer.unref?.();
      const onData = (d: Buffer) => {
        out += d.toString("utf8");
        const clean = stripAnsi(out);
        if (!prompted) {
          const url = clean.match(/https:\/\/\S+/)?.[0];
          if (url) {
            prompted = true;
            const code =
              clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0] ?? url.match(/user_code=([\w-]+)/)?.[1];
            cb.prompt({
              url,
              ...(code ? { userCode: code } : {}),
              needsInput: false,
              message: "Open the link and confirm the code.",
            });
          }
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (e) => finish({ ok: false, message: e.message }));
      child.on("exit", (code) => {
        const lines = stripAnsi(out)
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        finish(
          code === 0 ? { ok: true } : { ok: false, message: lines.pop() ?? `grok login exited ${code}` },
        );
      });
      return {
        input() {},
        cancel() {
          finish({ ok: false, message: "Sign-in canceled." });
        },
      };
    },

    async logout(account) {
      await runCli(account, ["logout"]);
    },

    /* -------------------------------- sessions -------------------------------- */

    async startSession(input) {
      if (sessions.has(input.sessionKey)) await adapter.stopSession(input.sessionKey);
      const secrets = secretValues(input.account.secrets);
      const sink = new EventSink(deps.emit, input.sessionKey, () => secrets);
      // The session object is created before the process so the client callbacks can reach it.
      const s = {
        key: input.sessionKey,
        input,
        sink,
        sessionId: "",
        runtimeMode: input.runtimeMode,
        loading: false,
        queue: [],
        pending: new Map(),
        tools: new Map(),
        stopped: false,
      } as unknown as GrokSession;
      const client: Client = {
        requestPermission: (p) => handlePermission(s, p),
        sessionUpdate: async (n) => handleUpdate(s, n),
        extMethod: async (method, params) => handleExtMethod(s, method, params),
        extNotification: async (method, params) => handleExtNotification(s, method, params),
      };
      s.proc = spawnAgent(
        input.account,
        {
          runtimeMode: input.runtimeMode,
          model: input.model,
          effort: input.effort,
          env: input.env,
          cwd: input.cwd,
        },
        client,
      );
      void s.proc.exited.then(({ code, signal }) => onExit(s, code, signal));
      try {
        const init = await initialize(s.proc);
        const caps = init.agentCapabilities ?? {};
        if (input.account.secrets.xaiApiKey) {
          await withTimeout(
            s.proc.conn.authenticate({ methodId: "xai.api_key" }),
            15_000,
            "grok authenticate",
          ).catch((err) => log(`grok api-key authenticate failed: ${errMessage(err)}`));
        }
        const meta = {
          ...(input.systemAppend ? { rules: input.systemAppend } : {}),
          ...(input.runtimeMode === "full-access" ? { yoloMode: true } : {}),
          ...(input.runtimeMode === "auto" ? { autoMode: true } : {}),
        };
        const mcpServers = toAcpMcp(input.mcpServers);
        const resumeId = str(input.resumeCursor?.sessionId);
        let resumed = false;
        const create = async () => {
          const r = await s.proc.conn.newSession({ cwd: input.cwd, mcpServers, _meta: meta });
          return r.sessionId;
        };
        const withAuthRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
          try {
            return await fn();
          } catch (err) {
            if (!/auth/i.test(errMessage(err))) throw err;
            // Cached `grok login` credentials: non-interactive auth method (per T3's GrokAcpSupport).
            await withTimeout(
              s.proc.conn.authenticate({ methodId: "cached_token" }),
              10_000,
              "grok authenticate",
            );
            return fn();
          }
        };
        if (resumeId && (caps.sessionCapabilities?.resume || caps.loadSession)) {
          try {
            await withAuthRetry(async () => {
              if (caps.sessionCapabilities?.resume) {
                await s.proc.conn.resumeSession({
                  sessionId: resumeId,
                  cwd: input.cwd,
                  mcpServers,
                  _meta: meta,
                });
              } else {
                // session/load replays history as session/update notifications; ignore them.
                s.loading = true;
                bySessionId.set(resumeId, s);
                try {
                  await s.proc.conn.loadSession({
                    sessionId: resumeId,
                    cwd: input.cwd,
                    mcpServers,
                    _meta: meta,
                  });
                } finally {
                  s.loading = false;
                }
              }
            });
            s.sessionId = resumeId;
            resumed = true;
          } catch (err) {
            log(`grok resume failed, starting fresh: ${errMessage(err)}`);
          }
        }
        if (!s.sessionId) s.sessionId = await withAuthRetry(create);
        bySessionId.set(s.sessionId, s);
        sessions.set(input.sessionKey, s);
        sink.send({
          type: "session.started",
          resumeCursor: { sessionId: s.sessionId },
          ...(input.model ? { model: input.model } : {}),
        });
        sink.state("idle");
        return { resumed };
      } catch (err) {
        s.stopped = true;
        s.proc.close();
        const msg = errMessage(err);
        throw new Error(/auth/i.test(msg) ? `Grok is not signed in: ${msg}` : msg);
      }
    },

    async sendTurn(sessionKey, turnId, parts) {
      const s = mustGet(sessionKey);
      if (s.active) {
        // ACP has no steering: queue until the running prompt finishes.
        s.queue.push({ turnId, parts });
        return;
      }
      runPrompt(s, turnId, parts);
    },

    async interrupt(sessionKey) {
      const s = sessions.get(sessionKey);
      if (!s?.active) return;
      s.active.interrupted = true;
      s.queue = [];
      for (const [id, p] of s.pending)
        p.resolve({ requestId: id, decision: "deny", message: "Interrupted." });
      await s.proc.conn
        .cancel({ sessionId: s.sessionId })
        .catch((err) => log(`grok cancel failed: ${errMessage(err)}`));
    },

    async respond(sessionKey, input) {
      const s = mustGet(sessionKey);
      const p = s.pending.get(input.requestId);
      if (!p) throw new Error(`unknown request ${input.requestId}`);
      p.resolve(input);
    },

    async setSession(sessionKey, patch) {
      const s = mustGet(sessionKey);
      if (patch.runtimeMode) s.runtimeMode = patch.runtimeMode;
      if (patch.model) {
        await s.proc.conn
          .setSessionConfigOption({ sessionId: s.sessionId, configId: "model", value: patch.model })
          .catch((err) => log(`grok set model failed: ${errMessage(err)}`));
      }
    },

    async stopSession(sessionKey) {
      const s = sessions.get(sessionKey);
      if (!s) return;
      s.stopped = true;
      sessions.delete(sessionKey);
      bySessionId.delete(s.sessionId);
      for (const [id, p] of s.pending)
        p.resolve({ requestId: id, decision: "deny", message: "Session stopped." });
      if (s.active) finishTurn(s, "interrupted");
      s.proc.close();
      s.sink.send({ type: "session.exited", reason: "stopped" });
    },

    hasSession(sessionKey) {
      return sessions.has(sessionKey);
    },

    async dispose() {
      await Promise.all([...sessions.keys()].map((k) => adapter.stopSession(k)));
    },
  };

  function mustGet(key: string): GrokSession {
    const s = sessions.get(key);
    if (!s) throw new Error(`no grok session ${key}`);
    return s;
  }

  function onExit(s: GrokSession, code: number | null, signal: string | null) {
    if (s.stopped) return;
    s.stopped = true;
    sessions.delete(s.key);
    bySessionId.delete(s.sessionId);
    const reason = `grok exited (${signal ?? code})${s.proc.stderr ? `: ${oneLine(s.proc.stderr, 200)}` : ""}`;
    for (const [id, p] of s.pending) p.resolve({ requestId: id, decision: "deny", message: reason });
    if (s.active) finishTurn(s, "failed", reason);
    s.sink.error(redact(reason), true);
    s.sink.state("error");
    s.sink.send({ type: "session.exited", reason });
  }

  /* --------------------------------- turns --------------------------------- */

  function runPrompt(s: GrokSession, turnId: string, parts: InputPart[]) {
    const promptId = newItemId("prompt");
    s.active = { turnId, promptId, interrupted: false, done: false };
    s.sink.send({ type: "turn.started", turnId });
    s.sink.state("running");
    s.proc.conn
      .prompt({
        sessionId: s.sessionId,
        prompt: toAcpPrompt(parts),
        _meta: { promptId, requestId: promptId },
      })
      .then((res) => {
        if (s.active?.promptId !== promptId) return;
        const u = res.usage;
        const usage = u
          ? {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              ...(u.cachedReadTokens != null ? { cacheReadTokens: u.cachedReadTokens } : {}),
            }
          : undefined;
        const status = res.stopReason === "cancelled" || s.active.interrupted ? "interrupted" : "completed";
        if (res.stopReason === "refusal")
          s.sink.notice(turnId, newItemId("notice"), "Grok declined to continue");
        if (res.stopReason === "max_tokens" || res.stopReason === "max_turn_requests") {
          s.sink.notice(turnId, newItemId("notice"), "Grok stopped early (length limit)");
        }
        finishTurn(s, status, undefined, usage);
      })
      .catch((err: unknown) => {
        if (s.active?.promptId !== promptId) return;
        const code = isRecord(err) && typeof err.code === "number" ? err.code : undefined;
        const message = errMessage(err);
        if (code === XAI_RATE_LIMITED || /rate.?limit|usage limit/i.test(message)) {
          s.sink.rateLimit({ status: "limited", message: "Grok usage limit reached." });
        }
        finishTurn(s, s.active.interrupted ? "interrupted" : "failed", redact(message));
      });
  }

  function closeStreams(s: GrokSession) {
    const turnId = s.active?.turnId;
    for (const key of ["message", "thought"] as const) {
      const open = s[key];
      if (open) {
        s.sink.itemCompleted(turnId, { ...open.item, status: "completed", text: open.text });
        s[key] = undefined;
      }
    }
  }

  function finishTurn(
    s: GrokSession,
    status: "completed" | "interrupted" | "failed",
    error?: string,
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number },
  ) {
    const a = s.active;
    if (!a || a.done) return;
    a.done = true;
    closeStreams(s);
    for (const [id, item] of s.tools) {
      s.tools.delete(id);
      s.sink.itemCompleted(a.turnId, { ...item, status: status === "completed" ? "completed" : "failed" });
    }
    if (s.planItemId) {
      s.planItemId = undefined;
    }
    s.active = undefined;
    s.sink.send({
      type: "turn.completed",
      turnId: a.turnId,
      status,
      ...(usage ? { usage } : {}),
      ...(error ? { error } : {}),
      resumeCursor: { sessionId: s.sessionId },
    });
    const next = s.queue.shift();
    if (next && !s.stopped) runPrompt(s, next.turnId, next.parts);
    else s.sink.state("idle");
  }

  /* -------------------------------- updates -------------------------------- */

  function handleUpdate(s: GrokSession, n: SessionNotification) {
    if (s.loading || n.sessionId !== s.sessionId || !s.active) return;
    const turnId = s.active.turnId;
    const u = n.update as Record<string, unknown> & { sessionUpdate: string };
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = isRecord(u.content) ? u.content : {};
        const text = content.type === "text" && typeof content.text === "string" ? content.text : "";
        if (!text) return;
        const key = u.sessionUpdate === "agent_message_chunk" ? "message" : "thought";
        const other = key === "message" ? "thought" : "message";
        const otherOpen = s[other];
        if (otherOpen) {
          s.sink.itemCompleted(turnId, { ...otherOpen.item, status: "completed", text: otherOpen.text });
          s[other] = undefined;
        }
        let open = s[key];
        if (!open) {
          const kind = key === "message" ? "assistant_message" : "reasoning";
          open = {
            item: { id: newItemId(key === "message" ? "msg" : "rsn"), kind, status: "running" },
            text: "",
          };
          s[key] = open;
          s.sink.itemStarted(turnId, open.item);
        }
        open.text += text;
        s.sink.delta(turnId, open.item.id, key === "message" ? "text" : "reasoning", text);
        return;
      }
      case "tool_call": {
        closeStreams(s);
        const id = String(u.toolCallId);
        const cls = classifyGrokTool(u as never);
        const item: Item = {
          id,
          kind: cls.kind,
          status: "running",
          title: cls.title,
          ...((str(u.name) ?? str(u.title)) ? { toolName: String(u.name ?? u.title) } : {}),
          ...(u.rawInput !== undefined ? { input: u.rawInput } : {}),
        };
        s.tools.set(id, item);
        s.sink.itemStarted(turnId, item);
        if (u.status === "completed" || u.status === "failed") completeTool(s, id, u);
        return;
      }
      case "tool_call_update": {
        const id = String(u.toolCallId);
        const prev = s.tools.get(id);
        if (!prev) return;
        if (u.rawInput !== undefined || u.title) {
          const cls = classifyGrokTool({
            ...(prev.input !== undefined ? { rawInput: prev.input } : {}),
            ...(u as object),
          } as never);
          prev.title = cls.title;
          prev.kind = cls.kind;
          if (u.rawInput !== undefined) prev.input = u.rawInput;
        }
        if (u.status === "completed" || u.status === "failed") {
          completeTool(s, id, u);
        } else if (Array.isArray(u.content) && u.content.length) {
          const { text } = toolCallOutput(u.content as unknown[]);
          if (text) s.sink.itemUpdated(turnId, { ...prev, output: text });
        }
        return;
      }
      case "plan": {
        const todos = todosFromPlan(u.entries);
        const first = !s.planItemId;
        s.planItemId ??= newItemId("plan");
        const item: Item = {
          id: s.planItemId,
          kind: "todo",
          status: "completed",
          title: "Updated the plan",
          todos,
        };
        if (first) s.sink.itemCompleted(turnId, item);
        else s.sink.itemUpdated(turnId, item);
        return;
      }
      default:
        return;
    }
  }

  function completeTool(s: GrokSession, id: string, u: Record<string, unknown>) {
    const prev = s.tools.get(id);
    if (!prev) return;
    s.tools.delete(id);
    const { text, image } = toolCallOutput(u.content as unknown[] | undefined, u.rawOutput);
    s.sink.itemCompleted(s.active?.turnId, {
      ...prev,
      status: u.status === "failed" ? "failed" : "completed",
      ...(text ? { output: text } : {}),
      ...(image ? { image } : {}),
    });
  }

  /* ------------------------------ permissions ------------------------------ */

  async function ask(
    s: GrokSession,
    request: Omit<Parameters<EventSink["requestOpened"]>[1], "requestId">,
  ): Promise<RespondInput> {
    const requestId = newItemId("req");
    const d = deferred<RespondInput>();
    s.pending.set(requestId, { resolve: d.resolve });
    s.sink.requestOpened(s.active?.turnId, { requestId, ...request });
    s.sink.state("waiting");
    const r = await d.promise;
    s.pending.delete(requestId);
    s.sink.send({ type: "request.resolved", requestId, decision: r.decision });
    if (s.active) s.sink.state("running");
    return r;
  }

  async function handlePermission(
    s: GrokSession,
    p: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const pick = (kinds: string[]) => p.options.find((o) => kinds.includes(o.kind))?.optionId;
    const allowOnce = pick(["allow_once"]) ?? pick(["allow_always"]);
    if (s.runtimeMode !== "approval-required" && allowOnce) {
      return { outcome: { outcome: "selected", optionId: allowOnce } };
    }
    const tc = p.toolCall;
    const prev = s.tools.get(tc.toolCallId);
    const cls = classifyGrokTool({
      ...(prev?.input !== undefined ? { rawInput: prev.input } : {}),
      ...(tc as object),
    } as never);
    const r = await ask(s, {
      kind: "tool_approval",
      title: cls.title
        .replace(/^Ran /, "Run ")
        .replace(/^Edited /, "Edit ")
        .replace(/^Opened /, "Open "),
      ...(str(tc.name) ? { toolName: String(tc.name) } : {}),
      input: tc.rawInput ?? prev?.input,
    });
    if (s.active?.interrupted) return { outcome: { outcome: "cancelled" } };
    const optionId =
      r.decision === "allow"
        ? allowOnce
        : r.decision === "allowAlways"
          ? (pick(["allow_always"]) ?? allowOnce)
          : (pick(["reject_once"]) ?? pick(["reject_always"]));
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
  }

  async function handleExtMethod(s: GrokSession, method: string, params: Record<string, unknown>) {
    const m = method.replace(/^_/, "");
    if (m === "x.ai/ask_user_question") {
      const questions = askQuestionsToYo(params);
      const r = await ask(s, {
        kind: "user_input",
        title: questions[0]?.question ? oneLine(questions[0].question, 120) : "A question for you",
        questions,
      });
      return askResponse(params, r.decision === "deny" ? undefined : r.answers);
    }
    if (m === "x.ai/exit_plan_mode") {
      // Yo does not use Grok's plan mode; let it proceed.
      return { outcome: "approved" };
    }
    throw new Error(`Yo does not support ${method}`);
  }

  function handleExtNotification(s: GrokSession, method: string, params: Record<string, unknown>) {
    const m = method.replace(/^_/, "");
    // Fallback completion signal when the session/prompt response is lost (see T3 XAiAcpExtension).
    if (m === "x.ai/session/prompt_complete" && params.sessionId === s.sessionId && s.active) {
      if (!params.promptId || params.promptId === s.active.promptId) {
        finishTurn(
          s,
          params.stopReason === "cancelled" || s.active.interrupted ? "interrupted" : "completed",
        );
      }
    }
  }

  return adapter;
}

export const createGrokAdapterFactory: (options?: GrokAdapterOptions) => AdapterFactory =
  (options) => (deps) =>
    createGrokAdapter(deps, options);
