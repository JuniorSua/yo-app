/**
 * Claude adapter: drives the Claude Agent SDK (`query()`) with streaming input — one long-lived
 * CLI process per Yo session, turns pushed through a queue so mid-turn messages steer.
 *
 * Patterns adapted from T3 Code's ClaudeAdapter.ts / ClaudeProvider.ts (MIT):
 * never-yielding prompt probe, AskUserQuestion via canUseTool updatedInput.answers,
 * TodoWrite/Task* → plan, bypassPermissions + allowDangerouslySkipPermissions.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  type CanUseTool,
  type HookCallback,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { AuthStatus, InputPart, Item, ModelInfo, RuntimeMode, UserQuestion } from "@yo/contracts";
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
import { buildChildEnv, redact, secretValues } from "../shared/env";
import { EventSink, epochMs } from "../shared/events";
import { loadPty, type PtySpawn, runCollect } from "../shared/process";
import {
  AsyncQueue,
  deferred,
  errMessage,
  isRecord,
  newItemId,
  oneLine,
  parseVersion,
  str,
  stringifyOutput,
  withTimeout,
} from "../shared/util";
import { resolveClaudeExecutable } from "./binary";
import {
  CLAUDE_DISALLOWED_TOOLS,
  ClaudeTaskTracker,
  classifyClaudeTool,
  planLabel,
  todosFromTodoWrite,
  toolResultContent,
} from "./mapping";
import { runSetupToken } from "./setupToken";

export type ClaudeQueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

export interface ClaudeAdapterOptions {
  /** Injectable `query` (tests use the testkit fake). */
  query?: ClaudeQueryFn;
  /** Claude executable override (else YO_CLAUDE_BIN, else the SDK's bundled binary). */
  executablePath?: string;
  /** PTY spawner override for setup-token (tests). */
  spawnPty?: PtySpawn;
  probeTimeoutMs?: number;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** 24h: Yo's blocking tools (ask_user, request_approval, request_takeover) wait on the human. */
export const MCP_TOOL_TIMEOUT_MS = 86_400_000;
type Effort = (typeof EFFORTS)[number];

export const CLAUDE_FALLBACK_MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5", efforts: [...EFFORTS] },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", isDefault: true, efforts: [...EFFORTS] },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1", efforts: [...EFFORTS] },
];

export function permissionModeFor(mode: RuntimeMode): PermissionMode {
  switch (mode) {
    case "full-access":
      return "bypassPermissions";
    case "auto":
      return "acceptEdits";
    default:
      return "default";
  }
}

/**
 * Env for every Claude child. `configDir === ""` means "use the CLI's default config" (only used by
 * the host live smoke test; agentd always passes a per-account dir).
 */
export function buildClaudeEnv(
  account: AccountContext,
  extra: Record<string, string> = {},
  opts: { includeToken?: boolean } = {},
): Record<string, string> {
  const { secrets } = account;
  const token = opts.includeToken === false ? undefined : secrets.claudeOauthToken;
  return buildChildEnv(extra, {
    CLAUDE_CONFIG_DIR: account.configDir || undefined,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    // Only pass an API key when the account is explicitly an API-key account.
    ANTHROPIC_API_KEY: token ? undefined : secrets.anthropicApiKey,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_CRON: "1",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    // Never pull the user's claude.ai connectors into the agent.
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
    MCP_TIMEOUT: "60000",
  });
}

function mcpConfig(input: SessionStartInput): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const s of input.mcpServers) {
    out[s.name] = {
      type: "stdio",
      command: s.command,
      args: s.args,
      ...(s.env ? { env: s.env } : {}),
      // Yo tools (ask_user, request_approval, takeover) can block for a long time.
      timeout: MCP_TOOL_TIMEOUT_MS,
    };
  }
  return out;
}

function toUserContent(parts: InputPart[]) {
  return parts.map((p) =>
    p.type === "text"
      ? { type: "text" as const, text: p.text }
      : {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: p.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: p.data,
          },
        },
  );
}

interface PendingRequest {
  kind: "tool_approval" | "user_input";
  resolve(r: RespondInput): void;
}

interface ToolInFlight {
  item: Item;
  turnId?: string;
  name: string;
  input: unknown;
}

interface StreamBlock {
  item: Item;
  text: string;
  started: boolean;
}

interface ClaudeSession {
  key: string;
  input: SessionStartInput;
  sink: EventSink;
  queue: AsyncQueue<SDKUserMessage>;
  abort: AbortController;
  q: Query;
  sessionId: string;
  runtimeMode: RuntimeMode;
  model?: string;
  active?: { turnId: string; uuid: string; interrupted: boolean };
  waiting: { turnId: string; uuid: string }[];
  pending: Map<string, PendingRequest>;
  tools: Map<string, ToolInFlight>;
  blocks: Map<number, StreamBlock>;
  streamedMessageIds: Set<string>;
  currentMessageId?: string;
  tasks: ClaudeTaskTracker;
  lastCostUsd: number;
  /** Context size (input + cache read + cache write) of the most recent model request. */
  lastContextTokens: number;
  stopped: boolean;
  completedTurns: number;
}

export function createClaudeAdapter(
  deps: { emit: EmitFn; log: (msg: string) => void },
  options: ClaudeAdapterOptions = {},
): ProviderAdapter {
  const queryFn: ClaudeQueryFn = options.query ?? (sdkQuery as ClaudeQueryFn);
  const sessions = new Map<string, ClaudeSession>();
  const modelCache = new Map<string, ModelInfo[]>();
  const exe = () => resolveClaudeExecutable(options.executablePath);
  const log = (msg: string) => deps.log(redact(msg));

  /* ------------------------------ probe/login ------------------------------ */

  async function sdkInit(account: AccountContext) {
    const abort = new AbortController();
    const never = (async function* (): AsyncGenerator<SDKUserMessage> {
      // Never yields: the CLI initializes (account + models) but no request reaches the API.
      await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve()));
    })();
    const q = queryFn({
      prompt: never,
      options: {
        persistSession: false,
        pathToClaudeCodeExecutable: exe(),
        abortController: abort,
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        allowedTools: [],
        env: buildClaudeEnv(account),
        cwd: tmpdir(),
        stderr: () => {},
      },
    });
    try {
      return await withTimeout(q.initializationResult(), options.probeTimeoutMs ?? 25_000, "claude init");
    } finally {
      abort.abort();
      try {
        q.close?.();
      } catch {
        // ignore
      }
    }
  }

  function mapModels(
    models: { value: string; displayName: string; description?: string; supportedEffortLevels?: string[] }[],
  ): ModelInfo[] {
    return models.map((m) => ({
      id: m.value,
      label: m.displayName || m.value,
      ...(m.description ? { description: m.description } : {}),
      ...(m.value === "default" ? { isDefault: true } : {}),
      ...(m.supportedEffortLevels?.length ? { efforts: [...m.supportedEffortLevels] } : {}),
    }));
  }

  async function authStatusCli(
    account: AccountContext,
  ): Promise<{ loggedIn?: boolean; email?: string; subscriptionType?: string } | null> {
    const r = await runCollect(exe(), ["auth", "status", "--json"], {
      env: buildClaudeEnv(account),
      timeoutMs: 15_000,
    });
    if (r.spawnError || r.timedOut) return null;
    try {
      const j = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
      return {
        loggedIn: typeof j.loggedIn === "boolean" ? j.loggedIn : undefined,
        email: str(j.email),
        subscriptionType: str(j.subscriptionType),
      };
    } catch {
      return null;
    }
  }

  const adapter: ProviderAdapter = {
    kind: "claude",

    async version() {
      const r = await runCollect(exe(), ["--version"], { timeoutMs: 10_000 });
      if (r.spawnError || r.code !== 0) return null;
      return parseVersion(r.stdout);
    },

    async probe(account): Promise<AuthStatus> {
      const base = { accountId: account.accountId, provider: "claude" as const };
      const cliVersion = (await adapter.version().catch(() => null)) ?? undefined;
      if (!cliVersion && !options.query) {
        return { ...base, status: "not_installed", message: "Claude Code binary not found." };
      }
      let email: string | undefined;
      let subscriptionType: string | undefined;
      let tokenSource: string | undefined;
      let apiKeySource: string | undefined;
      try {
        const init = await sdkInit(account);
        const acc = (init.account ?? {}) as Record<string, unknown>;
        email = str(acc.email);
        subscriptionType = str(acc.subscriptionType);
        tokenSource = str(acc.tokenSource);
        apiKeySource = str(acc.apiKeySource);
        if (Array.isArray(init.models) && init.models.length) {
          modelCache.set(account.accountId, mapModels(init.models as never));
        }
      } catch (err) {
        log(`claude sdk probe failed: ${errMessage(err)}`);
      }
      const hasToken = !!account.secrets.claudeOauthToken;
      if (!email && !subscriptionType && !hasToken) {
        const cli = await authStatusCli(account);
        if (cli) {
          email ??= cli.email;
          subscriptionType ??= cli.subscriptionType;
          if (cli.loggedIn === false && !apiKeySource) {
            return { ...base, status: "unauthenticated", cliVersion, message: "Not signed in to Claude." };
          }
        }
      }
      const usingApiKey = !hasToken && !!account.secrets.anthropicApiKey;
      if (email || subscriptionType || hasToken || usingApiKey || (tokenSource && tokenSource !== "none")) {
        const plan = planLabel(subscriptionType);
        return {
          ...base,
          status: "authenticated",
          cliVersion,
          ...(email ? { email } : {}),
          ...(plan ? { plan } : {}),
          label: usingApiKey
            ? "Anthropic API key"
            : plan
              ? `${plan}${email ? ` (${email})` : ""}`
              : "Claude subscription (token)",
        };
      }
      return { ...base, status: "unauthenticated", cliVersion, message: "Not signed in to Claude." };
    },

    async listModels(account) {
      const cached = modelCache.get(account.accountId);
      if (cached?.length) return cached;
      try {
        const init = await sdkInit(account);
        if (Array.isArray(init.models) && init.models.length) {
          const models = mapModels(init.models as never);
          modelCache.set(account.accountId, models);
          return models;
        }
      } catch (err) {
        log(`claude model list failed: ${errMessage(err)}`);
      }
      return CLAUDE_FALLBACK_MODELS;
    },

    async login(account, cb: LoginCallbacks): Promise<LoginHandle> {
      const spawnPty = options.spawnPty ?? (await loadPty());
      const env = buildClaudeEnv(account, {}, { includeToken: false });
      // Keep the CLI from opening the agent's own Chromium: the user signs in on their Mac.
      delete env.DISPLAY;
      delete env.WAYLAND_DISPLAY;
      env.BROWSER = "true";
      env.TERM = "xterm-256color";
      return runSetupToken({
        spawnPty,
        executable: exe(),
        env,
        cwd: account.configDir || tmpdir(),
        cb,
      });
    },

    async logout(account) {
      await runCollect(exe(), ["auth", "logout"], { env: buildClaudeEnv(account), timeoutMs: 15_000 });
      modelCache.delete(account.accountId);
    },

    /* -------------------------------- sessions -------------------------------- */

    async startSession(input) {
      if (sessions.has(input.sessionKey)) await adapter.stopSession(input.sessionKey);
      const resumeId = str(input.resumeCursor?.sessionId);
      const sessionId = resumeId ?? randomUUID();
      const secrets = secretValues(input.account.secrets);
      const sink = new EventSink(deps.emit, input.sessionKey, () => secrets);
      const queue = new AsyncQueue<SDKUserMessage>();
      const abort = new AbortController();
      const effort = EFFORTS.includes(input.effort as Effort) ? (input.effort as Effort) : undefined;

      const s = {
        key: input.sessionKey,
        input,
        sink,
        queue,
        abort,
        sessionId,
        runtimeMode: input.runtimeMode,
        model: input.model,
        waiting: [],
        pending: new Map(),
        tools: new Map(),
        blocks: new Map(),
        streamedMessageIds: new Set(),
        tasks: new ClaudeTaskTracker(),
        lastCostUsd: 0,
        lastContextTokens: 0,
        stopped: false,
        completedTurns: 0,
      } as unknown as ClaudeSession;

      const canUseTool: CanUseTool = (toolName, toolInput, opts) =>
        handlePermission(s, toolName, toolInput, opts);
      const permissionMode = permissionModeFor(input.runtimeMode);
      const opts: Options = {
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(effort ? { effort } : {}),
        pathToClaudeCodeExecutable: exe(),
        env: buildClaudeEnv(input.account, input.env),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(input.systemAppend ? { append: input.systemAppend } : {}),
        },
        settingSources: [],
        settings: { autoMemoryEnabled: false },
        mcpServers: mcpConfig(input),
        strictMcpConfig: true,
        includePartialMessages: true,
        disallowedTools: CLAUDE_DISALLOWED_TOOLS,
        permissionMode,
        // Always allowed so setSession can switch to full-access later; the container is the sandbox.
        allowDangerouslySkipPermissions: true,
        canUseTool,
        hooks: {
          // Long timeout (seconds): the user may take a while to answer.
          PreToolUse: [{ matcher: "AskUserQuestion", hooks: [askUserHook(s)], timeout: 24 * 60 * 60 }],
        },
        abortController: abort,
        stderr: (d: string) => log(`claude stderr: ${oneLine(d, 300)}`),
        ...(resumeId ? { resume: resumeId } : { sessionId }),
      };
      s.q = queryFn({ prompt: queue, options: opts });
      sessions.set(input.sessionKey, s);
      void consume(s);
      sink.send({
        type: "session.started",
        resumeCursor: { sessionId },
        ...(input.model ? { model: input.model } : {}),
      });
      sink.state("idle");
      return { resumed: !!resumeId };
    },

    async sendTurn(sessionKey, turnId, parts) {
      const s = mustGet(sessionKey);
      const uuid = randomUUID();
      const msg = {
        type: "user",
        message: { role: "user", content: toUserContent(parts) },
        parent_tool_use_id: null,
        uuid,
        session_id: s.sessionId,
      } as unknown as SDKUserMessage;
      if (!s.active) {
        startTurn(s, turnId, uuid);
      } else {
        // Mid-turn message: steers the running turn (the CLI folds it in between tool rounds).
        s.waiting.push({ turnId, uuid });
      }
      s.queue.push(msg);
    },

    async interrupt(sessionKey) {
      const s = sessions.get(sessionKey);
      if (!s?.active) return;
      s.active.interrupted = true;
      for (const [id, p] of s.pending) {
        p.resolve({ requestId: id, decision: "deny", message: "Interrupted by the user." });
      }
      try {
        await s.q.interrupt();
      } catch (err) {
        log(`claude interrupt failed: ${errMessage(err)}`);
      }
    },

    async respond(sessionKey, input) {
      const s = mustGet(sessionKey);
      const p = s.pending.get(input.requestId);
      if (!p) throw new Error(`unknown request ${input.requestId}`);
      p.resolve(input);
    },

    async setSession(sessionKey, patch) {
      const s = mustGet(sessionKey);
      if (patch.model && patch.model !== s.model) {
        await s.q.setModel(patch.model);
        s.model = patch.model;
      }
      if (patch.runtimeMode && patch.runtimeMode !== s.runtimeMode) {
        await s.q.setPermissionMode(permissionModeFor(patch.runtimeMode));
        s.runtimeMode = patch.runtimeMode;
      }
    },

    async stopSession(sessionKey) {
      const s = sessions.get(sessionKey);
      if (!s) return;
      s.stopped = true;
      sessions.delete(sessionKey);
      for (const [id, p] of s.pending)
        p.resolve({ requestId: id, decision: "deny", message: "Session stopped." });
      if (s.active) {
        s.sink.send({
          type: "turn.completed",
          turnId: s.active.turnId,
          status: "interrupted",
          resumeCursor: { sessionId: s.sessionId },
        });
        s.active = undefined;
      }
      s.queue.close();
      try {
        s.q.close?.();
      } catch {
        // ignore
      }
      s.abort.abort();
      s.sink.send({ type: "session.exited", reason: "stopped" });
    },

    hasSession(sessionKey) {
      return sessions.has(sessionKey);
    },

    async dispose() {
      await Promise.all([...sessions.keys()].map((k) => adapter.stopSession(k)));
    },
  };

  function mustGet(key: string): ClaudeSession {
    const s = sessions.get(key);
    if (!s) throw new Error(`no claude session ${key}`);
    return s;
  }

  function startTurn(s: ClaudeSession, turnId: string, uuid: string) {
    s.active = { turnId, uuid, interrupted: false };
    s.sink.send({ type: "turn.started", turnId });
    s.sink.state("running");
  }

  /* ------------------------------ permissions ------------------------------ */

  async function waitForUser(
    s: ClaudeSession,
    kind: PendingRequest["kind"],
    request: Omit<Parameters<EventSink["requestOpened"]>[1], "requestId" | "kind">,
    signal: AbortSignal,
  ): Promise<RespondInput> {
    const requestId = newItemId("req");
    const d = deferred<RespondInput>();
    s.pending.set(requestId, { kind, resolve: d.resolve });
    const onAbort = () => d.resolve({ requestId, decision: "deny", message: "Canceled." });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    s.sink.requestOpened(s.active?.turnId, { requestId, kind, ...request });
    s.sink.state("waiting");
    const r = await d.promise;
    signal.removeEventListener("abort", onAbort);
    s.pending.delete(requestId);
    s.sink.send({ type: "request.resolved", requestId, decision: r.decision });
    if (s.active) s.sink.state("running");
    return r;
  }

  /**
   * AskUserQuestion → Yo `user_input` request. Returns the answers keyed by full question text
   * (the SDK looks them up that way), or undefined if dismissed.
   */
  async function askUser(
    s: ClaudeSession,
    toolInput: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ answers?: Record<string, string>; message?: string }> {
    const raw = Array.isArray(toolInput.questions) ? toolInput.questions.filter(isRecord) : [];
    const questions: UserQuestion[] = raw.map((q) => ({
      question: str(q.question) ?? "",
      ...(str(q.header) ? { header: String(q.header) } : {}),
      options: Array.isArray(q.options)
        ? q.options.filter(isRecord).map((o) => ({
            label: str(o.label) ?? "",
            ...(str(o.description) ? { description: String(o.description) } : {}),
          }))
        : [],
      multiSelect: q.multiSelect === true,
    }));
    const r = await waitForUser(
      s,
      "user_input",
      {
        toolName: "AskUserQuestion",
        title: questions[0]?.question ? oneLine(questions[0].question, 120) : "A question for you",
        questions,
      },
      signal,
    );
    if (r.decision === "deny" || !r.answers)
      return { message: r.message ?? "The user dismissed the question." };
    return { answers: r.answers };
  }

  /**
   * PreToolUse hook for AskUserQuestion. Hooks run in every permission mode — canUseTool is
   * skipped entirely under bypassPermissions (full-access), so this is the primary path.
   */
  function askUserHook(s: ClaudeSession): HookCallback {
    return async (hookInput, _toolUseId, { signal }) => {
      const h = hookInput as { tool_name?: string; tool_input?: unknown };
      const toolInput = isRecord(h.tool_input) ? h.tool_input : {};
      if (h.tool_name !== "AskUserQuestion" || isRecord(toolInput.answers)) return { continue: true };
      const r = await askUser(s, toolInput, signal);
      if (!r.answers) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: r.message ?? "The user dismissed the question.",
          },
        };
      }
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { ...toolInput, answers: r.answers },
        },
      };
    };
  }

  async function handlePermission(
    s: ClaudeSession,
    toolName: string,
    toolInput: Record<string, unknown>,
    opts: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    if (toolName === "AskUserQuestion" && isRecord(toolInput.answers)) {
      // Already answered through the PreToolUse hook.
      return { behavior: "allow", updatedInput: toolInput };
    }
    if (toolName === "AskUserQuestion") {
      const r = await askUser(s, toolInput, opts.signal);
      if (!r.answers) return { behavior: "deny", message: r.message ?? "The user dismissed the question." };
      return { behavior: "allow", updatedInput: { ...toolInput, answers: r.answers } };
    }

    if (s.runtimeMode !== "approval-required") {
      return { behavior: "allow", updatedInput: toolInput };
    }

    const cls = classifyClaudeTool(toolName, toolInput);
    const r = await waitForUser(
      s,
      "tool_approval",
      {
        toolName,
        title: opts.title ?? cls.title,
        ...((opts.decisionReason ?? opts.description)
          ? { detail: String(opts.decisionReason ?? opts.description) }
          : {}),
        input: toolInput,
      },
      opts.signal,
    );
    if (r.decision === "deny") {
      return { behavior: "deny", message: r.message ?? "The user denied this action." };
    }
    return {
      behavior: "allow",
      updatedInput: toolInput,
      ...(r.decision === "allowAlways" && opts.suggestions ? { updatedPermissions: opts.suggestions } : {}),
    };
  }

  /* ---------------------------- message handling ---------------------------- */

  async function consume(s: ClaudeSession) {
    let failure: string | undefined;
    try {
      for await (const msg of s.q) {
        try {
          handleMessage(s, msg);
        } catch (err) {
          log(`claude message handling error: ${errMessage(err)}`);
        }
      }
    } catch (err) {
      failure = errMessage(err);
    }
    if (s.stopped) return;
    sessions.delete(s.key);
    for (const [id, p] of s.pending)
      p.resolve({ requestId: id, decision: "deny", message: "Session ended." });
    const message = failure ? redact(failure, secretValues(s.input.account.secrets)) : undefined;
    if (s.active) {
      s.sink.send({
        type: "turn.completed",
        turnId: s.active.turnId,
        status: s.active.interrupted ? "interrupted" : "failed",
        ...(message ? { error: message } : {}),
        resumeCursor: { sessionId: s.sessionId },
      });
      s.active = undefined;
    }
    if (message) {
      const resumeFailed = !!s.input.resumeCursor && s.completedTurns === 0;
      s.sink.error(resumeFailed ? `Could not resume Claude session: ${message}` : message, true);
      s.sink.state("error");
    }
    s.sink.send({ type: "session.exited", reason: message ?? "ended" });
  }

  function handleMessage(s: ClaudeSession, msg: SDKMessage) {
    const m = msg as unknown as Record<string, unknown>;
    switch (msg.type) {
      case "system":
        return handleSystem(s, m);
      case "stream_event":
        if (m.parent_tool_use_id == null) handleStreamEvent(s, m.event as Record<string, unknown>);
        return;
      case "assistant":
        return handleAssistant(s, m);
      case "user":
        return handleUser(s, m);
      case "result":
        return handleResult(s, m);
      case "rate_limit_event":
        return handleRateLimit(s, m.rate_limit_info as Record<string, unknown>);
      case "auth_status": {
        const e = str(m.error);
        if (e) s.sink.error(`Claude sign-in problem: ${e}`);
        return;
      }
      default:
        return;
    }
  }

  function handleSystem(s: ClaudeSession, m: Record<string, unknown>) {
    if (m.subtype === "init") {
      const model = str(m.model);
      if (model) s.model = s.model ?? model;
      return;
    }
    if (m.subtype === "compact_boundary") {
      s.sink.notice(s.active?.turnId, newItemId("notice"), "Compacted the conversation to save space");
    }
  }

  function handleStreamEvent(s: ClaudeSession, ev: Record<string, unknown>) {
    const turnId = s.active?.turnId;
    switch (ev.type) {
      case "message_start": {
        const message = isRecord(ev.message) ? ev.message : {};
        s.currentMessageId = str(message.id);
        s.blocks.clear();
        return;
      }
      case "content_block_start": {
        const index = Number(ev.index ?? 0);
        const block = isRecord(ev.content_block) ? ev.content_block : {};
        const kind =
          block.type === "text" ? "assistant_message" : block.type === "thinking" ? "reasoning" : undefined;
        if (!kind) return;
        const item: Item = {
          id: newItemId(kind === "assistant_message" ? "msg" : "rsn"),
          kind,
          status: "running",
        };
        // Started lazily on the first delta so empty (hidden) thinking blocks produce no items.
        s.blocks.set(index, { item, text: "", started: false });
        if (s.currentMessageId) s.streamedMessageIds.add(s.currentMessageId);
        return;
      }
      case "content_block_delta": {
        const b = s.blocks.get(Number(ev.index ?? 0));
        const delta = isRecord(ev.delta) ? ev.delta : {};
        if (!b) return;
        const piece =
          delta.type === "text_delta" && typeof delta.text === "string"
            ? delta.text
            : delta.type === "thinking_delta" && typeof delta.thinking === "string"
              ? delta.thinking
              : "";
        if (!piece) return;
        if (!b.started) {
          b.started = true;
          s.sink.itemStarted(turnId, b.item);
        }
        b.text += piece;
        s.sink.delta(turnId, b.item.id, b.item.kind === "reasoning" ? "reasoning" : "text", piece);
        return;
      }
      case "content_block_stop": {
        const index = Number(ev.index ?? 0);
        const b = s.blocks.get(index);
        if (!b) return;
        s.blocks.delete(index);
        if (b.started) s.sink.itemCompleted(turnId, { ...b.item, status: "completed", text: b.text });
        return;
      }
      default:
        return;
    }
  }

  function handleAssistant(s: ClaudeSession, m: Record<string, unknown>) {
    // Main conversation only (sub-agent requests have their own, separate context).
    const mu =
      m.parent_tool_use_id == null && isRecord(m.message) && isRecord(m.message.usage)
        ? m.message.usage
        : null;
    if (mu) {
      const n = (k: string) => (typeof mu[k] === "number" ? (mu[k] as number) : 0);
      const ctx = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
      if (ctx > 0) s.lastContextTokens = ctx;
    }
    const turnId = s.active?.turnId;
    const topLevel = m.parent_tool_use_id == null;
    const message = isRecord(m.message) ? m.message : {};
    const error = str(m.error);
    if (error === "rate_limit") {
      s.sink.rateLimit({ status: "limited", message: "Claude usage limit reached." });
    } else if (error === "authentication_failed" || error === "oauth_org_not_allowed") {
      s.sink.error("Claude sign-in failed or expired. Reconnect this account in Settings.");
    } else if (error === "billing_error") {
      s.sink.error("Claude billing problem on this account.");
    }
    if (!topLevel) return;
    const streamed = str(message.id) ? s.streamedMessageIds.has(String(message.id)) : false;
    const content = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    for (const block of content) {
      if ((block.type === "text" || block.type === "thinking") && !streamed) {
        const text = String(block.type === "text" ? (block.text ?? "") : (block.thinking ?? ""));
        if (!text) continue;
        const kind = block.type === "text" ? "assistant_message" : "reasoning";
        s.sink.itemCompleted(turnId, {
          id: newItemId(kind === "assistant_message" ? "msg" : "rsn"),
          kind,
          status: "completed",
          text,
        });
      } else if (
        block.type === "tool_use" ||
        block.type === "server_tool_use" ||
        block.type === "mcp_tool_use"
      ) {
        const id = str(block.id) ?? newItemId("tool");
        const rawName = str(block.name) ?? "tool";
        const name =
          block.type === "mcp_tool_use" && str(block.server_name)
            ? `mcp__${block.server_name}__${rawName}`
            : rawName;
        const cls = classifyClaudeTool(name, block.input);
        const item: Item = {
          id,
          kind: cls.kind,
          status: "running",
          title: cls.title,
          toolName: name,
          input: block.input,
          ...(cls.todos ? { todos: cls.todos } : {}),
        };
        s.tools.set(id, { item, turnId, name, input: block.input });
        s.sink.itemStarted(turnId, item);
      }
    }
  }

  function handleUser(s: ClaudeSession, m: Record<string, unknown>) {
    if (m.parent_tool_use_id != null) return;
    const message = isRecord(m.message) ? m.message : {};
    const content = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      const t = id ? s.tools.get(id) : undefined;
      if (!t || !id) continue;
      s.tools.delete(id);
      const { text, image } = toolResultContent(block.content);
      const failed = block.is_error === true;
      const done: Item = {
        ...t.item,
        status: failed ? "failed" : "completed",
        ...(text !== undefined ? { output: text } : {}),
        ...(image ? { image } : {}),
      };
      if (t.item.kind === "todo") {
        const todos =
          t.name === "TodoWrite"
            ? todosFromTodoWrite(t.input)
            : s.tasks.apply(t.name, t.input, m.tool_use_result);
        if (todos) done.todos = todos;
        delete done.output;
      }
      if (t.name === "AskUserQuestion" && isRecord(m.tool_use_result)) {
        done.output = stringifyOutput(m.tool_use_result.answers) ?? done.output;
      }
      s.sink.itemCompleted(t.turnId, done);
    }
  }

  function handleResult(s: ClaudeSession, m: Record<string, unknown>) {
    const active = s.active;
    const usageRaw = isRecord(m.usage) ? m.usage : {};
    const totalCost = typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined;
    const costUsd = totalCost !== undefined ? Math.max(0, totalCost - s.lastCostUsd) : undefined;
    if (totalCost !== undefined) s.lastCostUsd = totalCost;
    const usage = {
      ...(typeof usageRaw.input_tokens === "number" ? { inputTokens: usageRaw.input_tokens } : {}),
      ...(typeof usageRaw.output_tokens === "number" ? { outputTokens: usageRaw.output_tokens } : {}),
      ...(typeof usageRaw.cache_read_input_tokens === "number"
        ? { cacheReadTokens: usageRaw.cache_read_input_tokens }
        : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(s.lastContextTokens ? { contextTokens: s.lastContextTokens } : {}),
    };
    // Close any tool items left open (e.g. interrupted mid-tool).
    for (const [id, t] of s.tools) {
      if (t.turnId === active?.turnId) {
        s.tools.delete(id);
        s.sink.itemCompleted(t.turnId, { ...t.item, status: "failed" });
      }
    }
    const isError = m.is_error === true || (typeof m.subtype === "string" && m.subtype !== "success");
    const errors = Array.isArray(m.errors) ? m.errors.filter((e) => typeof e === "string").join("; ") : "";
    const status = active?.interrupted ? "interrupted" : isError ? "failed" : "completed";
    const cursor = { sessionId: s.sessionId };
    s.completedTurns++;
    if (active) {
      s.sink.send({
        type: "turn.completed",
        turnId: active.turnId,
        status,
        usage,
        ...(status === "failed" ? { error: errors || str(m.result) || String(m.subtype) } : {}),
        resumeCursor: cursor,
      });
    }
    s.active = undefined;

    // Messages sent mid-turn: folded ones complete with this turn; the rest start the next turn.
    const consumed = new Set(Array.isArray(m.user_message_uuids) ? (m.user_message_uuids as string[]) : []);
    const queued = typeof m.queued_turn_count === "number" ? m.queued_turn_count : undefined;
    const remaining: typeof s.waiting = [];
    for (const w of s.waiting) {
      const folded = consumed.has(w.uuid) || (consumed.size === 0 && !queued);
      if (folded) s.sink.send({ type: "turn.completed", turnId: w.turnId, status, resumeCursor: cursor });
      else remaining.push(w);
    }
    s.waiting = [];
    const next = remaining.shift();
    if (next) {
      s.waiting = remaining;
      startTurn(s, next.turnId, next.uuid);
    } else {
      s.sink.state("idle");
    }
  }

  function handleRateLimit(s: ClaudeSession, info: Record<string, unknown> | undefined) {
    if (!info) return;
    const status =
      info.status === "rejected" ? "limited" : info.status === "allowed_warning" ? "warning" : "ok";
    const resetsAt = epochMs(info.resetsAt as number | undefined);
    const utilization = typeof info.utilization === "number" ? info.utilization : undefined;
    const kind = str(info.rateLimitType)?.replace(/_/g, " ");
    s.sink.rateLimit({
      status,
      ...(resetsAt ? { resetsAt } : {}),
      ...(utilization !== undefined ? { utilization } : {}),
      ...(status !== "ok"
        ? {
            message: `Claude ${kind ?? "usage"} limit ${status === "limited" ? "reached" : "almost reached"}`,
          }
        : {}),
    });
  }

  return adapter;
}

export const createClaudeAdapterFactory: (options?: ClaudeAdapterOptions) => AdapterFactory =
  (options) => (deps) =>
    createClaudeAdapter(deps, options);
