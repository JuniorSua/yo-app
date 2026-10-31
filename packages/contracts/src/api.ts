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
import type { BrowserApiMethods } from "./browser";
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
  LedgerTask,
  Memory,
  Routine,
  Settings,
  TimelineEntry,
} from "./domain";
import type { Decision, ProviderKind, RuntimeMode } from "./events";
import type { OnePasswordApiMethods, OnePasswordStatus } from "./onePassword";
import type { SetupApiMethods } from "./setup";
import type { Space } from "./spaces";

export const CORE_PORT = 7777;

export interface Bootstrap {
  version: string;
  settings: Settings;
  agents: AgentView[];
  accounts: Account[];
  computer: ComputerOverview;
  /** Paired devices + grants. Absent from older cores. */
  execution?: ExecutionStatus;
  /** 0.1.x public builds: their subscription check. Yo 2 cores never send it (no check). */
  license?: LicenseState;
}

/**
 * Whether this Yo may work. 0.1.x public builds needed a paid subscription. Yo 2 is free: its core answers every
 * `license.*` call with `{ required: false, active: true }`, so an older app never locks.
 */
export interface LicenseState {
  /** False: this build never asks (and `active` is true). */
  required: boolean;
  active: boolean;
  /** "yo_…k3Lp", the end of the stored key. */
  keyHint?: string;
  /** Stripe's word for the subscription: active, past_due, canceled... */
  subscription?: string;
  /** Epoch ms: when Yo must check again at the latest (works offline until then). */
  expiresAt?: number;
  /** Epoch ms of the next payment, or when a cancelled subscription ends. */
  renewsAt?: number;
  endsAt?: number;
  /** Why Yo is locked, from the last check. */
  reason?: string;
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
  /**
   * agent.create only: the new teammate starts at once with its first turn: it introduces itself and asks the
   * user one question about its job. Ignored by older cores.
   */
  introduce?: boolean;
}

export interface Attachment {
  name: string;
  mediaType: string;
  /** base64 */
  data: string;
}

/** One of the user's messages waiting for the running task to finish. */
export interface QueuedRequest {
  id: string;
  text: string;
  /** How many files or pictures come with it. */
  attachments: number;
  createdAt: number;
}

/** Title of a user message that was sent into a running task (queue.steer); the chat marks it. */
export const STEERED_TITLE = "Sent mid-task";

export interface QueueSteerResult {
  /** true: it went into the running task now. false: it's first in line instead (see `note`). */
  steered: boolean;
  note?: string;
  items: QueuedRequest[];
}

/** `setup.*`: the first agent's computer setup (./setup.ts). */
export interface WorkspaceSearchResult {
  kind: "message" | "memory" | "routine" | "file";
  id: string;
  agentId: string | null;
  title: string;
  snippet: string;
  updatedAt: number;
}

export interface ApiMethods
  extends SetupApiMethods,
    PhoneApiMethods,
    OnePasswordApiMethods,
    BrowserApiMethods {
  "workspace.search": { params: { query: string; limit?: number }; result: WorkspaceSearchResult[] };
  "timeline.around": { params: { agentId: string; entryId: string }; result: TimelineEntry[] };
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

  /**
   * Fold agents into the main one. Plan = who would move and what; consolidate = do it (idempotent and
   * resumable: run it again and it finishes what's left). Yo 2 keeps teammates: the plan is always empty.
   */
  "team.consolidatePlan": { params: Record<string, never>; result: ConsolidationPlan };
  "team.consolidate": { params: { agentIds: string[] }; result: ConsolidationResult };

  "timeline.list": { params: { agentId: string; before?: number; limit?: number }; result: TimelineEntry[] };

  "chat.send": {
    params: { agentId: string; text: string; attachments?: Attachment[]; route?: RoutePreference };
    /** `turnId` "queued": it waits behind the running task as `queuedId` (see queue.*). */
    result: { turnId: string; queuedId?: string };
  };
  "chat.interrupt": { params: { agentId: string }; result: { ok: true } };

  /**
   * The user's own messages waiting for the running task to finish ("Up next"). Teammates' notes, helper
   * reports, team checks and routines wait in the same line but are never listed or editable here.
   */
  "queue.list": { params: { agentId: string }; result: QueuedRequest[] };
  "queue.update": { params: { agentId: string; id: string; text: string }; result: QueuedRequest[] };
  "queue.remove": { params: { agentId: string; id: string }; result: QueuedRequest[] };
  /** New order of the user's queued messages (ids left out keep their order, after the listed ones). */
  "queue.reorder": { params: { agentId: string; ids: string[] }; result: QueuedRequest[] };
  /**
   * Send a queued message into the running task now, so it adjusts as it works. When that isn't possible
   * (the model can't take messages mid-task, the task is still starting...) the message moves to the front of
   * the line instead, and `note` says why in plain words.
   */
  "queue.steer": { params: { agentId: string; id: string }; result: QueueSteerResult };

  "request.respond": {
    params: {
      agentId: string;
      requestId: string;
      decision: Decision;
      answers?: Record<string, string>;
      message?: string;
      /**
       * A secure form's values, one per field, in order. Core types them into the page and forgets them: they
       * are never stored, logged or sent anywhere else.
       */
      secureValues?: string[];
    };
    result: { ok: true };
  };

  "account.list": { params: Record<string, never>; result: Account[] };
  "account.add": { params: { provider: ProviderKind; label?: string }; result: Account };
  "account.remove": { params: { id: string }; result: { ok: true } };
  "account.refresh": { params: { id: string }; result: Account };
  "account.setDefault": { params: { id: string }; result: { ok: true } };
  /**
   * Sign in on Yo's computer. `method: "code"`: ChatGPT with a one-time code (device code) instead of its sign-in
   * page; the other providers have one way each and ignore it.
   */
  "account.login.start": {
    params: { id: string; restart?: boolean; method?: "code" };
    result: { ok: true };
  };
  "account.login.input": { params: { id: string; input: string }; result: { ok: true } };
  "account.login.cancel": { params: { id: string }; result: { ok: true } };
  "account.setApiKey": { params: { id: string; key: string }; result: Account };
  /**
   * "Connect your model" walkthrough (works before Yo's computer exists). What core can see on the machine
   * it runs on: which CLIs are installed and signed in. Never reads or returns their secrets.
   */
  "connect.detect": { params: Record<string, never>; result: ConnectDetection };
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
  /** `space`: which space's agents see it (null or absent = Everywhere). */
  "memory.add": {
    params: { content: string; agentId?: string | null; space?: Space | null };
    result: Memory;
  };
  /** `space` absent = unchanged; null = Everywhere. */
  "memory.update": { params: { id: string; content: string; space?: Space | null }; result: Memory };
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
  /**
   * The Tasks page: the active space's main agent's ledger tasks. Resolved (done) tasks from the last 7 days are
   * included; cancelled, interrupted and hidden ones are not.
   */
  "tasks.list": { params: { agentId?: string }; result: LedgerTask[] };
  /** The + button: a task the user adds. `start` sends it to Yo now; otherwise it's saved for Up next. */
  "tasks.create": { params: { title: string; note?: string; start: boolean }; result: LedgerTask };
  /** Start a suggestion or a saved task: Yo gets its prompt as the user's message and it moves to Working. */
  "tasks.start": { params: { id: string }; result: LedgerTask };
  /** Check off (done), hide a suggestion (hidden), or reopen (open). */
  "tasks.update": { params: { id: string; status: "done" | "hidden" | "open" }; result: LedgerTask };
  /**
   * Chat opened: post the morning brief if it's on, today's hasn't been posted yet, and it isn't the user's first
   * day. `posted` = this call started it (so only one tab or device ever does).
   */
  "brief.claim": { params: { localDate: string }; result: { posted: boolean } };
  /** Pin a file to the top of Your files, or unpin it. */
  "artifact.pin": { params: { id: string; pinned: boolean }; result: Artifact };
  /** Where submitted bug reports go. The GitHub token is write-only: core never returns it. */
  "bugReports.status": { params: Record<string, never>; result: BugReportFiling };
  /** Set or clear (`null`) the GitHub token and/or the repo ("owner/name"; `null` = the default). */
  "bugReports.configure": {
    params: { token?: string | null; repo?: string | null };
    result: BugReportFiling;
  };
  /** Exactly what "Send" would send: the bundle's files and its report.md. Nothing leaves the machine. */
  "bugReports.preview": { params: BugReportSend; result: BugReportPreview };
  /** Send a report the user just approved (Settings form, or the red draft card) to the bug mailbox. */
  "bugReports.send": { params: BugReportSend; result: BugReportSent };

  /** Kept for 0.1.x apps. Yo 2 is free: all four answer `{ required: false, active: true }`. */
  "license.status": { params: Record<string, never>; result: LicenseState };
  "license.activate": { params: { key: string }; result: LicenseState };
  "license.refresh": { params: Record<string, never>; result: LicenseState };
  "license.deactivate": { params: Record<string, never>; result: LicenseState };

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

  /**
   * "Restart to update" for a published server update (GET /api/version → `server.pending`): asks the updater
   * on the host to apply that release now. Only the pending `rev` is accepted. Returns at once; core restarts
   * within seconds and the outcome shows up as `server.lastResult`.
   */
  "update.applyServer": { params: { rev: string }; result: { ok: true } };
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

/** Yo Phone: text Yo from any phone through an end-to-end encrypted relay (docs/phone/PROTOCOL.md). */
export interface PhoneStatus {
  /** A phone link exists, so core polls the relay. */
  enabled: boolean;
  relayUrl: string;
  /** The current phone link (it carries the key). Only signed-in controllers get it. */
  link: string | null;
  /** When the current link was made. */
  pairedAt: number | null;
  /** When a phone last sent anything (null: the link hasn't been opened yet). */
  lastPhoneAt: number | null;
  /** Short label of the phone that last said hello, e.g. "iPhone · Safari". */
  device: string | null;
  /** Core is polling the relay right now. */
  polling: boolean;
  lastError: string | null;
  /** The relay's register key is saved (it's never returned). Without it, no new link can be made. */
  registerKeySet: boolean;
  /** Wiping an old link's mailbox failed and is being retried. */
  revokePending: boolean;
}

/**
 * `channels.phone.*`. Part of ApiMethods too (Settings → Phone calls them, so the web mock answers them), and of
 * ChannelApiMethods so core's PhoneChannel can type its handlers like TelegramChannel.
 */
export interface PhoneApiMethods {
  "channels.phone.status": { params: Record<string, never>; result: PhoneStatus };
  /** Make a new phone link (revoking the old one) and start polling. */
  "channels.phone.pair": { params: Record<string, never>; result: { link: string } };
  /**
   * Change the relay (relayUrl null or "": back to the default), or save the relay's register key (null: forget
   * it). The key is write-only.
   */
  "channels.phone.configure": {
    params: { relayUrl?: string | null; registerKey?: string | null };
    result: PhoneStatus;
  };
  /** Delete the link's secret and stop polling. */
  "channels.phone.off": { params: Record<string, never>; result: PhoneStatus };
}

/**
 * Owner-only methods served on the same WS API but with no UI yet (called by the maintainer's ops script).
 * Kept out of ApiMethods so clients that implement every method (the web mock) don't have to.
 */
export interface TelegramApiMethods {
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

/**
 * Every `channels.*` method core serves. The phone ones are in ApiMethods too (Settings → Phone uses them, so the
 * web mock answers them); the Telegram ones aren't.
 */
export interface ChannelApiMethods extends TelegramApiMethods, PhoneApiMethods {}

export interface ConsolidationCandidate {
  id: string;
  name: string;
  role: string;
  memories: number;
  routines: number;
}

export interface ConsolidationPlan {
  primaryId: string | null;
  /**
   * Active agents that would move into the main one. Left out: the main agent, helpers, and agents the owner
   * hands over by hand (settings.consolidateSkip).
   */
  agents: ConsolidationCandidate[];
}

export interface ConsolidationAgentResult {
  agentId: string;
  name: string;
  /** done: moved and archived. pending: something is left (see `error`), the agent keeps working. skipped: not moved. */
  status: "done" | "pending" | "skipped";
  memories: number;
  routines: number;
  /** Files copied into ~/Shared/<dir>/ (null: not copied yet). */
  files: { dir: string; copied: number; skipped: number; failed: number } | null;
  error?: string;
}

export interface ConsolidationResult {
  primaryId: string;
  agents: ConsolidationAgentResult[];
}

export interface HostCli {
  /** The CLI was found on PATH or in a usual install folder. */
  installed: boolean;
  /** Signed in with the user's own login on this machine (null: couldn't tell). Detected, never read. */
  signedIn: boolean | null;
}

export interface ConnectDetection {
  /** The machine core runs on (Yo's computer runs next to it on a home server or the PC edition). */
  host: { platform: string; name: string };
  claude: HostCli;
  codex: HostCli;
}

/** A report the user sends themselves: a chat draft (`draftId`) or the Settings form (`report`). */
export interface BugReportSend {
  draftId?: string;
  report?: { what_happened: string; expected?: string; steps?: string[]; title?: string };
  /** Whose recent chat goes with it (the form); a draft uses its own conversation. Default: the main agent. */
  agentId?: string;
  /** "Include recent chat": the last ~30 items of that conversation, redacted. */
  includeChat: boolean;
}

export interface BugReportPreview {
  title: string;
  /** The bundle's files, uncompressed sizes. */
  files: { name: string; bytes: number }[];
  reportMd: string;
}

export interface BugReportSent {
  /** sent: in the bug mailbox. pending: saved, Yo retries. filed: on GitHub with the owner's token. failed: use the link. */
  status: "sent" | "pending" | "filed" | "failed";
  artifactId: string;
  reportId?: string;
  issueNumber?: number;
  /** The prefilled GitHub link, when nothing else worked. */
  fallbackUrl?: string;
}

export interface BugReportFiling {
  /** Reports go, encrypted, to the owner's Yo through the bug mailbox (no account needed). False only with no relay. */
  inbox?: boolean;
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

/** Plain HTTP endpoints outside the WS API: GET /auth/info answers AuthInfo (./browser.ts). */

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
  /** The user's queued messages for an agent changed (added, edited, moved, removed, steered or started). */
  "queue.updated": { agentId: string; items: QueuedRequest[] };
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
  /** A ledger task was added or changed (the Tasks page and the suggestion above the message box). */
  "task.updated": LedgerTask;
  "settings.updated": Settings;
  "license.updated": LicenseState;
  "onePassword.updated": OnePasswordStatus;
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
