/**
 * Optional Telegram channel: notifications, approvals, questions and chat with your agents from your phone.
 *
 * Off until the owner saves a bot token (from @BotFather). Core never opens a port for it: it long-polls
 * Telegram's Bot API (`getUpdates`) over outbound HTTPS, so it works behind Tailscale with no public URL.
 * Only ONE chat is ever accepted, captured with a one-time `/pair <code>`; every other chat is ignored.
 *
 * Mac changes (exact-action approvals bound to the Mac UI) and screen takeovers are never answered here:
 * the message just says to open Yo.
 *
 * Long polling, the single-poller 409 rule and "unknown senders are ignored" follow Rakazo's messaging
 * adapters (packages/adapters/src/messaging-platforms.ts, Apache-2.0); see NOTICE.
 */
import crypto from "node:crypto";
import type {
  Agent,
  ApiPushChannel,
  ApiPushes,
  ChannelApiMethods,
  Decision,
  TelegramStatus,
  TimelineEntry,
} from "@yo/contracts";
import type { Store } from "../db/store";
import type { Hub } from "../hub";
import { addSecret, logger } from "../log";
import type { Orchestrator } from "../orchestrator/Orchestrator";
import type { SecretStore } from "../secrets/SecretStore";

const log = logger("telegram");

const SECRET_KEY = "telegram-bot-token";
const KV_KEY = "telegram";
const API_BASE = "https://api.telegram.org";
/** Telegram's limit per message. We stay a little under it. */
const MAX_TEXT = 4096 - 64;
/** A long reply is sent as at most this many messages; the rest stays in Yo. */
const MAX_REPLY_CHUNKS = 4;
const POLL_TIMEOUT_S = 50;
const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_MAX_TRIES = 5;
const PAIR_MAX_TOTAL_TRIES = 50;
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_OUTBOX = 100;
const MAX_ACTIONS = 500;
/** Exact-action approvals for a change on the user's Mac (file writes and app actions share it). */
const DEVICE_WRITE_TOOL = "mac_write_file";
const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

/* ------------------------------ Telegram types ----------------------------- */

interface TgChat {
  id: number;
  type: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  title?: string;
}
interface TgMessage {
  message_id: number;
  chat: TgChat;
  text?: string;
  reply_to_message?: { message_id: number };
}
interface TgCallbackQuery {
  id: string;
  data?: string;
  message?: { message_id: number; chat: TgChat };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
type TgButton = { text: string; callback_data: string };

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    description: string,
    readonly retryAfter?: number,
  ) {
    super(description);
  }
}

/* --------------------------------- helpers -------------------------------- */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Escape, then clip to `n` characters of HTML (never inside an entity), so a card can't outgrow Telegram's limit. */
export function escClip(s: string, n: number): string {
  const html = escapeHtml(s);
  if (html.length <= n) return html;
  let cut = html.slice(0, n - 1);
  const amp = cut.lastIndexOf("&");
  if (amp > cut.lastIndexOf(";")) cut = cut.slice(0, amp);
  return `${cut}…`;
}

/**
 * Escape `text` and split it into messages of at most `limit` characters (after escaping), preferring line
 * breaks. Splits only between characters, so an entity like `&amp;` is never cut. `prefix` (already HTML)
 * starts the first message.
 */
export function chunkHtml(text: string, prefix = "", limit = MAX_TEXT): string[] {
  const chunks: string[] = [];
  let cur = prefix;
  for (const ch of text) {
    const t = escapeHtml(ch);
    if (cur.length + t.length > limit) {
      const cut = cur.lastIndexOf("\n");
      if (cut > limit / 2) {
        chunks.push(cur.slice(0, cut));
        cur = cur.slice(cut + 1);
      } else {
        chunks.push(cur);
        cur = "";
      }
    }
    cur += t;
  }
  if (cur.trim() || !chunks.length) chunks.push(cur);
  return chunks;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

const shortId = () => crypto.randomBytes(6).toString("base64url");

/* ---------------------------------- types --------------------------------- */

interface State {
  chatId: number | null;
  chatName: string | null;
  activeAgentId: string | null;
  /** Next getUpdates offset (so a restart doesn't replay handled updates). */
  offset: number;
}
const EMPTY_STATE: State = { chatId: null, chatName: null, activeAgentId: null, offset: 0 };

type Action =
  | {
      type: "respond";
      entryId: string;
      agentId: string;
      requestId: string;
      decision: Decision;
      /** Answer to a question (option label). */
      answer?: string;
    }
  | { type: "use"; agentId: string };

/** A message we sent for a request card. */
interface Card {
  entryId: string;
  agentId: string;
  requestId: string;
  chatId: number;
  messageId: number | null;
  text: string;
  question: boolean;
  questions: string[];
  actionIds: string[];
  resolved: boolean;
}

/** Narrow views of core services (tests pass fakes). */
export interface TelegramDeps {
  store: Pick<
    Store,
    "getKv" | "setKv" | "getAgent" | "listAgents" | "getEntry" | "listTimeline" | "maxTimelineSeq"
  >;
  hub: Pick<Hub, "subscribe">;
  orchestrator: Pick<Orchestrator, "send" | "respond" | "interrupt" | "pendingRequestEntries" | "activityOf">;
  secrets: SecretStore;
  fetch?: typeof fetch;
  apiBase?: string;
  /** Minimum gap between messages to the chat (Telegram allows about one per second per chat). */
  sendGapMs?: number;
  pollTimeoutS?: number;
}

type ChannelHandlers = {
  [M in keyof ChannelApiMethods]: (
    params: ChannelApiMethods[M]["params"],
  ) => Promise<ChannelApiMethods[M]["result"]>;
};

const STATUS_LABEL: Record<string, string> = {
  allowed: "Approved in Yo",
  denied: "Denied in Yo",
  answered: "Answered in Yo",
  expired: "Expired",
};

const HELP = [
  "<b>Yo on Telegram</b>",
  "Send a message and it goes to your current agent; its reply comes back here.",
  "",
  "/agents · pick which agent you're talking to",
  "/use &lt;name&gt; · switch agent by name",
  "/stop · stop what the current agent is doing",
  "/unpair · disconnect this chat from Yo",
  "",
  "Approvals and questions show up with buttons. To answer a question in your own words, reply to it.",
].join("\n");

/* --------------------------------- channel -------------------------------- */

export class TelegramChannel {
  readonly api: ChannelHandlers;
  private token: string | null = null;
  private bot: { username: string; name: string } | null = null;
  private poll: AbortController | null = null;
  private polling = false;
  private lastError: string | null = null;
  /** Wrong codes are counted per chat, so a stranger who finds the bot can't use up the owner's tries. */
  private pair: { code: string; expiresAt: number; tries: Map<number, number>; total: number } | null = null;
  private outbox: (() => Promise<unknown>)[] = [];
  private draining: Promise<void> | null = null;
  private lastSentAt = 0;
  /** callback_data -> what the button does (callback_data is limited to 64 bytes). */
  private actions = new Map<string, Action>();
  /** request entry id -> the message showing it */
  private cards = new Map<string, Card>();
  /** Turns the owner started from Telegram whose reply is still owed, per agent. */
  private awaiting = new Map<string, { count: number; afterSeq: number }>();
  private unsubscribe: (() => unknown) | null = null;
  private readonly fetch: typeof fetch;
  private readonly base: string;
  private readonly gap: number;
  private readonly pollTimeout: number;

  constructor(private d: TelegramDeps) {
    this.fetch = d.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.base = d.apiBase ?? API_BASE;
    this.gap = d.sendGapMs ?? 1000;
    this.pollTimeout = d.pollTimeoutS ?? POLL_TIMEOUT_S;
    // Pushes are ignored until a token is saved and a chat is paired (see onPush).
    this.unsubscribe = d.hub.subscribe((channel, data) => this.onPush(channel, data));
    this.api = {
      "channels.telegram.status": async () => this.status(),
      "channels.telegram.configure": async (p) =>
        "clear" in p && p.clear
          ? this.clear()
          : this.configure(String((p as { token?: string }).token ?? "")),
      "channels.telegram.pairCode": async () => this.newPairCode(),
      "channels.telegram.unpair": async () => {
        this.unpair();
        return this.status();
      },
    };
  }

  /** Start if a token is saved. Does nothing (and sends nothing) otherwise. */
  async start() {
    const token = await this.d.secrets.get(SECRET_KEY).catch(() => null);
    if (!token) return;
    addSecret(token);
    this.token = token;
    this.startPolling();
  }

  async stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.poll?.abort();
    this.poll = null;
    this.outbox = [];
  }

  /** Resolves once everything queued so far has been sent. */
  async idle() {
    while (this.draining) await this.draining;
  }

  status(): TelegramStatus {
    const st = this.state();
    return {
      configured: !!this.token,
      polling: this.polling,
      bot: this.bot,
      paired: st.chatId != null ? { chatId: st.chatId, name: st.chatName ?? "" } : null,
      activeAgentId: this.activeAgent()?.id ?? null,
      pairCodeExpiresAt: this.pair && this.pair.expiresAt > Date.now() ? this.pair.expiresAt : null,
      lastError: this.lastError,
    };
  }

  /* -------------------------------- config -------------------------------- */

  private async configure(raw: string): Promise<TelegramStatus> {
    const token = raw.trim();
    if (!TOKEN_SHAPE.test(token)) throw new Error("That doesn't look like a bot token from @BotFather.");
    // Scrub it from logs even if checking it with Telegram fails below.
    addSecret(token);
    let me: { username?: string; first_name?: string };
    try {
      me = await this.call("getMe", {}, { token });
    } catch (err) {
      throw new Error(
        err instanceof TelegramError && err.code === 401
          ? "Telegram didn't accept this bot token."
          : `Couldn't reach Telegram to check the token: ${err instanceof Error ? err.message : err}`,
      );
    }
    // Long polling doesn't work while a webhook is set (409), and Yo never uses one.
    await this.call("deleteWebhook", { drop_pending_updates: false }, { token }).catch(() => {});
    if (token !== this.token) {
      // A different bot: its chats and update ids have nothing to do with the old one.
      this.saveState({ chatId: null, chatName: null, offset: 0 });
      this.forgetCards();
    }
    await this.d.secrets.set(SECRET_KEY, token);
    this.token = token;
    this.bot = { username: me.username ?? "", name: me.first_name ?? "" };
    this.lastError = null;
    this.startPolling();
    log.info(`Telegram bot @${this.bot.username} configured`);
    return this.status();
  }

  private async clear(): Promise<TelegramStatus> {
    this.poll?.abort();
    this.poll = null;
    await this.d.secrets.delete(SECRET_KEY);
    this.token = null;
    this.bot = null;
    this.pair = null;
    this.lastError = null;
    this.outbox = [];
    this.saveState({ chatId: null, chatName: null, offset: 0 });
    this.forgetCards();
    log.info("Telegram channel turned off");
    return this.status();
  }

  private newPairCode(): { code: string; expiresAt: number; link: string | null } {
    if (!this.token) throw new Error("Set a Telegram bot token first.");
    let code = "";
    for (let i = 0; i < 6; i++) code += PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)];
    this.pair = { code, expiresAt: Date.now() + PAIR_TTL_MS, tries: new Map(), total: 0 };
    return {
      code,
      expiresAt: this.pair.expiresAt,
      link: this.bot?.username ? `https://t.me/${this.bot.username}?start=${code}` : null,
    };
  }

  private unpair() {
    const { chatId } = this.state();
    if (chatId != null) this.sendHtml(chatId, "This chat is no longer connected to Yo.");
    this.saveState({ chatId: null, chatName: null });
    this.forgetCards();
  }

  private forgetCards() {
    this.cards.clear();
    this.actions.clear();
    this.awaiting.clear();
  }

  private state(): State {
    return { ...EMPTY_STATE, ...(this.d.store.getKv<Partial<State>>(KV_KEY) ?? {}) };
  }

  private saveState(patch: Partial<State>) {
    this.d.store.setKv(KV_KEY, { ...this.state(), ...patch });
  }

  /* --------------------------------- polling -------------------------------- */

  private startPolling() {
    this.poll?.abort();
    const ctrl = new AbortController();
    this.poll = ctrl;
    void this.loop(ctrl.signal);
  }

  private async loop(signal: AbortSignal) {
    this.polling = true;
    let backoff = 1000;
    try {
      if (!this.bot) {
        const me = await this.call<{ username?: string; first_name?: string }>("getMe", {}, { signal }).catch(
          () => null,
        );
        if (me) this.bot = { username: me.username ?? "", name: me.first_name ?? "" };
      }
      while (!signal.aborted) {
        try {
          const updates = await this.call<TgUpdate[]>(
            "getUpdates",
            {
              offset: this.state().offset,
              timeout: this.pollTimeout,
              allowed_updates: ["message", "callback_query"],
            },
            { signal, timeoutMs: (this.pollTimeout + 15) * 1000 },
          );
          backoff = 1000;
          this.lastError = null;
          for (const u of updates) {
            if (signal.aborted) break;
            // Advance first: an update that crashes us must not be replayed forever.
            this.saveState({ offset: u.update_id + 1 });
            await this.handleUpdate(u).catch((err) => log.warn("couldn't handle a Telegram update", err));
          }
        } catch (err) {
          if (signal.aborted) break;
          if (err instanceof TelegramError && err.code === 401) {
            this.lastError = "Telegram rejected the bot token (revoked?). Set a new one.";
            log.warn(this.lastError);
            break;
          }
          if (err instanceof TelegramError && err.code === 409) {
            if (/webhook/i.test(err.message)) {
              await this.call("deleteWebhook", { drop_pending_updates: false }, { signal }).catch(() => {});
              continue;
            }
            // Telegram allows one getUpdates reader per bot.
            this.lastError =
              "Another program is reading this bot's messages. Stop it, or give Yo its own bot.";
          } else {
            this.lastError = `Can't reach Telegram: ${err instanceof Error ? err.message : err}`;
          }
          log.warn(`${this.lastError} (retrying in ${Math.round(backoff / 1000)}s)`);
          await sleep(backoff, signal);
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    } finally {
      if (this.poll?.signal === signal || !this.poll) this.polling = false;
    }
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { signal?: AbortSignal; timeoutMs?: number; token?: string } = {},
  ): Promise<T> {
    const token = opts.token ?? this.token;
    if (!token) throw new Error("Telegram isn't set up");
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
    const res = await this.fetch(`${this.base}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    } | null;
    if (!body?.ok)
      throw new TelegramError(
        body?.error_code ?? res.status,
        body?.description ?? `HTTP ${res.status}`,
        body?.parameters?.retry_after,
      );
    return body.result as T;
  }

  /* -------------------------------- outbound -------------------------------- */

  /** Queue a call to the chat; sends are spaced out and retried once Telegram says how long to wait. */
  private enqueue(job: () => Promise<unknown>) {
    if (!this.token) return;
    if (this.outbox.length >= MAX_OUTBOX) {
      log.warn("Telegram outbox is full; dropping a message");
      return;
    }
    this.outbox.push(job);
    this.kick();
  }

  private kick() {
    if (this.draining || !this.outbox.length) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      this.kick();
    });
  }

  private async drain() {
    for (let job = this.outbox.shift(); job; job = this.outbox.shift()) {
      const wait = this.lastSentAt + this.gap - Date.now();
      if (wait > 0) await sleep(wait);
      for (let attempt = 0; ; attempt++) {
        try {
          await job();
          break;
        } catch (err) {
          if (err instanceof TelegramError && err.retryAfter && attempt < 2) {
            await sleep(err.retryAfter * 1000);
            continue;
          }
          log.warn("Telegram send failed", err instanceof Error ? err.message : err);
          break;
        }
      }
      this.lastSentAt = Date.now();
    }
  }

  private sendHtml(
    chatId: number,
    text: string,
    buttons?: TgButton[][],
    onSent?: (messageId: number) => void,
  ) {
    this.enqueue(async () => {
      const m = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
      });
      onSent?.(m.message_id);
    });
  }

  private toOwner(text: string, buttons?: TgButton[][]) {
    const { chatId } = this.state();
    if (chatId != null) this.sendHtml(chatId, text, buttons);
  }

  private sendReply(agentName: string, text: string) {
    let chunks = chunkHtml(text, `<b>${escapeHtml(agentName)}</b>\n`);
    if (chunks.length > MAX_REPLY_CHUNKS) {
      chunks = chunks.slice(0, MAX_REPLY_CHUNKS);
      chunks[chunks.length - 1] += "\n\n<i>… the rest is in Yo.</i>";
    }
    for (const c of chunks) this.toOwner(c);
  }

  private addAction(a: Action): string {
    const id = shortId();
    this.actions.set(id, a);
    while (this.actions.size > MAX_ACTIONS) this.actions.delete(this.actions.keys().next().value!);
    return id;
  }

  private onPush(channel: ApiPushChannel, data: unknown) {
    if (!this.token || this.state().chatId == null) return;
    if (channel === "notify") this.onNotify(data as ApiPushes["notify"]);
    else if (channel === "timeline.upsert") this.onEntry(data as TimelineEntry);
    else if (channel === "agent.updated") this.onAgent(data as ApiPushes["agent.updated"]);
  }

  /**
   * An agent stopped without a reply for Telegram (stopped from the Mac, or nothing to say): forget the
   * replies still owed, or a later chat started at the Mac would be forwarded as if Telegram asked.
   * Checked a tick later, because a queued message starts its turn right after the previous one ends.
   */
  private onAgent(a: ApiPushes["agent.updated"]) {
    if (!this.awaiting.has(a.id) || a.activity === "working" || a.activity === "waiting") return;
    setImmediate(() => {
      // Core may have shut down (and closed the database) in the meantime.
      if (!this.unsubscribe) return;
      try {
        const now = this.d.orchestrator.activityOf(a.id);
        if (now !== "working" && now !== "waiting") this.awaiting.delete(a.id);
      } catch (err) {
        log.debug(`couldn't check ${a.id}'s activity: ${err instanceof Error ? err.message : err}`);
      }
    });
  }

  private onNotify(n: ApiPushes["notify"]) {
    // "needs_you" always comes with a pending request card, which we send instead.
    if (n.kind === "info" || n.kind === "needs_you") return;
    const w = n.agentId ? this.awaiting.get(n.agentId) : undefined;
    if (w && n.agentId) {
      w.count--;
      if (w.count <= 0) this.awaiting.delete(n.agentId);
      if (n.kind === "done") {
        const reply = this.d.store
          .listTimeline(n.agentId, undefined, 200)
          .filter((e) => e.seq > w.afterSeq && e.item.kind === "assistant_message" && e.item.text?.trim())
          .at(-1);
        if (reply) {
          w.afterSeq = reply.seq;
          this.sendReply(this.d.store.getAgent(n.agentId)?.name ?? n.title, reply.item.text!);
          return;
        }
      }
    }
    // A reply to a chat started in the Yo app: the owner is at their Mac, so the phone stays quiet.
    // Routine results and problems are always forwarded.
    if (n.kind === "done" && n.agentId && !this.lastTurnWasRoutine(n.agentId)) return;
    const head =
      n.kind === "error" ? `<b>${escapeHtml(n.title)}</b> hit a problem` : `<b>${escapeHtml(n.title)}</b>`;
    this.toOwner(`${head}\n${escClip(n.body, 1000)}`);
  }

  /** Whether the agent's latest message came from a routine (routine messages carry a "Routine" title). */
  private lastTurnWasRoutine(agentId: string): boolean {
    const last = this.d.store
      .listTimeline(agentId, undefined, 50)
      .filter((e) => e.item.kind === "user_message")
      .at(-1);
    return !!last?.item.title?.startsWith("Routine");
  }

  private onEntry(e: TimelineEntry) {
    if (!e.request) return;
    const card = this.cards.get(e.id);
    if (e.request.status === "pending") {
      if (!card) this.sendCard(e);
    } else if (card && !card.resolved) {
      this.resolveCard(card, STATUS_LABEL[e.request.status] ?? "Handled in Yo");
    }
  }

  private sendCard(e: TimelineEntry) {
    const { chatId } = this.state();
    const req = e.request;
    if (chatId == null || !req) return;
    const name = escapeHtml(this.d.store.getAgent(e.agentId)?.name ?? "Agent");
    const title = escClip(req.title, 300);
    const card: Card = {
      entryId: e.id,
      agentId: e.agentId,
      requestId: req.requestId,
      chatId,
      messageId: null,
      text: "",
      question: false,
      questions: (req.questions ?? []).map((q) => q.question),
      actionIds: [],
      resolved: false,
    };
    const respond = (decision: Decision, answer?: string) => {
      const id = this.addAction({
        type: "respond",
        entryId: e.id,
        agentId: e.agentId,
        requestId: req.requestId,
        decision,
        answer,
      });
      card.actionIds.push(id);
      return id;
    };
    let buttons: TgButton[][] = [];

    if (req.deviceWrite || req.deviceAction || req.toolName === DEVICE_WRITE_TOOL) {
      // Exact-action approvals are bound to what the Mac shows; never approve them from here.
      card.text = `<b>${name} wants to change something on your Mac</b>\n${title}\n\nOpen Yo to review this change on your Mac.`;
    } else if (req.toolName === "request_takeover" || e.item.toolName === "request_takeover") {
      card.text = `<b>${name} needs you to take over its screen</b>\n${escClip(req.detail || req.title, 600)}\n\nOpen Yo to take over.`;
    } else if (req.kind === "user_input") {
      const q = req.questions?.[0];
      card.question = true;
      const header = q?.header ? ` · ${escapeHtml(q.header)}` : "";
      const options = (q?.options ?? []).slice(0, 8);
      card.text = `<b>${name} is asking</b>${header}\n${escClip(q?.question || req.title, 1500)}\n\n<i>${options.length ? "Tap an answer, or reply" : "Reply"} to this message to answer.</i>`;
      buttons = options.map((o) => [{ text: clip(o.label, 60), callback_data: respond("allow", o.label) }]);
    } else {
      const input = (req.input ?? {}) as Record<string, unknown>;
      const chips = Object.entries(input)
        .filter(
          ([k, v]) =>
            ["category", "total", "recipient", "url", "amount"].includes(k) && typeof v === "string",
        )
        .map(([k, v]) => `${k}: ${escClip(String(v), 200)}`);
      card.text = [
        `<b>${name} needs your approval</b>`,
        title,
        ...(req.detail ? [escClip(req.detail, 1500)] : []),
        ...(chips.length ? [`<i>${chips.join(" · ")}</i>`] : []),
      ].join("\n");
      buttons = [
        // No "Always allow" here: a standing rule is too easy to set with a stray tap on a phone. The Yo
        // app still offers it.
        [
          { text: "Approve", callback_data: respond("allow") },
          { text: "Deny", callback_data: respond("deny") },
        ],
      ];
    }
    this.cards.set(e.id, card);
    this.sendHtml(chatId, card.text, buttons, (messageId) => {
      card.messageId = messageId;
    });
  }

  /** Show the outcome on the card and remove its buttons. */
  private resolveCard(card: Card, outcome: string) {
    card.resolved = true;
    this.cards.delete(card.entryId);
    for (const id of card.actionIds) this.actions.delete(id);
    this.enqueue(async () => {
      if (card.messageId == null) return;
      await this.call("editMessageText", {
        chat_id: card.chatId,
        message_id: card.messageId,
        text: `${card.text}\n\n<b>${escapeHtml(outcome)}</b>`,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      });
    });
  }

  /* --------------------------------- inbound -------------------------------- */

  /** Handle one update from getUpdates (public for tests). */
  async handleUpdate(u: TgUpdate) {
    if (u.callback_query) await this.onCallback(u.callback_query);
    else if (u.message) await this.onMessage(u.message);
  }

  private async onMessage(m: TgMessage) {
    const st = this.state();
    const text = (m.text ?? "").trim();
    if (st.chatId == null || m.chat.id !== st.chatId) {
      // The only thing another chat can do is pair, and only while a code is waiting.
      const pair = /^\/(?:pair|start)(?:@\w+)?\s+(\S+)/i.exec(text);
      if (pair && this.pair && m.chat.type === "private") this.tryPair(m.chat, pair[1]!);
      else log.debug("ignored a message from a chat that isn't paired");
      return;
    }
    if (!m.text) {
      this.toOwner("I can only read text messages for now.");
      return;
    }
    if (text.startsWith("/")) return this.onCommand(text);

    // An answer to a question: a reply to its card, or else the current agent's open question.
    const agent = this.activeAgent();
    const replyTo = m.reply_to_message?.message_id;
    const open = [...this.cards.values()].filter((c) => c.question && !c.resolved);
    const card =
      (replyTo != null ? open.find((c) => c.messageId === replyTo) : undefined) ??
      open.filter((c) => c.agentId === agent?.id).at(-1);
    if (card && this.d.store.getEntry(card.entryId)?.request?.status === "pending") {
      await this.respondTo(card, "allow", text);
      return;
    }
    if (!agent) {
      this.toOwner("You don't have any agents yet. Create one in Yo.");
      return;
    }
    try {
      const afterSeq = this.d.store.maxTimelineSeq(agent.id);
      const res = await this.d.orchestrator.send(agent.id, text);
      const w = this.awaiting.get(agent.id);
      if (w) w.count++;
      else this.awaiting.set(agent.id, { count: 1, afterSeq });
      if (res.turnId === "queued")
        this.toOwner(`${escapeHtml(agent.name)} is busy; your message is next in line.`);
      else this.enqueue(() => this.call("sendChatAction", { chat_id: st.chatId, action: "typing" }));
    } catch (err) {
      this.toOwner(`Couldn't send that: ${escapeHtml(err instanceof Error ? err.message : String(err))}`);
    }
  }

  private tryPair(chat: TgChat, code: string) {
    const p = this.pair;
    if (!p || Date.now() > p.expiresAt) {
      this.pair = null;
      return;
    }
    const tries = p.tries.get(chat.id) ?? 0;
    if (tries >= PAIR_MAX_TRIES) return; // this chat is out of tries: ignored until the next code
    if (code.toUpperCase() !== p.code) {
      p.tries.set(chat.id, tries + 1);
      // A burst of wrong codes from many chats ends the window (codes are 6 of 32 characters).
      if (++p.total >= PAIR_MAX_TOTAL_TRIES) this.pair = null;
      log.info("a Telegram pairing attempt used the wrong code");
      this.sendHtml(chat.id, "That code didn't match. Get a fresh one from Yo and try again.");
      return;
    }
    this.pair = null;
    const name =
      [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
      (chat.username ? `@${chat.username}` : "");
    this.forgetCards();
    this.saveState({ chatId: chat.id, chatName: name });
    log.info("Telegram chat paired");
    const agent = this.activeAgent();
    this.toOwner(`Connected to Yo. You're talking to <b>${escapeHtml(agent?.name ?? "Yo")}</b>.\n\n${HELP}`);
    for (const e of this.d.orchestrator.pendingRequestEntries()) this.sendCard(e);
  }

  private async onCommand(text: string) {
    const [head = "", ...rest] = text.split(/\s+/);
    const cmd = head.slice(1).replace(/@.*$/, "").toLowerCase();
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "start":
      case "help":
        this.toOwner(HELP);
        return;
      case "agents":
        return this.listAgents();
      case "use": {
        const a = this.findAgent(arg);
        if (!a) {
          this.toOwner(
            arg ? `No agent called “${escapeHtml(arg)}”. /agents lists them.` : "Usage: /use &lt;name&gt;",
          );
          return;
        }
        this.useAgent(a);
        return;
      }
      case "stop": {
        const a = this.activeAgent();
        if (!a) return;
        this.awaiting.delete(a.id);
        await this.d.orchestrator.interrupt(a.id);
        this.toOwner(`Stopped ${escapeHtml(a.name)}.`);
        return;
      }
      case "pair":
        this.toOwner("This chat is already connected to Yo.");
        return;
      case "unpair":
        this.unpair();
        return;
      default:
        this.toOwner(`I don't know /${escapeHtml(cmd)}. Try /help.`);
    }
  }

  private listAgents() {
    const active = this.activeAgent();
    const agents = this.d.store.listAgents().slice(0, 30);
    const buttons = agents.map((a) => [
      {
        text: `${a.id === active?.id ? "● " : ""}${clip(a.name, 50)}`,
        callback_data: this.addAction({ type: "use", agentId: a.id }),
      },
    ]);
    this.toOwner(`Tap an agent to talk to it. Now: <b>${escapeHtml(active?.name ?? "none")}</b>`, buttons);
  }

  private findAgent(name: string): Agent | undefined {
    const q = name.trim().toLowerCase();
    if (!q) return undefined;
    const agents = this.d.store.listAgents();
    const exact = agents.find((a) => a.name.toLowerCase() === q);
    if (exact) return exact;
    const partial = agents.filter((a) => a.name.toLowerCase().startsWith(q));
    return partial.length === 1 ? partial[0] : undefined;
  }

  private useAgent(a: Agent) {
    this.saveState({ activeAgentId: a.id });
    this.toOwner(`Now talking to <b>${escapeHtml(a.name)}</b>.`);
  }

  /** The agent Telegram messages go to: the one picked with /use, else the primary agent. */
  private activeAgent(): Agent | undefined {
    const id = this.state().activeAgentId;
    const picked = id ? this.d.store.getAgent(id) : null;
    if (picked && !picked.archivedAt) return picked;
    const agents = this.d.store.listAgents();
    return agents.find((a) => a.isPrimary) ?? agents[0];
  }

  private async onCallback(q: TgCallbackQuery) {
    const { chatId } = this.state();
    if (chatId == null || q.message?.chat.id !== chatId) {
      log.debug("ignored a button press from a chat that isn't paired");
      return;
    }
    const answer = (text: string) =>
      this.call("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
    const action = this.actions.get(q.data ?? "");
    if (!action) {
      await answer("This button has expired. Open Yo to see what's pending.");
      return;
    }
    if (action.type === "use") {
      const a = this.d.store.getAgent(action.agentId);
      if (!a || a.archivedAt) {
        await answer("That agent is gone.");
        return;
      }
      this.useAgent(a);
      await answer(`Now talking to ${a.name}`);
      return;
    }
    const card = this.cards.get(action.entryId);
    if (!card) {
      this.actions.delete(q.data ?? "");
      await answer("This request was already handled.");
      return;
    }
    const outcome = await this.respondTo(card, action.decision, action.answer);
    await answer(outcome);
  }

  /** Answer a request from Telegram, unless it was already handled elsewhere. Returns the outcome shown. */
  private async respondTo(card: Card, decision: Decision, answer?: string): Promise<string> {
    const entry = this.d.store.getEntry(card.entryId);
    if (entry?.request?.status !== "pending") {
      const label = STATUS_LABEL[entry?.request?.status ?? ""] ?? "No longer pending";
      this.resolveCard(card, label);
      return `Already handled: ${label}`;
    }
    // Mark first: respond() pushes the resolved entry synchronously, which would label it "in Yo".
    card.resolved = true;
    const outcome = card.question
      ? `Answered ✓ by you: ${clip(answer ?? "", 200)}`
      : decision === "deny"
        ? "Denied ✗ by you"
        : decision === "allowAlways"
          ? "Always allowed ✓ by you"
          : "Approved ✓ by you";
    try {
      if (card.question) {
        const value = answer ?? "";
        const answers = Object.fromEntries(card.questions.map((q) => [q, value]));
        await this.d.orchestrator.respond(card.agentId, card.requestId, decision, answers, value);
      } else {
        await this.d.orchestrator.respond(card.agentId, card.requestId, decision);
      }
    } catch (err) {
      log.info(`Telegram response not applied: ${err instanceof Error ? err.message : err}`);
      this.resolveCard(card, "No longer pending");
      return "This request is no longer pending.";
    }
    this.resolveCard(card, outcome);
    return outcome;
  }
}
