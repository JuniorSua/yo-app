import {
  type AgentActivity,
  type AgentdPush,
  type AgentView,
  type Attachment,
  type ComputerState,
  DEVICE_TOOLS,
  type Decision,
  type InputPart,
  type Item,
  type LeaseHolder,
  newId,
  type PendingRequest,
  type ProviderEvent,
  type RoutePreference,
  type TimelineEntry,
  type TodoEntry,
} from "@yo/contracts";
import type { AgentdClient } from "../agentd/AgentdClient";
import type { Store } from "../db/store";
import type { DeviceActionRequest, DeviceToolContext, DeviceWriteRequest } from "../devices/DeviceTools";
import type { Hub } from "../hub";
import { logger } from "../log";
import type { AccountService } from "./AccountService";
import { buildSystemAppend, compactPrompt, messageClock, SILENT_REPLY } from "./PromptBuilder";

const log = logger("orchestrator");

/** The one Yo tool whose card is an exact-action approval for a change on the user's Mac. */
const DEVICE_WRITE_TOOL = "mac_write_file";

/** Rotate a native session after this many turns or this age, seeding the new one from Yo's history. */
const MAX_TURNS_PER_SESSION = 80;
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
/** Auto-compact (summary + fresh session) once a conversation gets this heavy, so each turn stays light. */
const AUTO_COMPACT_TOKENS = 100_000;
const AUTO_COMPACT_TURNS = 60;

interface QueuedInput {
  text: string;
  attachments: Attachment[];
  trigger: "user" | "routine";
  label?: string;
  /** A /compact run: the reply becomes the handoff summary instead of a chat message. */
  compact?: { focus?: string; auto: boolean };
  /** Where this message's steps may run (composer choice). A preference, never a permission. */
  route?: RoutePreference;
}

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
  /** Input of the running turn (kept so a failed resume can be retried on a fresh session). */
  input: QueuedInput | null;
  /** Context size (tokens) the provider reported for the last turn on the current session. */
  contextTokens: number;
  /** Assistant text collected during a /compact turn. */
  compactText: Map<string, string>;
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
}

export interface OrchestratorDeps {
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
}

export class Orchestrator {
  private runtimes = new Map<string, AgentRuntime>();
  private sessionToAgent = new Map<string, string>();
  /** sessionKeys started on the current agentd connection. */
  private liveSessions = new Set<string>();
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
    this.seqTimer = setInterval(() => this.flushSeqs(), 2000);
    this.seqTimer.unref();
  }

  dispose() {
    this.disposed = true;
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
        input: null,
        contextTokens: 0,
        compactText: new Map(),
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
    };
  }

  views(): AgentView[] {
    return this.d.store
      .listAgents()
      .map((a) => this.view(a.id))
      .filter((v): v is AgentView => !!v);
  }

  broadcast(agentId: string) {
    const v = this.view(agentId);
    if (v) this.d.hub.push("agent.updated", v);
  }

  private broadcastAll() {
    for (const a of this.d.store.listAgents()) this.broadcast(a.id);
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

  /* --------------------------------- send ---------------------------------- */

  async send(
    agentId: string,
    text: string,
    attachments: Attachment[] = [],
    trigger: "user" | "routine" = "user",
    label?: string,
    route: RoutePreference = "auto",
  ) {
    const agent = this.d.store.getAgent(agentId);
    if (!agent) throw new Error("Unknown agent");
    this.d.onActivity();
    const r = this.rt(agentId);
    r.lastError = null;
    r.needsModel = false;

    const userItem: Item = {
      id: newId("itm"),
      kind: "user_message",
      status: "completed",
      text,
      ...(trigger === "routine" ? { title: label ? `Routine · ${label}` : "Routine" } : {}),
      ...(attachments.length
        ? { input: { attachments: attachments.map((a) => ({ name: a.name, mediaType: a.mediaType })) } }
        : {}),
    };
    this.upsert({ id: newId("usr"), agentId, turnId: null, item: userItem });
    this.d.store.touchAgent(agentId);

    const queued: QueuedInput = { text, attachments, trigger, label, route };
    if (r.runningTurn) {
      r.queue.push(queued);
      this.broadcast(agentId);
      return { turnId: "queued" };
    }
    const turnId = newId("trn");
    void this.runTurn(agentId, turnId, queued);
    return { turnId };
  }

  private async runTurn(agentId: string, turnId: string, input: QueuedInput) {
    const r = this.rt(agentId);
    r.runningTurn = turnId;
    r.input = input;
    r.turnStartedAt = Date.now();
    r.turnSentAt = 0;
    r.lastEventAt = Date.now();
    r.lastUsedAt = Date.now();
    this.broadcast(agentId);
    try {
      const agent = this.d.store.getAgent(agentId)!;
      let account = this.d.accounts.resolveFor(agent.accountId);
      if (!account || (account.status !== "authenticated" && account.status !== "unverified")) {
        throw new NeedsModelError(
          account
            ? `${account.label} isn't connected yet. Connect your subscription in Settings → Accounts, then send this again.`
            : "No model is connected yet. Connect your Claude or ChatGPT plan in Settings → Accounts, then send this again.",
        );
      }

      if (!this.d.agentd.connected) {
        this.notice(agentId, "Waking up my computer…", { turnId });
        await this.d.ensureComputer();
        await this.d.agentd.waitReady(120000);
      }

      // Saved by the "Connect your model" walkthrough before the computer existed: check it now.
      if (account.status === "unverified") {
        await this.d.accounts.configure(account.id);
        account = await this.d.accounts.refresh(account.id);
        if (account.status !== "authenticated")
          throw new NeedsModelError(
            `${account.label} didn't accept the saved sign-in. Open Settings → Accounts to connect it again.`,
          );
      }

      await this.ensureAwake(agentId);
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

      const parts: InputPart[] = [];
      const clock = messageClock(new Date(), this.d.store.getSettings().timezone);
      const prefix =
        input.trigger === "routine"
          ? `${clock} [Scheduled routine${input.label ? `: ${input.label}` : ""}] `
          : `${clock} `;
      let text = prefix + input.text;
      for (const a of input.attachments) {
        if (a.mediaType.startsWith("image/"))
          parts.push({ type: "image", mediaType: a.mediaType, data: a.data });
        else if (/^text\/|json|xml|csv|markdown/.test(a.mediaType) && a.data.length < 400_000) {
          text += `\n\n<attached file name="${a.name}">\n${Buffer.from(a.data, "base64").toString("utf8")}\n</attached file>`;
        } else {
          text += `\n\n(The user attached "${a.name}" (${a.mediaType}), which can't be read directly.)`;
        }
      }
      parts.unshift({ type: "text", text });
      await this.sendTurnWithRetry(agentId, sessionKey, turnId, parts);
    } catch (err: any) {
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

  private async ensureAwake(agentId: string) {
    const r = this.rt(agentId);
    if (r.computer !== "ready") {
      await this.d.agentd.request("computer.ensure", { agentId }, 90000);
      r.computer = "ready";
    }
    // Enforce the awake cap: hibernate least-recently-used idle computers.
    const awake = [...this.runtimes.values()].filter(
      (x) => x.computer === "ready" || x.computer === "booting",
    );
    const cap = Math.max(1, this.d.maxAwake());
    if (awake.length > cap) {
      const victims = awake
        .filter((x) => x.agentId !== agentId && !x.runningTurn && x.lease !== "user")
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
        .slice(0, awake.length - cap);
      for (const v of victims) {
        await this.d.agentd.request("computer.hibernate", { agentId: v.agentId }).catch(() => {});
        v.computer = "hibernated";
        this.broadcast(v.agentId);
      }
    }
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
    if (!this.liveSessions.has(s.id)) {
      await this.startNative(agentId, s.id, accountId, runtimeMode, effort, model);
    } else if ((s.model ?? null) !== (model ?? null)) {
      await this.d.agentd
        .request("session.set", { sessionKey: s.id, model: model ?? undefined })
        .catch(() => {});
      this.d.store.updateSession(s.id, { model });
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
    const systemAppend = buildSystemAppend({
      agent,
      otherAgents: this.d.store
        .listAgents()
        .filter((a) => a.id !== agentId)
        .map((a) => ({ name: a.name, role: a.role })),
      settings,
      memories: this.d.store.listMemories(agentId),
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
      now: new Date(),
    });
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
    const compactRun = r.input?.compact;
    const trigger = r.input?.trigger;
    r.input = null;
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
    const silent =
      status === "completed" &&
      trigger === "routine" &&
      !compactRun &&
      this.quietRoutineReply(agentId, turnId);
    if (status !== "interrupted" && !compactRun && !silent) {
      this.d.store.bumpUnread(agentId);
      const preview = this.d.store.lastAssistantPreview(agentId) ?? "";
      this.d.hub.push("notify", {
        agentId,
        title: agent?.name ?? "Yo",
        body: status === "failed" ? (error ?? "Something went wrong") : preview || "Done",
        kind: status === "failed" ? "error" : "done",
      });
    }
    this.broadcast(agentId);
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
  private quietRoutineReply(agentId: string, turnId: string): boolean {
    const last = this.d.store
      .listTimeline(agentId, undefined, 20)
      .reverse()
      .find((e) => e.turnId === turnId && e.item.kind === "assistant_message");
    if (!last || last.item.text?.trim() !== SILENT_REPLY) return false;
    this.upsert({
      ...last,
      item: { ...last.item, kind: "notice", text: "Routine ran: nothing new to report." },
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
        call.tool === DEVICE_WRITE_TOOL ? "expired" : "This request expired: the task ended.",
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

  async interrupt(agentId: string) {
    const r = this.rt(agentId);
    r.queue = [];
    // Unblock any Yo tool calls waiting on the user.
    for (const call of [...this.toolCalls.values()].filter((c) => c.agentId === agentId)) {
      this.resolveToolCall(
        call.callId,
        call.tool === DEVICE_WRITE_TOOL ? "expired" : "The user stopped this task.",
        "expired",
      );
    }
    if (r.sessionKey && r.runningTurn) {
      await this.d.agentd.request("turn.interrupt", { sessionKey: r.sessionKey }).catch(() => {});
      const turnId = r.runningTurn;
      // If the provider doesn't confirm quickly, close the turn ourselves.
      this.later(8000, () => {
        if (!this.disposed && this.rt(agentId).runningTurn === turnId)
          this.finishTurn(agentId, turnId, "interrupted");
      });
    }
    this.broadcast(agentId);
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
    void this.d.agentd
      .request("computer.status", {})
      .then((st) => {
        for (const a of st.agents) {
          const r = this.rt(a.agentId);
          r.computer = a.state;
          r.lease = a.lease;
        }
        this.broadcastAll();
      })
      .catch(() => {});
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
        const r = this.rt(p.agentId);
        r.computer = p.state;
        if (p.lease) r.lease = p.lease;
        this.broadcast(p.agentId);
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
    if (!agentId) return;
    this.sessionToAgent.set(sessionKey, agentId);
    this.seqFlush.set(sessionKey, seq);
    const r = this.rt(agentId);
    if (this.abandoned.has(sessionKey)) return;
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
        if (ev.status === "failed" && ev.error)
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
        this.upsert({
          id: entryId,
          agentId,
          turnId: r.runningTurn,
          item,
          source: item.kind === "assistant_message" ? source : undefined,
        });
        if (ev.type === "item.completed" && item.kind === "assistant_message" && item.text?.includes("!["))
          void this.attachImageSnapshots(agentId, entryId, item.text);
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
      const rule = this.d.store.findRule(agentId, req.toolName);
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
    this.d.store.addActivity({
      agentId,
      kind: "approval",
      summary: `${agent?.name ?? "Agent"} needs you: ${what}`,
      ref: null,
    });
    this.d.hub.push("notify", {
      agentId,
      title: `${agent?.name ?? "Yo"} needs you`,
      body: what,
      kind: "needs_you",
    });
    this.broadcast(agentId);
  }

  async respond(
    agentId: string,
    requestId: string,
    decision: Decision,
    answers?: Record<string, string>,
    message?: string,
  ) {
    const call = this.toolCalls.get(requestId);
    if (call) {
      let text: string;
      let status: "allowed" | "denied" | "answered";
      if (call.tool === "ask_user") {
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
      } else if (call.tool === "request_takeover") {
        text =
          decision === "deny"
            ? `The user declined to take over.${message ? ` They said: ${message}` : ""}`
            : `The user took over and has handed control back.${message ? ` They said: ${message}` : ""} Take a screenshot/snapshot to see the current state before continuing.`;
        status = decision === "deny" ? "denied" : "answered";
      } else {
        if (decision === "allowAlways") {
          const category = String(call.args.category ?? "other");
          this.d.store.addRule({ agentId, match: `yo:${category}`, decision: "allow" });
        }
        text =
          decision === "deny"
            ? `DENIED by the user. Do not perform this action.${message ? ` The user said: ${message}` : ""}`
            : `APPROVED by the user. Go ahead.${message ? ` The user said: ${message}` : ""}`;
        status = decision === "deny" ? "denied" : "allowed";
      }
      this.resolveToolCall(requestId, text, status);
      return;
    }
    const pr = this.providerRequests.get(requestId);
    if (!pr) throw new Error("This request is no longer pending.");
    if (decision === "allowAlways" && pr.toolName)
      this.d.store.addRule({ agentId, match: pr.toolName, decision: "allow" });
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
    );
    if (e) this.upsert({ ...e, item: { ...e.item, status: "completed" } });
    this.broadcast(agentId);
  }

  private resolveToolCall(
    callId: string,
    text: string,
    status: "allowed" | "denied" | "answered" | "expired",
  ) {
    const call = this.toolCalls.get(callId);
    if (!call) return;
    this.toolCalls.delete(callId);
    const e = this.d.store.setRequestStatus(call.entryId, status);
    const output =
      call.tool === DEVICE_WRITE_TOOL
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
    try {
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
      const interactive = this.interactiveTool(agentId, p);
      if (interactive) {
        const text = await interactive;
        await reply(true, text);
        return;
      }
      const text = await this.d.tools(agentId, p.tool, p.args);
      if (p.tool === "notify_user")
        this.notice(agentId, String(p.args.message ?? ""), { turnId: this.rt(agentId).runningTurn });
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
      const rule = this.d.store.findRule(agentId, `yo:${category}`);
      if (rule)
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
      this.needsYou(agentId, request.title);
    });
  }

  /* ------------------------------- computer -------------------------------- */

  setLease(agentId: string, holder: LeaseHolder) {
    const r = this.rt(agentId);
    r.lease = holder;
    this.broadcast(agentId);
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
      if (r.computer !== "ready" && r.computer !== "booting") continue;
      if (r.runningTurn || r.queue.length || r.lease === "user" || this.hasPending(r.agentId)) continue;
      // A computer found awake when core started gets a full idle period from then, not from 0.
      if (now - Math.max(r.lastUsedAt, this.startedAt) < idleMs) continue;
      try {
        await this.d.agentd.request("computer.hibernate", { agentId: r.agentId });
      } catch {
        continue;
      }
      r.computer = "hibernated";
      this.broadcast(r.agentId);
      slept.push(r.agentId);
    }
    return slept;
  }
}

export class UserFacingError extends Error {}
/** A turn that couldn't start because no usable model is connected. */
class NeedsModelError extends UserFacingError {}
