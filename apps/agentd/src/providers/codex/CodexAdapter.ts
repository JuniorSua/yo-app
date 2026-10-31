/**
 * Codex adapter: drives `codex app-server` (JSONL JSON-RPC over stdio) with a per-account CODEX_HOME.
 *
 * Process model: ONE app-server process PER SESSION. Each Yo agent has its own display (DISPLAY),
 * its own browser MCP (CDP port) and its own env; Codex runs shell commands with the app-server's
 * env and MCP servers are process-level config, so sharing a process between agents would leak one
 * agent's display/browser into another. Sessions on the same account share CODEX_HOME (auth + history).
 *
 * Protocol handling adapted from T3 Code's CodexSessionRuntime.ts / CodexAdapter.ts (MIT).
 */
import { tmpdir } from "node:os";
import {
  type AuthStatus,
  type InputPart,
  type Item,
  type ModelInfo,
  parseCodexCallback,
  type RuntimeMode,
} from "@yo/contracts";
import type {
  AccountContext,
  AdapterFactory,
  EmitFn,
  LoginCallbacks,
  LoginHandle,
  LoginOptions,
  ProviderAdapter,
  RespondInput,
  SessionStartInput,
} from "../ProviderAdapter";
import { looksLikeAuthFailure, SIGN_IN_EXPIRED } from "../shared/auth";
import { buildChildEnv, redact, secretValues } from "../shared/env";
import { EventSink, epochMs } from "../shared/events";
import { runCollect } from "../shared/process";
import { classifyMcp, commandTitle, fileTitle, hostOf } from "../shared/titles";
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
import { mcpConfigOverrides, writeCodexConfig } from "./config";
import type {
  AccountLoginCompletedNotification,
  AskForApproval,
  GetAccountResponse,
  LoginAccountResponse,
  ModelListResponse,
  RateLimitSnapshot,
  ThreadItem,
  ThreadStartResponse,
  TokenUsageBreakdown,
  ToolRequestUserInputQuestion,
  Turn,
  UserInput,
} from "./protocol";
import { JsonRpcProcess } from "./rpc";

export interface CodexAdapterOptions {
  /** Command + leading args for the Codex CLI (default: YO_CODEX_BIN or `codex`). */
  command?: string[];
  /** Write `$CODEX_HOME/config.toml` before spawning (default true; false for read-only host checks). */
  writeConfig?: boolean;
  clientVersion?: string;
  interruptAckMs?: number;
  stuckInterruptMs?: number;
}

const STUCK_INTERRUPT_MS = 5_000;
const INTERRUPT_ACK_MS = 10_000;

const CLIENT_INFO = { name: "yo", title: "Yo" };

/**
 * full-access → never ask. auto → on-request (Codex may ask; the adapter auto-approves).
 * approval-required → untrusted: with the danger-full-access sandbox, "on-request" would almost
 * never ask, so anything that is not a known-safe read-only command is sent for approval.
 */
export function approvalPolicyFor(mode: RuntimeMode): AskForApproval {
  return mode === "full-access" ? "never" : mode === "auto" ? "on-request" : "untrusted";
}

const SIGN_IN_GONE = "This sign-in has ended. Press Try again for a fresh sign-in page.";

/**
 * Where Codex's sign-in server sends the browser after the callback (its /success page), when that's the same
 * server: same scheme, host and port as the callback. Anything else is never followed.
 */
export function successPage(callbackUrl: string, res: { status: number; headers: Headers }): string | null {
  if (res.status < 300 || res.status >= 400) return null;
  const location = res.headers.get("location");
  if (!location) return null;
  try {
    const from = new URL(callbackUrl);
    const to = new URL(location, from);
    return to.origin === from.origin && to.pathname !== from.pathname ? to.href : null;
  } catch {
    return null;
  }
}

/** A one-time code ChatGPT never confirmed: most often "device code sign-in" is still off in its settings. */
export const CODE_NOT_CONFIRMED =
  "ChatGPT didn't confirm the code in time. If its page said code sign-in is turned off, turn it on in ChatGPT's security settings first, then get a new code.";

/** Codex's reason a sign-in failed, in plain words where we know it (never anything secret: it's redacted). */
export function loginFailure(error: string | null | undefined, deviceCode: boolean): string {
  const e = redact(error ?? "");
  if (deviceCode && /timed out|expired/i.test(e)) return CODE_NOT_CONFIRMED;
  if (/not completed|cancel/i.test(e)) return "Sign-in canceled.";
  if (/token exchange failed/i.test(e))
    return "ChatGPT didn't accept that sign-in. Press Try again, sign in on the new page, and paste the new address.";
  if (/access_denied/i.test(e)) return "ChatGPT's page didn't allow the sign-in. Press Try again.";
  const reason = e.replace(/^Login server error:\s*/i, "").trim();
  return reason ? `ChatGPT's sign-in didn't finish: ${reason}` : "Sign-in failed.";
}

/** Split `YO_CODEX_BIN` like a shell would for simple cases ("node --import tsx /x.ts"). */
function splitCommand(s: string): string[] {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((p) => p.replace(/^["']|["']$/g, ""));
}

function planLabel(plan: string | undefined): string | undefined {
  if (!plan || plan === "unknown") return undefined;
  const pretty: Record<string, string> = {
    free: "ChatGPT Free",
    go: "ChatGPT Go",
    plus: "ChatGPT Plus",
    pro: "ChatGPT Pro",
    prolite: "ChatGPT Pro Lite",
    promax: "ChatGPT Pro Max",
    team: "ChatGPT Team",
    business: "ChatGPT Business",
    enterprise: "ChatGPT Enterprise",
    edu: "ChatGPT Edu",
  };
  return pretty[plan] ?? `ChatGPT ${plan.replace(/_/g, " ")}`;
}

function toCodexInput(parts: InputPart[]): UserInput[] {
  return parts.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text, text_elements: [] }
      : { type: "image", url: `data:${p.mediaType};base64,${p.data}` },
  );
}

interface PendingReq {
  resolve(r: RespondInput): void;
}

interface CodexSession {
  key: string;
  input: SessionStartInput;
  sink: EventSink;
  rpc: JsonRpcProcess;
  threadId: string;
  runtimeMode: RuntimeMode;
  model?: string;
  effort?: string;
  active?: {
    turnId: string;
    codexTurnId?: string;
    codexTurnIdReady: Promise<string | undefined>;
    cancelTurnStart(): void;
    setCodexTurnId(id: string): void;
    interrupted: boolean;
    interruptedAt?: number;
    steered: string[];
    usage?: TokenUsageBreakdown;
    planItemId?: string;
    /** ChatGPT turned the sign-in down during this turn (reported once, in plain words). */
    authFailed?: boolean;
  };
  pending: Map<string, PendingReq>;
  items: Map<string, Item>;
  stopped: boolean;
}

/** An `account/read` failure that means ChatGPT turned the login down (vs. offline or a server hiccup). */
export function isAuthRejection(message: string): boolean {
  return looksLikeAuthFailure(message) || /\b401\b|unauthori[sz]ed/i.test(message);
}

export function createCodexAdapter(
  deps: { emit: EmitFn; log: (msg: string) => void },
  options: CodexAdapterOptions = {},
): ProviderAdapter {
  const sessions = new Map<string, CodexSession>();
  const log = (m: string) => deps.log(redact(m));
  const baseCommand = (): string[] =>
    options.command ?? (process.env.YO_CODEX_BIN ? splitCommand(process.env.YO_CODEX_BIN) : ["codex"]);

  function codexEnv(account: AccountContext, extra: Record<string, string> = {}) {
    return buildChildEnv(extra, {
      CODEX_HOME: account.configDir,
      // Only an explicit API-key account gets an OpenAI key.
      OPENAI_API_KEY: account.secrets.openaiApiKey,
      NO_COLOR: "1",
    });
  }

  async function spawnServer(
    account: AccountContext,
    opts: { extraEnv?: Record<string, string>; mcp?: SessionStartInput["mcpServers"]; cwd?: string } = {},
  ): Promise<JsonRpcProcess> {
    if (options.writeConfig !== false) writeCodexConfig(account.configDir, { mcpServers: opts.mcp ?? [] });
    const [cmd, ...pre] = baseCommand();
    const rpc = new JsonRpcProcess({
      command: cmd!,
      args: [...pre, "app-server", ...mcpConfigOverrides(opts.mcp ?? [])],
      env: codexEnv(account, opts.extraEnv),
      cwd: opts.cwd ?? tmpdir(),
      log,
    });
    try {
      await rpc.request(
        "initialize",
        {
          clientInfo: { ...CLIENT_INFO, version: options.clientVersion ?? "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
        30_000,
      );
      rpc.notify("initialized");
      return rpc;
    } catch (err) {
      rpc.close();
      throw err;
    }
  }

  async function withServer<T>(account: AccountContext, fn: (rpc: JsonRpcProcess) => Promise<T>): Promise<T> {
    const rpc = await spawnServer(account);
    try {
      return await fn(rpc);
    } finally {
      rpc.close();
    }
  }

  const adapter: ProviderAdapter = {
    kind: "codex",

    async version() {
      const [cmd, ...pre] = baseCommand();
      const r = await runCollect(cmd!, [...pre, "--version"], { timeoutMs: 10_000 });
      if (r.spawnError || r.code !== 0) return null;
      return parseVersion(r.stdout);
    },

    async probe(account): Promise<AuthStatus> {
      const base = { accountId: account.accountId, provider: "codex" as const };
      const cliVersion = (await adapter.version().catch(() => null)) ?? undefined;
      if (!cliVersion) return { ...base, status: "not_installed", message: "Codex CLI not found." };
      // Ask ChatGPT's server whether the login still works (a token refresh: free, no model call), so an expired
      // login shows up in Settings before a task fails. Not while a task uses this login: its own Codex keeps the
      // login fresh, and two processes refreshing one rotating token at once is asking for trouble.
      const inUse = [...sessions.values()].some(
        (x) => !x.stopped && x.input.account.accountId === account.accountId,
      );
      const read = (refreshToken: boolean) =>
        withServer(account, (rpc) =>
          rpc.request<GetAccountResponse>("account/read", { refreshToken }, 20_000),
        );
      const expired = (): AuthStatus => ({
        ...base,
        status: "unauthenticated",
        cliVersion,
        verified: true,
        message: account.secrets.codexAuthJson
          ? "ChatGPT's sign-in has expired or was signed out."
          : "Not signed in to ChatGPT.",
      });
      try {
        let res: GetAccountResponse;
        let verified = false;
        if (inUse) res = await read(false);
        else {
          try {
            res = await read(true);
            verified = true;
          } catch (err) {
            if (isAuthRejection(errMessage(err))) return expired();
            // Offline, or ChatGPT's server is having a moment: say what the saved login says, unverified.
            log(`codex sign-in check failed, using the saved login: ${redact(errMessage(err))}`);
            res = await read(false);
          }
        }
        const acc = res.account;
        if (!acc)
          return verified && account.secrets.codexAuthJson
            ? expired()
            : { ...base, status: "unauthenticated", cliVersion, message: "Not signed in to ChatGPT." };
        if (acc.type === "chatgpt") {
          const plan = planLabel(acc.planType);
          return {
            ...base,
            status: "authenticated",
            cliVersion,
            ...(verified ? { verified } : {}),
            ...(acc.email ? { email: acc.email } : {}),
            ...(plan ? { plan } : {}),
            label: `${plan ?? "ChatGPT"}${acc.email ? ` (${acc.email})` : ""}`,
          };
        }
        return {
          ...base,
          status: "authenticated",
          cliVersion,
          label: acc.type === "apiKey" ? "OpenAI API key" : acc.type,
        };
      } catch (err) {
        if (isAuthRejection(errMessage(err))) return expired();
        return { ...base, status: "error", cliVersion, message: redact(errMessage(err)) };
      }
    },

    async listModels(account) {
      const res = await withServer(account, (rpc) =>
        rpc.request<ModelListResponse>("model/list", { limit: 100, includeHidden: false }, 30_000),
      );
      return res.data
        .filter((m) => !m.hidden)
        .map((m) => ({
          id: m.model || m.id,
          label: m.displayName || m.model,
          ...(m.description ? { description: m.description } : {}),
          ...(m.isDefault ? { isDefault: true } : {}),
          ...(m.supportedReasoningEfforts?.length
            ? { efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort) }
            : {}),
        })) satisfies ModelInfo[];
    },

    /**
     * Two ways in, both on Yo's computer:
     *  - "codex-browser" (the walkthrough's default): Codex's own sign-in page. ChatGPT's page then sends the
     *    person's browser to Codex's sign-in server here (`http://127.0.0.1:1455/auth/callback?code=…&state=…`),
     *    which their browser can't reach, so they paste that address into Yo and it is handed to Codex here
     *    (`input`). Only that very address, with this sign-in's `state`, is accepted; it is never logged.
     *  - "codex-device-code": a one-time code. ChatGPT only accepts it once "device code sign-in" is turned on in
     *    its security settings (or a workspace admin allows it); until then Codex just keeps waiting.
     */
    async login(account, cb: LoginCallbacks, opts?: LoginOptions): Promise<LoginHandle> {
      let done = false;
      let loginId: string | undefined;
      let rpc: JsonRpcProcess | undefined;
      /** The browser sign-in's link (it names the address to forward to, and its `state`). */
      let authUrl: string | undefined;
      const deviceCode = opts?.method !== "codex-browser";
      const finish = (r: Parameters<LoginCallbacks["result"]>[0]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        rpc?.close();
        cb.result(r);
      };
      const timer = setTimeout(
        () => finish({ ok: false, message: deviceCode ? CODE_NOT_CONFIRMED : "Sign-in timed out." }),
        15 * 60_000,
      );
      timer.unref?.();
      try {
        rpc = await spawnServer(account);
        rpc.onNotification((method, params) => {
          if (method !== "account/login/completed") return;
          const p = params as AccountLoginCompletedNotification;
          if (loginId && p.loginId && p.loginId !== loginId) return;
          finish(p.success ? { ok: true } : { ok: false, message: loginFailure(p.error, deviceCode) });
        });
        rpc.onExit(() => finish({ ok: false, message: "Codex exited during sign-in." }));
        const apiKey = account.secrets.openaiApiKey;
        const res = await rpc.request<LoginAccountResponse>(
          "account/login/start",
          apiKey
            ? { type: "apiKey", apiKey }
            : deviceCode
              ? { type: "chatgptDeviceCode" }
              : { type: "chatgpt" },
          30_000,
        );
        if (res.type === "apiKey") {
          finish({ ok: true });
        } else if (res.type === "chatgptDeviceCode") {
          loginId = res.loginId;
          cb.prompt({
            url: res.verificationUrl,
            userCode: res.userCode,
            needsInput: false,
            message: "Open the link, sign in to ChatGPT and enter the code.",
          });
        } else {
          loginId = res.loginId;
          authUrl = res.authUrl;
          cb.prompt({
            url: res.authUrl,
            needsInput: true,
            message:
              "Sign in on ChatGPT's page and click Continue. Then copy the address your browser lands on and paste it here.",
          });
        }
      } catch (err) {
        finish({ ok: false, message: redact(errMessage(err)) });
      }
      return {
        async input(text) {
          // The one-time code needs nothing typed here.
          if (!authUrl) return;
          if (done) throw new Error(SIGN_IN_GONE);
          const check = parseCodexCallback(text, authUrl);
          if (!check.ok) throw new Error(check.error);
          let status: number;
          try {
            // Codex's sign-in server, here on Yo's computer. It swaps the code for the sign-in itself, sends the
            // browser on to its /success page, and only reports the result (account/login/completed) once that
            // page is loaded. Nobody's browser can reach it here, so load it ourselves: one hop, same server only.
            const res = await fetch(check.callbackUrl, {
              redirect: "manual",
              signal: AbortSignal.timeout(30_000),
            });
            status = res.status;
            await res.body?.cancel().catch(() => {});
            const next = successPage(check.callbackUrl, res);
            if (next) {
              const page = await fetch(next, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
              await page.body?.cancel().catch(() => {});
            }
          } catch {
            // Never the error itself: it could quote the address, and the address carries the code.
            if (done) return;
            throw new Error(SIGN_IN_GONE);
          }
          if (status === 400 && !done)
            throw new Error("That address is from an earlier sign-in. Press Try again for a fresh one.");
        },
        cancel() {
          if (rpc && loginId && !rpc.isExited)
            void rpc.request("account/login/cancel", { loginId }, 5_000).catch(() => {});
          finish({ ok: false, message: "Sign-in canceled." });
        },
      };
    },

    async logout(account) {
      await withServer(account, (rpc) => rpc.request("account/logout", undefined, 15_000));
    },

    /* -------------------------------- sessions -------------------------------- */

    async startSession(input) {
      if (sessions.has(input.sessionKey)) await adapter.stopSession(input.sessionKey);
      const secrets = secretValues(input.account.secrets);
      const sink = new EventSink(deps.emit, input.sessionKey, () => secrets);
      const rpc = await spawnServer(input.account, {
        extraEnv: input.env,
        mcp: input.mcpServers,
        cwd: input.cwd,
      });
      const common = {
        ...(input.model ? { model: input.model } : {}),
        cwd: input.cwd,
        approvalPolicy: approvalPolicyFor(input.runtimeMode),
        sandbox: "danger-full-access" as const,
        ...(input.systemAppend ? { developerInstructions: input.systemAppend } : {}),
        serviceName: "yo",
      };
      const resumeId = str(input.resumeCursor?.threadId);
      let res: ThreadStartResponse;
      let resumed = false;
      try {
        if (resumeId) {
          try {
            res = await rpc.request<ThreadStartResponse>("thread/resume", {
              threadId: resumeId,
              excludeTurns: true,
              ...common,
            });
            resumed = true;
          } catch (err) {
            log(`codex thread/resume failed, starting fresh: ${errMessage(err)}`);
            res = await rpc.request<ThreadStartResponse>("thread/start", common);
          }
        } else {
          res = await rpc.request<ThreadStartResponse>("thread/start", common);
        }
      } catch (err) {
        rpc.close();
        throw err;
      }
      const s: CodexSession = {
        key: input.sessionKey,
        input,
        sink,
        rpc,
        threadId: res.thread.id,
        runtimeMode: input.runtimeMode,
        model: input.model ?? res.model,
        effort: input.effort,
        pending: new Map(),
        items: new Map(),
        stopped: false,
      };
      sessions.set(input.sessionKey, s);
      rpc.onNotification((m, p) => handleNotification(s, m, p));
      rpc.onServerRequest((m, p) => handleServerRequest(s, m, p));
      rpc.onExit(({ code, signal }) => onExit(s, code, signal));
      sink.send({
        type: "session.started",
        resumeCursor: { threadId: s.threadId },
        ...(s.model ? { model: s.model } : {}),
      });
      sink.state("idle");
      return { resumed };
    },

    async sendTurn(sessionKey, turnId, parts) {
      const s = mustGet(sessionKey);
      if (
        s.active?.interrupted &&
        Date.now() - (s.active.interruptedAt ?? 0) >= (options.stuckInterruptMs ?? STUCK_INTERRUPT_MS)
      ) {
        // Core already closed the stopped turn. Resume on the next message instead of steering a wedged CLI.
        s.stopped = true;
        sessions.delete(sessionKey);
        for (const [id, p] of s.pending)
          p.resolve({ requestId: id, decision: "deny", message: "Session restarted." });
        s.active.cancelTurnStart();
        s.active = undefined;
        s.rpc.close();
        throw Object.assign(new Error(`unknown session ${sessionKey}: its stopped task never ended`), {
          code: "unknown_session",
        });
      }
      const codexInput = toCodexInput(parts);
      if (s.active) {
        // Mid-turn message: steer the running turn.
        const active = s.active;
        const expectedTurnId = await active.codexTurnIdReady;
        if (!expectedTurnId || s.active !== active)
          throw new Error("The task ended before the message could be sent.");
        active.steered.push(turnId);
        await s.rpc.request("turn/steer", { threadId: s.threadId, input: codexInput, expectedTurnId });
        return;
      }
      const ready = deferred<string | undefined>();
      s.active = {
        turnId,
        codexTurnIdReady: ready.promise,
        cancelTurnStart: () => ready.resolve(undefined),
        setCodexTurnId: (id) => {
          if (s.active?.turnId === turnId && !s.active.codexTurnId) {
            s.active.codexTurnId = id;
            ready.resolve(id);
          }
        },
        interrupted: false,
        steered: [],
      };
      s.sink.send({ type: "turn.started", turnId });
      s.sink.state("running");
      try {
        const res = await s.rpc.request<{ turn: Turn }>("turn/start", {
          threadId: s.threadId,
          input: codexInput,
          approvalPolicy: approvalPolicyFor(s.runtimeMode),
          ...(s.model ? { model: s.model } : {}),
          ...(s.effort ? { effort: s.effort } : {}),
        });
        if (s.active?.turnId === turnId) s.active.setCodexTurnId(res.turn.id);
      } catch (err) {
        ready.resolve(undefined);
        const message = redact(errMessage(err), secretValues(s.input.account.secrets));
        if (s.active?.turnId === turnId) {
          s.active = undefined;
          s.sink.send({
            type: "turn.completed",
            turnId,
            status: "failed",
            error: message,
            resumeCursor: { threadId: s.threadId },
          });
          s.sink.state("idle");
        }
        throw err;
      }
    },

    async interrupt(sessionKey) {
      const s = sessions.get(sessionKey);
      if (!s?.active) return;
      const active = s.active;
      active.interrupted = true;
      active.interruptedAt ??= Date.now();
      for (const [id, p] of s.pending)
        p.resolve({ requestId: id, decision: "deny", message: "Interrupted." });
      try {
        await withTimeout(
          (async () => {
            const codexTurnId = active.codexTurnId ?? (await active.codexTurnIdReady);
            if (!codexTurnId || s.active !== active) return;
            await s.rpc.request(
              "turn/interrupt",
              { threadId: s.threadId, turnId: codexTurnId },
              options.interruptAckMs ?? INTERRUPT_ACK_MS,
            );
          })(),
          options.interruptAckMs ?? INTERRUPT_ACK_MS,
          "codex interrupt",
        );
      } catch (err) {
        log(`codex interrupt failed: ${errMessage(err)}`);
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
      // Applied on the next turn/start.
      if (patch.model) s.model = patch.model;
      if (patch.runtimeMode) s.runtimeMode = patch.runtimeMode;
    },

    async stopSession(sessionKey) {
      const s = sessions.get(sessionKey);
      if (!s) return;
      s.stopped = true;
      sessions.delete(sessionKey);
      for (const [id, p] of s.pending)
        p.resolve({ requestId: id, decision: "deny", message: "Session stopped." });
      if (s.active) {
        completeTurn(s, "interrupted");
      }
      s.rpc.close();
      s.sink.send({ type: "session.exited", reason: "stopped" });
    },

    hasSession(sessionKey) {
      return sessions.has(sessionKey);
    },

    async dispose() {
      await Promise.all([...sessions.keys()].map((k) => adapter.stopSession(k)));
    },
  };

  function mustGet(key: string): CodexSession {
    const s = sessions.get(key);
    if (!s) throw new Error(`no codex session ${key}`);
    return s;
  }

  function onExit(s: CodexSession, code: number | null, signal: string | null) {
    if (s.stopped) return;
    sessions.delete(s.key);
    for (const [id, p] of s.pending) p.resolve({ requestId: id, decision: "deny", message: "Codex exited." });
    const reason = `codex app-server exited (${signal ?? code})`;
    if (s.active) completeTurn(s, "failed", reason);
    s.sink.error(reason, true);
    s.sink.state("error");
    s.sink.send({ type: "session.exited", reason });
  }

  /** A turn error that means the saved ChatGPT sign-in was turned down (expired, revoked, signed out). */
  function isAuthError(e: unknown): boolean {
    if (!isRecord(e)) return false;
    return e.codexErrorInfo === "unauthorized" || looksLikeAuthFailure(str(e.message));
  }

  /** Once per turn: one plain message, flagged so core marks the account "sign in again". */
  function reportAuthFailure(s: CodexSession) {
    if (s.active?.authFailed) return;
    if (s.active) s.active.authFailed = true;
    s.sink.authError(SIGN_IN_EXPIRED.codex);
  }

  function completeTurn(s: CodexSession, status: "completed" | "interrupted" | "failed", error?: string) {
    const a = s.active;
    if (!a) return;
    a.cancelTurnStart();
    s.active = undefined;
    // Close anything still open (e.g. interrupted mid-command).
    for (const [id, item] of s.items) {
      s.items.delete(id);
      s.sink.itemCompleted(a.turnId, { ...item, status: status === "completed" ? "completed" : "failed" });
    }
    const usage = a.usage
      ? {
          inputTokens: a.usage.inputTokens,
          outputTokens: a.usage.outputTokens,
          cacheReadTokens: a.usage.cachedInputTokens,
          // "last" usage = the latest request; Codex input already includes the cached part.
          contextTokens: a.usage.inputTokens,
        }
      : undefined;
    const cursor = { threadId: s.threadId };
    s.sink.send({
      type: "turn.completed",
      turnId: a.turnId,
      status,
      ...(usage ? { usage } : {}),
      ...(error ? { error } : {}),
      resumeCursor: cursor,
    });
    for (const t of a.steered)
      s.sink.send({ type: "turn.completed", turnId: t, status, resumeCursor: cursor });
    s.sink.state("idle");
  }

  /* --------------------------------- items --------------------------------- */

  function itemFromCodex(ci: ThreadItem): Item | undefined {
    const c = ci as Record<string, unknown> & { type: string; id: string };
    switch (c.type) {
      case "agentMessage":
        return { id: c.id, kind: "assistant_message", status: "running", text: str(c.text) ?? "" };
      case "reasoning": {
        const summary = Array.isArray(c.summary) ? c.summary.join("\n") : "";
        const content = Array.isArray(c.content) ? c.content.join("\n") : "";
        return { id: c.id, kind: "reasoning", status: "running", text: summary || content };
      }
      case "commandExecution":
        return {
          id: c.id,
          kind: "command",
          status: "running",
          title: commandTitle(c.command),
          toolName: "shell",
          input: { command: c.command, cwd: c.cwd },
          ...(typeof c.aggregatedOutput === "string" ? { output: c.aggregatedOutput } : {}),
        };
      case "fileChange": {
        const changes = Array.isArray(c.changes) ? c.changes.filter(isRecord) : [];
        const first = changes[0];
        const kindOf = (k: unknown) => (isRecord(k) ? str(k.type) : str(k)) ?? "update";
        const verb = (k: unknown) =>
          kindOf(k) === "add" ? "Created" : kindOf(k) === "delete" ? "Deleted" : "Edited";
        const title =
          changes.length > 1
            ? `Edited ${changes.length} files`
            : first
              ? fileTitle(verb(first.kind), first.path)
              : "Edited files";
        const diff = changes.map((ch) => `--- ${ch.path}\n${str(ch.diff) ?? ""}`).join("\n");
        return {
          id: c.id,
          kind: "file_change",
          status: "running",
          title,
          toolName: "apply_patch",
          input: { files: changes.map((ch) => ch.path) },
          ...(diff ? { output: diff } : {}),
        };
      }
      case "mcpToolCall": {
        const server = str(c.server);
        const tool = str(c.tool) ?? "tool";
        const cls = classifyMcp(server, tool, c.arguments);
        const item: Item = {
          id: c.id,
          kind: cls.kind,
          status: "running",
          title: cls.title,
          toolName: `${server ?? "mcp"}.${tool}`,
          input: c.arguments,
        };
        const result = isRecord(c.result) ? c.result : undefined;
        if (result && Array.isArray(result.content)) {
          const texts: string[] = [];
          for (const b of result.content.filter(isRecord)) {
            if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
            if (b.type === "image" && typeof b.data === "string" && !item.image) item.image = b.data;
          }
          if (texts.length) item.output = texts.join("\n");
        }
        if (isRecord(c.error) && typeof c.error.message === "string") item.output = c.error.message;
        return item;
      }
      case "dynamicToolCall":
        return {
          id: c.id,
          kind: "tool",
          status: "running",
          title: str(c.tool) ?? "Tool",
          toolName: str(c.tool),
          input: c.arguments,
        };
      case "webSearch": {
        const action = isRecord(c.action) ? c.action : undefined;
        const title =
          action?.type === "openPage" || action?.type === "findInPage"
            ? `Read ${hostOf(action.url) ?? "a web page"}`
            : str(c.query)
              ? `Searched the web for "${oneLine(String(c.query), 50)}"`
              : "Searched the web";
        return {
          id: c.id,
          kind: "web",
          status: "running",
          title,
          toolName: "web_search",
          input: { query: c.query, action },
        };
      }
      case "imageView":
        return {
          id: c.id,
          kind: "tool",
          status: "running",
          title: "Looked at an image",
          input: { path: c.path },
        };
      case "plan":
        return { id: c.id, kind: "todo", status: "running", title: "Made a plan", text: str(c.text) ?? "" };
      case "contextCompaction":
        return {
          id: c.id,
          kind: "notice",
          status: "running",
          title: "Compacted the conversation to save space",
        };
      default:
        return undefined;
    }
  }

  function finalStatus(ci: ThreadItem): Item["status"] {
    const c = ci as Record<string, unknown>;
    const st = str(c.status)?.toLowerCase();
    if (st && /(fail|declin|error|cancel)/.test(st)) return "failed";
    if (c.type === "commandExecution" && typeof c.exitCode === "number" && c.exitCode !== 0) return "failed";
    if (c.type === "mcpToolCall" && isRecord(c.error)) return "failed";
    if (c.type === "dynamicToolCall" && c.success === false) return "failed";
    return "completed";
  }

  /* ----------------------------- notifications ----------------------------- */

  function handleNotification(s: CodexSession, method: string, params: unknown) {
    if (s.stopped) return;
    const p = (isRecord(params) ? params : {}) as Record<string, unknown>;
    if (typeof p.threadId === "string" && p.threadId !== s.threadId) return;
    const turnId = s.active?.turnId;
    switch (method) {
      case "turn/started": {
        const turn = p.turn as Turn | undefined;
        if (turn?.id) s.active?.setCodexTurnId(turn.id);
        return;
      }
      case "item/started": {
        const item = itemFromCodex(p.item as ThreadItem);
        if (!item) return;
        s.items.set(item.id, item);
        s.sink.itemStarted(turnId, item);
        return;
      }
      case "item/agentMessage/delta":
        return appendDelta(s, p, "text");
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return appendDelta(s, p, "reasoning");
      case "item/commandExecution/outputDelta":
        return appendDelta(s, p, "command_output");
      case "item/completed": {
        const ci = p.item as ThreadItem;
        const item = itemFromCodex(ci);
        if (!item) return;
        const prev = s.items.get(item.id);
        s.items.delete(item.id);
        const text = item.text || prev?.text;
        const output = item.output ?? prev?.output;
        s.sink.itemCompleted(turnId, {
          ...item,
          status: finalStatus(ci),
          ...(text ? { text } : {}),
          ...(output ? { output } : {}),
        });
        return;
      }
      case "turn/plan/updated": {
        if (!s.active) return;
        const steps = Array.isArray(p.plan) ? p.plan.filter(isRecord) : [];
        const todos = steps.map((st) => ({
          text: str(st.step) ?? "Step",
          status:
            st.status === "completed"
              ? ("completed" as const)
              : st.status === "inProgress"
                ? ("in_progress" as const)
                : ("pending" as const),
        }));
        const first = !s.active.planItemId;
        s.active.planItemId ??= newItemId("plan");
        const item: Item = {
          id: s.active.planItemId,
          kind: "todo",
          status: "running",
          title: "Updated the plan",
          todos,
          ...(str(p.explanation) ? { text: String(p.explanation) } : {}),
        };
        s.items.set(item.id, item);
        if (first) s.sink.itemStarted(turnId, item);
        else s.sink.itemUpdated(turnId, item);
        return;
      }
      case "thread/tokenUsage/updated": {
        const tu = isRecord(p.tokenUsage) ? p.tokenUsage : undefined;
        if (s.active && tu && isRecord(tu.last)) s.active.usage = tu.last as unknown as TokenUsageBreakdown;
        return;
      }
      case "turn/completed": {
        const turn = p.turn as Turn | undefined;
        if (!s.active) return;
        // Mark the open plan item as completed with the rest.
        const status =
          turn?.status === "interrupted" || s.active.interrupted
            ? "interrupted"
            : turn?.status === "failed"
              ? "failed"
              : "completed";
        if (status === "failed" && isAuthError(turn?.error)) reportAuthFailure(s);
        completeTurn(
          s,
          status,
          status === "failed"
            ? s.active.authFailed
              ? SIGN_IN_EXPIRED.codex
              : turn?.error?.message
            : undefined,
        );
        return;
      }
      case "error": {
        const e = isRecord(p.error) ? p.error : {};
        const info = e.codexErrorInfo;
        if (info === "usageLimitExceeded" || info === "rateLimitExceeded") {
          s.sink.rateLimit({ status: "limited", message: str(e.message) ?? "ChatGPT usage limit reached." });
        }
        if (p.willRetry === true) return;
        if (isAuthError(e)) reportAuthFailure(s);
        else s.sink.error(str(e.message) ?? "Codex error");
        return;
      }
      case "account/rateLimits/updated": {
        const rl = p.rateLimits as RateLimitSnapshot | undefined;
        if (!rl) return;
        const w = [rl.primary, rl.secondary].filter((x): x is NonNullable<typeof x> => !!x);
        const worst = w.sort((a, b) => b.usedPercent - a.usedPercent)[0];
        const limited = !!rl.rateLimitReachedType || (worst?.usedPercent ?? 0) >= 100;
        const status = limited ? "limited" : (worst?.usedPercent ?? 0) >= 80 ? "warning" : "ok";
        const resetsAt = epochMs(worst?.resetsAt ?? undefined);
        s.sink.rateLimit({
          status,
          ...(worst ? { utilization: worst.usedPercent / 100 } : {}),
          ...(resetsAt ? { resetsAt } : {}),
          ...(status !== "ok"
            ? { message: limited ? "ChatGPT usage limit reached." : "ChatGPT usage limit almost reached." }
            : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  function appendDelta(
    s: CodexSession,
    p: Record<string, unknown>,
    stream: "text" | "reasoning" | "command_output",
  ) {
    const itemId = str(p.itemId);
    const delta = typeof p.delta === "string" ? p.delta : "";
    if (!itemId || !delta) return;
    const item = s.items.get(itemId);
    if (item) {
      if (stream === "command_output") item.output = (item.output ?? "") + delta;
      else item.text = (item.text ?? "") + delta;
    }
    s.sink.delta(s.active?.turnId, itemId, stream, delta);
  }

  /* ---------------------------- server requests ---------------------------- */

  async function ask(
    s: CodexSession,
    request: Omit<Parameters<EventSink["requestOpened"]>[1], "requestId">,
  ): Promise<RespondInput> {
    const requestId = newItemId("req");
    const d = deferred<RespondInput>();
    s.pending.set(requestId, { resolve: d.resolve });
    s.sink.requestOpened(s.active?.turnId, { requestId, ...request });
    s.sink.state("waiting");
    const r = await d.promise;
    s.pending.delete(requestId);
    if (s.stopped) return r;
    s.sink.send({ type: "request.resolved", requestId, decision: r.decision });
    if (s.active) s.sink.state("running");
    return r;
  }

  async function handleServerRequest(s: CodexSession, method: string, params: unknown): Promise<unknown> {
    if (s.stopped) throw new Error("Session stopped.");
    const p = (isRecord(params) ? params : {}) as Record<string, unknown>;
    const autoApprove = s.runtimeMode !== "approval-required";
    switch (method) {
      case "item/commandExecution/requestApproval": {
        if (autoApprove) return { decision: "accept" };
        const r = await ask(s, {
          kind: "tool_approval",
          toolName: "shell",
          title: commandTitle(p.command).replace(/^Ran/, "Run"),
          ...(str(p.reason) ? { detail: String(p.reason) } : {}),
          input: { command: p.command, cwd: p.cwd },
        });
        return {
          decision:
            r.decision === "allow" ? "accept" : r.decision === "allowAlways" ? "acceptForSession" : "decline",
        };
      }
      case "item/fileChange/requestApproval": {
        if (autoApprove) return { decision: "accept" };
        const item = s.items.get(String(p.itemId));
        const r = await ask(s, {
          kind: "tool_approval",
          toolName: "apply_patch",
          title:
            item?.title
              ?.replace(/^Edited/, "Edit")
              .replace(/^Created/, "Create")
              .replace(/^Deleted/, "Delete") ?? "Change files",
          ...(str(p.reason) ? { detail: String(p.reason) } : {}),
          input: item?.input,
        });
        return {
          decision:
            r.decision === "allow" ? "accept" : r.decision === "allowAlways" ? "acceptForSession" : "decline",
        };
      }
      case "item/permissions/requestApproval": {
        const grant = { permissions: p.permissions ?? {}, scope: "turn" };
        if (autoApprove) return grant;
        const r = await ask(s, {
          kind: "tool_approval",
          title: "Allow extra permissions",
          ...(str(p.reason) ? { detail: String(p.reason) } : {}),
          input: p.permissions,
        });
        if (r.decision === "deny") return { permissions: {}, scope: "turn" };
        return { ...grant, scope: r.decision === "allowAlways" ? "session" : "turn" };
      }
      case "item/tool/requestUserInput": {
        const qs = (Array.isArray(p.questions) ? p.questions : []) as ToolRequestUserInputQuestion[];
        const r = await ask(s, {
          kind: "user_input",
          title: qs[0]?.question ? oneLine(qs[0].question, 120) : "A question for you",
          questions: qs.map((q) => ({
            question: q.question,
            ...(q.header ? { header: q.header } : {}),
            options: (q.options ?? []).map((o) => ({
              label: o.label,
              ...(o.description ? { description: o.description } : {}),
            })),
            multiSelect: false,
          })),
        });
        const answers: Record<string, { answers: string[] }> = {};
        if (r.decision !== "deny" && r.answers) {
          for (const q of qs) {
            const a = r.answers[q.question] ?? r.answers[q.id];
            if (a !== undefined) answers[q.id] = { answers: [a] };
          }
        }
        return { answers };
      }
      case "mcpServer/elicitation/request": {
        // Codex asks before MCP tool calls under on-request approval; Yo's own tools must run in auto mode.
        const accept = { action: "accept", content: {}, _meta: null };
        if (autoApprove) return accept;
        const server = str(p.serverName);
        const r = await ask(s, {
          kind: "tool_approval",
          title: str(p.message) ? oneLine(String(p.message), 120) : `Use a ${server ?? "tool"} action`,
          ...(server ? { toolName: server } : {}),
          input: p._meta,
        });
        return r.decision === "deny" ? { action: "decline", content: null, _meta: null } : accept;
      }
      case "execCommandApproval":
      case "applyPatchApproval": {
        if (autoApprove) return { decision: "approved" };
        const r = await ask(s, {
          kind: "tool_approval",
          title:
            method === "execCommandApproval"
              ? commandTitle(p.command).replace(/^Ran/, "Run")
              : "Change files",
          input: p,
        });
        return {
          decision:
            r.decision === "allow"
              ? "approved"
              : r.decision === "allowAlways"
                ? "approved_for_session"
                : { denied: { rejection: r.message ?? "Denied by the user." } },
        };
      }
      default:
        throw new Error(`Yo does not support ${method}`);
    }
  }

  return adapter;
}

export const createCodexAdapterFactory: (options?: CodexAdapterOptions) => AdapterFactory =
  (options) => (deps) =>
    createCodexAdapter(deps, options);
