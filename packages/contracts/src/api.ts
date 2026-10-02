/**
 * Web UI <-> yo-core protocol.
 *
 * Transport: WebSocket at ws://127.0.0.1:7777/ws (same origin as the UI).
 *   client -> server: { id, method, params }
 *   server -> client: { id, result } | { id, error }  and pushes { push: <channel>, data }
 *
 * HTTP (same origin):
 *   GET  /api/vnc/:agentId          (WS upgrade) -> proxied RFB stream for noVNC
 *   GET  /api/screenshot/:agentId   -> latest PNG of the agent's screen
 *   GET  /api/artifacts/:id         -> artifact download
 *   GET  /api/pty/:ptyId            (WS upgrade) -> terminal stream
 */
import type { ModelInfo } from "./agentd";
import type {
  DeviceGrant,
  DeviceOperation,
  ExecutionStatus,
  PairedDevice,
  RouteDecision,
  RoutePreference,
} from "./devices";
import type {
  Account,
  ActivityEvent,
  Agent,
  AgentView,
  ApprovalRule,
  Artifact,
  Avatar,
  ComputerOverview,
  Memory,
  Routine,
  Settings,
  TimelineEntry,
} from "./domain";
import type { Decision, ProviderKind, RuntimeMode } from "./events";
import type { SetupApiMethods } from "./setup";

export const CORE_PORT = 7777;

export interface Bootstrap {
  version: string;
  settings: Settings;
  agents: AgentView[];
  accounts: Account[];
  computer: ComputerOverview;
  /** Paired devices + grants. Absent from older cores. */
  execution?: ExecutionStatus;
}

export interface AgentDraft {
  name: string;
  role: string;
  instructions: string;
  avatar: Avatar;
  accountId?: string | null;
  model?: string | null;
  effort?: string | null;
  runtimeMode?: RuntimeMode;
}

export interface Attachment {
  name: string;
  mediaType: string;
  /** base64 */
  data: string;
}

/** `setup.*`: the first agent's computer setup (./setup.ts). */
export interface ApiMethods extends SetupApiMethods {
  bootstrap: { params: Record<string, never>; result: Bootstrap };

  "settings.update": { params: Partial<Settings>; result: Settings };

  "agent.create": { params: AgentDraft; result: AgentView };
  "agent.update": {
    params: { id: string; patch: Partial<AgentDraft> & { pinned?: boolean } };
    result: AgentView;
  };
  "agent.archive": { params: { id: string }; result: { ok: true } };
  "agent.markRead": { params: { id: string }; result: { ok: true } };
  "agent.newSession": { params: { id: string }; result: { ok: true } };
  /** Summarize the conversation so far and continue on a fresh, lighter session (/compact). */
  "agent.compact": { params: { id: string; focus?: string }; result: { ok: true } };

  "timeline.list": { params: { agentId: string; before?: number; limit?: number }; result: TimelineEntry[] };

  "chat.send": {
    params: { agentId: string; text: string; attachments?: Attachment[]; route?: RoutePreference };
    result: { turnId: string };
  };
  "chat.interrupt": { params: { agentId: string }; result: { ok: true } };
  "request.respond": {
    params: {
      agentId: string;
      requestId: string;
      decision: Decision;
      answers?: Record<string, string>;
      message?: string;
    };
    result: { ok: true };
  };

  "account.list": { params: Record<string, never>; result: Account[] };
  "account.add": { params: { provider: ProviderKind; label?: string }; result: Account };
  "account.remove": { params: { id: string }; result: { ok: true } };
  "account.refresh": { params: { id: string }; result: Account };
  "account.setDefault": { params: { id: string }; result: { ok: true } };
  "account.login.start": { params: { id: string; restart?: boolean }; result: { ok: true } };
  "account.login.input": { params: { id: string; input: string }; result: { ok: true } };
  "account.login.cancel": { params: { id: string }; result: { ok: true } };
  "account.setApiKey": { params: { id: string; key: string }; result: Account };
  /**
   * "Connect your model" walkthrough (works before Yo's computer exists). What core can see on the machine
   * it runs on: which CLIs are installed and signed in. Never reads or returns their secrets.
   */
  "connect.detect": { params: Record<string, never>; result: ConnectDetection };
  /** Save a token from `claude setup-token` (run by the user in Terminal). Errors are returned, not thrown. */
  "connect.claudeToken": {
    params: { token: string; accountId?: string };
    result: { ok: true; account: Account } | { ok: false; error: string };
  };
  /**
   * Import the dedicated Codex login the walkthrough asks the user to create (in CODEX_YO_HOME). Polled:
   * "waiting" until it appears, then core stores it once and removes the copy on this machine.
   */
  "connect.codexImport": {
    params: { accountId?: string };
    result:
      | { state: "waiting" }
      | { state: "connected"; account: Account }
      | { state: "error"; error: string };
  };
  "models.list": { params: { accountId: string }; result: ModelInfo[] };

  "computer.overview": { params: Record<string, never>; result: ComputerOverview };
  "computer.start": { params: Record<string, never>; result: ComputerOverview };
  "computer.stop": { params: Record<string, never>; result: ComputerOverview };
  "computer.wake": { params: { agentId: string }; result: { ok: true } };
  "computer.takeover": { params: { agentId: string }; result: { ok: true } };
  "computer.release": { params: { agentId: string; note?: string }; result: { ok: true } };
  "computer.files": {
    params: { agentId: string; path: string };
    result: { name: string; path: string; type: "file" | "dir"; size: number; mtime: number }[];
  };
  "pty.open": { params: { agentId: string; cols: number; rows: number }; result: { ptyId: string } };

  "memory.list": { params: { agentId?: string | null }; result: Memory[] };
  "memory.add": { params: { content: string; agentId?: string | null }; result: Memory };
  "memory.update": { params: { id: string; content: string }; result: Memory };
  "memory.delete": { params: { id: string }; result: { ok: true } };

  "routine.list": { params: { agentId?: string }; result: Routine[] };
  "routine.create": {
    params: { agentId: string; name: string; prompt: string; cron?: string | null; runAt?: number | null };
    result: Routine;
  };
  "routine.update": {
    params: { id: string; patch: Partial<Pick<Routine, "name" | "prompt" | "cron" | "enabled">> };
    result: Routine;
  };
  "routine.delete": { params: { id: string }; result: { ok: true } };
  "routine.runNow": { params: { id: string }; result: { ok: true } };

  "activity.list": { params: { agentId?: string; limit?: number }; result: ActivityEvent[] };
  "approvals.pending": { params: Record<string, never>; result: TimelineEntry[] };
  "rules.list": { params: Record<string, never>; result: ApprovalRule[] };
  "rules.delete": { params: { id: string }; result: { ok: true } };
  "artifacts.list": { params: { agentId?: string }; result: Artifact[] };
  /** Where submitted bug reports go. The GitHub token is write-only: core never returns it. */
  "bugReports.status": { params: Record<string, never>; result: BugReportFiling };
  /** Set or clear (`null`) the GitHub token and/or the repo ("owner/name"; `null` = the default). */
  "bugReports.configure": {
    params: { token?: string | null; repo?: string | null };
    result: BugReportFiling;
  };

  /** Paired devices and the folders/files the user picked on them. */
  "execution.status": { params: Record<string, never>; result: ExecutionStatus };
  /** Start pairing. Only the desktop app's main process finishes it (with a native confirmation). */
  "devices.pair.start": { params: Record<string, never>; result: PairingChallenge };
  "devices.unpair": { params: { deviceId: string }; result: { ok: true } };
  "devices.rename": { params: { deviceId: string; name: string }; result: PairedDevice };
  /** Revoke from core; the device is told immediately (or on reconnect). The device can also revoke locally. */
  "grants.revoke": { params: { grantId: string }; result: { ok: true } };
  "operations.list": { params: { agentId?: string; limit?: number }; result: DeviceOperation[] };
  "routes.list": { params: { agentId: string; limit?: number }; result: RouteDecision[] };

  /** Host actions (only meaningful inside the desktop app / local mode). */
  "host.openExternal": { params: { url: string }; result: { ok: true } };
}

/** Optional Telegram channel (off until a bot token is saved). */
export interface TelegramStatus {
  /** A bot token is saved, so the channel is on. */
  configured: boolean;
  /** Core is long-polling Telegram right now. */
  polling: boolean;
  bot: { username: string; name: string } | null;
  /** The one Telegram chat allowed to talk to Yo. */
  paired: { chatId: number; name: string } | null;
  /** Where plain Telegram messages go. */
  activeAgentId: string | null;
  /** A pairing code is waiting to be used until then. */
  pairCodeExpiresAt: number | null;
  lastError: string | null;
}

/**
 * Owner-only methods served on the same WS API but with no UI yet (called by the maintainer's ops script).
 * Kept out of ApiMethods so clients that implement every method (the web mock) don't have to.
 */
export interface ChannelApiMethods {
  "channels.telegram.status": { params: Record<string, never>; result: TelegramStatus };
  /** Save (and check with getMe) a bot token from @BotFather, or turn the channel off. */
  "channels.telegram.configure": { params: { token: string } | { clear: true }; result: TelegramStatus };
  /** One-time code (10 min) the owner sends to the bot as `/pair <code>`. */
  "channels.telegram.pairCode": {
    params: Record<string, never>;
    result: { code: string; expiresAt: number; link: string | null };
  };
  "channels.telegram.unpair": { params: Record<string, never>; result: TelegramStatus };
}

export interface HostCli {
  /** The CLI was found on PATH or in a usual install folder. */
  installed: boolean;
  /** Signed in with the user's own login on this machine (null: couldn't tell). Detected, never read. */
  signedIn: boolean | null;
}

export interface ConnectDetection {
  /** The machine core runs on: Terminal commands for Codex have to run there. */
  host: { platform: string; name: string };
  claude: HostCli;
  /** `yoLogin`: the dedicated login for Yo is there, waiting to be imported. */
  codex: HostCli & { yoLogin: boolean };
}

export interface BugReportFiling {
  /** A GitHub token is stored, so submitted reports are filed as issues automatically. */
  configured: boolean;
  /** "owner/name" the reports go to. */
  repo: string;
  defaultRepo: string;
}

export interface PairingChallenge {
  challenge: string;
  expiresAt: number;
  coreId: string;
  /** Core's Ed25519 public key (SPKI DER, base64). The device pins it. */
  corePublicKey: string;
  coreLabel: string;
}

/** Plain HTTP endpoints outside the WS API (used by the desktop app's main process). */
export interface AuthInfo {
  /** Absent on cores older than controller auth. */
  protocol: 1;
  authRequired: boolean;
  enrolled: boolean;
  coreId: string;
}

export type ApiMethod = keyof ApiMethods;
export type ApiParams<M extends ApiMethod> = ApiMethods[M]["params"];
export type ApiResult<M extends ApiMethod> = ApiMethods[M]["result"];

export interface ApiRequestFrame {
  id: string;
  method: ApiMethod;
  params: unknown;
}
export type ApiResponseFrame = { id: string; result: unknown } | { id: string; error: string };

/** Server pushes. */
export interface ApiPushes {
  "agent.updated": AgentView;
  "agent.removed": { id: string };
  "timeline.upsert": TimelineEntry;
  "timeline.delta": {
    agentId: string;
    entryId: string;
    delta: string;
    stream: "text" | "reasoning" | "command_output";
  };
  "account.updated": Account;
  "account.removed": { id: string };
  "account.login": {
    accountId: string;
    phase: "prompt" | "done" | "error";
    url?: string;
    userCode?: string;
    needsInput?: boolean;
    message?: string;
  };
  "computer.updated": ComputerOverview;
  "routine.updated": Routine;
  "routine.removed": { id: string };
  "activity.new": ActivityEvent;
  "memory.updated": Memory;
  "artifact.new": Artifact;
  "settings.updated": Settings;
  "device.updated": PairedDevice;
  "grant.updated": DeviceGrant;
  "operation.updated": DeviceOperation;
  "route.decided": RouteDecision;
  notify: {
    agentId: string | null;
    title: string;
    body: string;
    kind: "done" | "needs_you" | "info" | "error";
  };
}
export type ApiPushChannel = keyof ApiPushes;
export type ApiPushFrame = { [K in ApiPushChannel]: { push: K; data: ApiPushes[K] } }[ApiPushChannel];

export type { Agent };
