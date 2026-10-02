/**
 * yo-core <-> agentd WebSocket protocol.
 *
 * Transport: one WebSocket at ws://<agentd>/control, `Authorization: Bearer <token>`.
 * Every frame is JSON. Requests carry `id`; agentd answers with `{type:"ok"|"err", re:id}`.
 * Pushes from agentd have no `id`. Session events carry a per-session monotonically increasing `seq`,
 * and agentd keeps a ring buffer so yo-core can resume after a reconnect (hello.resume).
 *
 * Other agentd HTTP endpoints (same bearer auth):
 *   GET  /healthz                         -> 200 "ok" (no auth)
 *   WS   /vnc/:agentId                    -> raw RFB bytes bridged to that display's x11vnc (loopback)
 *   GET  /screenshot/:agentId             -> image/png of the agent's display
 *   GET  /files/:agentId?path=...         -> raw file download from the agent's home
 */
import { z } from "zod";
import { Decision, InputPart, ProviderEvent, ProviderKind, ResumeCursor, RuntimeMode } from "./events";

export const PROTOCOL_VERSION = 1;
export const AGENTD_PORT = 7801;

export const ComputerState = z.enum(["off", "booting", "ready", "hibernated", "error"]);
export type ComputerState = z.infer<typeof ComputerState>;

export const LeaseHolder = z.enum(["agent", "user"]);
export type LeaseHolder = z.infer<typeof LeaseHolder>;

export const AuthStatus = z.object({
  accountId: z.string(),
  provider: ProviderKind,
  status: z.enum(["authenticated", "unauthenticated", "unknown", "error", "not_installed"]),
  email: z.string().optional(),
  plan: z.string().optional(),
  label: z.string().optional(),
  message: z.string().optional(),
  cliVersion: z.string().optional(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

export const ModelInfo = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  efforts: z.array(z.string()).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const AccountSecrets = z.object({
  /** Claude: long-lived token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN). */
  claudeOauthToken: z.string().optional(),
  /**
   * Codex: a dedicated ChatGPT login made for Yo on the user's machine (`auth.json` from the "Connect your
   * model" walkthrough). agentd seeds the account's CODEX_HOME with it once; after that Codex refreshes its
   * own copy and this one is never written over it again (ChatGPT refresh tokens rotate).
   */
  codexAuthJson: z.string().optional(),
  /** Optional API key fallbacks. */
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  xaiApiKey: z.string().optional(),
});
export type AccountSecrets = z.infer<typeof AccountSecrets>;

export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "dir"]),
  size: z.number(),
  mtime: z.number(),
});
export type FsEntry = z.infer<typeof FsEntry>;

/* ----------------------------- core -> agentd ----------------------------- */

const req = <K extends string, T extends z.ZodRawShape>(type: K, shape: T) =>
  z.object({ id: z.string(), type: z.literal(type), ...shape });

export const AgentdRequest = z.discriminatedUnion("type", [
  req("hello", {
    token: z.string(),
    coreVersion: z.string(),
    resume: z.array(z.object({ sessionKey: z.string(), lastSeq: z.number() })).default([]),
  }),
  req("computer.ensure", { agentId: z.string() }),
  req("computer.hibernate", { agentId: z.string() }),
  req("computer.lease", { agentId: z.string(), holder: LeaseHolder }),
  req("computer.status", {}),
  req("account.configure", { accountId: z.string(), provider: ProviderKind, secrets: AccountSecrets }),
  req("account.remove", { accountId: z.string(), provider: ProviderKind }),
  req("auth.probe", { accountId: z.string(), provider: ProviderKind }),
  req("auth.login.start", {
    accountId: z.string(),
    provider: ProviderKind,
    method: z.enum(["claude-setup-token", "codex-device-code", "grok-login"]),
  }),
  req("auth.login.input", { accountId: z.string(), input: z.string() }),
  req("auth.login.cancel", { accountId: z.string() }),
  req("models.list", { accountId: z.string(), provider: ProviderKind }),
  req("session.start", {
    sessionKey: z.string(),
    agentId: z.string(),
    accountId: z.string(),
    provider: ProviderKind,
    model: z.string().optional(),
    effort: z.string().optional(),
    runtimeMode: RuntimeMode,
    /** Persona + memory + scratchpad + recent context; appended to the provider's system prompt. */
    systemAppend: z.string(),
    resumeCursor: ResumeCursor.optional(),
  }),
  req("session.set", {
    sessionKey: z.string(),
    model: z.string().optional(),
    runtimeMode: RuntimeMode.optional(),
  }),
  req("session.stop", { sessionKey: z.string() }),
  req("turn.send", { sessionKey: z.string(), turnId: z.string(), input: z.array(InputPart) }),
  req("turn.interrupt", { sessionKey: z.string() }),
  req("request.respond", {
    sessionKey: z.string(),
    requestId: z.string(),
    decision: Decision,
    /** For user_input requests: question -> answer text. */
    answers: z.record(z.string(), z.string()).optional(),
    message: z.string().optional(),
  }),
  req("tool.result", { callId: z.string(), ok: z.boolean(), text: z.string() }),
  req("pty.open", {
    ptyId: z.string(),
    agentId: z.string(),
    cols: z.number(),
    rows: z.number(),
  }),
  req("pty.input", { ptyId: z.string(), data: z.string() }),
  req("pty.resize", { ptyId: z.string(), cols: z.number(), rows: z.number() }),
  req("pty.close", { ptyId: z.string() }),
  req("fs.list", { agentId: z.string(), path: z.string() }),
  /** Save a file the user shared from their Mac into the agent's home (~/from-mac/...). */
  req("fs.write", {
    agentId: z.string(),
    dir: z.literal("from-mac"),
    name: z.string().max(255),
    dataBase64: z.string(),
  }),
]);
export type AgentdRequest = z.infer<typeof AgentdRequest>;
export type AgentdRequestType = AgentdRequest["type"];

/** Response payloads keyed by request type. */
export interface AgentdResponses {
  hello: {
    agentdVersion: string;
    providers: { kind: ProviderKind; version: string | null }[];
    /** Provider sessions still alive in this agentd (absent from older agentd versions). */
    liveSessions?: string[];
  };
  "computer.ensure": { state: ComputerState; display: number };
  "computer.hibernate": Record<string, never>;
  "computer.lease": Record<string, never>;
  "computer.status": {
    agents: { agentId: string; state: ComputerState; display: number; lease: LeaseHolder }[];
    memMB: number;
    memLimitMB: number;
  };
  "account.configure": Record<string, never>;
  "account.remove": Record<string, never>;
  "auth.probe": AuthStatus;
  "auth.login.start": Record<string, never>;
  "auth.login.input": Record<string, never>;
  "auth.login.cancel": Record<string, never>;
  "models.list": { models: ModelInfo[] };
  "session.start": { resumed: boolean };
  "session.set": Record<string, never>;
  "session.stop": Record<string, never>;
  "turn.send": Record<string, never>;
  "turn.interrupt": Record<string, never>;
  "request.respond": Record<string, never>;
  "tool.result": Record<string, never>;
  "pty.open": Record<string, never>;
  "pty.input": Record<string, never>;
  "pty.resize": Record<string, never>;
  "pty.close": Record<string, never>;
  "fs.list": { entries: FsEntry[] };
  "fs.write": { path: string };
}

export type AgentdReply =
  | { type: "ok"; re: string; data: unknown }
  | { type: "err"; re: string; error: string; code?: string };

/* ----------------------------- agentd -> core ----------------------------- */

export const AgentdPush = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), sessionKey: z.string(), seq: z.number(), event: ProviderEvent }),
  z.object({
    type: z.literal("tool.call"),
    callId: z.string(),
    agentId: z.string(),
    sessionKey: z.string().optional(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("computer.state"),
    agentId: z.string(),
    state: ComputerState,
    lease: LeaseHolder.optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal("auth.login.prompt"),
    accountId: z.string(),
    /** URL the user must open in their own browser. */
    url: z.string().optional(),
    /** Device code to show the user (Codex device flow). */
    userCode: z.string().optional(),
    /** Whether the flow expects the user to paste a code back (Claude setup-token). */
    needsInput: z.boolean().default(false),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal("auth.login.result"),
    accountId: z.string(),
    ok: z.boolean(),
    message: z.string().optional(),
    /** Claude setup-token: the captured long-lived token, to be stored by core in the Keychain. */
    secrets: AccountSecrets.optional(),
  }),
  z.object({ type: z.literal("pty.data"), ptyId: z.string(), data: z.string() }),
  z.object({ type: z.literal("pty.exit"), ptyId: z.string(), code: z.number().nullable() }),
  z.object({
    type: z.literal("metrics"),
    memMB: z.number(),
    memLimitMB: z.number(),
    cpuPct: z.number().optional(),
  }),
  z.object({
    type: z.literal("log"),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string(),
  }),
]);
export type AgentdPush = z.infer<typeof AgentdPush>;

export type AgentdFrame = AgentdReply | AgentdPush;
