import {
  type Agent,
  type AgentActivity,
  type AgentdPush,
  type AgentView,
  type Attachment,
  CheckHelpersInput,
  type ComputerState,
  CreateAgentInput,
  CreatePhoneLinkInput,
  cleanSecureValues,
  DEVICE_TOOLS,
  type Decision,
  describeWorkHours,
  type FsEntry,
  fieldList as fieldWords,
  type HelperState,
  type InputPart,
  type Item,
  isLead,
  isPublicSuffix,
  isSpecificSite,
  type LeaseHolder,
  type LedgerTask,
  MessageAgentInput,
  NO_FREE_SEAT,
  newId,
  normalizePlaybook,
  type PendingRequest,
  PHONE_TOOLS,
  type ProviderEvent,
  type QueuedRequest,
  type QueueSteerResult,
  RequestSecureInputInput,
  type RoutePreference,
  resolveSpace,
  SECURE_INPUT_TOOL,
  type SecureField,
  type SecureForm,
  STEERED_TITLE,
  StartHelperInput,
  StopHelperInput,
  secureFieldList,
  secureFillKinds,
  secureFormTitle,
  siteHost,
  type TimelineEntry,
  type TodoEntry,
  teammateAvatar,
  toolAllowed,
  type YoToolset,
} from "@yo/contracts";
import type { AgentdClient } from "../agentd/AgentdClient";
import type { Store } from "../db/store";
import type { DeviceActionRequest, DeviceToolContext, DeviceWriteRequest } from "../devices/DeviceTools";
import type { Hub } from "../hub";
import { logger } from "../log";
import {
  type FillApproval,
  ONE_PASSWORD_APPROVAL,
  ONE_PASSWORD_TOOLS,
  ruleFor as onePasswordRule,
} from "../onepassword/tools";
import { findSensitiveFor } from "../safety/sensitive";
import { focusOf } from "../team/spaces";
import {
  base64Bytes,
  formatBytes,
  isInlineText,
  isSavedAsFile,
  isZipAttachment,
  zipListing,
  zipNote,
  zipProblem,
} from "../zipUploads";
import type { AccountService } from "./AccountService";
import { helperAvatar } from "./helperAvatar";
import {
  buildHelperSystemAppend,
  buildSystemAppend,
  compactPrompt,
  helperReportNote,
  messageClock,
  openTasksLine,
  SILENT_REPLY,
  type TeamMember,
  teamCheckNote,
  teammateIntro,
  teammateNote,
  teamNewsLine,
} from "./PromptBuilder";
import {
  missingFields,
  onSite,
  pageHostOf,
  SECURE_FILL_FAILED_OUTPUT,
  SECURE_SUBMITTED,
  scrubSecrets,
  secureFillError,
  secureFillResult,
  secureSites,
} from "./secureForm";

const log = logger("orchestrator");

/** The one Yo tool whose card is an exact-action approval for a change on the user's Mac. */
const DEVICE_WRITE_TOOL = "mac_write_file";
/** Cards whose answer is the bare decision ("allow" | "deny" | "expired") for the code that asked. */
const DECISION_CARDS = new Set([DEVICE_WRITE_TOOL, ONE_PASSWORD_APPROVAL]);

/** Rotate a native session after this many turns or this age, seeding the new one from Yo's history. */
const MAX_TURNS_PER_SESSION = 80;
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
/** Auto-compact (summary + fresh session) once a conversation gets this heavy, so each turn stays light. */
const AUTO_COMPACT_TOKENS = 100_000;
const AUTO_COMPACT_TURNS = 60;
/** A card waiting on the user (question, approval, take over) holds a task this long, then the agent wraps up. */
const USER_WAIT_MS = 15 * 60 * 1000;
/** A task is stopped after this long, so an agent never runs for hours (the user can say "continue"). */
const MAX_TURN_MS = 60 * 60 * 1000;
/** While an agent waits for a free screen: how often it asks again even if nothing it watches changed. */
const SEAT_RETRY_MS = 5000;
/**
 * A running task with no sign of life from the model for this long has frozen (a browser script that never
 * returns, say) and is stopped, unless it's waiting on the user or a teammate (those waits have their own limits).
 */
const STUCK_TURN_MS = 10 * 60 * 1000;
/** message_agent with wait: how long the asker waits for a reply before carrying on (the reply follows later). */
const AGENT_REPLY_WAIT_MS = 30 * 60 * 1000;
/** Longest teammate reply handed back to the asker (message_agent). */
const MAX_TEAMMATE_REPLY = 12_000;
/** Agent-to-agent messages in a row before Yo stops the chain (agents could otherwise talk forever). */
const MAX_AGENT_HOPS = 6;
/**
 * Team checks: the lead agent (the primary) is told when a teammate's task runs into trouble, so it can
 * check in. A teammate is "failing" after this many failed steps in a row, spread over at least
 * OVERSIGHT_FAIL_MS (a few quick retries aren't trouble).
 */
const OVERSIGHT_FAIL_STREAK = 3;
const OVERSIGHT_FAIL_MS = 5 * 60 * 1000;
/** A teammate's task still running after this long gets one team check. */
const OVERSIGHT_LONG_MS = 15 * 60 * 1000;
/** At most one team check about the same teammate in this window. */
const OVERSIGHT_COOLDOWN_MS = 10 * 60 * 1000;
/** Helpers: how many one agent may have working at once (Yo + 2 = 3 screens, agentd's seat cap). */
const MAX_HELPERS = 2;
/** A helper's task is stopped after this long (it does one bounded job). */
const HELPER_TURN_MS = 20 * 60 * 1000;
/** A helper's card waiting on the user holds it this long, then it wraps up and reports. */
const HELPER_USER_WAIT_MS = 10 * 60 * 1000;
/** Longest helper report handed to its parent. */
const MAX_HELPER_REPORT = 8000;
/** check_helpers waits at most this long for a helper to finish. */
const MAX_HELPER_WAIT_S = 600;
/** Timeline item kinds that are steps (tool use), whose failures count for team checks. */
const STEP_KINDS = new Set<Item["kind"]>(["command", "file_change", "tool", "browser", "web"]);

/** How a teammate's running task is going, for the lead's team checks. */
interface TurnHealth {
  turnId: string;
  /** Failed steps in a row (a step that works resets it), and when the first of them failed. */
  failStreak: number;
  streakSince: number;
  failures: number;
  /** The last few failed steps, newest last. */
  recent: { tool: string; error: string }[];
  /** Core stopped the task: a step froze (no events for the stuck limit) or it hit its time limit. */
  stopped: "froze" | "time limit" | null;
  /** The lead was sent a team check about this task. */
  noted: boolean;
}

/** Why the lead gets a team check about a teammate. */
type TeamCheckWhy = "failing" | "long" | "froze" | "time limit" | "failed" | "rough" | "after check";

/** A teammate's message waiting for (or being answered by) another agent's turn. */
interface AgentExchange {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  /** The asking agent is blocked on the reply (message_agent with wait). Cleared once it stops waiting. */
  resolve: ((text: string) => void) | null;
  timer: NodeJS.Timeout | null;
  /** Send the reply to the asker as a new message when it comes: an async handoff, or a wait that timed out. */
  deliverLate: boolean;
  fromCheckIn: boolean;
  hops: number;
}

interface QueuedInput {
  text: string;
  attachments: Attachment[];
  /** Where each attached zip was saved on the agent's computer ("~/uploads/x.zip"), by attachment index. */
  saved?: Record<number, string>;
  /** "intro": a new teammate's first turn (it says hello and asks the user one question). */
  trigger: "user" | "routine" | "agent" | "oversight" | "helper" | "intro";
  label?: string;
  /** Finished helpers' reports for their parent (merged while queued; `text` is all of them). */
  helperReports?: { id: string; text: string }[];
  /** A team check for the lead agent about this teammate (agent id). */
  oversight?: { about: string };
  /**
   * Started by a message sent during a team check (or a chain of messages from one). Such a task never
   * triggers a team check itself, so the lead checking in can't loop back to the lead.
   */
  fromCheckIn?: boolean;
  /** At most one outgoing message per automatic check-in turn. */
  checkInSent?: boolean;
  /**
   * A teammate's message (message_agent): who sent it, and the exchange its reply belongs to. `reply`: it's the
   * teammate's answer to this agent's own earlier message (nothing goes back for it).
   */
  from?: { agentId: string; name: string; role: string; exchangeId: string | null; reply?: boolean };
  /** How many agent-to-agent messages led to this turn (0 = started by the user or a routine). */
  hops?: number;
  /** A /compact run: the reply becomes the handoff summary instead of a chat message. */
  compact?: { focus?: string; auto: boolean };
  /** Where this message's steps may run (composer choice). A preference, never a permission. */
  route?: RoutePreference;
  /**
   * The user's own message ("Up next"): only these are listed, edited, reordered, removed or steered by the
   * user (queue.*). Everything else in the line (teammates, helpers, team checks, routines, /compact) is internal.
   */
  own?: { id: string; createdAt: number };
  /** Its chat bubble, shown when it starts (or is steered in) rather than while it waits in line. */
  userItem?: Item;
  /** Never steered into a running turn (Yo Phone: phone text always gets a turn of its own). */
  noSteer?: boolean;
}

/** Providers whose running task takes a new message mid-way (Claude folds it in, Codex `turn/steer`). */
const STEERABLE = new Set(["claude", "codex"]);

interface AgentRuntime {
  agentId: string;
  sessionKey: string | null;
  runningTurn: string | null;
  turnStartedAt: number;
  /** When the running turn was handed to agentd (0 = not yet: still waking the computer or starting a session). */
  turnSentAt: number;
  lastEventAt: number;
  queue: QueuedInput[];
  /** assistant item id -> accumulated text */
  buffers: Map<string, string>;
  todos: TodoEntry[];
  lastError: string | null;
  /** The last turn failed for want of a connected model (cleared once one is connected). */
  needsModel: boolean;
  computer: ComputerState;
  lease: LeaseHolder;
  lastUsedAt: number;
  /** The running turn is waiting for a free screen (every awake computer is busy). */
  seatWait: boolean;
  /** Input of the running turn (kept so a failed resume can be retried on a fresh session). */
  input: QueuedInput | null;
  /** Context size (tokens) the provider reported for the last turn on the current session. */
  contextTokens: number;
  /** Assistant text collected during a /compact turn. */
  compactText: Map<string, string>;
  /** How the running task is going (for team checks); null between tasks. */
  health: TurnHealth | null;
  /** The task ledger as the current session last saw it (ledgerSig), so a change is told on the next message. */
  ledgerSeen: string | null;
  /** The team as the current session last saw it (teamSig): a change is told on the next message. */
  teamSeen: string | null;
  /** Turn ids of messages steered into the running task (their provider completions are bookkeeping only). */
  steered: Set<string>;
  /** The user's queue as last pushed (queue.updated), so unchanged lines aren't pushed again. */
  queueSig: string;
  /** The turn whose provider turned the sign-in down: its plain notice is already shown, don't repeat it. */
  signInNoticeTurn: string | null;
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m === 1 ? "1 minute" : `${m} minutes`;
}

/** What an agent is told when the user didn't answer its card in time. */
function unanswered(tool: string, waited: string): string {
  const wrap =
    "Stop here and don't ask again in this task. End your turn with one short message saying exactly what you need from the user; they'll reply in chat when they're back.";
  if (tool === "request_takeover") return `The user didn't take over within ${waited}. ${wrap}`;
  if (tool === "ask_user") return `No answer from the user after ${waited}. Don't guess the answer. ${wrap}`;
  if (tool === SECURE_INPUT_TOOL)
    return `The user didn't fill in the secure form within ${waited}, so nothing was typed. ${wrap}`;
  return `No decision from the user after ${waited}, so it's NOT approved: don't do this action. ${wrap}`;
}

/** A resumed native session that no longer exists on the computer (e.g. the computer moved or was reset). */
const RESUME_LOST =
  /no conversation found|could not resume|(session|thread|conversation)[^.]{0,40}not found/i;

interface PendingToolCall {
  callId: string;
  agentId: string;
  /** Native session that asked; its pending cards expire when it ends. */
  sessionKey?: string;
  entryId: string;
  tool: string;
  args: Record<string, unknown>;
  resolve: (text: string) => void;
  /** A secure form: takes the user's values (held in memory only until they're typed into the page). */
  secureValues?: (values: string[]) => void;
  /** Set once the user submits, so expiry doesn't fire while the page is being filled. */
  filling?: boolean;
  /** Resolves request.respond after the fill succeeds or fails and the card has been updated. */
  onFilled?: () => void;
}

export interface OrchestratorDeps {
  /** 1Password's vault names for the prompt, or null when it isn't connected (../onepassword). */
  onePasswordInfo?: () => { vaults: string[] } | null;
  store: Store;
  agentd: AgentdClient;
  hub: Hub;
  accounts: AccountService;
  /** Ensure the computer runtime is up (local mode: Colima + compose). */
  ensureComputer: () => Promise<void>;
  /** Handle Yo tool calls that aren't interactive (memory, schedule, artifacts...). */
  tools: (agentId: string, tool: string, args: Record<string, unknown>) => Promise<string>;
  /** Copy the pictures a finished assistant message embeds (markdown src -> snapshot name). */
  snapshotImages?: (agentId: string, text: string) => Promise<Record<string, string>>;
  /** `mac_*` tools: routed and permission-checked against the user's paired devices. */
  deviceTools?: (tool: string, args: Record<string, unknown>, ctx: DeviceToolContext) => Promise<string>;
  maxAwake: () => number;
  onActivity: () => void;
  /** How long after an agentd reconnect a turn may stay quiet before it's declared lost (tests shorten it). */
  lostTurnGraceMs?: number;
  /** How long message_agent waits for a teammate's reply before carrying on (tests shorten it). */
  agentReplyWaitMs?: number;
  /** How long a card waits on the user before the agent stops waiting (tests shorten it). */
  userWaitMs?: number;
  /** Longest a single task may run (tests shorten it). */
  maxTurnMs?: number;
  /** How long a task may go without any event from the model before it's presumed frozen (tests shorten it). */
  stuckTurnMs?: number;
  /** Team checks: how long a teammate's steps must keep failing before the lead is told (tests shorten it). */
  oversightFailMs?: number;
  /** Team checks: how long a teammate's task runs before the lead is told, once (tests shorten it). */
  oversightLongMs?: number;
  /** Team checks: the least time between two checks about the same teammate (tests shorten it). */
  oversightCooldownMs?: number;
  /** Longest a helper's task may run (tests shorten it). */
  helperTurnMs?: number;
}

/**
 * A turn starting (with the queued message it came from, if any) or ending. Channels use it to route a reply to
 * whoever sent the message: a queued message only gets a turnId when it starts.
 */
export type TurnEvent =
  /** `queuedId`: the user's message it runs (for a message that waited in "Up next", the id send returned). */
  | { type: "started"; agentId: string; turnId: string; queuedId?: string }
  /** A queued message was steered into the running turn (`turnId`) instead of getting its own. */
  | { type: "steered"; agentId: string; turnId: string; queuedId: string }
  | { type: "ended"; agentId: string; turnId: string; status: string; error?: string };

/** What the Yo Phone tools need from the phone channel (main.ts attaches it once both exist). */
export interface PhoneLinks {
  /** Make a new link (revoking the old one). Throws a message fit for the user. */
  createLink(): Promise<{ link: string }>;
  turnOff(): Promise<unknown>;
  /** Whether a turn was started by a message from the phone. */
  isPhoneTurn(turnId: string): boolean;
}

/** The onepassword_* tools (../onepassword/tools). */
export type OnePasswordToolHandler = (
  agentId: string,
  callId: string,
  tool: string,
  args: Record<string, unknown>,
) => Promise<string>;

export class Orchestrator {
  private runtimes = new Map<string, AgentRuntime>();
  private sessionToAgent = new Map<string, string>();
  /** sessionKeys started on the current agentd connection. */
  private liveSessions = new Set<string>();
  /** Sessions whose provider turned the sign-in down: restarted (with the current sign-in) before their next turn. */
  private signInRejected = new Set<string>();
  /** The permission mode each live session was started (or last set) with. */
  private sessionModes = new Map<string, "approval-required" | "auto" | "full-access">();
  private toolCalls = new Map<string, PendingToolCall>();
  /** Tool calls being handled. agentd re-sends unanswered ones after a reconnect; those are ignored. */
  private inFlightCalls = new Set<string>();
  private providerRequests = new Map<
    string,
    { agentId: string; sessionKey: string; entryId: string; toolName?: string }
  >();
  private seqFlush = new Map<string, number>();
  /** Sessions started from a resume cursor that haven't completed a turn yet. */
  private resuming = new Set<string>();
  /** Sessions abandoned after a lost resume; their late events are ignored. */
  private abandoned = new Set<string>();
  private firstConnect = true;
  private readonly startedAt = Date.now();
  /** Core is shutting down: late timers must not touch the (closed) database. */
  private disposed = false;
  private seqTimer: NodeJS.Timeout;
  /** One-shot timers that touch the store; cleared on dispose so none fires after the database closes. */
  private timers = new Set<NodeJS.Timeout>();
  /** message_agent exchanges whose reply hasn't been handed back yet. */
  private exchanges = new Map<string, AgentExchange>();
  /** Agents waiting for a free screen: called when one may have freed up (a task ended, a computer slept). */
  private seatWaiters = new Set<() => void>();
  /** When the lead was last sent a team check about each teammate (agent id -> ms). */
  private teamCheckAt = new Map<string, number>();
  /** Finished helpers' reports not handed to their parent yet (helper id -> report). */
  private helperReports = new Map<string, { parentId: string; text: string }>();
  /** Agents blocked in check_helpers (wait_seconds), and how to wake them (parent id -> wakers). */
  private helperWaiters = new Map<string, Set<() => void>>();
  /** Helpers their parent stopped (stop_helper): their parent already knows, so no report. */
  private stoppedByLead = new Set<string>();
  /** Retired helpers whose computer still has to be discarded once the computer is reachable. */
  private pendingDiscards = new Set<string>();
  /** What each live helper's card last showed (no write when nothing changed). */
  private helperCards = new Map<string, string>();

  constructor(private d: OrchestratorDeps) {
    d.agentd.on("push", (p) => this.onPush(p));
    d.agentd.on("connected", () => this.onConnected());
    d.hub.subscribe((channel, data) => {
      const status = channel === "account.updated" ? (data as { status?: string }).status : null;
      if (status === "authenticated" || status === "unverified") this.modelConnected();
    });
    d.agentd.on("disconnected", () => {
      this.liveSessions.clear();
      for (const rt of this.runtimes.values()) rt.computer = "off";
      this.broadcastAll();
    });
    // Seed seq cursors so agentd replays anything we missed while core was down.
    for (const s of d.store.openSessions()) {
      d.agentd.seedSeq(s.id, s.lastSeq);
      this.sessionToAgent.set(s.id, s.agentId);
    }
    // Core (re)started mid-task: close what those turns left running and say so in each chat.
    for (const t of d.store.failRunningTurns()) {
      for (const e of d.store.closeRunningItems(t.id, "failed")) d.hub.push("timeline.upsert", e);
      this.notice(t.agentId, "Yo restarted during this task. Ask me to pick it back up.", {
        turnId: t.id,
        error: true,
      });
    }
    d.store.expirePendingRequests();
    // Anything else still marked running (a task stopped before it reached the model, a card) is over too.
    for (const e of d.store.closeAllRunningItems()) d.hub.push("timeline.upsert", e);
    this.seqTimer = setInterval(() => this.flushSeqs(), 2000);
    this.seqTimer.unref();
    // Helpers that were working when core stopped can't pick up again: retire them and tell their parent.
    for (const h of d.store.listHelpers(null, { live: true }))
      this.retireHelper(h, { turnId: null, status: "interrupted", restart: true });
  }

  private turnWatchers = new Set<(e: TurnEvent) => void>();
  private phone: PhoneLinks | null = null;
  private onePassword: OnePasswordToolHandler | null = null;

  /** Give the Yo Phone tools their channel. */
  attachPhone(phone: PhoneLinks) {
    this.phone = phone;
  }

  /** Give the 1Password tools their handler (main.ts makes it with askOnePassword below). */
  attachOnePassword(handler: OnePasswordToolHandler) {
    this.onePassword = handler;
  }

  /** Follow turns as they start and end (see TurnEvent). Returns an unsubscribe function. */
  onTurn(cb: (e: TurnEvent) => void): () => void {
    this.turnWatchers.add(cb);
    return () => this.turnWatchers.delete(cb);
  }

  private emitTurn(e: TurnEvent) {
    for (const cb of this.turnWatchers) {
      try {
        cb(e);
      } catch (err) {
        log.warn("a turn watcher failed", err);
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.seatMaybeFree(); // tasks waiting for a screen stop waiting
    for (const id of [...this.helperWaiters.keys()]) this.wakeHelperWaiters(id);
    clearInterval(this.seqTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.flushSeqs();
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref();
    this.timers.add(t);
  }

  /* -------------------------------- runtime -------------------------------- */

  private rt(agentId: string): AgentRuntime {
    let r = this.runtimes.get(agentId);
    if (!r) {
      const s = this.d.store.latestSession(agentId);
      r = {
        agentId,
        sessionKey: s && !s.endedAt ? s.id : null,
        runningTurn: null,
        turnStartedAt: 0,
        turnSentAt: 0,
        lastEventAt: 0,
        queue: [],
        buffers: new Map(),
        todos: [],
        lastError: null,
        needsModel: false,
        computer: "off",
        lease: "agent",
        lastUsedAt: 0,
        seatWait: false,
        input: null,
        contextTokens: 0,
        compactText: new Map(),
        health: null,
        ledgerSeen: null,
        teamSeen: null,
        steered: new Set(),
        queueSig: "[]",
        signInNoticeTurn: null,
      };
      this.runtimes.set(agentId, r);
    }
    return r;
  }

  /** Current native session of an agent (null after /compact or "New session" until the next turn). */
  sessionKeyOf(agentId: string): string | null {
    return this.rt(agentId).sessionKey;
  }

  private hasPending(agentId: string): boolean {
    return [...this.toolCalls.values(), ...this.providerRequests.values()].some((p) => p.agentId === agentId);
  }

  activityOf(agentId: string): AgentActivity {
    const r = this.rt(agentId);
    if (this.hasPending(agentId)) return "waiting";
    if (r.runningTurn) return "working";
    if (r.lastError) return "error";
    const agent = this.d.store.getAgent(agentId);
    if (agent && agent.unread > 0) return "done";
    if (r.computer === "hibernated" || r.computer === "off") return "sleeping";
    return "idle";
  }

  view(agentId: string): AgentView | null {
    const a = this.d.store.getAgent(agentId);
    if (!a) return null;
    const r = this.rt(agentId);
    const { unread, lastActiveAt, ...agent } = a;
    return {
      ...agent,
      activity: this.activityOf(agentId),
      unread,
      preview: this.d.store.lastAssistantPreview(agentId),
      computer: { state: r.computer, lease: r.lease },
      todos: r.todos,
      lastActiveAt,
      statusLine: this.statusLine(agentId),
    };
  }

  /**
   * One line on what the agent is doing now (AgentView.statusLine). Built from what core already holds when it
   * pushes the agent (a task starting or ending, a card, a plan update), so it never adds a push of its own.
   */
  private statusLine(agentId: string): string | null {
    const r = this.rt(agentId);
    const card = [...this.toolCalls.values(), ...this.providerRequests.values()].find(
      (p) => p.agentId === agentId,
    );
    if (card) {
      const req = this.d.store.getEntry(card.entryId)?.request;
      const what = req?.kind === "user_input" ? "Waiting for your answer" : "Waiting for your OK";
      return req?.title ? `${what}: ${oneLine(req.title, 70)}` : what;
    }
    const q = r.input;
    if (!r.runningTurn || !q) return null;
    if (r.seatWait) return "Waiting for a free screen";
    const waitingOn = [...this.exchanges.values()].find((x) => x.fromAgentId === agentId && x.resolve);
    if (waitingOn)
      return `Waiting for ${this.d.store.getAgent(waitingOn.toAgentId)?.name ?? "a teammate"}'s reply`;
    const step = r.todos.find((t) => t.status === "in_progress")?.text;
    if (step) return oneLine(step, 80);
    if (q.compact) return "Tidying up the conversation";
    if (q.trigger === "intro") return "Saying hello";
    if (q.from?.reply) return `Reading ${q.from.name}'s reply`;
    if (q.from) return `For ${q.from.name}: ${oneLine(q.text.split("\n")[0] ?? "", 60)}`;
    if (q.trigger === "routine") return q.label ? `Routine: ${oneLine(q.label, 60)}` : "Running a routine";
    if (q.trigger === "helper") return "Reading a helper's report";
    if (q.trigger === "oversight") return "Checking on a teammate";
    return oneLine(q.text.split("\n")[0] ?? "", 60) || "Working on your request";
  }

  /** Every agent, plus helpers still working (the app shows those as cards in their parent's chat). */
  views(): AgentView[] {
    return this.liveAgents()
      .map((a) => this.view(a.id))
      .filter((v): v is AgentView => !!v);
  }

  private liveAgents(): Agent[] {
    return [...this.d.store.listAgents(), ...this.d.store.listHelpers(null, { live: true })];
  }

  broadcast(agentId: string) {
    const v = this.view(agentId);
    if (v) this.d.hub.push("agent.updated", v);
    if (v?.kind === "helper" && !v.archivedAt) this.refreshHelperCard(v);
    this.pushQueue(agentId);
  }

  /* ---------------------------- the user's queue ---------------------------- */

  /** The user's own messages waiting for the running task, in the order they'll run. */
  queueOf(agentId: string): QueuedRequest[] {
    const r = this.runtimes.get(agentId);
    if (!r) return [];
    return r.queue.flatMap((q) =>
      q.own
        ? [{ id: q.own.id, text: q.text, attachments: q.attachments.length, createdAt: q.own.createdAt }]
        : [],
    );
  }

  private pushQueue(agentId: string) {
    const r = this.runtimes.get(agentId);
    if (!r) return;
    const items = this.queueOf(agentId);
    const sig = JSON.stringify(items);
    if (sig === r.queueSig) return;
    r.queueSig = sig;
    this.d.hub.push("queue.updated", { agentId, items });
  }

  private ownQueued(agentId: string, id: string): QueuedInput {
    const q = this.runtimes.get(agentId)?.queue.find((x) => x.own?.id === id);
    if (!q) throw new UserFacingError("That message isn't waiting anymore. It may have already started.");
    return q;
  }

  updateQueued(agentId: string, id: string, text: string): QueuedRequest[] {
    const q = this.ownQueued(agentId, id);
    const body = text.trim();
    if (!body && !q.attachments.length) throw new UserFacingError("A message can't be empty.");
    q.text = body;
    if (q.userItem) q.userItem = { ...q.userItem, text: body };
    this.pushQueue(agentId);
    return this.queueOf(agentId);
  }

  removeQueued(agentId: string, id: string): QueuedRequest[] {
    const q = this.ownQueued(agentId, id);
    const r = this.rt(agentId);
    r.queue = r.queue.filter((x) => x !== q);
    this.pushQueue(agentId);
    return this.queueOf(agentId);
  }

  /** The user's messages take the listed order; internal items (teammates, reports...) keep their places. */
  reorderQueued(agentId: string, ids: string[]): QueuedRequest[] {
    const r = this.rt(agentId);
    const own = r.queue.filter((q) => q.own);
    const rank = (q: QueuedInput) => {
      const i = ids.indexOf(q.own!.id);
      return i < 0 ? ids.length + own.indexOf(q) : i;
    };
    const sorted = [...own].sort((a, b) => rank(a) - rank(b));
    let next = 0;
    r.queue = r.queue.map((q) => (q.own ? sorted[next++]! : q));
    this.pushQueue(agentId);
    return this.queueOf(agentId);
  }

  /** Why a message can't go into the running task right now (null: it can). */
  private cantSteer(r: AgentRuntime): string | null {
    if (!r.runningTurn) return null;
    const name = this.d.store.getAgent(r.agentId)?.name ?? "Yo";
    if (r.input?.compact) return `${name} is compacting the conversation right now.`;
    if (r.input?.from || r.input?.oversight) return `${name} is answering a teammate right now.`;
    if (!r.sessionKey || !r.turnSentAt || !this.liveSessions.has(r.sessionKey))
      return `${name} is still getting this task started.`;
    const provider = this.d.store.getSession(r.sessionKey)?.provider;
    if (!provider || !STEERABLE.has(provider)) return "This model can't take new messages mid-task.";
    return null;
  }

  /**
   * Send a queued message into the running task now. Claude folds it in between steps; Codex gets it as a
   * `turn/steer`. When that isn't possible it moves to the front of the line instead, with a note saying why.
   */
  async steerQueued(agentId: string, id: string): Promise<QueueSteerResult> {
    const q = this.ownQueued(agentId, id);
    const r = this.rt(agentId);
    const toFront = (why: string): QueueSteerResult => {
      if (r.queue.includes(q)) r.queue = [q, ...r.queue.filter((x) => x !== q)];
      this.pushQueue(agentId);
      return { steered: false, note: `${why} It's next in line instead.`, items: this.queueOf(agentId) };
    };
    // Nothing running (the task just ended): it simply starts now.
    if (!r.runningTurn) {
      r.queue = r.queue.filter((x) => x !== q);
      void this.runTurn(agentId, newId("trn"), q);
      return { steered: true, items: this.queueOf(agentId) };
    }
    // A message from Yo Phone never joins a turn someone else started.
    if (q.noSteer) return toFront("Messages from Yo Phone get a turn of their own.");
    const why = this.cantSteer(r);
    if (why) return toFront(why);
    const sessionKey = r.sessionKey!;
    const running = r.runningTurn;
    r.queue = r.queue.filter((x) => x !== q);
    const turnId = newId("trn");
    r.steered.add(turnId);
    try {
      await this.saveUploads(agentId, q);
      await this.d.agentd.request("turn.send", {
        sessionKey,
        turnId,
        input: this.inputParts(q, `${this.clock()} `),
      });
    } catch (err) {
      r.steered.delete(turnId);
      log.info(`steer into ${running} failed: ${(err as Error)?.message ?? err}`);
      // The task ended meanwhile: the message runs on its own as soon as the line moves.
      if (r.runningTurn !== running && !r.runningTurn) {
        void this.runTurn(agentId, newId("trn"), q);
        return { steered: true, items: this.queueOf(agentId) };
      }
      r.queue.unshift(q);
      return toFront(`${this.d.store.getAgent(agentId)?.name ?? "Yo"} couldn't take it mid-task.`);
    }
    r.lastEventAt = Date.now();
    if (q.userItem)
      this.upsert({
        id: newId("usr"),
        agentId,
        turnId: running,
        item: { ...q.userItem, title: STEERED_TITLE },
      });
    // It joined a turn someone else started: whoever sent it gets no reply of its own.
    if (q.own) this.emitTurn({ type: "steered", agentId, turnId: running, queuedId: q.own.id });
    this.d.store.touchAgent(agentId);
    this.pushQueue(agentId);
    return { steered: true, items: this.queueOf(agentId) };
  }

  /**
   * Save the message's files the model can't read inline (zip files, PDFs, spreadsheets, documents...) on the
   * agent's computer (~/uploads), once. Core never extracts them: the
   * agent does, in its sandbox. A computer from before ~/uploads existed takes them in ~/from-mac.
   */
  private async saveUploads(agentId: string, input: QueuedInput) {
    for (const [i, a] of input.attachments.entries()) {
      if (!isSavedAsFile(a) || input.saved?.[i]) continue;
      const write = (dir: "uploads" | "from-mac") =>
        this.d.agentd.request("fs.write", { agentId, dir, name: a.name, dataBase64: a.data });
      try {
        const res = await write("uploads").catch((err) => {
          // An older computer only knows ~/from-mac (its agentd rejects the request as invalid).
          if (!/invalid request/i.test(String((err as Error)?.message))) throw err;
          return write("from-mac");
        });
        input.saved = { ...input.saved, [i]: res.path };
      } catch (err) {
        log.warn(`couldn't save ${a.name} on ${agentId}'s computer: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  /**
   * The model's input for a message: `prefix` + its text, with pictures as images, text files inline and zip
   * files as where they were saved (saveUploads) plus a listing of their names.
   */
  private inputParts(input: QueuedInput, prefix: string): InputPart[] {
    const parts: InputPart[] = [];
    let text = prefix + input.text;
    for (const [i, a] of input.attachments.entries()) {
      if (isZipAttachment(a)) {
        const where = input.saved?.[i];
        text += where
          ? `\n\n${zipNote(a.name, base64Bytes(a.data), where, zipListing(Buffer.from(a.data, "base64")))}`
          : `\n\n(The user attached the zip file "${a.name}", but it couldn't be saved on your computer. Ask them to send it again.)`;
      } else if (a.mediaType.startsWith("image/"))
        parts.push({ type: "image", mediaType: a.mediaType, data: a.data });
      else if (isInlineText(a)) {
        text += `\n\n<attached file name="${a.name}">\n${Buffer.from(a.data, "base64").toString("utf8")}\n</attached file>`;
      } else {
        const where = input.saved?.[i];
        const what = `"${a.name}" (${a.mediaType}, ${formatBytes(base64Bytes(a.data))})`;
        text += where
          ? `\n\n(The user attached ${what}. It's saved on your computer at ${where}: open it there.)`
          : `\n\n(The user attached ${what}, but it couldn't be saved on your computer. Ask them to send it again.)`;
      }
    }
    parts.unshift({ type: "text", text });
    return parts;
  }

  private broadcastAll() {
    for (const a of this.liveAgents()) this.broadcast(a.id);
  }

  isBusy(): boolean {
    return (
      [...this.runtimes.values()].some((r) => r.runningTurn || r.queue.length) ||
      this.toolCalls.size > 0 ||
      this.providerRequests.size > 0
    );
  }

  /* -------------------------------- timeline ------------------------------- */

  private upsert(e: Parameters<Store["upsertEntry"]>[0]): TimelineEntry {
    const entry = this.d.store.upsertEntry(e);
    this.d.hub.push("timeline.upsert", entry);
    return entry;
  }

  private notice(agentId: string, text: string, opts: { turnId?: string | null; error?: boolean } = {}) {
    return this.upsert({
      id: newId("ntc"),
      agentId,
      turnId: opts.turnId ?? null,
      item: { id: newId("itm"), kind: "notice", status: opts.error ? "failed" : "completed", text },
    });
  }

  /** Stop the task once it has run for MAX_TURN_MS (not while the user is on the agent's screen). */
  private capTurn(agentId: string, turnId: string) {
    const max = this.turnLimit(agentId);
    this.later(max, () => {
      // A retired helper's runtime is gone: don't bring it back.
      const r = this.runtimes.get(agentId);
      if (this.disposed || !r || r.runningTurn !== turnId) return;
      if (r.lease === "user") return this.capTurn(agentId, turnId);
      log.info(`turn ${turnId} hit the time limit`);
      if (r.health?.turnId === turnId) r.health.stopped = "time limit";
      for (const call of [...this.toolCalls.values()].filter((c) => c.agentId === agentId))
        this.resolveToolCall(
          call.callId,
          DECISION_CARDS.has(call.tool) ? "expired" : "This task hit its time limit.",
          "expired",
        );
      this.notice(
        agentId,
        this.isHelper(agentId)
          ? `I stopped at a helper's ${minutes(max)} time limit.`
          : `I stopped after ${minutes(max)} so I don't run forever. Say "continue" and I'll pick up where I left off.`,
        { turnId },
      );
      if (r.sessionKey)
        void this.d.agentd.request("turn.interrupt", { sessionKey: r.sessionKey }).catch(() => {});
      this.later(8000, () => {
        if (!this.disposed && this.runtimes.get(agentId)?.runningTurn === turnId)
          this.finishTurn(agentId, turnId, "interrupted", undefined, "Time limit");
      });
    });
  }

  /** How long one task may run: a helper's job is bounded tighter than an agent's. */
  private turnLimit(agentId: string): number {
    return this.isHelper(agentId)
      ? (this.d.helperTurnMs ?? HELPER_TURN_MS)
      : (this.d.maxTurnMs ?? MAX_TURN_MS);
  }

  /**
   * Stop a task that has gone STUCK_TURN_MS without a single event from the model: a step froze (e.g. a
   * browser script that never returns) and would otherwise hold the agent, and anyone waiting on it, until
   * MAX_TURN_MS. Not while the task is legitimately waiting (waitsLegitimately); then the quiet time counts
   * from when that wait was last seen.
   */
  private watchTurn(agentId: string, turnId: string, quietFrom = 0) {
    const limit = this.d.stuckTurnMs ?? STUCK_TURN_MS;
    const step = Math.max(10, Math.min(30_000, Math.floor(limit / 4)));
    this.later(step, () => {
      const r = this.runtimes.get(agentId);
      if (this.disposed || !r || r.runningTurn !== turnId) return;
      const now = Date.now();
      if (this.waitsLegitimately(r)) return this.watchTurn(agentId, turnId, now);
      if (now - Math.max(r.lastEventAt, quietFrom) < limit) return this.watchTurn(agentId, turnId, quietFrom);
      log.warn(`turn ${turnId} froze: no events for ${minutes(limit)}, stopping it`);
      if (r.health?.turnId === turnId) r.health.stopped = "froze";
      this.notice(
        agentId,
        `I stopped because a step froze for ${minutes(limit)}. Say "continue" and I'll pick up where I left off.`,
        { turnId },
      );
      if (r.sessionKey)
        void this.d.agentd.request("turn.interrupt", { sessionKey: r.sessionKey }).catch(() => {});
      this.later(8000, () => {
        if (!this.disposed && this.runtimes.get(agentId)?.runningTurn === turnId)
          this.finishTurn(agentId, turnId, "interrupted", undefined, "A step froze");
      });
    });
  }

  /**
   * The running task is quiet for a good reason: not with the model yet (waking the computer, waiting for a
   * free screen, starting a session), a card waiting on the user, the user using its screen, or message_agent
   * waiting on a teammate's reply.
   */
  private waitsLegitimately(r: AgentRuntime): boolean {
    return (
      !r.turnSentAt ||
      this.hasPending(r.agentId) ||
      r.lease === "user" ||
      [...this.exchanges.values()].some((x) => x.fromAgentId === r.agentId && !!x.resolve) ||
      this.helperWaiters.has(r.agentId) // check_helpers waiting for a helper to finish
    );
  }

  /**
   * A card the user hasn't answered within USER_WAIT_MS: the agent stops waiting and wraps up, so it doesn't
   * hold its task (and its computer) open for hours. While the user is on the agent's screen it keeps waiting.
   */
  private expireUnanswered(agentId: string, pending: () => boolean, expire: (waited: string) => void) {
    const base = this.d.userWaitMs ?? USER_WAIT_MS;
    // A helper doesn't hold its screen as long: it reports what it needs to its parent instead.
    const wait = this.isHelper(agentId) ? Math.min(base, HELPER_USER_WAIT_MS) : base;
    this.later(wait, () => {
      if (this.disposed || !pending()) return;
      if (this.runtimes.get(agentId)?.lease === "user")
        return this.expireUnanswered(agentId, pending, expire);
      expire(minutes(wait));
    });
  }

  /* --------------------------------- send ---------------------------------- */

  async send(
    agentId: string,
    text: string,
    attachments: Attachment[] = [],
    trigger: "user" | "routine" = "user",
    label?: string,
    route: RoutePreference = "auto",
    /** `notice`: the chat shows this quiet line instead of the message (a request nobody typed: the brief). */
    opts: { noSteer?: boolean; notice?: string } = {},
  ) {
    const agent = this.d.store.getAgent(agentId);
    if (!agent) throw new Error("Unknown agent");
    if (agent.kind === "helper" && agent.archivedAt)
      throw new UserFacingError("This helper has finished. Ask your main agent instead.");
    this.d.onActivity();
    for (const a of attachments) {
      if (!isZipAttachment(a)) continue;
      const problem = zipProblem(a);
      if (problem) throw new UserFacingError(problem);
    }
    attachments = attachments.map((a) => (isZipAttachment(a) ? { ...a, mediaType: "application/zip" } : a));
    const r = this.rt(agentId);
    r.lastError = null;
    r.needsModel = false;

    const userItem: Item = opts.notice
      ? { id: newId("itm"), kind: "notice", status: "completed", title: opts.notice }
      : {
          id: newId("itm"),
          kind: "user_message",
          status: "completed",
          text,
          ...(trigger === "routine" ? { title: label ? `Routine · ${label}` : "Routine" } : {}),
          ...(attachments.length
            ? { input: { attachments: attachments.map((a) => ({ name: a.name, mediaType: a.mediaType })) } }
            : {}),
        };
    return this.enqueue(agentId, userItem, {
      text,
      attachments,
      trigger,
      label,
      route,
      ...(opts.noSteer ? { noSteer: true } : {}),
      ...(trigger === "user" ? { own: { id: newId("qmsg"), createdAt: Date.now() } } : {}),
    });
  }

  /**
   * Shows the message in the chat (if any), then runs it now or after the turn that's running. The user's own
   * messages wait in "Up next" (queue.*) and join the chat when they start.
   */
  private enqueue(agentId: string, userItem: Item | null, queued: QueuedInput) {
    const r = this.rt(agentId);
    if (userItem && queued.own && r.runningTurn) queued.userItem = userItem;
    else if (userItem) this.upsert({ id: newId("usr"), agentId, turnId: null, item: userItem });
    this.d.store.touchAgent(agentId);
    if (r.runningTurn) {
      r.queue.push(queued);
      this.broadcast(agentId);
      return { turnId: "queued", ...(queued.own ? { queuedId: queued.own.id } : {}) };
    }
    const turnId = newId("trn");
    void this.runTurn(agentId, turnId, queued);
    return { turnId };
  }

  private async runTurn(agentId: string, turnId: string, input: QueuedInput) {
    const r = this.rt(agentId);
    if (input.userItem) {
      // A queued message joins the chat as it starts.
      this.upsert({ id: newId("usr"), agentId, turnId: null, item: input.userItem });
      input.userItem = undefined;
    }
    r.steered.clear();
    r.runningTurn = turnId;
    r.input = input;
    this.emitTurn({ type: "started", agentId, turnId, ...(input.own ? { queuedId: input.own.id } : {}) });
    r.turnStartedAt = Date.now();
    r.turnSentAt = 0;
    r.lastEventAt = Date.now();
    r.lastUsedAt = Date.now();
    r.health = {
      turnId,
      failStreak: 0,
      streakSince: 0,
      failures: 0,
      recent: [],
      stopped: null,
      noted: false,
    };
    this.capTurn(agentId, turnId);
    this.watchTurn(agentId, turnId);
    this.watchLong(agentId, turnId);
    this.broadcast(agentId);
    try {
      const agent = this.d.store.getAgent(agentId)!;
      let account = this.d.accounts.resolveFor(agent.accountId);
      // A sign-in can finish while Yo isn't looking (core restarting mid-login, say): check again before refusing.
      if (
        account &&
        account.status !== "authenticated" &&
        account.status !== "unverified" &&
        this.d.agentd.connected
      ) {
        account = await this.d.accounts.refresh(account.id).catch(() => account!);
        this.assertStillRunning(agentId, turnId);
      }
      if (!account || (account.status !== "authenticated" && account.status !== "unverified")) {
        throw new NeedsModelError(
          account?.signInExpired
            ? signInExpiredMessage(account)
            : account
              ? `${account.label} isn't connected yet. Connect your subscription in Settings → Accounts, then send this again.`
              : "No model is connected yet. Connect your Claude, ChatGPT or Grok plan in Settings → Accounts, then send this again.",
        );
      }

      if (!this.d.agentd.connected) {
        this.notice(agentId, "Waking up my computer…", { turnId });
        await this.d.ensureComputer();
        await this.d.agentd.waitReady(120000);
        this.assertStillRunning(agentId, turnId);
      }

      // Saved by the "Connect your model" walkthrough before the computer existed: check it now.
      if (account.status === "unverified") {
        await this.d.accounts.configure(account.id);
        account = await this.d.accounts.refresh(account.id);
        this.assertStillRunning(agentId, turnId);
        if (account.status !== "authenticated")
          throw new NeedsModelError(
            `${account.label} didn't accept the saved sign-in. Open Settings → Accounts to connect it again.`,
          );
      }

      await this.ensureAwake(agentId, turnId);
      this.assertStillRunning(agentId, turnId);
      // Still pinned to a provider Yo doesn't offer (normally repaired at boot): its model and effort belong
      // to that provider, so run on the fallback account's defaults.
      const hidden = this.d.accounts.isHiddenAccount(agent.accountId);
      const sessionKey = await this.ensureSession(
        agentId,
        account.id,
        account.provider,
        hidden ? null : agent.model,
        hidden ? null : agent.effort,
        agent.runtimeMode,
      );
      this.assertStillRunning(agentId, turnId);
      this.d.store.createTurn({ id: turnId, agentId, sessionId: sessionKey, trigger: input.trigger });
      this.d.store.incSessionTurns(sessionKey);
      this.d.store.addActivity({
        agentId,
        kind: "run.started",
        summary: input.compact
          ? `${agent.name} is compacting the conversation`
          : `${agent.name} started: ${input.text.slice(0, 120)}`,
        ref: turnId,
      });
      if (input.compact) {
        const userName = this.d.store.getSettings().userName?.trim() || "the user";
        await this.sendTurnWithRetry(agentId, sessionKey, turnId, [
          { type: "text", text: compactPrompt(userName, input.compact.focus) },
        ]);
        return;
      }

      const clock = this.clock();
      const from = input.from;
      const prefix =
        input.trigger === "routine"
          ? `${clock} [Scheduled routine${input.label ? `: ${input.label}` : ""}] `
          : from
            ? `${clock} ${teammateNote(
                {
                  ...from,
                  waiting: !!from.exchangeId && !!this.exchanges.get(from.exchangeId)?.resolve,
                },
                this.d.store.getSettings().userName,
              )}\n`
            : `${clock} `;
      // Reports about to be read here aren't handed over again (check_helpers, the next queued report).
      for (const x of input.helperReports ?? []) this.helperReports.delete(x.id);
      const ledger = agent.kind === "helper" ? "" : this.ledgerNews(agentId);
      const team = agent.kind === "helper" ? "" : this.teamNews(agentId);
      await this.saveUploads(agentId, input);
      this.assertStillRunning(agentId, turnId);
      const parts = this.inputParts(
        input,
        prefix + (ledger ? `${ledger}\n` : "") + (team ? `${team}\n` : ""),
      );
      await this.sendTurnWithRetry(agentId, sessionKey, turnId, parts);
    } catch (err: any) {
      // A stopped startup may reject after another task began, or after shutdown closed the store.
      if (this.disposed || r.runningTurn !== turnId || err instanceof TurnEndedError) return;
      const msg =
        err instanceof UserFacingError ? err.message : `Something went wrong: ${err?.message ?? err}`;
      // Something the user can fix (no model connected, say) isn't a fault: no stack in the log.
      if (err instanceof UserFacingError) log.info(`turn ${turnId} not started: ${err.message}`);
      else log.warn(`turn ${turnId} failed to start`, err);
      this.notice(agentId, msg, { turnId, error: true });
      this.finishTurn(agentId, turnId, "failed", undefined, msg);
      if (err instanceof NeedsModelError) r.needsModel = true;
    }
  }

  /**
   * The task was stopped (Stop, archived, time limit) while it was still starting (waking the computer,
   * starting a session): it must not go on to reach the model after the chat already shows it stopped.
   */
  private assertStillRunning(agentId: string, turnId: string) {
    if (this.disposed || this.rt(agentId).runningTurn !== turnId) throw new TurnEndedError();
  }

  private async sendTurnWithRetry(agentId: string, sessionKey: string, turnId: string, parts: InputPart[]) {
    this.rt(agentId).turnSentAt = Date.now();
    try {
      await this.d.agentd.request("turn.send", { sessionKey, turnId, input: parts });
    } catch (err: any) {
      if (!/unknown session|no session|not found/i.test(String(err?.message))) throw err;
      // agentd restarted and lost the session: resume it from the stored cursor and retry once.
      this.liveSessions.delete(sessionKey);
      const agent = this.d.store.getAgent(agentId)!;
      const s = this.d.store.getSession(sessionKey)!;
      await this.startNative(agentId, s.id, s.accountId, agent.runtimeMode, agent.effort, s.model);
      await this.d.agentd.request("turn.send", { sessionKey, turnId, input: parts });
    }
  }

  private async ensureAwake(agentId: string, turnId?: string) {
    const r = this.rt(agentId);
    if (r.computer !== "ready") await this.wake(agentId, turnId);
    // Helpers neither count toward the soft cap (settings.maxAwakeComputers) nor enforce it: a waking helper
    // must not put its own lead to sleep. The computer's hard cap (YO_MAX_AWAKE_SEATS) still holds (wake).
    if (this.isHelper(agentId)) return;
    // Enforce the awake cap: hibernate least-recently-used idle computers (the main agent's last).
    const awake = [...this.runtimes.values()].filter((x) => isAwake(x) && !this.isHelper(x.agentId));
    const cap = Math.max(1, this.d.maxAwake());
    if (awake.length > cap) {
      const victims = awake
        .filter((x) => x.agentId !== agentId && this.canSleep(x))
        .sort((a, b) => this.sleepOrder(a, b))
        .slice(0, awake.length - cap);
      for (const v of victims) await this.putToSleep(v);
    }
  }

  /** The time stamped on a message, with "· personal time" / "· work time" when Work & Personal is on. */
  private clock(): string {
    const s = this.d.store.getSettings();
    return messageClock(new Date(), s.timezone, s.spacesOn ? resolveSpace(Date.now(), s).space : undefined);
  }

  /** Who goes to sleep first: least recently used, but the main agents (Yo, and Pip for Personal) last. */
  private sleepOrder(a: AgentRuntime, b: AgentRuntime): number {
    const lead = (r: AgentRuntime) => {
      const x = this.d.store.getAgent(r.agentId);
      return x && isLead(x) ? 1 : 0;
    };
    return lead(a) - lead(b) || a.lastUsedAt - b.lastUsedAt;
  }

  /**
   * Nothing would be cut short by putting this agent's computer to sleep: no task running or queued, no card
   * waiting on the user, and the user isn't in control of its screen.
   */
  private canSleep(r: AgentRuntime): boolean {
    return !r.runningTurn && !r.queue.length && r.lease !== "user" && !this.hasPending(r.agentId);
  }

  private async putToSleep(r: AgentRuntime): Promise<boolean> {
    try {
      await this.d.agentd.request("computer.hibernate", { agentId: r.agentId });
    } catch {
      return false;
    }
    r.computer = "hibernated";
    // Its Claude session and tool servers would otherwise stay up while it sleeps (~0.5 GB). The session row
    // keeps its resume cursor, so the next message resumes the same conversation.
    if (r.sessionKey && this.liveSessions.has(r.sessionKey)) {
      const sessionKey = r.sessionKey;
      this.liveSessions.delete(sessionKey);
      this.sessionModes.delete(sessionKey);
      await this.d.agentd.request("session.stop", { sessionKey }).catch(() => {});
    }
    this.broadcast(r.agentId);
    this.seatMaybeFree();
    return true;
  }

  /**
   * Wakes the agent's computer. The computer refuses one more awake screen than it allows (NO_FREE_SEAT,
   * YO_MAX_AWAKE_SEATS); only core knows who is idle, so it puts the least recently used idle agent's computer
   * to sleep and asks again. When every awake agent is busy, a task (`turnId`) waits for a free screen and
   * says so in its chat, instead of failing; anything else (waking by hand) gets a clear error.
   */
  private async wake(agentId: string, turnId?: string) {
    const r = this.rt(agentId);
    let told = false;
    let synced = false;
    for (;;) {
      try {
        await this.d.agentd.request("computer.ensure", { agentId }, 90000);
        r.computer = "ready";
        if (told) this.broadcast(agentId);
        return;
      } catch (err) {
        if (!isNoFreeSeat(err)) throw err;
      }
      const victim = this.idleToSleep(agentId);
      if (victim && (await this.putToSleep(victim))) continue;
      if (!synced) {
        // Core's picture of who is awake may be stale (say, a screen woken from the live view): refresh once.
        synced = true;
        await this.syncComputers();
        if (this.idleToSleep(agentId)) continue;
      }
      if (!turnId)
        throw new UserFacingError(
          "Every screen on the agents' computer is in use by an agent that's working. Try again when one finishes.",
        );
      r.seatWait = true;
      if (!told) {
        told = true;
        log.info(`${agentId} is waiting for a free screen`);
        this.notice(
          agentId,
          "Waiting for a free screen. The other agents' screens are all busy; I'll start as soon as one frees up.",
          { turnId },
        );
        this.broadcast(agentId); // a helper's card says it's waiting
      }
      try {
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, SEAT_RETRY_MS);
          t.unref();
          function done() {
            clearTimeout(t);
            resolve();
          }
          this.seatWaiters.add(done);
        });
      } finally {
        r.seatWait = false;
      }
      if (this.disposed || r.runningTurn !== turnId) throw new TurnEndedError();
    }
  }

  /**
   * The least recently used awake agent (other than `agentId`) whose computer can go to sleep; the main agents
   * last. A helper never puts its parent (or a main agent) to sleep to get a screen: it waits instead.
   */
  private idleToSleep(agentId: string): AgentRuntime | undefined {
    const me = this.d.store.getAgent(agentId);
    const spare = new Set<string>();
    if (me?.kind === "helper") {
      if (me.parentId) spare.add(me.parentId);
      for (const a of this.d.store.listAgents()) if (isLead(a)) spare.add(a.id);
    }
    return [...this.runtimes.values()]
      .filter((x) => x.agentId !== agentId && !spare.has(x.agentId) && isAwake(x) && this.canSleep(x))
      .sort((a, b) => this.sleepOrder(a, b))[0];
  }

  /** Something may have freed a screen (a task ended, a computer slept, the user handed one back). */
  private seatMaybeFree() {
    const waiters = [...this.seatWaiters];
    this.seatWaiters.clear();
    for (const w of waiters) w();
  }

  /** Waking a computer by hand (its live view): makes room like a task does, but doesn't wait. */
  async wakeComputer(agentId: string) {
    const before = this.rt(agentId).computer;
    this.markComputer(agentId, "booting");
    try {
      await this.wake(agentId);
    } catch (err) {
      const r = this.rt(agentId);
      if (r.computer === "booting") r.computer = before;
      this.broadcast(agentId);
      throw err;
    }
    this.markComputer(agentId, "ready");
  }

  private async syncComputers() {
    const st = await this.d.agentd.request("computer.status", {}).catch(() => null);
    // Core may have shut down (database closed) while the computer was answering.
    if (!st || this.disposed) return;
    for (const a of st.agents) {
      if (this.retiredHelper(a.agentId)) continue;
      const r = this.rt(a.agentId);
      r.computer = a.state;
      r.lease = a.lease;
    }
    this.broadcastAll();
  }

  private async ensureSession(
    agentId: string,
    accountId: string,
    provider: string,
    model: string | null,
    effort: string | null,
    runtimeMode: "approval-required" | "auto" | "full-access",
  ): Promise<string> {
    const r = this.rt(agentId);
    let s = r.sessionKey ? this.d.store.getSession(r.sessionKey) : null;
    const stale =
      !s ||
      !!s.endedAt ||
      s.accountId !== accountId ||
      s.provider !== provider ||
      s.turnCount >= MAX_TURNS_PER_SESSION ||
      Date.now() - s.startedAt > MAX_SESSION_AGE_MS;
    if (s && stale) {
      if (this.liveSessions.has(s.id))
        await this.d.agentd.request("session.stop", { sessionKey: s.id }).catch(() => {});
      this.liveSessions.delete(s.id);
      this.d.store.endSession(s.id);
      const acc = this.d.store.getAccount(accountId);
      if (s.provider !== provider && acc)
        this.notice(
          agentId,
          `Switched to ${acc.label}${model ? ` · ${model}` : ""}. I still remember our conversation.`,
        );
      s = null;
    }
    if (!s) {
      r.contextTokens = 0;
      s = this.d.store.createSession({ agentId, accountId, provider: provider as any, model });
      r.sessionKey = s.id;
      this.sessionToAgent.set(s.id, agentId);
    }
    if (this.signInRejected.has(s.id)) {
      // Its provider process still holds the sign-in that was turned down: start it again with the current one.
      this.signInRejected.delete(s.id);
      if (this.liveSessions.has(s.id))
        await this.d.agentd.request("session.stop", { sessionKey: s.id }).catch(() => {});
      this.liveSessions.delete(s.id);
    }
    if (!this.liveSessions.has(s.id)) {
      await this.startNative(agentId, s.id, accountId, runtimeMode, effort, model);
    } else if ((s.model ?? null) !== (model ?? null)) {
      // A failed switch must not be recorded: the picker would show a model this session isn't using,
      // and the next message would not try again.
      try {
        await this.d.agentd.request("session.set", { sessionKey: s.id, model: model ?? undefined });
        this.d.store.updateSession(s.id, { model });
      } catch (err: any) {
        const agent = this.d.store.getAgent(agentId);
        if (agent && (agent.model ?? null) !== (s.model ?? null)) {
          this.d.store.updateAgent(agentId, { model: s.model });
          this.broadcast(agentId);
        }
        const wanted = model ?? "the default model";
        const kept = s.model ?? "the default model";
        const why = String(err?.message ?? "").trim();
        throw new UserFacingError(
          why
            ? `Couldn't switch to ${wanted}: ${why}. This chat is still using ${kept}.`
            : `Couldn't switch to ${wanted}. This chat is still using ${kept}.`,
        );
      }
    }
    const mode = this.sessionModes.get(s.id);
    if (this.liveSessions.has(s.id) && mode && mode !== runtimeMode) {
      // The agent's permissions changed (say Full access -> Ask first): the running session must follow now,
      // not when it next restarts. If the computer can't switch it, restart the session in the new mode.
      const switched = await this.d.agentd.request("session.set", { sessionKey: s.id, runtimeMode }).then(
        () => true,
        () => false,
      );
      if (switched) this.sessionModes.set(s.id, runtimeMode);
      else {
        await this.d.agentd.request("session.stop", { sessionKey: s.id }).catch(() => {});
        this.liveSessions.delete(s.id);
        await this.startNative(agentId, s.id, accountId, runtimeMode, effort, model);
      }
    }
    return s.id;
  }

  private async startNative(
    agentId: string,
    sessionKey: string,
    accountId: string,
    runtimeMode: "approval-required" | "auto" | "full-access",
    effort: string | null,
    model: string | null,
  ) {
    const s = this.d.store.getSession(sessionKey)!;
    const agent = this.d.store.getAgent(agentId)!;
    const settings = this.d.store.getSettings();
    const hasCursor = !!s.resumeCursor;
    const summary = hasCursor ? null : this.d.store.getContextSummary(agentId);
    // The current user message is sent as the turn itself, so it's left out of the seed (a /compact has none).
    const compactRun = !!this.rt(agentId).input?.compact;
    const openTasks = agent.kind === "helper" ? [] : this.d.store.listTasks(agentId);
    const parent = agent.kind === "helper" && agent.parentId ? this.d.store.getAgent(agent.parentId) : null;
    // Work & Personal: an agent leading a space (and its helpers) sees that space's memories and Everywhere's.
    const focus = focusOf(this.d.store, agent);
    const others = this.d.store.listAgents().filter((a) => a.id !== agentId);
    const counterpart = focus ? (others.find((a) => a.space && a.space !== focus) ?? null) : null;
    const team = parent ? [] : this.teamOf(agentId);
    const systemAppend = parent
      ? buildHelperSystemAppend({
          helper: agent,
          parent,
          brief: agent.brief ?? "",
          playbook: this.d.store.playbookRunOfHelper(agentId)?.playbook ?? null,
          settings,
          memories: this.d.store.listMemories(parent.id, { space: focus }),
          onePassword: this.d.onePasswordInfo?.() ?? null,
          now: new Date(),
        })
      : buildSystemAppend({
          agent,
          team,
          spaces: focus
            ? {
                hours: describeWorkHours(settings.workHours),
                counterpart: counterpart && { name: counterpart.name, role: counterpart.role },
              }
            : undefined,
          settings,
          memories: this.d.store.listMemories(agentId, { space: focus }),
          scratchpad: this.d.store.getScratchpad(agentId),
          routines: this.d.store.listRoutines(agentId),
          // A resumed native session already has its own history; a fresh one gets Yo's transcript — after a
          // /compact, the handoff summary plus only the messages since.
          priorConversation: hasCursor
            ? []
            : this.d.store
                .recentConversation(agentId, summary ? 16 : 24, summary?.uptoSeq ?? 0)
                .slice(0, compactRun ? undefined : -1),
          conversationSummary: hasCursor ? null : summary?.summary,
          openTasks,
          onePassword: this.d.onePasswordInfo?.() ?? null,
          now: new Date(),
        });
    // The session starts knowing the ledger and the team as they are now (its prompt shows both).
    this.rt(agentId).ledgerSeen = ledgerSig(openTasks);
    this.rt(agentId).teamSeen = parent ? null : this.teamSig(agentId);
    await this.d.accounts.configure(accountId);
    this.d.agentd.resetSeq(sessionKey);
    this.seqFlush.delete(sessionKey);
    this.d.store.updateSession(sessionKey, { lastSeq: 0 });
    if (hasCursor) this.resuming.add(sessionKey);
    else this.resuming.delete(sessionKey);
    await this.d.agentd.request(
      "session.start",
      {
        sessionKey,
        agentId,
        accountId,
        provider: s.provider,
        model: model ?? undefined,
        effort: effort ?? undefined,
        runtimeMode,
        systemAppend,
        resumeCursor: s.resumeCursor ?? undefined,
        toolset: this.toolsetOf(agent),
      },
      120000,
    );
    this.liveSessions.add(sessionKey);
    this.sessionModes.set(sessionKey, runtimeMode);
    this.sessionToAgent.set(sessionKey, agentId);
  }

  private finishTurn(agentId: string, turnId: string, status: string, usage?: unknown, error?: string) {
    const r = this.rt(agentId);
    if (r.runningTurn !== turnId && turnId !== "*") return;
    const endedTurn = turnId === "*" ? r.runningTurn : turnId;
    const compactRun = r.input?.compact;
    const trigger = r.input?.trigger;
    const exchangeId = r.input?.from?.exchangeId ?? null;
    const input = r.input;
    const health = r.health?.turnId === turnId ? r.health : null;
    r.input = null;
    r.health = null;
    if (compactRun && status !== "completed") {
      // Ended some other way (stopped, lost connection, failed to start): don't leave "Compacting…" spinning.
      const e = this.d.store.getEntry(`ntc_compact_${turnId}`);
      if (e && e.item.status === "running")
        this.upsert({
          ...e,
          item: {
            ...e.item,
            status: status === "interrupted" ? "completed" : "failed",
            text:
              status === "interrupted"
                ? "Compacting was stopped. Our conversation is unchanged."
                : "Couldn't compact our conversation. Nothing was lost.",
          },
        });
    }
    this.d.store.finishTurn(turnId, status, usage, error);
    // Ended without turn.completed (provider exited, Stop not confirmed, lost connection): keep the text that
    // streamed so far, which only lives in memory until now, so the reply doesn't vanish from the chat.
    if (r.sessionKey && turnId !== "*")
      for (const [itemId, text] of r.buffers) {
        const id = this.entryId(r.sessionKey, itemId);
        const existing = this.d.store.getEntry(id);
        if (existing && existing.item.status === "running" && text)
          this.d.store.upsertEntry({ id, agentId, turnId, item: { ...existing.item, text } });
      }
    r.buffers.clear();
    if (turnId !== "*")
      for (const e of this.d.store.closeRunningItems(turnId, status === "completed" ? "completed" : "failed"))
        this.d.hub.push("timeline.upsert", e);
    if (status !== "completed") this.expirePending(agentId);
    r.runningTurn = null;
    r.lastEventAt = Date.now();
    r.lastUsedAt = Date.now();
    this.seatMaybeFree();
    if (status === "failed") r.lastError = error ?? "failed";
    const agent = this.d.store.getAgent(agentId);
    this.d.store.addActivity({
      agentId,
      kind: status === "failed" ? "run.failed" : "run.completed",
      summary: compactRun
        ? `${agent?.name ?? "Agent"} ${status === "completed" ? "compacted the conversation" : "couldn't compact the conversation"}`
        : `${agent?.name ?? "Agent"} ${status === "failed" ? "hit a problem" : status === "interrupted" ? "was stopped" : "finished"}${error ? `: ${error.slice(0, 160)}` : ""}`,
      ref: turnId,
    });
    // A helper does one job: when it ends, its report goes to its parent and the helper is retired.
    if (agent?.kind === "helper") {
      this.retireHelper(agent, { turnId: turnId === "*" ? null : turnId, status, error, health });
      return;
    }
    // A check_helpers wait ends with the task (the call's answer has nowhere to go now).
    this.wakeHelperWaiters(agentId);
    const from = input?.from;
    const silent =
      status === "completed" &&
      (trigger === "routine" || trigger === "oversight" || trigger === "helper" || trigger === "agent") &&
      !compactRun &&
      this.quietRoutineReply(
        agentId,
        turnId,
        trigger === "oversight"
          ? "Team check: nothing to do."
          : trigger === "helper"
            ? "Helper report noted; waiting for the others."
            : trigger === "agent"
              ? from?.reply
                ? `Read ${from.name}'s reply; nothing to tell you yet.`
                : `Nothing to send back to ${from?.name ?? "my teammate"}.`
              : "Routine ran: nothing new to report.",
      );
    // Before the reply goes back to whoever asked (they hear how it went from it, so they get no team check).
    if (health && input) this.afterTeammateTurn(agentId, input, health, status, error);
    // Yo stopping a frozen or overlong task is no reason the user knows about: say it to whoever asked.
    const stopped =
      health?.stopped === "froze"
        ? "a step froze"
        : health?.stopped === "time limit"
          ? "it hit its time limit"
          : undefined;
    if (exchangeId && turnId !== "*") this.answerExchange(exchangeId, turnId, status, error ?? stopped);
    // Its own turn ended while still waiting on a teammate (the provider died, say): stop waiting, and
    // unless the user stopped it, pass the teammate's reply on as a new message when it comes.
    for (const ex of [...this.exchanges.values()].filter((x) => x.fromAgentId === agentId && x.resolve)) {
      ex.deliverLate = status !== "interrupted";
      this.stopWaiting(ex, "This task ended.");
    }
    if (status !== "interrupted" && !compactRun && !silent) {
      this.d.store.bumpUnread(agentId);
      const preview = this.d.store.lastAssistantPreview(agentId) ?? "";
      // A teammate asked: the reply shows in the asker's chat, so no popup for this side of it. A teammate's
      // reply waking this agent is different: what it says now is for the user.
      if (trigger !== "agent" || from?.reply)
        this.d.hub.push("notify", {
          agentId,
          title: agent?.name ?? "Yo",
          body: status === "failed" ? (error ?? "Something went wrong") : preview || "Done",
          kind: status === "failed" ? "error" : "done",
        });
    }
    if (endedTurn)
      this.emitTurn({ type: "ended", agentId, turnId: endedTurn, status, ...(error ? { error } : {}) });
    this.broadcast(agentId);
    // Reports that came while it waited in check_helpers but were never handed over: next in line.
    this.queueUndeliveredReports(agentId);
    const next = r.queue.shift();
    if (next) void this.runTurn(agentId, newId("trn"), next);
    else if (status === "completed" && !compactRun && this.needsCompaction(agentId)) {
      void this.compact(agentId, undefined, true).catch((err) => log.warn("auto-compact failed", err));
    }
  }

  /**
   * A routine that found nothing to report answers exactly NO_RESPONSE: its reply becomes a quiet note
   * and nobody is notified. Returns whether that happened.
   */
  private quietRoutineReply(agentId: string, turnId: string, note: string): boolean {
    const last = this.d.store
      .listTimeline(agentId, undefined, 20)
      .reverse()
      .find((e) => e.turnId === turnId && e.item.kind === "assistant_message");
    if (!last || last.item.text?.trim() !== SILENT_REPLY) return false;
    this.upsert({
      ...last,
      item: { ...last.item, kind: "notice", text: note },
    });
    return true;
  }

  /** Cards still waiting on the user for this agent (or one of its sessions) can no longer be answered. */
  private expirePending(agentId: string, sessionKey?: string) {
    const matches = (p: { agentId: string; sessionKey?: string }) =>
      p.agentId === agentId && (!sessionKey || !p.sessionKey || p.sessionKey === sessionKey);
    for (const call of [...this.toolCalls.values()].filter(matches))
      this.resolveToolCall(
        call.callId,
        DECISION_CARDS.has(call.tool) ? "expired" : "This request expired: the task ended.",
        "expired",
      );
    for (const [requestId, pr] of [...this.providerRequests].filter(([, pr]) => matches(pr))) {
      this.providerRequests.delete(requestId);
      const e = this.d.store.setRequestStatus(pr.entryId, "expired");
      if (e) this.upsert({ ...e, item: { ...e.item, status: "completed" } });
    }
  }

  /** Text streamed so far for a running assistant entry (the DB only gets it when the message completes). */
  liveText(entryId: string): string | undefined {
    const cut = entryId.indexOf(":");
    if (cut < 0) return undefined;
    const agentId = this.sessionToAgent.get(entryId.slice(0, cut));
    return agentId ? this.runtimes.get(agentId)?.buffers.get(entryId.slice(cut + 1)) : undefined;
  }

  /** Heavy conversation: lots of context tokens, or many turns on one native session. */
  private needsCompaction(agentId: string): boolean {
    const r = this.rt(agentId);
    if (!r.sessionKey) return false;
    const s = this.d.store.getSession(r.sessionKey);
    if (!s || s.endedAt) return false;
    return r.contextTokens >= AUTO_COMPACT_TOKENS || s.turnCount >= AUTO_COMPACT_TURNS;
  }

  /**
   * /compact: the agent writes a handoff summary of the conversation, then the heavy native session is ended.
   * The next turn starts a fresh, light session seeded with that summary plus the messages since.
   * Works the same on every provider (Yo owns continuity). Queued behind a running turn.
   */
  async compact(agentId: string, focus?: string, auto = false) {
    const agent = this.d.store.getAgent(agentId);
    if (!agent) throw new Error("Unknown agent");
    const r = this.rt(agentId);
    const input: QueuedInput = {
      text: "",
      attachments: [],
      trigger: "user",
      compact: { focus: focus?.trim() || undefined, auto },
    };
    if (r.runningTurn) {
      if (r.queue.some((q) => q.compact)) return;
      r.queue.push(input);
      if (!auto) this.notice(agentId, "I'll compact our conversation as soon as I finish this task.");
      this.broadcast(agentId);
      return;
    }
    const summary = this.d.store.getContextSummary(agentId);
    const s = r.sessionKey ? this.d.store.getSession(r.sessionKey) : null;
    const liveTurns = s && !s.endedAt ? s.turnCount : 0;
    const newMessages = this.d.store.recentConversation(agentId, 2, summary?.uptoSeq ?? 0).length;
    if (liveTurns === 0 && newMessages === 0) {
      if (!auto) this.notice(agentId, "Nothing to compact yet — our conversation is already light.");
      return;
    }
    const turnId = newId("trn");
    this.upsert({
      id: `ntc_compact_${turnId}`,
      agentId,
      turnId,
      item: {
        id: `compact_${turnId}`,
        kind: "notice",
        status: "running",
        text: auto
          ? "Our conversation is getting long, so I'm compacting it to stay quick…"
          : "Compacting our conversation…",
      },
    });
    r.compactText.clear();
    void this.runTurn(agentId, turnId, input);
  }

  /** A /compact turn ended: keep the summary and drop the heavy native session (or report why not). */
  private finishCompaction(
    agentId: string,
    sessionKey: string,
    turnId: string,
    status: string,
    error?: string,
  ) {
    const r = this.rt(agentId);
    const text = [...r.compactText.values(), ...r.buffers.values()].join("\n\n").trim();
    r.compactText.clear();
    r.buffers.clear();
    const noticeId = `ntc_compact_${turnId}`;
    const before = r.contextTokens;
    if (status === "completed" && text.length >= 40) {
      this.d.store.setContextSummary(agentId, text, this.d.store.maxTimelineSeq(agentId));
      if (this.liveSessions.has(sessionKey))
        void this.d.agentd.request("session.stop", { sessionKey }).catch(() => {});
      this.liveSessions.delete(sessionKey);
      this.d.store.endSession(sessionKey);
      if (r.sessionKey === sessionKey) r.sessionKey = null;
      r.contextTokens = 0;
      const words = text.split(/\s+/).length;
      const size = before >= 1000 ? `about ${Math.round(before / 1000)}k tokens of context → ` : "";
      this.upsert({
        id: noticeId,
        agentId,
        turnId,
        item: {
          id: `compact_${turnId}`,
          kind: "notice",
          status: "completed",
          text: `Compacted our conversation (${size}a ${words}-word summary). I'll continue from my notes on a fresh, lighter session.`,
        },
      });
    } else {
      this.upsert({
        id: noticeId,
        agentId,
        turnId,
        item: {
          id: `compact_${turnId}`,
          kind: "notice",
          status: status === "interrupted" ? "completed" : "failed",
          text:
            status === "interrupted"
              ? "Compacting was stopped. Our conversation is unchanged."
              : `Couldn't compact our conversation${error ? `: ${error}` : "."} Nothing was lost.`,
        },
      });
    }
  }

  /**
   * Stop the running task. The user's own queued messages (and routines) still run after it, and so do
   * teammates' replies to this agent's earlier messages; teammates' queued requests are dropped and their
   * senders told. `dropQueue` drops everything (archiving the agent).
   */
  async interrupt(agentId: string, opts: { dropQueue?: boolean } = {}) {
    const r = this.rt(agentId);
    const dropped = r.queue.filter((q) => opts.dropQueue || (q.from && !q.from.reply) || q.oversight);
    r.queue = r.queue.filter((q) => !dropped.includes(q));
    // Teammates waiting on messages that won't run now get told instead of waiting forever.
    for (const q of dropped)
      if (q.from?.exchangeId) this.answerExchange(q.from.exchangeId, null, "interrupted");
    // This agent stops waiting on its own questions to teammates (they still finish; nothing comes back).
    // Messages it sent without waiting are separate work: their replies still come.
    for (const ex of [...this.exchanges.values()].filter((x) => x.fromAgentId === agentId && x.resolve)) {
      ex.deliverLate = false;
      this.stopWaiting(ex, "The user stopped this task.");
    }
    // It stops waiting for its helpers (they keep working; their reports still come).
    this.wakeHelperWaiters(agentId);
    // Unblock any Yo tool calls waiting on the user.
    for (const call of [...this.toolCalls.values()].filter((c) => c.agentId === agentId)) {
      this.resolveToolCall(
        call.callId,
        call.tool === DEVICE_WRITE_TOOL ? "expired" : "The user stopped this task.",
        "expired",
      );
    }
    if (r.runningTurn && (r.seatWait || !r.turnSentAt)) {
      // Still starting (waiting for a free screen, waking the computer, starting its session): nothing
      // reached the model yet, so it just ends; runTurn sees that and doesn't send it.
      this.finishTurn(agentId, r.runningTurn, "interrupted");
      this.seatMaybeFree();
    } else if (r.sessionKey && r.runningTurn) {
      const turnId = r.runningTurn;
      await this.d.agentd.request("turn.interrupt", { sessionKey: r.sessionKey }).catch(() => {});
      if (this.disposed) return;
      // If the provider doesn't confirm quickly, close the turn ourselves.
      this.later(8000, () => {
        if (!this.disposed && this.runtimes.get(agentId)?.runningTurn === turnId)
          this.finishTurn(agentId, turnId, "interrupted");
      });
    } else {
      // A helper with nothing running (say, it never got to start) is retired right away.
      const helper = this.d.store.getAgent(agentId);
      if (helper?.kind === "helper" && !helper.archivedAt && !r.runningTurn)
        return this.retireHelper(helper, { turnId: null, status: "interrupted" });
    }
    if (this.runtimes.has(agentId)) this.broadcast(agentId);
  }

  async newSession(agentId: string) {
    const r = this.rt(agentId);
    if (r.runningTurn) await this.interrupt(agentId);
    if (r.sessionKey) {
      if (this.liveSessions.has(r.sessionKey))
        await this.d.agentd.request("session.stop", { sessionKey: r.sessionKey }).catch(() => {});
      this.liveSessions.delete(r.sessionKey);
      this.d.store.endSession(r.sessionKey);
      r.sessionKey = null;
    }
    r.contextTokens = 0;
    this.notice(agentId, "Started a fresh session. I still have my memory and notes.");
  }

  /** A model was just connected: agents stuck on "connect a model" leave their error state. */
  private modelConnected() {
    if (this.disposed) return;
    for (const r of this.runtimes.values()) {
      if (!r.needsModel || r.runningTurn) continue;
      r.needsModel = false;
      r.lastError = null;
      this.notice(r.agentId, "A model is connected now. Send your message again and I'll get started.");
      this.broadcast(r.agentId);
    }
  }

  /* ------------------------------ agentd events ---------------------------- */

  private onConnected() {
    if (this.firstConnect) {
      // Core (re)started: provider sessions on agentd belong to the previous core process. Stop them so the
      // next turn resumes cleanly from the stored cursor.
      for (const s of this.d.store.openSessions()) {
        void this.d.agentd.request("session.stop", { sessionKey: s.id }).catch(() => {});
      }
      this.firstConnect = false;
    }
    // Helpers retired while the computer was out of reach (a restart): free their screens now.
    for (const id of [...this.pendingDiscards]) {
      this.pendingDiscards.delete(id);
      void this.discardComputer(id);
    }
    void this.syncComputers().catch((err) => log.debug("computer sync failed", err));
    // Detect turns that were lost because agentd restarted. A newer agentd says which sessions survived,
    // so a turn on a live session (waiting on an approval, or running a long quiet command) carries on.
    // An older one doesn't: then a turn that went quiet is presumed lost, unless it's waiting on the user.
    const reconnectAt = Date.now();
    const live = this.d.agentd.info?.liveSessions;
    const lost = (r: AgentRuntime) => {
      if (live) return !r.sessionKey || !live.includes(r.sessionKey);
      return r.lastEventAt < reconnectAt && !this.hasPending(r.agentId);
    };
    this.later(this.d.lostTurnGraceMs ?? 20000, () => {
      if (this.disposed) return;
      for (const r of this.runtimes.values()) {
        // Only turns agentd already had: one that woke the computer (or was still starting its session) when
        // this connection came up is sent afterwards, on a session the reconnect's list can't include.
        if (r.runningTurn && r.turnSentAt && r.turnSentAt < reconnectAt && lost(r)) {
          this.notice(
            r.agentId,
            "I lost connection to my computer during this task. Ask me to pick it back up.",
            {
              turnId: r.runningTurn,
              error: true,
            },
          );
          if (r.sessionKey) this.liveSessions.delete(r.sessionKey);
          this.finishTurn(r.agentId, r.runningTurn, "failed", undefined, "Lost connection to computer");
        }
      }
    });
  }

  private onPush(p: AgentdPush) {
    switch (p.type) {
      case "event":
        this.onEvent(p.sessionKey, p.seq, p.event);
        break;
      case "tool.call":
        void this.onToolCall(p);
        break;
      case "computer.state": {
        if (this.retiredHelper(p.agentId)) break;
        const r = this.rt(p.agentId);
        r.computer = p.state;
        if (p.lease) r.lease = p.lease;
        this.broadcast(p.agentId);
        this.seatMaybeFree();
        break;
      }
      default:
        break;
    }
  }

  private flushSeqs() {
    for (const [k, seq] of this.seqFlush) this.d.store.updateSession(k, { lastSeq: seq });
    this.seqFlush.clear();
  }

  private entryId(sessionKey: string, itemId: string) {
    return `${sessionKey}:${itemId}`;
  }

  private onEvent(sessionKey: string, seq: number, ev: ProviderEvent) {
    const agentId = this.sessionToAgent.get(sessionKey) ?? this.d.store.getSession(sessionKey)?.agentId;
    if (!agentId || this.abandoned.has(sessionKey)) return;
    this.sessionToAgent.set(sessionKey, agentId);
    this.seqFlush.set(sessionKey, seq);
    const r = this.rt(agentId);
    // The provider confirming, late, a task Yo already closed (Stop or a time limit it didn't confirm within
    // seconds): it must not end the task running now (the user's next message). Keep its resume cursor only.
    if (ev.type === "turn.completed" && r.runningTurn && ev.turnId && ev.turnId !== r.runningTurn) {
      log.info(`late completion of closed turn ${ev.turnId} ignored (running: ${r.runningTurn})`);
      if (ev.resumeCursor) this.d.store.updateSession(sessionKey, { resumeCursor: ev.resumeCursor });
      return;
    }
    r.lastEventAt = Date.now();
    const session = this.d.store.getSession(sessionKey);
    const source = session ? { provider: session.provider, model: session.model } : undefined;

    // A /compact turn: collect the summary instead of showing it as a chat message.
    const compacting = !!r.input?.compact && !!r.runningTurn && r.sessionKey === sessionKey;
    if (compacting) {
      if (ev.type === "content.delta") {
        if (ev.stream !== "reasoning" && ev.stream !== "command_output")
          r.buffers.set(ev.itemId, (r.buffers.get(ev.itemId) ?? "") + ev.delta);
        return;
      }
      if (ev.type === "item.started" || ev.type === "item.updated" || ev.type === "item.completed") {
        if (ev.item.kind === "assistant_message") {
          const text = ev.item.text ?? r.buffers.get(ev.item.id) ?? "";
          if (ev.type === "item.completed") {
            r.buffers.delete(ev.item.id);
            if (text) r.compactText.set(ev.item.id, text);
          } else if (text) r.buffers.set(ev.item.id, text);
        }
        return;
      }
      if (ev.type === "turn.completed") {
        if (ev.status === "failed" && this.recoverLostResume(agentId, sessionKey, ev.error)) return;
        if (ev.status === "completed") this.resuming.delete(sessionKey);
        const turnId = r.runningTurn!;
        this.finishCompaction(agentId, sessionKey, turnId, ev.status, ev.error);
        this.finishTurn(agentId, turnId, ev.status, ev.usage, ev.error);
        return;
      }
    }

    switch (ev.type) {
      case "session.started":
        if (ev.resumeCursor) this.d.store.updateSession(sessionKey, { resumeCursor: ev.resumeCursor });
        if (ev.model && session && !session.model)
          this.d.store.updateSession(sessionKey, { model: ev.model });
        break;
      case "turn.completed": {
        if (ev.status === "failed" && this.recoverLostResume(agentId, sessionKey, ev.error)) break;
        if (ev.status === "completed") this.resuming.delete(sessionKey);
        if (ev.resumeCursor) this.d.store.updateSession(sessionKey, { resumeCursor: ev.resumeCursor });
        // Persist any still-streaming assistant text.
        for (const [itemId, text] of r.buffers) {
          const id = this.entryId(sessionKey, itemId);
          const existing = this.d.store.getEntry(id);
          if (existing && existing.item.status === "running")
            this.upsert({
              id,
              agentId,
              turnId: r.runningTurn,
              item: { ...existing.item, text, status: "completed" },
            });
        }
        r.buffers.clear();
        if (ev.status === "failed" && ev.error && !(r.runningTurn && r.signInNoticeTurn === r.runningTurn))
          this.notice(agentId, ev.error, { turnId: r.runningTurn, error: true });
        // Conversation size as the model last saw it: drives auto-compaction. (Summed input/cache counters
        // grow with every tool step, so they're not used for this.)
        if (ev.usage?.contextTokens && r.sessionKey === sessionKey) r.contextTokens = ev.usage.contextTokens;
        if (r.runningTurn) this.finishTurn(agentId, r.runningTurn, ev.status, ev.usage, ev.error);
        break;
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = { ...ev.item };
        if (item.kind === "assistant_message") {
          if (ev.type === "item.completed") {
            item.text = item.text ?? r.buffers.get(item.id) ?? "";
            r.buffers.delete(item.id);
          } else {
            item.text = item.text ?? r.buffers.get(item.id) ?? "";
            if (item.text) r.buffers.set(item.id, item.text);
          }
        }
        if (item.kind === "todo" && item.todos) {
          r.todos = item.todos;
          this.broadcast(agentId);
        }
        // Plan updates within a turn collapse into one live checklist card.
        const todoTurn = item.kind === "todo" ? (r.runningTurn ?? ev.turnId) : null;
        if (todoTurn) {
          const planId = `${sessionKey}:plan:${todoTurn}`;
          const prev = this.d.store.getEntry(planId);
          if (!item.todos && prev?.item.todos) item.todos = prev.item.todos;
          this.upsert({
            id: planId,
            agentId,
            turnId: r.runningTurn,
            item: { ...item, id: `plan_${todoTurn}` },
          });
          break;
        }
        const entryId = this.entryId(sessionKey, item.id);
        const previous = this.d.store.getEntry(entryId);
        this.upsert({
          id: entryId,
          agentId,
          turnId: r.runningTurn,
          item,
          source: item.kind === "assistant_message" ? source : undefined,
        });
        if (ev.type === "item.completed" && item.kind === "assistant_message" && item.text?.includes("!["))
          void this.attachImageSnapshots(agentId, entryId, item.text);
        if (
          ev.type === "item.completed" &&
          r.sessionKey === sessionKey &&
          (!ev.turnId || ev.turnId === r.runningTurn) &&
          previous?.item.status !== "completed" &&
          previous?.item.status !== "failed"
        )
          this.noteStep(r, item);
        break;
      }
      case "content.delta": {
        const id = this.entryId(sessionKey, ev.itemId);
        const buf = (r.buffers.get(ev.itemId) ?? "") + ev.delta;
        r.buffers.set(ev.itemId, buf);
        if (!this.d.store.getEntry(id)) {
          const kind =
            ev.stream === "reasoning"
              ? "reasoning"
              : ev.stream === "command_output"
                ? "command"
                : "assistant_message";
          this.upsert({
            id,
            agentId,
            turnId: r.runningTurn,
            item: { id: ev.itemId, kind, status: "running", text: "" },
            source: kind === "assistant_message" ? source : undefined,
          });
        }
        this.d.hub.push("timeline.delta", { agentId, entryId: id, delta: ev.delta, stream: ev.stream });
        break;
      }
      case "request.opened":
        this.onProviderRequest(agentId, sessionKey, ev.request);
        break;
      case "request.resolved": {
        const pr = this.providerRequests.get(ev.requestId);
        if (pr) {
          this.providerRequests.delete(ev.requestId);
          const e = this.d.store.setRequestStatus(pr.entryId, ev.decision === "deny" ? "denied" : "allowed");
          if (e) this.d.hub.push("timeline.upsert", e);
          this.broadcast(agentId);
        }
        break;
      }
      case "rate_limit": {
        const accountId = session?.accountId;
        if (accountId) {
          const a = this.d.store.updateAccount(accountId, { rateLimit: ev.info });
          if (a) this.d.hub.push("account.updated", a);
        }
        if (ev.info.status === "limited") {
          const when = ev.info.resetsAt ? ` It resets ${new Date(ev.info.resetsAt).toLocaleString()}.` : "";
          this.notice(agentId, `Your subscription's usage limit was reached.${when}`, { error: true });
        }
        break;
      }
      case "runtime.error":
        if (ev.auth) {
          // The provider turned the saved sign-in down (expired, signed out): the account shows "Sign in again"
          // right away, and this session (started with the old sign-in) is replaced on the next message.
          this.signInRejected.add(sessionKey);
          r.signInNoticeTurn = r.runningTurn;
          if (session?.accountId) this.d.accounts.markSignInExpired(session.accountId);
        }
        if (ev.fatal && this.recoverLostResume(agentId, sessionKey, ev.message)) break;
        this.notice(agentId, ev.message, { turnId: r.runningTurn, error: true });
        if (ev.fatal) {
          this.liveSessions.delete(sessionKey);
          if (r.runningTurn) this.finishTurn(agentId, r.runningTurn, "failed", undefined, ev.message);
        }
        break;
      case "session.exited":
        if (this.recoverLostResume(agentId, sessionKey, ev.reason)) break;
        this.liveSessions.delete(sessionKey);
        this.expirePending(agentId, sessionKey);
        if (r.runningTurn && r.sessionKey === sessionKey)
          this.finishTurn(agentId, r.runningTurn, "failed", undefined, ev.reason ?? "Session ended");
        break;
      default:
        break;
    }
  }

  /**
   * The provider couldn't find the conversation we tried to resume (the computer was moved or reset).
   * Drop that native session and quietly rerun the turn on a fresh one seeded from Yo's own history.
   */
  private recoverLostResume(agentId: string, sessionKey: string, error: string | undefined): boolean {
    if (!this.resuming.has(sessionKey) || !error || !RESUME_LOST.test(error)) return false;
    const r = this.rt(agentId);
    const turnId = r.runningTurn;
    const input = r.input;
    if (!turnId || !input || r.sessionKey !== sessionKey) return false;
    log.warn(`session ${sessionKey} could not be resumed (${error.slice(0, 120)}); starting fresh`);
    this.resuming.delete(sessionKey);
    this.abandoned.add(sessionKey);
    this.liveSessions.delete(sessionKey);
    void this.d.agentd.request("session.stop", { sessionKey }).catch(() => {});
    this.d.store.endSession(sessionKey);
    this.d.store.finishTurn(turnId, "failed", undefined, error);
    this.expirePending(agentId, sessionKey);
    r.sessionKey = null;
    r.runningTurn = null;
    r.buffers.clear();
    void this.runTurn(agentId, newId("trn"), input);
    return true;
  }

  private async attachImageSnapshots(agentId: string, entryId: string, text: string) {
    if (!this.d.snapshotImages) return;
    try {
      const images = await this.d.snapshotImages(agentId, text);
      if (!Object.keys(images).length) return;
      const e = this.d.store.getEntry(entryId);
      if (!e) return;
      this.upsert({ ...e, item: { ...e.item, images } });
    } catch (err) {
      log.warn("image snapshot failed", err);
    }
  }

  /* ------------------------------ approvals -------------------------------- */

  private onProviderRequest(agentId: string, sessionKey: string, req: PendingRequest) {
    const r = this.rt(agentId);
    const entryId = this.entryId(sessionKey, `req_${req.requestId}`);
    if (req.kind === "tool_approval" && req.toolName) {
      const rule = this.d.store.findRule(this.ruleOwner(agentId), req.toolName);
      if (rule) {
        void this.d.agentd
          .request("request.respond", {
            sessionKey,
            requestId: req.requestId,
            decision: rule.decision === "allow" ? "allow" : "deny",
          })
          .catch(() => {});
        return;
      }
    }
    this.providerRequests.set(req.requestId, { agentId, sessionKey, entryId, toolName: req.toolName });
    this.expireUnanswered(
      agentId,
      () => this.providerRequests.has(req.requestId),
      (waited) => {
        this.providerRequests.delete(req.requestId);
        void this.d.agentd
          .request("request.respond", {
            sessionKey,
            requestId: req.requestId,
            decision: "deny",
            message: unanswered(req.kind === "user_input" ? "ask_user" : "approval", waited),
          })
          .catch(() => {});
        const e = this.d.store.setRequestStatus(entryId, "expired");
        if (e) this.upsert({ ...e, item: { ...e.item, status: "completed" } });
        this.broadcast(agentId);
      },
    );
    this.upsert({
      id: entryId,
      agentId,
      turnId: r.runningTurn,
      item: {
        id: `req_${req.requestId}`,
        kind: "tool",
        status: "running",
        title: req.title,
        toolName: req.toolName,
        input: req.input,
      },
      request: { ...req, status: "pending" },
    });
    this.needsYou(agentId, req.title);
  }

  private needsYou(agentId: string, what: string) {
    const agent = this.d.store.getAgent(agentId);
    // A helper's card shows in its parent's chat: the notification opens that chat.
    const parent = agent?.kind === "helper" && agent.parentId ? this.d.store.getAgent(agent.parentId) : null;
    const who = parent ? `${parent.name}'s helper` : (agent?.name ?? "Agent");
    this.d.store.addActivity({
      agentId: parent?.id ?? agentId,
      kind: "approval",
      summary: `${who} needs you: ${parent ? `${agent!.name}: ` : ""}${what}`,
      ref: parent ? agentId : null,
    });
    this.d.hub.push("notify", {
      agentId: parent?.id ?? agentId,
      title: `${parent ? who : (agent?.name ?? "Yo")} needs you`,
      body: parent ? `${agent!.name}: ${what}` : what,
      kind: "needs_you",
    });
    this.broadcast(agentId);
  }

  /** Whose "always allow" rules apply: a helper's are its parent's (an "always" on its card is for both). */
  private ruleOwner(agentId: string): string {
    const a = this.d.store.getAgent(agentId);
    return a?.kind === "helper" && a.parentId ? a.parentId : agentId;
  }

  async respond(
    _agentId: string,
    requestId: string,
    decision: Decision,
    answers?: Record<string, string>,
    message?: string,
    secureValues?: string[],
  ) {
    const call = this.toolCalls.get(requestId);
    if (call) {
      let text: string;
      let status: "allowed" | "denied" | "answered";
      if (call.tool === SECURE_INPUT_TOOL) {
        // The values go to the waiting tool call and nowhere else. The card stays pending until the fill
        // finishes: "Submitted" only after the page took them, and a failed fill is shown as a failure.
        if (call.filling) throw new Error("Yo is still typing this into the page.");
        if (decision === "deny") {
          text =
            "The user cancelled the secure form, so nothing was typed. Don't ask for these values in chat: ask what they'd like to do instead.";
          status = "denied";
        } else {
          const fields = (call.args.fields ?? []) as SecureField[];
          const clean = cleanSecureValues(fields, secureValues);
          if ("error" in clean) throw new Error(clean.error);
          call.filling = true;
          const settled = new Promise<void>((resolve) => {
            call.onFilled = resolve;
          });
          call.secureValues?.(clean.values);
          call.resolve(SECURE_SUBMITTED);
          await settled;
          return;
        }
      } else if (call.tool === "ask_user") {
        const answer = answers ? Object.values(answers).join("; ") : (message ?? "");
        text =
          decision === "deny"
            ? "The user declined to answer."
            : `The user answered: ${answer || "(no answer)"}`;
        status = decision === "deny" ? "denied" : "answered";
      } else if (call.tool === DEVICE_WRITE_TOOL) {
        // Exact-action approval: there is no "always" for writes to the user's Mac.
        text = decision === "deny" ? "deny" : "allow";
        status = decision === "deny" ? "denied" : "allowed";
      } else if (call.tool === ONE_PASSWORD_APPROVAL) {
        // "Always allow" is for this one site (any 1Password login on it).
        const host = String(call.args.host ?? "");
        if (decision === "allowAlways" && host)
          this.d.store.addRule({
            agentId: this.ruleOwner(call.agentId),
            match: onePasswordRule(host),
            decision: "allow",
          });
        text = decision === "deny" ? "deny" : "allow";
        status = decision === "deny" ? "denied" : "allowed";
      } else if (call.tool === "request_takeover") {
        text =
          decision === "deny"
            ? `The user declined to take over.${message ? ` They said: ${message}` : ""}`
            : `The user took over and has handed control back.${message ? ` They said: ${message}` : ""} Take a screenshot/snapshot to see the current state before continuing.`;
        status = decision === "deny" ? "denied" : "answered";
      } else if (PHONE_TOOLS.includes(call.tool)) {
        // One at a time, like adding an agent: no "always" for phone links.
        text =
          decision === "deny"
            ? `DENIED by the user.${message ? ` The user said: ${message}` : ""}`
            : `APPROVED${message ? ` The user said: ${message}` : ""}`;
        status = decision === "deny" ? "denied" : "allowed";
      } else if (call.tool === "create_agent") {
        // Adding an agent is approved one at a time: there's no "always" for it.
        text =
          decision === "deny"
            ? `DENIED by the user. Don't add this agent.${message ? ` The user said: ${message}` : ""}`
            : `APPROVED${message ? ` The user said: ${message}` : ""}`;
        status = decision === "deny" ? "denied" : "allowed";
      } else {
        if (decision === "allowAlways") {
          const category = String(call.args.category ?? "other");
          this.d.store.addRule({
            agentId: this.ruleOwner(call.agentId),
            match: `yo:${category}`,
            decision: "allow",
          });
        }
        text =
          decision === "deny"
            ? `DENIED by the user. Do not perform this action.${message ? ` The user said: ${message}` : ""}`
            : `APPROVED by the user. Go ahead.${message ? ` The user said: ${message}` : ""}`;
        status = decision === "deny" ? "denied" : "allowed";
      }
      this.resolveToolCall(
        requestId,
        text,
        status,
        call.tool === "ask_user" && decision !== "deny" ? answers : undefined,
      );
      return;
    }
    const pr = this.providerRequests.get(requestId);
    if (!pr) throw new Error("This request is no longer pending.");
    if (decision === "allowAlways" && pr.toolName)
      this.d.store.addRule({ agentId: this.ruleOwner(pr.agentId), match: pr.toolName, decision: "allow" });
    await this.d.agentd.request("request.respond", {
      sessionKey: pr.sessionKey,
      requestId,
      decision,
      answers,
      message,
    });
    this.providerRequests.delete(requestId);
    const e = this.d.store.setRequestStatus(
      pr.entryId,
      decision === "deny" ? "denied" : answers ? "answered" : "allowed",
      decision === "deny" ? undefined : answers,
    );
    if (e) this.upsert({ ...e, item: { ...e.item, status: "completed" } });
    this.broadcast(pr.agentId);
  }

  private resolveToolCall(
    callId: string,
    text: string,
    status: "allowed" | "denied" | "answered" | "expired",
    answers?: Record<string, string>,
  ) {
    const call = this.toolCalls.get(callId);
    if (!call) return;
    this.toolCalls.delete(callId);
    const e = this.d.store.setRequestStatus(call.entryId, status, answers);
    const output = DECISION_CARDS.has(call.tool)
      ? (({ allow: "Approved", deny: "Declined", expired: "Expired" } as Record<string, string>)[text] ??
        text)
      : text;
    if (e) {
      const done = this.d.store.upsertEntry({ ...e, item: { ...e.item, status: "completed", output } });
      this.d.hub.push("timeline.upsert", done);
    }
    call.resolve(text);
    this.broadcast(call.agentId);
  }

  /** User handed control back after a takeover: resolve pending takeover requests. */
  releaseTakeover(agentId: string, note?: string) {
    for (const call of [...this.toolCalls.values()].filter(
      (c) => c.agentId === agentId && c.tool === "request_takeover",
    )) {
      void this.respond(agentId, call.callId, "allow", undefined, note);
    }
  }

  pendingRequestEntries(): TimelineEntry[] {
    return this.d.store.pendingRequests();
  }

  /* ------------------------------- Yo tools -------------------------------- */

  private async onToolCall(p: Extract<AgentdPush, { type: "tool.call" }>) {
    // Re-sent after an agentd reconnect while the first delivery is still being handled (e.g. a card
    // waiting on the user): that first handler replies, so a second card would only be a dead duplicate.
    if (this.inFlightCalls.has(p.callId)) {
      // It also proves the turn survived the reconnect, so the lost-connection check mustn't fail it.
      this.rt(p.agentId).lastEventAt = Date.now();
      return;
    }
    this.inFlightCalls.add(p.callId);
    try {
      await this.handleToolCall(p);
    } finally {
      this.inFlightCalls.delete(p.callId);
    }
  }

  private async handleToolCall(p: Extract<AgentdPush, { type: "tool.call" }>) {
    const agentId = p.agentId;
    const reply = (ok: boolean, text: string) =>
      this.d.agentd
        .request("tool.result", { callId: p.callId, ok, text })
        .catch((err) => log.warn("tool.result failed", err));
    // Tool calls come over a socket any process in the computer could reach: only accept calls whose
    // sessionKey belongs to the claimed agent.
    const owner = p.sessionKey
      ? (this.sessionToAgent.get(p.sessionKey) ?? this.d.store.getSession(p.sessionKey)?.agentId)
      : null;
    if (!owner || owner !== agentId) {
      log.warn(`rejected tool call ${p.tool}: session/agent mismatch`);
      await reply(false, "Error: tool call rejected (unknown session)");
      return;
    }
    // A helper's tool set is smaller; an older computer may still offer it the rest.
    const caller = this.d.store.getAgent(agentId);
    if (caller?.kind === "helper" && !toolAllowed("helper", p.tool)) {
      await reply(
        false,
        `Error: ${p.tool} isn't available to helpers. Do your one job and put anything else in your report.`,
      );
      return;
    }
    try {
      if (p.tool === "start_helper") {
        await reply(true, await this.startHelper(agentId, p.args));
        return;
      }
      if (p.tool === "check_helpers") {
        await reply(true, await this.checkHelpers(agentId, p.args));
        return;
      }
      if (p.tool === "stop_helper") {
        await reply(true, await this.stopHelper(agentId, p.args));
        return;
      }
      if (p.tool === "playbook_list") {
        await reply(true, await this.playbookList(agentId));
        return;
      }
      if (DEVICE_TOOLS.has(p.tool)) {
        if (!this.d.deviceTools) {
          await reply(false, "Error: Mac access isn't available on this Yo core.");
          return;
        }
        const r = this.rt(agentId);
        const text = await this.d.deviceTools(p.tool, p.args, {
          agentId,
          turnId: r.runningTurn,
          route: r.input?.route ?? "auto",
          askApproval: (title, details) =>
            this.askDeviceWrite(agentId, p.callId, title, { deviceWrite: details }),
          askAction: (title, details) =>
            this.askDeviceWrite(agentId, p.callId, title, { deviceAction: details }),
        });
        await reply(true, text);
        return;
      }
      if (p.tool === "message_agent") {
        await reply(true, await this.messageAgent(agentId, p.args));
        return;
      }
      if (p.tool === "create_agent") {
        await reply(true, await this.createAgentTool(agentId, p));
        return;
      }
      if (PHONE_TOOLS.includes(p.tool)) {
        await reply(true, await this.phoneTool(agentId, p));
        return;
      }
      if (p.tool === SECURE_INPUT_TOOL) {
        await reply(true, await this.secureInput(agentId, p));
        return;
      }
      if (ONE_PASSWORD_TOOLS.includes(p.tool)) {
        if (!this.onePassword) throw new Error("1Password isn't available on this Yo core.");
        await reply(true, await this.onePassword(agentId, p.callId, p.tool, p.args));
        return;
      }
      const interactive = this.interactiveTool(agentId, p);
      if (interactive) {
        const text = await interactive;
        await reply(true, text);
        return;
      }
      const text = await this.d.tools(agentId, p.tool, p.args);
      if (p.tool === "notify_user")
        this.notice(agentId, String(p.args.message ?? ""), { turnId: this.rt(agentId).runningTurn });
      // Its own ledger change: no need to tell it on the next message.
      if (p.tool.startsWith("task_"))
        this.rt(agentId).ledgerSeen = ledgerSig(this.d.store.listTasks(agentId));
      await reply(true, text);
    } catch (err: any) {
      await reply(false, `Error: ${err?.message ?? err}`);
    }
  }

  /** Exact-action card for a change on the user's Mac. Resolves "allow" | "deny" | "expired". */
  private askDeviceWrite(
    agentId: string,
    callId: string,
    title: string,
    payload: { deviceWrite: DeviceWriteRequest } | { deviceAction: DeviceActionRequest },
  ): Promise<"allow" | "deny" | "expired"> {
    const entryId = newId("req");
    const r = this.rt(agentId);
    const details = "deviceWrite" in payload ? payload.deviceWrite : payload.deviceAction;
    const request: PendingRequest = {
      requestId: callId,
      kind: "tool_approval",
      // Both kinds share the exact-action rules in respond() (never "always allow").
      toolName: DEVICE_WRITE_TOOL,
      title,
      detail:
        "deviceWrite" in payload
          ? `${payload.deviceWrite.displayPath} on ${details.deviceName}`
          : `${payload.deviceAction.lines.map((l) => `${l.label}: ${l.value}`).join(" · ")}`.slice(0, 300),
      ...payload,
    };
    this.upsert({
      id: entryId,
      agentId,
      turnId: r.runningTurn,
      item: {
        id: newId("itm"),
        kind: "tool",
        status: "running",
        title,
        toolName: DEVICE_WRITE_TOOL,
        input:
          "deviceWrite" in payload
            ? { path: payload.deviceWrite.displayPath, bytes: payload.deviceWrite.bytes }
            : { app: payload.deviceAction.app },
      },
      request: { ...request, status: "pending" },
    });
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.resolveToolCall(callId, "expired", "expired"),
        Math.max(1000, details.expiresAt - Date.now()),
      );
      timer.unref();
      this.toolCalls.set(callId, {
        callId,
        agentId,
        entryId,
        tool: DEVICE_WRITE_TOOL,
        args: {},
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text === "allow" ? "allow" : text === "deny" ? "deny" : "expired");
        },
      });
      this.needsYou(agentId, title);
    });
  }

  /**
   * The 1Password card: "Sign in to github.com with 1Password?". Its answer goes back to the fill tool, which
   * types the login only on "allow". "Always allow" saves `yo:1password:<host>` (Settings → Rules).
   */
  askOnePassword(agentId: string, callId: string, a: FillApproval): Promise<"allow" | "deny" | "expired"> {
    const entryId = newId("req");
    const r = this.rt(agentId);
    const title = `Sign in to ${a.host} with 1Password?`;
    const name = this.d.store.getAgent(agentId)?.name ?? "Yo";
    const request: PendingRequest = {
      requestId: callId,
      kind: "tool_approval",
      toolName: ONE_PASSWORD_APPROVAL,
      title,
      detail: `${name} types the ${fieldWords(a.fields)} from your 1Password login "${a.item}" into the page on ${a.host} and submits it. ${name} never sees them.`,
      input: { site: a.host, login: a.item },
    };
    this.upsert({
      id: entryId,
      agentId,
      turnId: r.runningTurn,
      item: {
        id: newId("itm"),
        kind: "tool",
        status: "running",
        title,
        toolName: ONE_PASSWORD_APPROVAL,
        input: { site: a.host, login: a.item },
      },
      request: { ...request, status: "pending" },
    });
    return new Promise((resolve) => {
      this.toolCalls.set(callId, {
        callId,
        agentId,
        entryId,
        tool: ONE_PASSWORD_APPROVAL,
        args: { host: a.host },
        resolve: (text) => resolve(text === "allow" ? "allow" : text === "deny" ? "deny" : "expired"),
      });
      this.expireUnanswered(
        agentId,
        () => this.toolCalls.has(callId),
        () => this.resolveToolCall(callId, "expired", "expired"),
      );
      this.needsYou(agentId, title);
    });
  }

  /**
   * Mark the secure-form card once the fill has finished. "Submitted" only when the page took the values.
   * A failure uses fixed words, never the browser's error (that text can quote what was typed).
   */
  private finishSecureForm(callId: string, outcome: "submitted" | "failed") {
    const call = this.toolCalls.get(callId);
    if (!call) return;
    this.toolCalls.delete(callId);
    const e = this.d.store.getEntry(call.entryId);
    if (!e?.request) return;
    const submitted = outcome === "submitted";
    const done = this.d.store.upsertEntry({
      ...e,
      item: {
        ...e.item,
        status: submitted ? "completed" : "failed",
        output: submitted ? SECURE_SUBMITTED : SECURE_FILL_FAILED_OUTPUT,
      },
      request: { ...e.request, status: submitted ? "answered" : "failed" },
    });
    this.d.hub.push("timeline.upsert", done);
    this.broadcast(call.agentId);
  }

  /**
   * request_secure_input: check the page is on the site and shows the fields (no values sent), show the secure
   * form for the page the dry run actually found, then type what the user entered into that page through
   * agentd's browser.fillLogin. The values live only in this call: never in the timeline, the database, logs,
   * pushes or the agent's result.
   */
  private async secureInput(agentId: string, p: Extract<AgentdPush, { type: "tool.call" }>): Promise<string> {
    const parsed = RequestSecureInputInput.safeParse(p.args);
    if (!parsed.success)
      throw new Error(parsed.error.issues[0]?.message ?? "Invalid request_secure_input call");
    const { reason, fields } = parsed.data;
    const host = siteHost(parsed.data.site);
    if (!host || !isSpecificSite(host))
      throw new Error(
        `"${parsed.data.site}" isn't a website Yo can limit a form to. Pass a specific site, e.g. "uber.com". A shared ending like "github.io" or "vercel.app" isn't one site.`,
      );
    const plan = secureFillKinds(fields);
    if ("error" in plan) throw new Error(plan.error);
    const ask = (sites: ReturnType<typeof secureSites>, values?: string[]) =>
      this.d.agentd.request(
        "browser.fillLogin",
        {
          agentId,
          sites,
          fields: plan.kinds.map((kind, i) => (values ? { kind, value: values[i] } : { kind })),
          dryRun: !values,
        },
        45_000,
      );

    // Find the page first, so the user is only asked when there's somewhere to put the values.
    const probe = await ask(secureSites(host)).catch((err) => {
      throw secureFillError(err, host);
    });
    const pageHost = pageHostOf(probe.host);
    if (!pageHost || isPublicSuffix(pageHost) || !onSite(pageHost, host))
      throw new Error(
        `The open page is on ${probe.host}, not ${host}. A secure form only fills a page on ${host}: open it there first.`,
      );
    const missing = missingFields(fields, probe.found);
    if (missing.length)
      throw new Error(
        `The page on ${pageHost} doesn't show a field for the ${secureFieldList(missing)} that Yo can recognize (fields inside embedded frames aren't supported yet). Take a snapshot, or use request_takeover for this one.`,
      );

    // The card names the page that was open, not the broader site the agent typed.
    const form: SecureForm = { site: pageHost, reason, fields };
    const title = secureFormTitle(fields, pageHost);
    const entryId = newId("req");
    const r = this.rt(agentId);
    this.upsert({
      id: entryId,
      agentId,
      turnId: r.runningTurn,
      item: {
        id: newId("itm"),
        kind: "tool",
        status: "running",
        title,
        toolName: SECURE_INPUT_TOOL,
        input: form,
      },
      request: {
        requestId: p.callId,
        kind: "user_input",
        toolName: SECURE_INPUT_TOOL,
        title,
        detail: reason || undefined,
        input: { site: pageHost },
        secureForm: form,
        status: "pending",
      },
    });
    const answer = await new Promise<{ text: string } | { values: string[] }>((resolve) => {
      let held: string[] | null = null;
      this.toolCalls.set(p.callId, {
        callId: p.callId,
        agentId,
        sessionKey: p.sessionKey,
        entryId,
        tool: SECURE_INPUT_TOOL,
        args: { fields },
        secureValues: (v) => {
          held = v;
        },
        resolve: (text) => resolve(held && text === SECURE_SUBMITTED ? { values: held } : { text }),
      });
      this.expireUnanswered(
        agentId,
        () => {
          const c = this.toolCalls.get(p.callId);
          return !!c && !c.filling;
        },
        (waited) => this.resolveToolCall(p.callId, unanswered(SECURE_INPUT_TOOL, waited), "expired"),
      );
      this.needsYou(agentId, title);
    });
    if ("text" in answer) {
      // Cancel and expiry don't set onFilled. If they ever overlap a submit, don't leave the request hanging.
      this.toolCalls.get(p.callId)?.onFilled?.();
      return answer.text;
    }

    const call = this.toolCalls.get(p.callId);
    try {
      // Type only into the host the card named, not every subdomain of the site the agent asked for.
      const done = await ask(secureSites(pageHost), answer.values);
      this.finishSecureForm(p.callId, "submitted");
      const agentName = this.d.store.getAgent(agentId)?.name ?? "Yo";
      const filled = fields.filter((f) => !missingFields([f], done.filled).length);
      this.d.store.addActivity({
        agentId,
        kind: "system",
        summary: `Filled the ${secureFieldList(filled)} from a secure form on ${done.host}`,
        ref: null,
      });
      log.info(`${agentName} filled a secure form on ${done.host} (${secureFieldList(filled)})`);
      return secureFillResult(fields, done);
    } catch (err) {
      // The fill itself failed. A later bookkeeping error (the card is already "answered") is not one.
      if (this.d.store.getEntry(entryId)?.request?.status === "answered") throw err;
      const safe = secureFillError(err, pageHost);
      const message = scrubSecrets(
        `The user filled in the secure form, but Yo couldn't type it into the page: ${safe.message}`,
        answer.values,
      );
      this.finishSecureForm(p.callId, "failed");
      const agentName = this.d.store.getAgent(agentId)?.name ?? "Yo";
      this.d.store.addActivity({
        agentId,
        kind: "system",
        summary: `Couldn't fill a secure form on ${pageHost}`,
        ref: null,
      });
      log.info(`${agentName} couldn't fill a secure form on ${pageHost}`);
      throw new Error(message);
    } finally {
      call?.onFilled?.();
    }
  }

  /** Whose "always allow" rules apply to an agent (see ruleOwner). */
  ruleOwnerOf(agentId: string): string {
    return this.ruleOwner(agentId);
  }

  private interactiveTool(
    agentId: string,
    p: Extract<AgentdPush, { type: "tool.call" }>,
  ): Promise<string> | null {
    const a = p.args;
    let request: PendingRequest;
    if (p.tool === "ask_user") {
      const options = Array.isArray(a.options) ? (a.options as unknown[]).map(String) : [];
      request = {
        requestId: p.callId,
        kind: "user_input",
        title: String(a.question ?? "Question"),
        questions: [
          {
            question: String(a.question ?? ""),
            options: options.map((label) => ({ label })),
            multiSelect: false,
          },
        ],
      };
    } else if (p.tool === "request_approval") {
      const category = String(a.category ?? "other");
      // Something sensitive going out (a card number, a password, a health detail…): the card warns, and a standing
      // "always allow" doesn't skip the question. A payment's card and a sign-in's password are expected, not flagged.
      const sensitive = findSensitiveFor(
        category,
        `${String(a.action ?? "")}\n${a.details ? String(a.details) : ""}`,
      );
      const rule = this.d.store.findRule(this.ruleOwner(agentId), `yo:${category}`);
      if (rule && !(rule.decision === "allow" && sensitive.length))
        return Promise.resolve(
          rule.decision === "allow" ? "APPROVED (standing rule). Go ahead." : "DENIED (standing rule).",
        );
      request = {
        requestId: p.callId,
        kind: "tool_approval",
        toolName: `yo:${category}`,
        title: String(a.action ?? "Approve action"),
        detail: a.details ? String(a.details) : undefined,
        input: { category },
        ...(sensitive.length ? { sensitive } : {}),
      };
    } else if (p.tool === "create_agent") {
      const name = String(a.name ?? "").trim();
      const role = String(a.role ?? "").trim();
      request = {
        requestId: p.callId,
        kind: "tool_approval",
        toolName: "yo:create_agent",
        title: `Add a new agent: ${name}${role ? `, ${role}` : ""}`,
        // In full: the user approves exactly the standing instructions that get saved (CreateAgentInput caps them).
        detail: a.instructions ? String(a.instructions) : undefined,
        input: { name, ...(role ? { role } : {}) },
      };
    } else if (p.tool === "create_phone_link") {
      const label = String(a.label ?? "").trim();
      request = {
        requestId: p.callId,
        kind: "tool_approval",
        toolName: "yo:create_phone_link",
        title: `Create a phone link for ${label || "your phone"}?`,
        detail: "Anyone with the link can talk to Yo as you. A new link turns off the old one.",
        ...(label ? { input: { label } } : {}),
      };
    } else if (p.tool === "turn_off_phone") {
      request = {
        requestId: p.callId,
        kind: "tool_approval",
        toolName: "yo:turn_off_phone",
        title: "Turn off Yo Phone?",
        detail: "The current phone link stops working, and that phone can't text Yo anymore.",
      };
    } else if (p.tool === "request_takeover") {
      request = {
        requestId: p.callId,
        kind: "user_input",
        toolName: "request_takeover",
        title: `Take over my screen: ${String(a.reason ?? "")}`,
        detail: String(a.reason ?? ""),
      };
    } else {
      return null;
    }
    const entryId = newId("req");
    const r = this.rt(agentId);
    this.upsert({
      id: entryId,
      agentId,
      turnId: r.runningTurn,
      item: {
        id: newId("itm"),
        kind: "tool",
        status: "running",
        title: request.title,
        toolName: p.tool,
        input: a,
      },
      request: { ...request, status: "pending" },
    });
    return new Promise<string>((resolve) => {
      this.toolCalls.set(p.callId, {
        callId: p.callId,
        agentId,
        sessionKey: p.sessionKey,
        entryId,
        tool: p.tool,
        args: a,
        resolve,
      });
      this.expireUnanswered(
        agentId,
        () => this.toolCalls.has(p.callId),
        (waited) => this.resolveToolCall(p.callId, unanswered(p.tool, waited), "expired"),
      );
      this.needsYou(agentId, request.title);
    });
  }

  /* ------------------------------ team chat -------------------------------- */

  /**
   * message_agent: put a message from one agent in a teammate's chat and run it as a turn there (after the
   * one it's on, if busy). By default it's an async handoff: the asker gets "Sent to Dew" at once and carries
   * on, and the teammate's reply comes back later as a new message that wakes the asker (answerExchange). With
   * wait, the asker's tool call waits for the reply instead (a reply later than AGENT_REPLY_WAIT_MS still comes).
   */
  private async messageAgent(fromId: string, args: Record<string, unknown>): Promise<string> {
    const parsed = MessageAgentInput.safeParse(args);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid message_agent call");
    const { to, message } = parsed.data;
    const wait = parsed.data.wait === true;
    const sender = this.d.store.getAgent(fromId);
    if (!sender) throw new Error("Unknown agent");
    // agentd sends unanswered tool calls again after core restarts; that turn is already closed here, so a
    // replay must not deliver the message a second time.
    if (!this.rt(fromId).runningTurn) throw new Error("This turn has ended; the message wasn't sent.");
    const target = this.findTeammate(fromId, to);
    const hops = (this.rt(fromId).input?.hops ?? 0) + 1;
    if (hops > MAX_AGENT_HOPS)
      throw new Error(
        "You and your teammates have passed messages back and forth too many times in a row. Finish with what you have, or ask the user.",
      );
    if (wait && this.waitsOn(target.id, fromId))
      throw new Error(
        `${target.name} is waiting for your reply right now, so they can't take a new message. Put what you want to tell them in your reply instead.`,
      );

    const asking = this.rt(fromId).input;
    const checkIn = !!(asking?.oversight || asking?.fromCheckIn);
    if (checkIn && asking?.checkInSent)
      throw new Error("This team check already sent its one check-in. Finish with what you know.");
    if (checkIn && asking) asking.checkInSent = true;
    const ex: AgentExchange = {
      id: newId("xch"),
      fromAgentId: fromId,
      toAgentId: target.id,
      resolve: null,
      timer: null,
      deliverLate: !wait,
      fromCheckIn: checkIn,
      hops,
    };
    // Where the teammate is right now, for the asker (a busy teammate gets to it after its current task).
    const busy = !!this.rt(target.id).runningTurn;
    const asleep = !busy && this.activityOf(target.id) === "sleeping";
    this.d.store.addActivity({
      agentId: fromId,
      kind: "system",
      summary: `${sender.name} → ${target.name}: ${message.replace(/\s+/g, " ").slice(0, 120)}`,
      ref: target.id,
    });
    this.exchanges.set(ex.id, ex);
    const delivered = new Promise<string>((resolve) => {
      if (!wait) return resolve("");
      ex.resolve = resolve;
      ex.timer = setTimeout(() => {
        ex.deliverLate = true;
        this.stopWaiting(
          ex,
          `${target.name} hasn't replied yet (still working on it). Carry on; their reply will come to you as a new message when they finish.`,
        );
      }, this.d.agentReplyWaitMs ?? AGENT_REPLY_WAIT_MS);
      ex.timer.unref();
    });
    try {
      this.receive(target.id, sender, message, { exchangeId: ex.id, hops, checkIn });
    } catch (err) {
      ex.deliverLate = false;
      this.stopWaiting(ex, "");
      throw err;
    }
    if (wait) return delivered;
    const now = busy
      ? ` ${target.name} is busy with another task, so yours is next in line.`
      : asleep
        ? ` ${target.name} was asleep; this wakes them.`
        : "";
    // The exchange id lets the app fold the reply that comes later into this row ("2 messages with Dew").
    return `Sent to ${target.name}.${now} Carry on with your own work: their reply comes to you as a new message when they finish. (exchange ${ex.id})`;
  }

  /**
   * A teammate's message lands in an agent's chat and becomes a turn there: a request (its answer goes back
   * through `exchangeId`), or with `reply` the answer to this agent's own earlier message (nothing goes back).
   * `modelText`: what the agent's model reads, when it isn't what the chat shows.
   */
  private receive(
    toId: string,
    sender: Agent,
    text: string,
    o: { exchangeId: string; hops: number; checkIn?: boolean; reply?: boolean; modelText?: string },
  ) {
    this.d.onActivity();
    const r = this.rt(toId);
    r.lastError = null;
    const from = { agentId: sender.id, name: sender.name };
    const reply = o.reply ? { reply: true } : {};
    this.enqueue(
      toId,
      {
        id: newId("itm"),
        kind: "user_message",
        status: "completed",
        text,
        from: { ...from, exchangeId: o.exchangeId, ...reply },
      },
      {
        text: o.modelText ?? text,
        attachments: [],
        trigger: "agent",
        // A reply closes its exchange: what the asker says next is for the user, not sent back.
        from: { ...from, role: sender.role, exchangeId: o.reply ? null : o.exchangeId, ...reply },
        hops: o.hops,
        ...(o.checkIn ? { fromCheckIn: true } : {}),
      },
    );
  }

  /** A teammate by name (or id) for `fromId`. */
  private findTeammate(fromId: string, to: string): Agent {
    const others = this.d.store.listAgents().filter((a) => a.id !== fromId);
    const q = to
      .trim()
      .toLowerCase()
      .replace(/^(the\s+|@)/, "");
    const found =
      others.find((a) => a.id === to.trim() || a.name.toLowerCase() === q) ??
      (q.length >= 3 ? others.find((a) => a.name.toLowerCase().startsWith(q)) : undefined);
    if (found) return found;
    const self = this.d.store.getAgent(fromId);
    if (self && self.name.toLowerCase() === q) throw new Error("That's you. Pick a teammate.");
    throw new Error(
      others.length
        ? `No teammate named "${to}". Your teammates: ${others.map((a) => a.name).join(", ")}.`
        : "You have no teammates yet. The user can add one, or you can propose one with create_agent.",
    );
  }

  /** `agentId` is (directly or through others) blocked waiting on a reply from `target`. */
  private waitsOn(agentId: string, target: string): boolean {
    const seen = new Set<string>();
    const next = (id: string) =>
      [...this.exchanges.values()].filter((x) => x.resolve && x.fromAgentId === id).map((x) => x.toAgentId);
    const stack = [agentId];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...next(id));
    }
    return false;
  }

  /** The asker stops waiting (reply, timeout, or the user stopped it). */
  private stopWaiting(ex: AgentExchange, text: string) {
    if (ex.timer) clearTimeout(ex.timer);
    ex.timer = null;
    const resolve = ex.resolve;
    ex.resolve = null;
    if (!ex.deliverLate) this.exchanges.delete(ex.id);
    resolve?.(text);
  }

  /**
   * The teammate's turn for an exchange ended: hand its reply to the asker, as the waiting tool call's answer or
   * (async, or a wait that ran out) as a new message from the teammate that wakes the asker. If the teammate
   * couldn't finish (it failed, or Yo stopped it: `error` says why) the asker is woken too, so it can tell the
   * user; a teammate the user stopped only leaves a quiet line in the asker's chat.
   */
  private answerExchange(exchangeId: string, turnId: string | null, status: string, error?: string) {
    const ex = this.exchanges.get(exchangeId);
    if (!ex) return;
    this.exchanges.delete(exchangeId);
    const to = this.d.store.getAgent(ex.toAgentId);
    const name = to?.name ?? "Your teammate";
    const text0 = turnId
      ? this.d.store
          .listTimeline(ex.toAgentId, undefined, 200)
          .filter((e) => e.turnId === turnId && e.item.kind === "assistant_message" && e.item.text?.trim())
          .map((e) => e.item.text!.trim())
          .join("\n\n")
      : "";
    // Marked off and capped: it's a teammate's words (information for the asker, not the user's instructions).
    const capped =
      text0.length > MAX_TEAMMATE_REPLY
        ? `${text0.slice(0, MAX_TEAMMATE_REPLY)}\n…(cut: reply too long)`
        : text0;
    const said = capped ? `<teammate_reply from="${name}">\n${capped}\n</teammate_reply>` : "";
    const text =
      status === "completed"
        ? `${name} replied:\n\n${said || "(no reply text)"}`
        : status === "interrupted"
          ? `${name} was stopped before replying.${said ? ` What they said so far:\n\n${said}` : ""}`
          : `${name} couldn't finish${error ? `: ${error}` : "."}${said ? `\n\nWhat they said so far:\n\n${said}` : ""}`;
    if (ex.resolve) {
      this.stopWaiting(ex, text);
      return;
    }
    const asker = this.d.store.getAgent(ex.fromAgentId);
    if (!ex.deliverLate || !to || !asker || asker.archivedAt) return;
    const hops = ex.hops + 1;
    if (status === "completed") {
      // Nothing came back (an FYI the teammate answered with NO_RESPONSE): the asker isn't woken for it.
      if (!said) return;
      // The chat shows the teammate's words; the asker's model reads them marked off.
      this.receive(ex.fromAgentId, to, capped, {
        exchangeId: ex.id,
        hops,
        checkIn: ex.fromCheckIn,
        reply: true,
        modelText: said,
      });
      return;
    }
    if (status === "interrupted" && !error) {
      this.notice(ex.fromAgentId, `${name} was stopped before replying.`);
      return;
    }
    const why = error ? `: ${oneLine(error, 160)}` : ".";
    // The asker's chat says it in the asker's voice; its model reads the same with what came back so far.
    this.notice(
      ex.fromAgentId,
      status === "interrupted"
        ? `${name} was stopped before replying${why}`
        : `${name} couldn't finish what I asked${why}`,
    );
    this.d.onActivity();
    this.enqueue(ex.fromAgentId, null, {
      text: `${status === "interrupted" ? `${name} was stopped before replying${why}` : `${name} couldn't finish what you asked${why}`}${said ? `\n\nWhat they said so far:\n\n${said}` : ""}`,
      attachments: [],
      trigger: "agent",
      from: { agentId: to.id, name: to.name, role: to.role, exchangeId: null, reply: true },
      hops,
      ...(ex.fromCheckIn ? { fromCheckIn: true } : {}),
    });
  }

  /**
   * create_phone_link / turn_off_phone: the user approves a card in Yo, then the phone channel acts. Main agent
   * only (enforced here, not just by the tool list), and never from a turn the phone started, so a leaked link
   * can't mint or keep itself alive. The link itself never reaches the model: it's shown only in Settings → Phone.
   */
  private async phoneTool(agentId: string, p: Extract<AgentdPush, { type: "tool.call" }>): Promise<string> {
    const caller = this.d.store.getAgent(agentId);
    if (!caller || !isLead(caller)) throw new Error(`${p.tool} is only available to your main agent.`);
    if (!this.phone) throw new Error("Yo Phone isn't available on this Yo core.");
    const create = p.tool === "create_phone_link";
    // agentd re-sends unanswered calls after a restart; that turn is already closed, so do nothing.
    const turnId = this.rt(agentId).runningTurn;
    if (!turnId) throw new Error("This turn has ended; nothing was changed.");
    if (this.phone.isPhoneTurn(turnId))
      throw new Error(
        create
          ? "Create phone links from Yo on your computer."
          : "Turn off Yo Phone from Yo on your computer.",
      );
    let args: Record<string, unknown> = {};
    if (create) {
      const parsed = CreatePhoneLinkInput.safeParse(p.args);
      if (!parsed.success)
        throw new Error(parsed.error.issues[0]?.message ?? "Invalid create_phone_link call");
      args = parsed.data.label ? { label: parsed.data.label } : {};
    }
    const answer = await this.interactiveTool(agentId, { ...p, args })!;
    if (!answer.startsWith("APPROVED"))
      return answer.startsWith("DENIED")
        ? `${answer} ${create ? "No phone link was made; any current link still works." : "Yo Phone is still on."}`
        : answer;
    if (!create) {
      await this.phone.turnOff();
      return "The user approved. Yo Phone is off: the old link no longer works.";
    }
    await this.phone.createLink();
    // A nudge in the owner's UI. Notifications never reach the model, and Telegram skips "info" ones.
    this.d.hub.push("notify", {
      agentId,
      title: "Yo Phone",
      body: "Phone link ready — open Settings → Phone",
      kind: "info",
    });
    return "Link created. It's in Settings → Phone.";
  }

  /** create_agent: the user approves a card, then the agent joins the team. */
  private async createAgentTool(
    agentId: string,
    p: Extract<AgentdPush, { type: "tool.call" }>,
  ): Promise<string> {
    const parsed = CreateAgentInput.safeParse(p.args);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid create_agent call");
    const { name, role = "", instructions = "" } = parsed.data;
    const team = this.d.store.listAgents();
    if (team.some((a) => a.name.toLowerCase() === name.toLowerCase()))
      throw new Error(`There's already an agent named ${name}. Message them with message_agent instead.`);
    const answer = await this.interactiveTool(agentId, { ...p, args: { name, role, instructions } })!;
    if (!answer.startsWith("APPROVED")) return answer;
    const created = this.d.store.createAgent({
      name,
      role,
      instructions,
      // The next Softie nobody wears yet (Dew, Pico, Mochi, Clove, Kiki).
      avatar: teammateAvatar(this.d.store.listAgents()),
      // On the default subscription and model to start; the user can switch it from its chat header.
      accountId: null,
      model: null,
      effort: null,
      runtimeMode: this.d.store.getSettings().defaultRuntimeMode,
      isPrimary: false,
      pinned: false,
    });
    const by = this.d.store.getAgent(agentId)?.name ?? "An agent";
    this.d.store.addActivity({
      agentId: created.id,
      kind: "system",
      summary: `${by} added ${created.name} to the team`,
      ref: null,
    });
    this.broadcast(created.id);
    this.introduce(created.id, by);
    const said = answer.replace(/^APPROVED\s*/, "");
    return `The user approved. ${created.name} has joined the team${role ? ` as ${role}` : ""}.${said ? ` ${said}` : ""} ${created.name} is saying hello to the user now and asking them one question about the job. Hand ${created.name} work with message_agent (to: "${created.name}"); it gets to it right after.`;
  }

  /**
   * A new teammate's first turn, started at once: it says hello in a line or two, says what it'll take care of,
   * and asks the user one multiple-choice question about its job (an ask_user card). `by`: who added it.
   */
  introduce(agentId: string, by: string | null = null) {
    const agent = this.d.store.getAgent(agentId);
    if (!agent || agent.archivedAt || isLead(agent) || agent.kind === "helper") return;
    this.d.onActivity();
    this.enqueue(agentId, null, {
      text: teammateIntro({ role: agent.role, by, userName: this.d.store.getSettings().userName }),
      attachments: [],
      trigger: "intro",
    });
  }

  /* -------------------------------- helpers -------------------------------- */

  /**
   * One-off helpers: the main agent hands a self-contained job to a helper (start_helper), a hidden agent of
   * kind "helper" with its own screen and a fresh session. When its task ends, its final message goes to its
   * parent as a report and it is retired: session stopped, computer discarded, archived. Bounded: at most
   * MAX_HELPERS per parent, HELPER_TURN_MS per job, no team or helper tools of its own.
   */

  private isHelper(agentId: string): boolean {
    return this.d.store.getAgent(agentId)?.kind === "helper";
  }

  /** A helper that's done: nothing about it may bring its runtime (or screen) back. */
  private retiredHelper(agentId: string): boolean {
    const a = this.d.store.getAgent(agentId);
    return a?.kind === "helper" && !!a.archivedAt;
  }

  /** The Yo tools an agent's sessions offer. */
  private toolsetOf(agent: Agent): YoToolset {
    return agent.kind === "helper" ? "helper" : isLead(agent) ? "primary" : "agent";
  }

  /** The model a helper runs on: its parent's for now (the place for a future "fast helper model" setting). */
  private helperModel(parent: Agent): Pick<Agent, "accountId" | "model" | "effort" | "runtimeMode"> {
    return {
      accountId: parent.accountId,
      model: parent.model,
      effort: parent.effort,
      runtimeMode: parent.runtimeMode,
    };
  }

  /** start_helper: create the helper, link (or add) its ledger task, and send it its brief. Returns at once. */
  private async startHelper(parentId: string, args: Record<string, unknown>): Promise<string> {
    const parsed = StartHelperInput.safeParse(args);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid start_helper call");
    const parent = this.d.store.getAgent(parentId);
    if (!parent || parent.kind === "helper") throw new Error("Helpers can't start helpers.");
    // A replay after a core restart: that turn is already closed, so no helper is started twice.
    if (!this.rt(parentId).runningTurn) throw new Error("This turn has ended; no helper was started.");
    const live = this.d.store.listHelpers(parentId, { live: true });
    if (live.length >= MAX_HELPERS)
      throw new Error(
        `You already have ${live.length} helpers working: ${live.map((h) => `"${h.name}" (${h.id})`).join(", ")}. Wait for a result (check_helpers with wait_seconds) or stop one (stop_helper), then start this one.`,
      );
    let playbook: string | null = null;
    if (parsed.data.playbook) {
      playbook = normalizePlaybook(parsed.data.playbook);
      if (!playbook)
        throw new Error(
          `"${parsed.data.playbook}" isn't a playbook: give its path under ~/Shared/playbooks, e.g. work/desk-quote.md.`,
        );
    }
    let task: LedgerTask | null = null;
    if (parsed.data.task_id) {
      task = this.d.store.getTask(parsed.data.task_id);
      if (!task || task.ownerId !== parentId)
        throw new Error(`There's no task ${parsed.data.task_id} in your ledger (see task_list).`);
    }
    const brief = parsed.data.brief;
    const title = shortTitle(parsed.data.title || task?.title || brief);
    const id = newId("agt");
    const helper = this.d.store.createAgent({
      id,
      name: title,
      role: `${parent.name}'s helper`,
      instructions: "",
      avatar: helperAvatar(id),
      ...this.helperModel(parent),
      isPrimary: false,
      pinned: false,
      kind: "helper",
      parentId,
      brief,
    });
    task = task
      ? this.d.store.updateTask(task.id, { status: "in_progress", helperId: id })
      : this.d.store.addTask({ ownerId: parentId, title, status: "in_progress", helperId: id });
    if (playbook) this.d.store.addPlaybookRun({ playbook, agentId: parentId, helperId: id });
    this.d.store.addActivity({
      agentId: parentId,
      kind: "system",
      summary: `${parent.name} started a helper: ${title}`,
      ref: id,
    });
    log.info(`${parent.name} started helper ${id}: ${title}`);
    // Its own ledger change (the helper's task): not news on its next message.
    this.rt(parentId).ledgerSeen = ledgerSig(this.d.store.listTasks(parentId));
    this.broadcast(helper.id); // its card shows in the parent's chat
    // The brief is the helper's first (and only) message, shown as from its parent.
    this.enqueue(
      id,
      {
        id: newId("itm"),
        kind: "user_message",
        status: "completed",
        text: brief,
        from: { agentId: parentId, name: parent.name },
      },
      { text: brief, attachments: [], trigger: "agent" },
    );
    return `Started helper "${title}" (id ${id}${task ? `, task ${task.id}` : ""}${playbook ? `, playbook ${playbook}` : ""}). It works on its own screen; its report comes to you as a message when it finishes (or use check_helpers).`;
  }

  /** check_helpers: how each helper is doing, plus reports not handed over yet; optionally waits for one. */
  private async checkHelpers(parentId: string, args: Record<string, unknown>): Promise<string> {
    const parsed = CheckHelpersInput.safeParse(args);
    const waitS = Math.min(MAX_HELPER_WAIT_S, parsed.success ? (parsed.data.wait_seconds ?? 0) : 0);
    if (!this.rt(parentId).runningTurn) throw new Error("This turn has ended.");
    if (
      waitS > 0 &&
      !this.undeliveredReports(parentId).length &&
      this.d.store.listHelpers(parentId, { live: true }).length
    )
      await this.waitForHelper(parentId, waitS * 1000);
    return this.helperStatus(parentId);
  }

  /** Blocks until one of the parent's helpers finishes (or the wait ends: timeout, task stopped, shutdown). */
  private waitForHelper(parentId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wakers = this.helperWaiters.get(parentId) ?? new Set<() => void>();
      this.helperWaiters.set(parentId, wakers);
      const done = () => {
        clearTimeout(timer);
        wakers.delete(done);
        if (!wakers.size && this.helperWaiters.get(parentId) === wakers) this.helperWaiters.delete(parentId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      wakers.add(done);
    });
  }

  private wakeHelperWaiters(parentId: string) {
    for (const w of [...(this.helperWaiters.get(parentId) ?? [])]) w();
  }

  private undeliveredReports(parentId: string): { id: string; text: string }[] {
    return [...this.helperReports]
      .filter(([, r]) => r.parentId === parentId)
      .map(([id, r]) => ({ id, text: r.text }));
  }

  /** The parent's helpers right now, and the reports it hasn't had (handed over here, so never again). */
  private helperStatus(parentId: string): string {
    const now = Date.now();
    const userName = this.d.store.getSettings().userName?.trim() || "the user";
    const reports = this.undeliveredReports(parentId);
    for (const x of reports) this.helperReports.delete(x.id);
    // Not again as a queued message either.
    const r = this.rt(parentId);
    const taken = new Set(reports.map((x) => x.id));
    for (const q of r.queue.filter((q) => q.helperReports?.some((x) => taken.has(x.id)))) {
      q.helperReports = q.helperReports!.filter((x) => !taken.has(x.id));
      q.text = q.helperReports.map((x) => x.text).join("\n\n");
    }
    r.queue = r.queue.filter((q) => !q.helperReports || q.helperReports.length);
    const live = this.d.store.listHelpers(parentId, { live: true });
    const lines = live.map((h) => {
      const hr = this.runtimes.get(h.id);
      const pending = this.pendingTitle(h.id);
      const state = hr?.seatWait
        ? "waiting for a free screen"
        : pending
          ? `waiting for ${userName}: ${pending}`
          : "working";
      const step = this.d.store
        .listTimeline(h.id, undefined, 40)
        .reverse()
        .find((e) => STEP_KINDS.has(e.item.kind));
      const last = step ? `; last step: ${step.item.title ?? stepName(step.item)}` : "";
      return `- "${h.name}" (${h.id}): ${state}, ${minutes(now - h.createdAt)} so far${last}`;
    });
    const out = [
      live.length ? `Helpers working (${live.length}):\n${lines.join("\n")}` : "No helpers are working now.",
      ...reports.map((x) => x.text),
    ];
    return out.join("\n\n");
  }

  /** The title of a card one of this agent's steps is waiting on the user for, if any. */
  private pendingTitle(agentId: string): string | null {
    const entry =
      [...this.toolCalls.values()].find((c) => c.agentId === agentId)?.entryId ??
      [...this.providerRequests.values()].find((p) => p.agentId === agentId)?.entryId;
    if (!entry) return null;
    const e = this.d.store.getEntry(entry);
    return e?.request?.title ?? e?.item.title ?? "a question";
  }

  /** stop_helper: its parent stops it (and knows, so no report follows). */
  private async stopHelper(parentId: string, args: Record<string, unknown>): Promise<string> {
    const parsed = StopHelperInput.safeParse(args);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid stop_helper call");
    const h = this.d.store.getAgent(parsed.data.id);
    if (h?.kind !== "helper" || h.parentId !== parentId) {
      const live = this.d.store.listHelpers(parentId, { live: true });
      throw new Error(
        `You have no helper ${parsed.data.id}.${live.length ? ` Working: ${live.map((x) => `"${x.name}" (${x.id})`).join(", ")}.` : ""}`,
      );
    }
    if (h.archivedAt) return `"${h.name}" has already finished.`;
    this.stoppedByLead.add(h.id);
    await this.interrupt(h.id);
    return `Stopped "${h.name}". Its task in your ledger is marked cancelled; no report will come.`;
  }

  /** Its card in the parent's chat follows its state (waiting for a screen or the user, working). */
  private refreshHelperCard(helper: Agent) {
    const r = this.runtimes.get(helper.id);
    const pending = this.pendingTitle(helper.id);
    const userName = this.d.store.getSettings().userName?.trim() || "the user";
    if (r?.seatWait) this.helperCard(helper, "waiting", "Waiting for a free screen");
    else if (pending) this.helperCard(helper, "waiting", `Waiting for ${userName}: ${pending}`);
    else this.helperCard(helper, "working");
  }

  /** Upserts the helper's card (`hcard_<id>`) in its parent's chat. */
  private helperCard(helper: Agent, state: HelperState, summary?: string, endedAt?: number) {
    if (!helper.parentId) return;
    const key = JSON.stringify([state, summary, endedAt]);
    if (this.helperCards.get(helper.id) === key) return;
    this.helperCards.set(helper.id, key);
    const label = {
      waiting: "waiting",
      working: "working",
      done: "done",
      failed: "couldn't finish",
      stopped: "stopped",
    }[state];
    this.upsert({
      id: `hcard_${helper.id}`,
      agentId: helper.parentId,
      turnId: null,
      item: {
        id: `hcard_${helper.id}`,
        kind: "notice",
        status:
          state === "failed" ? "failed" : state === "done" || state === "stopped" ? "completed" : "running",
        // What an app without helper cards shows.
        text: `Helper "${helper.name}": ${label}${summary ? `. ${summary}` : ""}`,
        helper: {
          id: helper.id,
          title: helper.name,
          avatar: helper.avatar,
          state,
          ...(summary ? { summary } : {}),
          startedAt: helper.createdAt,
          ...(endedAt ? { endedAt } : {}),
        },
      },
    });
  }

  /**
   * A helper's task ended (or core restarted under it): in order, collect its reply, report to its parent,
   * stop its session, discard its computer (hibernate on an older one), archive it, drop its runtime, and
   * update its card. Its ledger task and playbook run are closed too.
   */
  private retireHelper(
    helper: Agent,
    end: {
      turnId: string | null;
      status: string;
      error?: string;
      health?: TurnHealth | null;
      restart?: boolean;
    },
  ) {
    if (helper.archivedAt) return;
    const now = Date.now();
    const parentId = helper.parentId;
    const userName = this.d.store.getSettings().userName?.trim() || "the user";
    const r = this.runtimes.get(helper.id);
    const h = end.health ?? null;
    const byLead = this.stoppedByLead.delete(helper.id);

    // 1. What it said (a helper only ever runs one task).
    const said = this.d.store
      .listTimeline(helper.id, undefined, 400)
      .filter((e) => e.item.kind === "assistant_message" && e.item.text?.trim())
      .map((e) => e.item.text!.trim())
      .join("\n\n");
    const report =
      said.length > MAX_HELPER_REPORT ? `${said.slice(0, MAX_HELPER_REPORT)}\n…(cut: report too long)` : said;
    let state: HelperState;
    let outcome: string;
    let ledger: LedgerTask["status"];
    let summary: string;
    const stopped = h?.stopped;
    if (end.restart) {
      state = "stopped";
      outcome = "was interrupted when Yo restarted, before it could finish";
      ledger = "interrupted";
      summary = "Interrupted by a restart";
    } else if (end.status === "completed") {
      state = "done";
      outcome = `finished after ${minutes(now - helper.createdAt)}`;
      ledger = "done";
      summary = oneLine(said, 280) || "Done";
    } else if (stopped) {
      state = "failed";
      outcome = `was stopped: ${stopped === "froze" ? `a step froze for ${minutes(this.d.stuckTurnMs ?? STUCK_TURN_MS)} with no progress` : `it hit a helper's ${minutes(this.turnLimit(helper.id))} time limit`}`;
      ledger = "interrupted";
      summary = stopped === "froze" ? "Stopped: a step froze" : "Stopped at its time limit";
    } else if (end.status === "interrupted") {
      state = "stopped";
      outcome = byLead ? "was stopped by you" : `was stopped by ${userName}`;
      ledger = "cancelled";
      summary = byLead ? "Stopped" : `Stopped by ${userName}`;
    } else {
      state = "failed";
      const why = end.error?.replace(/\s+/g, " ").slice(0, 200);
      outcome = `couldn't finish${why ? `: ${why}` : ""}`;
      ledger = "interrupted";
      summary = why ? `Couldn't finish: ${why}` : "Couldn't finish";
    }
    const notes: string[] = [];
    if (h && h.failures >= OVERSIGHT_FAIL_STREAK)
      notes.push(
        `${h.failures} of its steps failed along the way (last: ${h.recent.map((f) => `${f.tool}: ${f.error.replace(/[<>]/g, " ")}`).join("; ")}).`,
      );
    const task = this.d.store.taskOfHelper(helper.id);
    if (task && task.status !== "done" && task.status !== "cancelled") {
      this.d.store.updateTask(task.id, { status: ledger, note: `Helper ${outcome}.` });
      // The parent stopped it itself: that ledger change isn't news to it.
      const pr = byLead && parentId ? this.runtimes.get(parentId) : undefined;
      if (pr) pr.ledgerSeen = ledgerSig(this.d.store.listTasks(parentId!));
    }
    const run = this.d.store.playbookRunOfHelper(helper.id);
    if (run && !run.endedAt)
      this.d.store.updatePlaybookRun(run.id, {
        endedAt: now,
        outcome: state === "done" ? "success" : state === "stopped" ? "stopped" : "failed",
      });

    // 2. The report goes to its parent (unless the parent stopped it itself).
    const parent = parentId ? this.d.store.getAgent(parentId) : null;
    if (parent && !parent.archivedAt && !byLead) {
      const stillWorking = this.d.store
        .listHelpers(parent.id, { live: true })
        .filter((x) => x.id !== helper.id)
        .map((x) => `"${x.name}" (${x.id})`);
      this.deliverHelperReport(
        parent.id,
        helper.id,
        helperReportNote({
          title: helper.name,
          helperId: helper.id,
          outcome,
          notes: [...notes, ...(task ? [`Ledger task ${task.id} is now ${ledger.replace("_", " ")}.`] : [])],
          report,
          stillWorking,
          userName,
        }),
      );
    }

    // 3–4. Its session and computer go (once the computer is reachable).
    const sessionKey = r?.sessionKey ?? null;
    for (const [key, id] of [...this.sessionToAgent]) if (id === helper.id) this.sessionToAgent.delete(key);
    if (sessionKey) {
      this.abandoned.add(sessionKey);
      this.liveSessions.delete(sessionKey);
      this.sessionModes.delete(sessionKey);
      this.d.store.endSession(sessionKey);
    }
    if (this.d.agentd.connected)
      void (async () => {
        if (sessionKey) await this.d.agentd.request("session.stop", { sessionKey }).catch(() => {});
        await this.discardComputer(helper.id);
      })();
    else this.pendingDiscards.add(helper.id);

    // 5–7. Archived (its chat stays readable), its runtime dropped, its card final.
    this.d.store.updateAgent(helper.id, { archivedAt: now });
    this.runtimes.delete(helper.id);
    this.teamCheckAt.delete(helper.id);
    this.helperCard(helper, state, summary, now);
    this.helperCards.delete(helper.id);
    this.d.store.addActivity({
      agentId: parentId ?? null,
      kind: "system",
      summary: `Helper "${helper.name}" ${outcome}`.slice(0, 200),
      ref: helper.id,
    });
    log.info(`helper ${helper.id} retired: ${outcome}`);
    this.d.hub.push("agent.removed", { id: helper.id });
    this.seatMaybeFree();
  }

  /** Frees a retired helper's screen for good; an older computer can only put it to sleep. */
  private async discardComputer(agentId: string) {
    try {
      await this.d.agentd.request("computer.discard", { agentId }, 60000);
    } catch (err: any) {
      log.info(`computer.discard failed (${String(err?.message ?? err).slice(0, 120)}); hibernating instead`);
      await this.d.agentd.request("computer.hibernate", { agentId }).catch(() => {});
    }
    if (!this.disposed) this.seatMaybeFree();
  }

  /**
   * A finished helper's report for its parent: to a check_helpers that's waiting, else as a message (merged
   * into a report already queued for it, so it answers once).
   */
  private deliverHelperReport(parentId: string, helperId: string, text: string) {
    this.helperReports.set(helperId, { parentId, text });
    if (this.helperWaiters.get(parentId)?.size) return this.wakeHelperWaiters(parentId);
    if (this.disposed) return;
    const pr = this.rt(parentId);
    const queued = pr.queue.find((q) => q.trigger === "helper" && q.helperReports);
    if (queued) {
      queued.helperReports!.push({ id: helperId, text });
      queued.text = queued.helperReports!.map((x) => x.text).join("\n\n");
      return;
    }
    this.d.onActivity();
    this.enqueue(parentId, null, {
      text,
      attachments: [],
      trigger: "helper",
      helperReports: [{ id: helperId, text }],
    });
  }

  /** Reports a check_helpers wait was woken for but never handed over (the task ended first): queue them. */
  private queueUndeliveredReports(parentId: string) {
    const r = this.runtimes.get(parentId);
    if (!r) return;
    const queued = new Set(r.queue.flatMap((q) => q.helperReports?.map((x) => x.id) ?? []));
    const left = this.undeliveredReports(parentId).filter((x) => !queued.has(x.id));
    if (!left.length) return;
    const q = r.queue.find((x) => x.trigger === "helper" && x.helperReports);
    if (q) q.helperReports!.push(...left);
    else r.queue.push({ text: "", attachments: [], trigger: "helper", helperReports: left });
    const target = q ?? r.queue.at(-1)!;
    target.text = target.helperReports!.map((x) => x.text).join("\n\n");
  }

  /** The ledger line put before a message when the ledger changed since this session last saw it. */
  private ledgerNews(agentId: string): string {
    const r = this.rt(agentId);
    const tasks = this.d.store.listTasks(agentId);
    const sig = ledgerSig(tasks);
    const changed = r.ledgerSeen !== null && r.ledgerSeen !== sig;
    r.ledgerSeen = sig;
    return changed ? openTasksLine(tasks) : "";
  }

  /* --------------------------------- team ---------------------------------- */

  /**
   * The team as `agentId` sees it in its prompt: itself and the other long-lived agents, each with its job,
   * status and model. A space's main agent doesn't list the other space's: that's its counterpart (# Your space).
   */
  private teamOf(agentId: string): TeamMember[] {
    const me = this.d.store.getAgent(agentId);
    if (!me || me.kind === "helper") return [];
    const focus = focusOf(this.d.store, me);
    return this.d.store
      .listAgents()
      .filter((a) => a.id === agentId || !(focus && a.space && a.space !== focus))
      .map((a) => ({
        name: a.name,
        role: a.role,
        status: this.rosterStatus(a.id),
        model: this.modelLabel(a),
        main: isLead(a),
        ...(a.id === agentId ? { you: true } : {}),
      }));
  }

  private rosterStatus(agentId: string): TeamMember["status"] {
    const a = this.activityOf(agentId);
    return a === "working" || a === "waiting" ? "working" : a === "sleeping" ? "asleep" : "idle";
  }

  /** An agent's subscription and model as the roster shows them: "Claude · Sonnet 5.5". */
  private modelLabel(agent: Agent): string {
    const account = this.d.accounts.resolveFor(agent.accountId);
    if (!account) return "no subscription connected";
    // Still pinned to a provider Yo doesn't offer: it runs on the fallback account's default model (runTurn).
    const id = this.d.accounts.isHiddenAccount(agent.accountId) ? null : agent.model;
    const model = id ? account.models.find((m) => m.id === id) : account.models.find((m) => m.isDefault);
    return `${account.label} · ${model?.label ?? id ?? "its default model"}`;
  }

  /**
   * Fingerprint of the team `agentId` sees: who's on it, their jobs and models (not their status, which changes
   * all the time, and not model labels, which arrive after an account is checked).
   */
  private teamSig(agentId: string): string {
    const me = this.d.store.getAgent(agentId);
    const focus = focusOf(this.d.store, me);
    return this.d.store
      .listAgents()
      .filter((a) => a.id !== agentId && !(focus && a.space && a.space !== focus))
      .map((a) => [a.id, a.name, a.role, a.accountId, a.model, isLead(a)].join("|"))
      .join("\n");
  }

  /** The team line put before a message when the team changed (joined, left, new job or model) since the session started. */
  private teamNews(agentId: string): string {
    const r = this.rt(agentId);
    const sig = this.teamSig(agentId);
    const changed = r.teamSeen !== null && r.teamSeen !== sig;
    r.teamSeen = sig;
    return changed ? teamNewsLine(this.teamOf(agentId)) : "";
  }

  /** playbook_list: the playbooks in ~/Shared/playbooks and how their runs have gone. */
  private async playbookList(agentId: string): Promise<string> {
    const root = "Shared/playbooks";
    const list = (p: string) =>
      this.d.agentd.request("fs.list", { agentId, path: p }).then(
        (r) => r.entries,
        () => null as FsEntry[] | null,
      );
    const files: string[] = [];
    const top = this.d.agentd.connected ? await list(root) : null;
    for (const e of top ?? []) {
      if (e.name.startsWith(".")) continue;
      if (e.type === "file" && /\.md$/i.test(e.name)) files.push(e.name);
      else if (e.type === "dir")
        for (const f of (await list(`${root}/${e.name}`)) ?? [])
          if (f.type === "file" && /\.md$/i.test(f.name)) files.push(`${e.name}/${f.name}`);
    }
    const runs = this.d.store.listPlaybookRuns(undefined, 1000);
    const names = [...new Set([...files, ...runs.map((r) => r.playbook)])].sort();
    if (!names.length)
      return top
        ? "No playbooks yet. Write one per recurring job to ~/Shared/playbooks/<area>/<job>.md (sections: goal and done criteria, before you start, steps, preferences, site quirks and fixes, good examples, lessons log)."
        : "Couldn't read ~/Shared/playbooks (the computer is off) and no playbook runs are recorded yet.";
    const lines = names.map((n) => {
      const mine = runs.filter((r) => r.playbook === n);
      const missing = top && !files.includes(n) ? " (file missing)" : "";
      return `- ${n}${missing}: ${playbookRunSummary(mine)}`;
    });
    return `Playbooks in ~/Shared/playbooks${top ? "" : " (couldn't list the folder: the computer is off; from recorded runs)"}:\n${lines.join("\n")}`;
  }

  /* ------------------------------ team checks ------------------------------ */

  /**
   * The lead agent (the primary) supervises its teammates: when a teammate's task runs into trouble (steps
   * keep failing, it runs long, core had to stop it), the lead gets ONE short note and can check in with
   * message_agent. Bounded: at most one note per teammate per cooldown, never about the lead itself, never
   * about a task the lead's own check-in started (no loop), none while the lead is already waiting on that
   * teammate's reply (the reply tells it how it went).
   */

  /** A teammate's task still running after OVERSIGHT_LONG_MS: the lead hears about it once. */
  private watchLong(agentId: string, turnId: string, after = this.d.oversightLongMs ?? OVERSIGHT_LONG_MS) {
    // A helper's job has its own tight time limit: no "running long" check for it.
    if (this.isHelper(agentId)) return;
    this.later(after, () => {
      const r = this.rt(agentId);
      if (this.disposed || r.runningTurn !== turnId || !r.health || !r.input) return;
      // Waiting on the user, a teammate or a free screen isn't being stuck: look again a little later.
      if (this.waitsLegitimately(r))
        return this.watchLong(agentId, turnId, Math.max(10, Math.min(60_000, after)));
      this.teamCheck(agentId, r.input, r.health, "long");
    });
  }

  /** A step of the running task finished: count failures in a row, and tell the lead if they keep coming. */
  private noteStep(r: AgentRuntime, item: Item) {
    const h = r.health;
    if (!h || h.turnId !== r.runningTurn || !r.input || !STEP_KINDS.has(item.kind)) return;
    if (item.status !== "failed") {
      if (item.status === "completed") h.failStreak = 0;
      return;
    }
    const now = Date.now();
    if (!h.failStreak) h.streakSince = now;
    h.failStreak++;
    h.failures++;
    h.recent = [...h.recent, { tool: stepName(item), error: stepError(item) }].slice(-3);
    if (
      h.failStreak >= OVERSIGHT_FAIL_STREAK &&
      now - h.streakSince >= (this.d.oversightFailMs ?? OVERSIGHT_FAIL_MS)
    )
      this.teamCheck(r.agentId, r.input, h, "failing");
  }

  /** A teammate's task ended: if it had trouble (or the lead already heard about it), tell the lead how. */
  private afterTeammateTurn(
    agentId: string,
    input: QueuedInput,
    h: TurnHealth,
    status: string,
    error?: string,
  ) {
    const why: TeamCheckWhy | null = h.stopped
      ? h.stopped
      : status === "failed"
        ? this.rt(agentId).turnSentAt
          ? "failed"
          : null // never reached the model (no model connected, say): nothing for the lead to fix
        : status !== "completed"
          ? null // the user stopped it
          : h.failures >= OVERSIGHT_FAIL_STREAK
            ? "rough"
            : h.noted
              ? "after check"
              : null;
    if (why) this.teamCheck(agentId, input, h, why, error);
  }

  private teamCheck(agentId: string, input: QueuedInput, h: TurnHealth, why: TeamCheckWhy, error?: string) {
    if (this.disposed || input.compact || input.oversight || input.fromCheckIn) return;
    const mate = this.d.store.getAgent(agentId);
    if (!mate || isLead(mate) || mate.archivedAt) return;
    // A helper's lead is the agent that started it. Only its mid-task trouble gets a separate check: how it
    // ended (froze, time limit, failed, rough) is part of its report.
    const helper = mate.kind === "helper";
    if (helper && why !== "failing") return;
    const lead =
      helper && mate.parentId
        ? this.d.store.getAgent(mate.parentId)
        : this.d.store.listAgents().find((a) => a.isPrimary);
    if (!lead || lead.id === agentId || lead.archivedAt) return;
    // The lead is waiting on this teammate's reply, or handed it this task: that reply (or "couldn't finish")
    // already tells it.
    if (this.waitsOn(lead.id, agentId)) return;
    const asked = input.from?.exchangeId ? this.exchanges.get(input.from.exchangeId) : undefined;
    if (asked?.fromAgentId === lead.id && asked.deliverLate) return;
    const now = Date.now();
    const lr = this.rt(lead.id);
    const waiting = lr.queue.find((q) => q.oversight?.about === agentId);
    // Refresh an already queued note even during cooldown, so the lead sees the final outcome.
    // Otherwise each task gets one check, and a new task must also clear the teammate cooldown.
    if (
      !waiting &&
      (h.noted || now - (this.teamCheckAt.get(agentId) ?? Number.NEGATIVE_INFINITY) < this.cooldown())
    )
      return;
    h.noted = true;

    const r = this.rt(agentId);
    const running = r.runningTurn === h.turnId;
    const headline = teamCheckHeadline(why, h, {
      now,
      error,
      stuckMs: this.d.stuckTurnMs ?? STUCK_TURN_MS,
      maxMs: this.turnLimit(agentId),
      elapsedMs: now - r.turnStartedAt,
    });
    const settings = this.d.store.getSettings();
    const userName = settings.userName?.trim() || "the user";
    const text = teamCheckNote({
      teammate: { name: helper ? `Your helper "${mate.name}"` : mate.name, role: helper ? "" : mate.role },
      headline,
      task: input.text,
      taskFrom:
        input.trigger === "routine"
          ? `a routine${input.label ? ` (${input.label})` : ""}`
          : helper || (input.from && input.from.agentId === lead.id)
            ? "you"
            : input.from
              ? input.from.name
              : userName,
      startedAgo: minutes(now - r.turnStartedAt),
      failures: h.failures,
      recent: h.recent,
      stillRunning: running,
      userName,
      ...(helper ? { helperId: mate.id } : {}),
    });
    if (waiting) {
      waiting.text = text;
      return;
    }
    this.teamCheckAt.set(agentId, now);
    log.info(`team check for ${lead.name} about ${mate.name}: ${headline}`);
    const check = helper ? `Helper check: "${mate.name}"` : `Team check: ${mate.name}`;
    this.d.store.addActivity({
      agentId: lead.id,
      kind: "system",
      summary: `${check} ${headline}`.slice(0, 200),
      ref: agentId,
    });
    this.d.onActivity();
    this.notice(lead.id, `${check} ${headline}. ${helper ? "I'll take a look." : "I'll check in."}`);
    this.enqueue(lead.id, null, {
      text,
      attachments: [],
      trigger: "oversight",
      oversight: { about: agentId },
    });
  }

  private cooldown(): number {
    return this.d.oversightCooldownMs ?? OVERSIGHT_COOLDOWN_MS;
  }

  /* ------------------------------- computer -------------------------------- */

  setLease(agentId: string, holder: LeaseHolder) {
    const r = this.rt(agentId);
    r.lease = holder;
    this.broadcast(agentId);
    if (holder === "agent") this.seatMaybeFree();
  }

  markComputer(agentId: string, state: ComputerState) {
    const r = this.rt(agentId);
    r.computer = state;
    // Waking it by hand counts as using it, so auto-sleep doesn't put it straight back to sleep.
    if (state === "ready" || state === "booting") r.lastUsedAt = Date.now();
    this.broadcast(agentId);
  }

  /**
   * Auto-sleep: hibernate every agent computer that has been idle for `idleMs` (no turn or queued message,
   * nothing waiting on the user, user not in control). Hibernating stops its screen and Chromium and frees the
   * memory; the next task wakes it and reopens its tabs. Works whether or not core manages the container.
   */
  async sleepIdle(idleMs: number): Promise<string[]> {
    const now = Date.now();
    const slept: string[] = [];
    for (const r of [...this.runtimes.values()]) {
      if (!isAwake(r) || !this.canSleep(r)) continue;
      // A computer found awake when core started gets a full idle period from then, not from 0.
      if (now - Math.max(r.lastUsedAt, this.startedAt) < idleMs) continue;
      if (await this.putToSleep(r)) slept.push(r.agentId);
    }
    return slept;
  }
}

/** A helper's card title: given, or the start of its brief; one line, at most 60 characters. */
function shortTitle(s: string): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || "Helper";
}

function oneLine(s: string, max: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Fingerprint of an agent's open tasks: it changes whenever one is added, closed or edited. */
function ledgerSig(tasks: LedgerTask[]): string {
  return tasks.map((t) => `${t.id}:${t.status}:${t.updatedAt}`).join("|");
}

/** How a playbook's runs have gone (newest first): count, the latest, and whether it's getting worse. */
function playbookRunSummary(
  runs: { startedAt: number; endedAt: number | null; outcome: string | null; corrections: number }[],
): string {
  if (!runs.length) return "no runs recorded yet";
  const done = runs.filter((r) => r.endedAt);
  const mins = (r: { startedAt: number; endedAt: number | null }) => (r.endedAt! - r.startedAt) / 60_000;
  const avg = (xs: typeof done) => xs.reduce((s, r) => s + mins(r), 0) / Math.max(1, xs.length);
  const last = runs[0]!;
  const parts = [
    `${runs.length} run${runs.length === 1 ? "" : "s"}`,
    `latest: ${last.endedAt ? `${Math.max(1, Math.round(mins(last)))} min, ` : ""}${last.outcome ?? "running"}${last.corrections ? `, ${last.corrections} correction${last.corrections === 1 ? "" : "s"}` : ""}`,
  ];
  if (done.length) parts.push(`average ${Math.max(1, Math.round(avg(done)))} min`);
  const recent = done.slice(0, 3);
  const before = done.slice(3, 6);
  if (recent.length >= 2 && before.length >= 2) {
    if (avg(recent) > avg(before) * 1.25) parts.push("GETTING SLOWER");
    const fixes = (xs: typeof done) => xs.reduce((s, r) => s + r.corrections, 0) / xs.length;
    if (fixes(recent) > fixes(before)) parts.push("MORE CORRECTIONS LATELY");
  }
  const failed = runs.slice(0, 5).filter((r) => r.outcome === "failed").length;
  if (failed >= 2) parts.push(`${failed} of the last ${Math.min(5, runs.length)} failed`);
  return parts.join("; ");
}

/** A step's tool, readably: "mcp__browser__browser_navigate" -> "browser_navigate". */
function stepName(item: Item): string {
  return (item.toolName ?? item.title ?? item.kind).replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
}

/** What a failed step said, on one short line. */
function stepError(item: Item): string {
  const said = (item.output ?? item.text ?? "").replace(/\s+/g, " ").trim();
  return said ? (said.length > 160 ? `${said.slice(0, 160)}…` : said) : "(no error text)";
}

/** One line on what's wrong with a teammate's task, after its name: "Pepe <headline>". */
function teamCheckHeadline(
  why: TeamCheckWhy,
  h: TurnHealth,
  t: { now: number; error?: string; stuckMs: number; maxMs: number; elapsedMs: number },
): string {
  switch (why) {
    case "failing":
      return `has had ${h.failStreak} steps in a row fail over ${minutes(t.now - h.streakSince)}`;
    case "long":
      return `has been on one task for ${minutes(t.elapsedMs)}${h.failures ? ` (${h.failures} failed steps so far)` : ""}`;
    case "froze":
      return `was stopped: a step froze for ${minutes(t.stuckMs)} with no progress`;
    case "time limit":
      return `was stopped at the ${minutes(t.maxMs)} time limit`;
    case "failed":
      return `couldn't finish its task${t.error ? `: ${t.error.replace(/\s+/g, " ").slice(0, 160)}` : ""}`;
    case "rough":
      return `finished its task, but ${h.failures} steps failed along the way`;
    case "after check":
      return "finished the task you were told about";
  }
}

export class UserFacingError extends Error {}
/** A turn that couldn't start because no usable model is connected. */
class NeedsModelError extends UserFacingError {}

/** A task can't start because the account's saved sign-in was turned down. */
function signInExpiredMessage(a: { provider: string }): string {
  const name = a.provider === "codex" ? "ChatGPT" : a.provider === "grok" ? "Grok" : "Claude";
  return `${name}'s sign-in has expired or was signed out. Open Settings → Accounts and press Sign in again, then send this again.`;
}
/** The task ended (stopped, time limit) while it was waiting for a free screen. */
class TurnEndedError extends Error {}

const isAwake = (r: { computer: ComputerState }) => r.computer === "ready" || r.computer === "booting";

/** The computer has no free screen (NO_FREE_SEAT; an older computer only says so in words). */
function isNoFreeSeat(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === NO_FREE_SEAT || /screens of the shared computer are in use/.test(e?.message ?? "");
}
