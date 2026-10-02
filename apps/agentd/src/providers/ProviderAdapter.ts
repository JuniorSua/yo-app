/**
 * Provider adapter interface (runs inside the yo-computer container).
 * Pattern adapted from T3 Code's ProviderAdapter (MIT).
 *
 * One adapter instance per provider kind. It manages many sessions, keyed by `sessionKey`.
 * Sessions must be isolated per account: each account has its own config dir
 * (CLAUDE_CONFIG_DIR / CODEX_HOME / GROK home) under /data/accounts/<provider>/<accountId>.
 */
import type {
  AccountSecrets,
  AuthStatus,
  Decision,
  InputPart,
  ModelInfo,
  ProviderEvent,
  ProviderKind,
  ResumeCursor,
  RuntimeMode,
} from "@yo/contracts";

export interface AccountContext {
  accountId: string;
  provider: ProviderKind;
  /** Per-account home for provider state, e.g. /data/accounts/claude/acc_123 */
  configDir: string;
  secrets: AccountSecrets;
}

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SessionStartInput {
  sessionKey: string;
  agentId: string;
  account: AccountContext;
  model?: string;
  effort?: string;
  runtimeMode: RuntimeMode;
  systemAppend: string;
  resumeCursor?: ResumeCursor;
  /** The agent's home/work directory, e.g. /home/agent/agents/<agentId> */
  cwd: string;
  /** Environment for the agent's display: DISPLAY=:N etc. */
  env: Record<string, string>;
  /** MCP servers to attach: "yo" (yo-mcp shim), "browser" (playwright over CDP), "desktop". */
  mcpServers: McpServerSpec[];
}

export interface RespondInput {
  requestId: string;
  decision: Decision;
  answers?: Record<string, string>;
  message?: string;
}

export type EmitFn = (sessionKey: string, event: ProviderEvent) => void;

export interface LoginCallbacks {
  prompt(p: { url?: string; userCode?: string; needsInput: boolean; message?: string }): void;
  result(r: { ok: boolean; message?: string; secrets?: AccountSecrets }): void;
}

export interface LoginHandle {
  input(text: string): void;
  cancel(): void;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  /** CLI version string, or null if not installed. */
  version(): Promise<string | null>;
  /** Cheap auth check. Must NOT start interactive login or spend model tokens. */
  probe(account: AccountContext): Promise<AuthStatus>;
  listModels(account: AccountContext): Promise<ModelInfo[]>;
  login(account: AccountContext, cb: LoginCallbacks): Promise<LoginHandle>;
  logout?(account: AccountContext): Promise<void>;

  startSession(input: SessionStartInput): Promise<{ resumed: boolean }>;
  sendTurn(sessionKey: string, turnId: string, input: InputPart[]): Promise<void>;
  interrupt(sessionKey: string): Promise<void>;
  respond(sessionKey: string, input: RespondInput): Promise<void>;
  setSession?(sessionKey: string, patch: { model?: string; runtimeMode?: RuntimeMode }): Promise<void>;
  stopSession(sessionKey: string): Promise<void>;
  hasSession(sessionKey: string): boolean;
  /** Stop everything (process shutdown). */
  dispose(): Promise<void>;
}

export type AdapterFactory = (deps: { emit: EmitFn; log: (msg: string) => void }) => ProviderAdapter;
