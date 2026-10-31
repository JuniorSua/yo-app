/**
 * Yo Phone: text Yo from any phone (docs/phone/PROTOCOL.md).
 *
 * The phone is a web app on Vercel (phone/). Messages go through a relay there that only stores encrypted
 * envelopes; the key travels in the phone link's URL fragment and never reaches the server. Like the Telegram
 * channel, core only makes outbound HTTPS calls: it polls the relay's `in` mailbox and posts to `out`, so it
 * works behind Tailscale with no public URL.
 *
 * Off until the owner makes a phone link (`channels.phone.pair`). The link is personal to the owner of this Yo
 * (there's no guest mode yet): whoever holds it texts Yo as the owner. A new link or `off` revokes the old one.
 * The phone still only sees its own conversation: replies, errors and approval cards from turns its own messages
 * started, never ones from turns started in Yo on the computer.
 * Mac changes and screen takeovers are never answered from the phone: the card says to open Yo on the computer.
 */

import type { webcrypto } from "node:crypto";
import {
  type Agent,
  type ApiPushChannel,
  type ApiPushes,
  type Attachment,
  briefFromInput,
  briefIsEmpty,
  type Decision,
  type LedgerTask,
  type MorningBrief,
  type PhoneApiMethods,
  type PhoneStatus,
  readReplies,
  SECURE_INPUT_TOOL,
  type TimelineEntry,
} from "@yo/contracts";
import { computerImageRefs } from "../chatImages";
import type { Store } from "../db/store";
import type { Hub } from "../hub";
import { imageInfo, type ShrunkImage, shrinkImage } from "../imageShrink";
import { addSecret, logger } from "../log";
import type { Orchestrator, TurnEvent } from "../orchestrator/Orchestrator";
import type { SecretStore } from "../secrets/SecretStore";
import { createTasksApi } from "../tasks/tasks";
import { activeSpaceAgent } from "../team/spaces";
import { claimBrief, sendBriefRequest } from "../tools/brief";
import {
  admitFor,
  BLOB_ID_RE,
  boxOf,
  coreCredFor,
  deriveKeys,
  hashOf,
  importSignKey,
  newSignKey,
  open,
  openBlob,
  type PhoneKeys,
  type PhoneSignKey,
  randomBlobId,
  randomSecret,
  seal,
  sealBlob,
  signOut,
} from "./phoneCrypto";

const log = logger("phone");

const SECRET_KEY = "phone-link-secret";
/** Lets core register a new mailbox with the relay (the relay only accepts mail for registered boxes). */
const REGISTER_KEY = "phone-register-key";
const NO_REGISTER_KEY = "Yo Phone isn't available on this copy of Yo yet. It's coming soon.";
/** The link's Ed25519 private key (PKCS8) and public key, JSON. Core signs every `out` envelope with it. */
const SIGN_KEY = "phone-sign-key";
/** Wipes of old mailboxes that failed and are being retried (JSON list of PendingRevoke). */
const REVOKES_KEY = "phone-pending-revokes";
const OLD_LINK = "This phone link is from an older version. Make a new link.";
const KV_KEY = "_phone";
export const DEFAULT_RELAY_URL = "https://yo-phone.vercel.app";

/*
 * Poll cadence. The relay's mailbox is a free Upstash Redis database shared with everything else on it, capped at
 * 500k commands a month, so core polls slowly unless someone is actually texting: every GET is one command and a
 * beat (`beat=1`, which tells the phone the PC is online) is one more.
 */
/** Between polls while nobody is texting. */
export const IDLE_POLL_MS = 15_000;
/** Between polls for a while after a phone message, so a conversation feels live. */
export const FAST_POLL_MS = 1_500;
/** How long the fast cadence lasts after the last phone message. */
export const FAST_FOR_MS = 5 * 60_000;
/** At most one beat per this long. */
export const BEAT_EVERY_MS = 2 * 60_000;
/** Longest wait between retries when the relay can't be reached. */
export const MAX_BACKOFF_MS = 60_000;
/** At most one "working" status per this long while a turn runs. */
export const STATUS_EVERY_MS = 15_000;

const MAX_IN_TEXT = 8000;
const MAX_REPLY = 16_000;
const REST_IN_YO = "\n\n… the rest is in Yo.";
const MAX_SEEN_IDS = 500;
/** A `msg` older than this isn't run (a replayed envelope, or one stuck somewhere for too long). */
const MAX_MSG_AGE_MS = 10 * 60_000;
/** Turns the phone started that we remember (for cards and replies). */
const MAX_OWN_TURNS = 200;
const MAX_QUEUED = 100;
/** Flood cap: phone messages queued or running at once, and accepted per rolling minute. */
const MAX_IN_FLIGHT = 3;
const MAX_PER_MINUTE = 10;
const BUSY = "Yo is busy. Send it again in a minute.";
/** At most one BUSY reply per this long per mailbox, so a flood of messages doesn't become a flood of posts. */
const BUSY_EVERY_MS = 60_000;
/** Revoke retries: first wait, then doubling up to the max. */
const REVOKE_RETRY_MS = 5_000;
const MAX_REVOKE_BACKOFF_MS = 10 * 60_000;
const MAX_OUTBOX = 200;
const DEVICE_WRITE_TOOL = "mac_write_file";

/*
 * Pictures (v2.1). Each one is shrunk (imageShrink.ts), encrypted and stored once on the relay as a blob with a short
 * TTL; the signed `images` message only points at it. The relay's database is a shared free one, so: a few per
 * reply, and a daily budget per link. Past either, the phone says "N more pictures in Yo".
 */
export const MAX_PICS_PER_REPLY = 4;
export const MAX_PICS_PER_DAY = 40;
export const MAX_PIC_BYTES_PER_DAY = 8_000_000;
/** Photos the phone sends with one message, and the most bytes each may have. */
const MAX_IN_PICS = 3;
const MAX_IN_PIC_BYTES = 1_500_000;
const IN_PIC_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
/**
 * What this core understands beyond v2, told to the phone in `hello` (an older phone ignores it). v2.3: `tasks`
 * (the Tasks page), `brief` (hello's localDate claims the morning brief; replies carry it) and `replies` (quick
 * replies on a reply).
 */
export const PHONE_CAPS = ["images", "photos", "helpers", "tasks", "brief", "replies"] as const;
/** Peeks at the agent's screen (v2.2): at most one per PEEK_EVERY_MS; past that the phone hears "wait" once a minute. */
export const PEEK_EVERY_MS = 5_000;
const PEEK_TEXT = "Here's my screen right now.";
const PEEK_FAILED = "I couldn't get a look at my screen just now. My computer may be asleep or restarting.";
const DAY_MS = 24 * 60 * 60_000;
/** Tasks (v2.3): at most this many go to the phone; ledger changes are gathered this long into one push. */
export const MAX_PHONE_TASKS = 40;
export const TASKS_PUSH_MS = 5_000;
/**
 * Task pushes only go to a phone seen this recently: a closed phone doesn't read its mailbox, so pushes would pile
 * up on the relay. It asks for the list itself whenever it comes back to the foreground.
 */
export const TASKS_PUSH_SEEN_MS = 15 * 60_000;
/**
 * The relay refuses envelopes over 64 KiB (413), and the sealed, base64'd box is about 4/3 of its JSON. Messages
 * that can grow (the task list, a reply with a brief) are kept under this many UTF-8 bytes of JSON.
 */
export const MAX_OUT_JSON_BYTES = 40_000;
/** A brief that came without any text after it still gets a reply to sit on. */
const BRIEF_ONLY = "Here's your brief.";
const TASK_ACTIONS = new Set(["start", "hide", "done"]);
/** A refused Start always says so (the phone waits for it), but at most this many times a minute. */
const MAX_TASK_REFUSALS_PER_MINUTE = 10;
const TASK_BUSY = "I'm busy right now. Try Start again in a minute.";

const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const realSleep = (ms: number, signal?: AbortSignal) =>
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

/* ---------------------------------- types --------------------------------- */

/** Messages from the phone (plaintext inside `in` envelopes). */
export type PhoneIn =
  /** `localDate` (v2.3, `YYYY-MM-DD`, the phone's own date): claims the day's morning brief like brief.claim. */
  | { v: 1; t: "hello"; id: string; device?: string; localDate?: string }
  | { v: 1; t: "msg"; id: string; text: string; at?: number; pics?: PicRef[] }
  | { v: 1; t: "respond"; id: string; requestId: string; decision: "approve" | "deny"; answer?: string }
  | { v: 1; t: "stop"; id: string }
  /** v2.2: a picture of the agent's screen right now (only when the core said `peek` in its caps). */
  | { v: 1; t: "peek"; id: string }
  /** v2.3: send me the task list. */
  | { v: 1; t: "tasks"; id: string }
  /** v2.3: Start (a suggestion or a task the user saved), Hide (a suggestion) or check off a task. */
  | { v: 1; t: "task"; id: string; taskId: string; action: "start" | "hide" | "done" };

/** A picture stored as a blob on the relay (v2.1). `hash`: base64url sha256 of the bytes. */
export interface PicRef {
  id: string;
  mime: string;
  w: number;
  h: number;
  size: number;
  hash: string;
  /** Pictures from a reply: the markdown source it replaces, and its alt text. */
  src?: string;
  alt?: string;
}

/** A ledger task as the phone shows it (v2.3). */
export interface PhoneTask {
  id: string;
  title: string;
  status: LedgerTask["status"];
  note?: string;
  why?: string;
  origin?: NonNullable<LedgerTask["origin"]>;
  updatedAt: number;
}

/** Order on the phone: what needs the user first, newest first within a status. */
const TASK_ORDER: LedgerTask["status"][] = ["review", "waiting", "in_progress", "open", "suggested", "done"];

/** The Tasks page (tasks.list) as the phone gets it: sorted, at most MAX_PHONE_TASKS, long text clipped. */
export function phoneTasks(list: LedgerTask[]): PhoneTask[] {
  const rank = (s: LedgerTask["status"]) => {
    const i = TASK_ORDER.indexOf(s);
    return i < 0 ? TASK_ORDER.length : i;
  };
  return [...list]
    .sort((a, b) => rank(a.status) - rank(b.status) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_PHONE_TASKS)
    .map((t) => ({
      id: t.id,
      title: clip(t.title, 200),
      status: t.status,
      ...(t.note?.trim() ? { note: clip(t.note.trim(), 300) } : {}),
      ...(t.why?.trim() ? { why: clip(t.why.trim(), 300) } : {}),
      ...(t.origin ? { origin: t.origin } : {}),
      updatedAt: t.updatedAt,
    }));
}

/**
 * The list cut to fit `budget` bytes of JSON (the relay's size limit): first the notes and whys go, from the
 * bottom of the list up, then the rows at the bottom. The order puts what needs the user first, so that's what
 * stays.
 */
export function fitTasks(items: PhoneTask[], budget = MAX_OUT_JSON_BYTES - 200): PhoneTask[] {
  const out = [...items];
  const sizes = out.map(jsonBytes);
  // "[" + "]" + the commas between rows.
  let total = 2 + Math.max(0, out.length - 1) + sizes.reduce((a, b) => a + b, 0);
  for (let i = out.length - 1; i >= 0 && total > budget; i--) {
    const t = out[i]!;
    if (t.note === undefined && t.why === undefined) continue;
    const { note: _n, why: _w, ...rest } = t;
    out[i] = rest;
    const size = jsonBytes(rest);
    total += size - sizes[i]!;
    sizes[i] = size;
  }
  while (out.length && total > budget) {
    total -= sizes.pop()! + (out.length > 1 ? 1 : 0);
    out.pop();
  }
  return out;
}

/** What the list shows, for "did it change": a newer `updatedAt` alone isn't worth a push. */
const tasksShown = (items: PhoneTask[]) => JSON.stringify(items.map(({ updatedAt: _u, ...t }) => t));

/** The brief as the phone gets it: without Yo's own `start` notes (Start sends what the row shows). */
export function phoneBrief(b: MorningBrief): MorningBrief {
  const rows = (list: MorningBrief["needsYou"]) => list.map(({ start: _s, ...r }) => r);
  return { ...b, needsYou: rows(b.needsYou), canWait: rows(b.canWait), today: rows(b.today) };
}

/**
 * A brief's reply text when Yo wrote none, for phones that can't draw the card (older ones, the iOS app): the
 * titles that need the user, short. A 1.3 phone hides it under the card (the reply says `briefText`).
 */
export function briefFallbackText(b: MorningBrief): string {
  const titles = b.needsYou.map((r) => clip(r.title.replace(/\s+/g, " ").trim(), 60)).filter(Boolean);
  if (!titles.length) return `${BRIEF_ONLY} Nothing needs you right now.`;
  const shown = titles.slice(0, 5).map((t) => `• ${t}`);
  if (titles.length > 5) shown.push(`• and ${titles.length - 5} more`);
  return `Your brief: ${shown.join(" ")}`;
}

const isTool = (e: TimelineEntry, name: string) =>
  e.item.kind === "tool" &&
  e.item.status === "completed" &&
  !!e.item.toolName &&
  new RegExp(`(^|__)${name}$`).test(e.item.toolName);

/**
 * What a finished turn showed besides its text (v2.3), read like the chat draws it (web: agent/blocks.ts): the
 * brief of its post_brief call, and the quick replies of a suggest_replies call on its last step (none once
 * another tool ran after it).
 */
export function turnExtras(turn: TimelineEntry[]): {
  brief?: MorningBrief;
  briefEntryId?: string;
  replies?: string[];
} {
  const out: { brief?: MorningBrief; briefEntryId?: string; replies?: string[] } = {};
  const call = turn.filter((e) => isTool(e, "post_brief")).at(-1);
  const brief = call ? briefFromInput(call.item.input) : null;
  if (call && brief && !briefIsEmpty(brief)) {
    out.brief = brief;
    out.briefEntryId = call.id;
  }
  const last = turn.filter((e) => e.item.kind === "tool").at(-1);
  if (last && isTool(last, "suggest_replies")) {
    const r = readReplies(last.item.input);
    if ("replies" in r) out.replies = r.replies;
  }
  return out;
}

/** Messages to the phone (plaintext inside `out` envelopes). */
export type PhoneOut =
  | { v: 1; t: "hello"; agent: { name: string }; at: number; caps?: readonly string[] }
  | { v: 1; t: "ack"; ids: string[] }
  | {
      v: 1;
      t: "status";
      agent: string;
      state: "working" | "queued" | "idle";
      detail?: string;
      /** Helpers the agent started that are still working (v2.1). */
      helpers?: number;
    }
  | {
      v: 1;
      t: "reply";
      id: string;
      agent: string;
      text: string;
      at: number;
      /** How many pictures follow in an `images` message (v2.1). */
      pics?: number;
      /** v2.2: the answer to a `peek` (not a turn's reply: the phone keeps its working indicator). */
      peek?: true;
      /** v2.3: the morning brief the turn posted (post_brief), drawn as a card above the text. */
      brief?: MorningBrief;
      /** v2.3: `text` is only the brief's titles in words (Yo wrote none): a phone that draws the card hides it. */
      briefText?: true;
      /** v2.3: quick replies (suggest_replies on the turn's last step), shown as chips. */
      replies?: string[];
    }
  /** v2.3: the task list. Only to a phone that has asked for it (`tasks`) at least once. */
  | { v: 1; t: "tasks"; items: PhoneTask[]; at: number }
  | { v: 1; t: "images"; replyId: string; items: PicRef[]; more: number }
  | {
      v: 1;
      t: "request";
      requestId: string;
      agent: string;
      kind: "approval" | "question" | "open_yo";
      title: string;
      detail: string;
      options?: string[];
    }
  | { v: 1; t: "resolved"; requestId: string; outcome: string }
  | { v: 1; t: "error"; agent: string; text: string };

/** Distributes Omit over the union, so each message keeps its own fields. */
type OutBody = PhoneOut extends infer U ? (U extends PhoneOut ? Omit<U, "v"> : never) : never;

interface State {
  enabled: boolean;
  /** null: the default (YO_PHONE_RELAY_URL or yo-phone.vercel.app). */
  relayUrl: string | null;
  pairedAt: number | null;
  /** When the phone last sent anything. */
  lastSeenAt: number | null;
  device: string | null;
  /** Handled phone message ids (the last 500), so a re-delivered or replayed one doesn't run twice. */
  seen: string[];
  /** The last `n` put on a message to the phone (the counter only goes up, across links and restarts). */
  outN?: number;
  /** Pictures sent today (UTC day number), for the daily budget. */
  pics?: { day: number; count: number; bytes: number };
  /** v2.3: this phone asked for the task list, so it understands `tasks` pushes (an older phone never asks). */
  tasksCap?: boolean;
}
const EMPTY_STATE: State = {
  enabled: false,
  relayUrl: null,
  pairedAt: null,
  lastSeenAt: null,
  device: null,
  seen: [],
};

/** What a core call to the relay authenticates with (v2: token, admit and coreCred). */
interface Creds {
  authToken: string;
  admit: string;
  coreCred: string;
}

/** A wipe of an old mailbox that hasn't gone through yet. */
interface PendingRevoke extends Creds {
  relayUrl: string;
  tries: number;
  nextAt: number;
}

async function credsFor(keys: PhoneKeys, registerKey: string): Promise<Creds> {
  const box = await boxOf(keys.authToken);
  const [admit, coreCred] = await Promise.all([admitFor(registerKey, box), coreCredFor(registerKey, box)]);
  addSecret(admit);
  addSecret(coreCred);
  return { authToken: keys.authToken, admit, coreCred };
}

/** A request card sent to the phone. */
interface Card {
  entryId: string;
  /** The turn it belongs to (always one of the phone's). */
  turnId: string | null;
  agentId: string;
  requestId: string;
  kind: "approval" | "question" | "open_yo";
  questions: string[];
  resolved: boolean;
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The relay refused the credentials (401): its register key changed (or core has the wrong one), so every link made
 * with the old key is void there. Retrying can't help.
 */
const isUnauthorized = (err: unknown) => err instanceof RelayError && err.status === 401;
const GIVE_UP_REVOKE =
  "the relay no longer accepts an old phone mailbox's credentials (its register key changed), so the old link " +
  "can't reach it any more; not retrying the wipe (the relay's own 30-day expiry clears it)";
const KEY_REFUSED = "The relay didn't accept Yo's relay key. Set the right one with `yo-ops phone key`.";

/** Narrow views of core services (tests pass fakes). */
export interface PhoneDeps {
  store: Pick<
    Store,
    | "getKv"
    | "setKv"
    | "getAgent"
    | "listAgents"
    | "getEntry"
    | "listTimeline"
    | "getSettings"
    // v2.3 Tasks (through tasks.ts's createTasksApi) and the morning brief claim (brief.ts)
    | "getTask"
    | "updateTask"
    | "addTask"
    | "listTaskPage"
    | "onTaskChange"
  >;
  hub: Pick<Hub, "subscribe">;
  orchestrator: Pick<Orchestrator, "send" | "respond" | "interrupt" | "pendingRequestEntries" | "onTurn">;
  secrets: SecretStore;
  /** Default relay (config `phoneRelayUrl`). */
  relayUrl?: string;
  fetch?: typeof fetch;
  /**
   * Reads a picture a reply embeds (its markdown src), from the chat-images snapshot when there is one (`stored`),
   * else from the agent's computer. Without it, replies say their pictures are in Yo.
   */
  readImage?: (agentId: string, src: string, stored?: string) => Promise<Buffer>;
  /** A PNG of the agent's screen right now (agentd's /screenshot). Without it, the phone gets no `peek` cap. */
  screenshot?: (agentId: string) => Promise<Buffer>;
  /** Phone-sized copy of a picture, or null if it can't fit (defaults to imageShrink). */
  shrink?: (buf: Buffer) => ShrunkImage | null;
  /** Clock and waits (tests make them fast). */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  idlePollMs?: number;
  fastPollMs?: number;
  fastForMs?: number;
  beatEveryMs?: number;
  maxBackoffMs?: number;
  statusEveryMs?: number;
  /** First wait before retrying a failed wipe of an old mailbox (doubles up to 10 minutes). */
  revokeRetryMs?: number;
  /** How long ledger changes are gathered into one `tasks` push (v2.3). */
  tasksPushMs?: number;
}

type PhoneHandlers = {
  [M in keyof PhoneApiMethods]: (
    params: PhoneApiMethods[M]["params"],
  ) => Promise<PhoneApiMethods[M]["result"]>;
};

const STATUS_LABEL: Record<string, string> = {
  allowed: "Approved in Yo",
  denied: "Denied in Yo",
  answered: "Answered in Yo",
  expired: "Expired",
  failed: "Couldn't fill the page",
};

/** A relay URL: https (http only for this machine, for the local dev relay), no trailing slash. */
export function normalizeRelayUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("That isn't a web address.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    throw new Error("The relay must be an https:// address.");
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

/* --------------------------------- channel -------------------------------- */

export class PhoneChannel {
  readonly api: PhoneHandlers;
  private secret: string | null = null;
  private keys: PhoneKeys | null = null;
  /** The relay credentials for the current link (null without a relay key). */
  private creds: Creds | null = null;
  private signKey: webcrypto.CryptoKey | null = null;
  private signPub: string | null = null;
  private pendingRevokes: PendingRevoke[] = [];
  private revokeCtrl: AbortController | null = null;
  /** When the phone's recent messages were accepted (flood cap). */
  private sentAt: number[] = [];
  /** When the phone last got a BUSY reply (reset with each new link, i.e. per mailbox). */
  private busyAt = Number.NEGATIVE_INFINITY;
  /** When refused task Starts were told "busy" in the last minute (each is told, up to a few a minute). */
  private taskRefusedAt: number[] = [];
  /** The last peek taken, and the last "wait a moment" said about one. */
  private peekAt = Number.NEGATIVE_INFINITY;
  private peekBusyAt = Number.NEGATIVE_INFINITY;
  private registerKey: string | null = null;
  private registerKeyLoaded = false;
  private poll: AbortController | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private polling = false;
  private lastError: string | null = null;
  private lastBeatAt = Number.NEGATIVE_INFINITY;
  private fastUntil = 0;
  /** Recently handled phone message ids (the relay delivers at least once). */
  private seen = new Set<string>();
  private outbox: OutBody[] = [];
  private draining: Promise<void> | null = null;
  /** Pictures are prepared one reply at a time, in order. */
  private pictures: Promise<void> = Promise.resolve();
  /** request entry id -> the card the phone got */
  private cards = new Map<string, Card>();
  /** The phone's messages still waiting in "Up next" (queuedId -> agent). */
  private queued = new Map<string, string>();
  /** Turns the phone's messages started (turnId -> agent), oldest first. Only these get cards and replies. */
  private ownTurns = new Map<string, string>();
  /** The subset still running. */
  private openTurns = new Set<string>();
  private unwatchTurns: (() => unknown) | null = null;
  /** Last "working" status per agent, and what the agent is doing right now. */
  private statusAt = new Map<string, number>();
  private detail = new Map<string, string>();
  /** Helpers' last known state (helperId -> parent and whether it's busy), for "2 helpers working". */
  private helperState = new Map<string, { parentId: string; active: boolean }>();
  private helpersSent = new Map<string, number>();
  private unsubscribe: (() => unknown) | null = null;
  /** v2.3 Tasks: the Tasks page's API (its rules, not a copy), the ledger watch, and the last list sent. */
  private readonly tasks: ReturnType<typeof createTasksApi>;
  private unwatchTasks: (() => unknown) | null = null;
  private tasksTimer: ReturnType<typeof setTimeout> | null = null;
  private tasksSent: string | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly defaultRelay: string;
  private readonly t: {
    idle: number;
    fast: number;
    fastFor: number;
    beat: number;
    maxBackoff: number;
    status: number;
    revoke: number;
    tasks: number;
  };

  constructor(private d: PhoneDeps) {
    this.fetch = d.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? realSleep;
    this.defaultRelay = normalizeRelayUrl(d.relayUrl || DEFAULT_RELAY_URL);
    this.t = {
      idle: d.idlePollMs ?? IDLE_POLL_MS,
      fast: d.fastPollMs ?? FAST_POLL_MS,
      fastFor: d.fastForMs ?? FAST_FOR_MS,
      beat: d.beatEveryMs ?? BEAT_EVERY_MS,
      maxBackoff: d.maxBackoffMs ?? MAX_BACKOFF_MS,
      status: d.statusEveryMs ?? STATUS_EVERY_MS,
      revoke: d.revokeRetryMs ?? REVOKE_RETRY_MS,
      tasks: d.tasksPushMs ?? TASKS_PUSH_MS,
    };
    // Pushes are ignored until there's a phone link (see onPush).
    this.unsubscribe = d.hub.subscribe((channel, data) => this.onPush(channel, data));
    this.unwatchTurns = d.orchestrator.onTurn((e) => this.onTurn(e));
    // A task started from the phone is the phone's own turn (never steered into another), so its reply comes back.
    this.tasks = createTasksApi({
      store: d.store,
      orchestrator: {
        send: async (agentId, text, attachments, trigger, label, route, opts) => {
          const res = await d.orchestrator.send(agentId, text, attachments, trigger, label, route, {
            ...opts,
            noSteer: true,
          });
          this.own(agentId, res);
          return res;
        },
      },
      now: () => this.now(),
    });
    this.unwatchTasks = d.store.onTaskChange((t) => this.onTaskChange(t));
    this.api = {
      "channels.phone.status": async () => {
        await this.loadRegisterKey();
        return this.status();
      },
      "channels.phone.pair": async () => {
        await this.loadRegisterKey();
        return this.pair();
      },
      "channels.phone.configure": async (p) => {
        await this.loadRegisterKey();
        return this.configure(p ?? {});
      },
      "channels.phone.off": async () => {
        await this.loadRegisterKey();
        return this.off();
      },
    };
  }

  /** Start polling if a phone link exists. Does nothing (and sends nothing) otherwise. */
  async start() {
    await this.loadRegisterKey();
    // Old mailboxes whose wipe failed earlier: keep trying, whether or not there's a link now.
    const pending = await this.d.secrets.get(REVOKES_KEY).catch(() => null);
    if (pending) {
      try {
        const list = JSON.parse(pending) as PendingRevoke[];
        this.pendingRevokes = Array.isArray(list) ? list : [];
        for (const r of this.pendingRevokes) for (const v of [r.authToken, r.admit, r.coreCred]) addSecret(v);
      } catch {
        this.pendingRevokes = [];
      }
      this.kickRevokes();
    }
    const secret = await this.d.secrets.get(SECRET_KEY).catch(() => null);
    if (!secret) return;
    const signRaw = await this.d.secrets.get(SIGN_KEY).catch(() => null);
    try {
      if (!signRaw) throw new Error(OLD_LINK);
      await this.useSecret(secret, JSON.parse(signRaw) as PhoneSignKey);
    } catch (err) {
      this.lastError =
        err instanceof Error && err.message === OLD_LINK
          ? OLD_LINK
          : "The saved phone link is damaged. Make a new one.";
      log.warn(this.lastError, err instanceof Error ? err.message : err);
      return;
    }
    this.seen = new Set(this.state().seen);
    // Refresh the mailbox's registration (it lapses after 30 days without a beat). Best effort: if it fails, the
    // first poll registers again.
    if (this.creds)
      await this.register(this.creds).catch((err) =>
        log.info(err instanceof Error ? err.message : String(err)),
      );
    await this.startPolling();
  }

  async stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unwatchTurns?.();
    this.unwatchTurns = null;
    this.unwatchTasks?.();
    this.unwatchTasks = null;
    this.stopTaskPush();
    this.poll?.abort();
    this.poll = null;
    this.revokeCtrl?.abort();
    this.revokeCtrl = null;
    this.outbox = [];
  }

  /** The main agent's create_phone_link (after the owner approved it in Yo). */
  async createLink(): Promise<{ link: string }> {
    await this.loadRegisterKey();
    return this.pair();
  }

  /** The main agent's turn_off_phone (after the owner approved it in Yo). */
  async turnOff(): Promise<PhoneStatus> {
    await this.loadRegisterKey();
    return this.off();
  }

  /** Whether a turn was started by a message from the phone. */
  isPhoneTurn(turnId: string): boolean {
    return this.ownTurns.has(turnId);
  }

  /**
   * The next counter for a message to the phone. It's inside the signed envelope, and the phone refuses one that
   * doesn't go up, so the relay can't replay or reorder replies. Milliseconds since the epoch (or one more than the
   * last, if that's higher), so it keeps going up even if the saved value were lost.
   */
  private nextOutN(): number {
    const n = Math.max((this.state().outN ?? 0) + 1, this.now());
    this.saveState({ outN: n });
    return n;
  }

  /** Resolves once everything queued for the phone so far (pictures included) has been posted. */
  async idle() {
    await this.pictures;
    while (this.draining) await this.draining;
  }

  relayUrl(): string {
    return this.state().relayUrl ?? this.defaultRelay;
  }

  status(): PhoneStatus {
    const st = this.state();
    return {
      enabled: !!this.secret,
      relayUrl: this.relayUrl(),
      link: this.linkUrl(),
      pairedAt: this.secret ? st.pairedAt : null,
      lastPhoneAt: this.secret ? st.lastSeenAt : null,
      device: this.secret ? st.device : null,
      polling: this.polling,
      lastError: this.lastError,
      registerKeySet: !!this.registerKey,
      revokePending: this.pendingRevokes.length > 0,
    };
  }

  /** `#k=<secret>&a=<admit>&p=<signPub>` (v2). Null without a link, or without the relay key to make `a`. */
  private linkUrl(): string | null {
    if (!this.secret || !this.creds || !this.signPub) return null;
    return `${this.relayUrl()}/#k=${this.secret}&a=${this.creds.admit}&p=${this.signPub}`;
  }

  /* -------------------------------- config -------------------------------- */

  private async loadRegisterKey() {
    if (this.registerKeyLoaded) return;
    this.registerKeyLoaded = true;
    const key = await this.d.secrets.get(REGISTER_KEY).catch(() => null);
    if (key) {
      addSecret(key);
      this.registerKey = key;
    }
  }

  private async useSecret(secret: string, sign: PhoneSignKey) {
    const keys = await deriveKeys(secret);
    addSecret(secret);
    addSecret(keys.authToken);
    addSecret(sign.pkcs8);
    this.signKey = await importSignKey(sign.pkcs8);
    this.signPub = sign.pub;
    this.secret = secret;
    this.keys = keys;
    await this.refreshCreds();
  }

  /** Recompute the relay credentials (after a new link or a new relay key). */
  private async refreshCreds() {
    this.creds = this.keys && this.registerKey ? await credsFor(this.keys, this.registerKey) : null;
  }

  /** Register a mailbox with the relay, so it accepts mail for it. Throws a message fit for the owner. */
  private async register(creds: Creds, relayUrl = this.relayUrl()) {
    try {
      await this.relay("POST", "register", {}, { creds, relayUrl });
    } catch (err) {
      if (err instanceof RelayError && (err.status === 401 || err.status === 403))
        throw new Error(KEY_REFUSED);
      if (err instanceof RelayError && err.status === 503)
        throw new Error("The relay has no register key set up yet, so it can't take new phone links.");
      throw new Error(
        `Couldn't register the phone link with the relay: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Wipe a mailbox on a relay: its link stops working there. If that fails, it's saved and retried with backoff
   * (the loop below), and status says revokePending until it goes through.
   */
  private async revoke(creds: Creds, relayUrl: string) {
    try {
      await this.relay("DELETE", "box", undefined, { creds, relayUrl });
    } catch (err) {
      if (isUnauthorized(err)) {
        log.info(GIVE_UP_REVOKE);
        return;
      }
      log.info(`couldn't wipe the old phone mailbox yet: ${err instanceof Error ? err.message : err}`);
      this.pendingRevokes.push({ ...creds, relayUrl, tries: 1, nextAt: this.now() + this.t.revoke });
      await this.saveRevokes();
      this.kickRevokes();
    }
  }

  private async saveRevokes() {
    if (this.pendingRevokes.length)
      await this.d.secrets.set(REVOKES_KEY, JSON.stringify(this.pendingRevokes)).catch(() => {});
    else await this.d.secrets.delete(REVOKES_KEY).catch(() => {});
  }

  /** Start the retry loop for failed wipes, unless it's running. */
  private kickRevokes() {
    if (this.revokeCtrl || !this.pendingRevokes.length) return;
    const ctrl = new AbortController();
    this.revokeCtrl = ctrl;
    void this.revokeLoop(ctrl.signal).finally(() => {
      if (this.revokeCtrl === ctrl) this.revokeCtrl = null;
    });
  }

  private async revokeLoop(signal: AbortSignal) {
    while (!signal.aborted && this.pendingRevokes.length) {
      const next = Math.min(...this.pendingRevokes.map((r) => r.nextAt));
      await this.sleep(Math.max(0, next - this.now()), signal);
      if (signal.aborted) return;
      let changed = false;
      for (const r of [...this.pendingRevokes]) {
        if (r.nextAt > this.now()) continue;
        changed = true;
        try {
          await this.relay("DELETE", "box", undefined, { creds: r, relayUrl: r.relayUrl, signal });
          this.pendingRevokes = this.pendingRevokes.filter((x) => x !== r);
          log.info("an old phone mailbox was wiped");
        } catch (err) {
          if (signal.aborted) return;
          if (isUnauthorized(err)) {
            this.pendingRevokes = this.pendingRevokes.filter((x) => x !== r);
            log.info(GIVE_UP_REVOKE);
            continue;
          }
          r.tries++;
          r.nextAt = this.now() + Math.min(this.t.revoke * 2 ** (r.tries - 1), MAX_REVOKE_BACKOFF_MS);
        }
      }
      if (changed) await this.saveRevokes();
    }
  }

  private async pair(): Promise<{ link: string }> {
    if (!this.registerKey) throw new Error(NO_REGISTER_KEY);
    const secret = randomSecret();
    const keys = await deriveKeys(secret);
    addSecret(secret);
    addSecret(keys.authToken);
    const creds = await credsFor(keys, this.registerKey);
    // Registered first: if that fails, the old link keeps working.
    await this.register(creds);
    const sign = await newSignKey();
    await this.stopPolling();
    this.outbox = [];
    if (this.creds) await this.revoke(this.creds, this.relayUrl());
    await this.d.secrets.set(SIGN_KEY, JSON.stringify(sign));
    await this.d.secrets.set(SECRET_KEY, secret);
    await this.useSecret(secret, sign);
    // A new link is a new mailbox: whatever the old phone knew about is gone.
    this.forget();
    this.saveState({
      enabled: true,
      pairedAt: this.now(),
      lastSeenAt: null,
      device: null,
      seen: [],
      tasksCap: false,
    });
    this.lastError = null;
    this.lastBeatAt = Number.NEGATIVE_INFINITY;
    await this.startPolling();
    log.info("Yo Phone link created (any older link is revoked)");
    return { link: this.linkUrl()! };
  }

  private async configure(p: {
    relayUrl?: string | null;
    registerKey?: string | null;
  }): Promise<PhoneStatus> {
    if (p.registerKey !== undefined) {
      const key = p.registerKey?.trim() || null;
      if (key) {
        if (key.length < 16) throw new Error("That relay key looks too short.");
        addSecret(key);
        await this.d.secrets.set(REGISTER_KEY, key);
      } else {
        await this.d.secrets.delete(REGISTER_KEY);
      }
      const changed = key !== this.registerKey;
      this.registerKey = key;
      if (changed) {
        await this.refreshCreds();
        if (this.secret) await this.startPolling();
      }
    }
    if (p.relayUrl !== undefined) {
      const before = this.relayUrl();
      const url = p.relayUrl?.trim() ? normalizeRelayUrl(p.relayUrl) : null;
      this.saveState({ relayUrl: url === this.defaultRelay ? null : url });
      if (this.secret && this.relayUrl() !== before) {
        this.lastBeatAt = Number.NEGATIVE_INFINITY;
        await this.stopPolling();
        if (this.creds) {
          // The old relay forgets this mailbox; the new one learns it.
          await this.revoke(this.creds, before);
          await this.register(this.creds).catch((err) => {
            this.lastError = err instanceof Error ? err.message : String(err);
          });
        }
        await this.startPolling();
      }
    }
    return this.status();
  }

  private async off(): Promise<PhoneStatus> {
    await this.stopPolling();
    this.outbox = [];
    if (this.creds) await this.revoke(this.creds, this.relayUrl());
    await this.d.secrets.delete(SECRET_KEY);
    await this.d.secrets.delete(SIGN_KEY);
    this.secret = null;
    this.keys = null;
    this.creds = null;
    this.signKey = null;
    this.signPub = null;
    this.lastError = null;
    this.forget();
    this.saveState({
      enabled: false,
      pairedAt: null,
      lastSeenAt: null,
      device: null,
      seen: [],
      tasksCap: false,
    });
    log.info("Yo Phone turned off");
    return this.status();
  }

  private forget() {
    this.cards.clear();
    this.queued.clear();
    this.ownTurns.clear();
    this.openTurns.clear();
    this.sentAt = [];
    this.busyAt = Number.NEGATIVE_INFINITY;
    this.taskRefusedAt = [];
    this.seen.clear();
    this.statusAt.clear();
    this.detail.clear();
    this.helpersSent.clear();
    this.fastUntil = 0;
    this.stopTaskPush();
    this.tasksSent = null;
  }

  private state(): State {
    return { ...EMPTY_STATE, ...(this.d.store.getKv<Partial<State>>(KV_KEY) ?? {}) };
  }

  private saveState(patch: Partial<State>) {
    this.d.store.setKv(KV_KEY, { ...this.state(), ...patch });
  }

  /* --------------------------------- polling -------------------------------- */

  /** Stop the poll loop and wait until it has finished. */
  private async stopPolling() {
    this.poll?.abort();
    this.poll = null;
    await this.loopDone;
    this.polling = false;
  }

  /** (Re)start the poll loop, once the old one has finished. */
  private async startPolling() {
    await this.stopPolling();
    const ctrl = new AbortController();
    this.poll = ctrl;
    this.loopDone = this.loop(ctrl.signal);
  }

  private async loop(signal: AbortSignal) {
    this.polling = true;
    let backoff = 0;
    try {
      while (!signal.aborted) {
        let wait: number;
        try {
          await this.pollOnce(signal);
          backoff = 0;
          this.lastError = null;
          wait = this.now() < this.fastUntil ? this.t.fast : this.t.idle;
        } catch (err) {
          if (signal.aborted) break;
          backoff = Math.min(backoff ? backoff * 2 : Math.max(this.t.fast, 2_000), this.t.maxBackoff);
          this.lastError = isUnauthorized(err)
            ? KEY_REFUSED
            : err instanceof RelayError && err.status === 404
              ? err.message === "link_revoked"
                ? "The relay doesn't know this phone link. Make a new link."
                : `The relay at ${this.relayUrl()} wasn't found (404).`
              : `Can't reach the phone relay: ${err instanceof Error ? err.message : err}`;
          log.warn(`${this.lastError} (retrying in ${Math.round(backoff / 1000)}s)`);
          wait = backoff;
        }
        await this.sleep(wait, signal);
      }
    } finally {
      if (this.poll?.signal === signal || !this.poll) this.polling = false;
    }
  }

  private async relay<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    opts: { signal?: AbortSignal; creds?: Creds; relayUrl?: string } = {},
  ): Promise<T> {
    const creds = opts.creds ?? this.creds;
    if (!creds) throw new Error(this.secret ? NO_REGISTER_KEY : "Yo Phone isn't set up");
    const { signal } = opts;
    const timeout = AbortSignal.timeout(20_000);
    // Every core route: the token, the link's admit and the core's own credential (v2).
    const res = await this.fetch(`${opts.relayUrl ?? this.relayUrl()}/api/relay/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${creds.authToken}`,
        "x-yo-admit": creds.admit,
        "x-yo-core": creds.coreCred,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !json) throw new RelayError(res.status, json?.error ?? `HTTP ${res.status}`);
    return json;
  }

  /** One poll of the `in` mailbox: handle the batch, then ack it. Public for tests. */
  async pollOnce(signal?: AbortSignal) {
    const keys = this.keys;
    if (!keys) return;
    if (!this.creds) throw new Error(NO_REGISTER_KEY);
    const beat = this.now() - this.lastBeatAt >= this.t.beat;
    const get = () =>
      this.relay<{ items?: unknown[] }>("GET", `in${beat ? "?beat=1" : ""}`, undefined, { signal });
    let res: { items?: unknown[] };
    try {
      res = await get();
    } catch (err) {
      // The relay forgot the mailbox (its registration lapsed): register again, once, and retry.
      if (!(err instanceof RelayError && err.status === 404 && err.message === "link_revoked") || !this.creds)
        throw err;
      await this.register(this.creds);
      res = await get();
    }
    const { items } = res;
    if (beat) this.lastBeatAt = this.now();
    const batch = Array.isArray(items) ? items : [];
    if (!batch.length) return;
    const acked: string[] = [];
    for (const env of batch) {
      if (signal?.aborted || this.keys !== keys) return;
      let m: PhoneIn;
      try {
        m = (await open(keys, String(env), "in")) as PhoneIn;
      } catch {
        // Not for this link (an old one, or junk): drop it.
        log.debug("dropped a phone envelope that didn't decrypt");
        continue;
      }
      await this.handle(m, acked).catch((err) => log.warn("couldn't handle a phone message", err));
    }
    if (signal?.aborted || this.keys !== keys) return;
    await this.relay("POST", "in/ack", { count: batch.length }, { signal });
    if (acked.length) this.send({ t: "ack", ids: acked });
  }

  /* --------------------------------- inbound -------------------------------- */

  /** Handle one decrypted phone message. `acked` collects ids to tell the phone "Delivered". */
  private async handle(m: PhoneIn, acked: string[]) {
    if (!m || typeof m !== "object" || m.v !== 1 || typeof m.id !== "string" || !m.id) return;
    acked.push(m.id);
    if (this.seen.has(m.id)) return;
    this.seen.add(m.id);
    while (this.seen.size > MAX_SEEN_IDS) this.seen.delete(this.seen.values().next().value!);
    this.fastUntil = this.now() + this.t.fastFor;
    this.saveState({ lastSeenAt: this.now(), seen: [...this.seen] });

    switch (m.t) {
      case "hello":
        return this.onHello(m);
      case "msg":
        return this.onMsg(m);
      case "respond":
        return this.onRespond(m);
      case "stop":
        return this.onStop();
      case "peek":
        return this.onPeek();
      case "tasks":
        this.wantsTasks();
        return this.sendTasks();
      case "task":
        return this.onTask(m);
    }
  }

  /** What this core understands, for `hello`. */
  private caps(): readonly string[] {
    return this.d.screenshot ? [...PHONE_CAPS, "peek"] : PHONE_CAPS;
  }

  /**
   * A picture of the agent's screen right now, as a reply marked `peek` (it isn't a turn and runs no model). It
   * goes through the same blob path and daily picture budget as replies' pictures. Rate limited: one per
   * PEEK_EVERY_MS, and the phone hears "wait" at most once a minute.
   */
  private async onPeek() {
    const agent = this.activeAgent();
    const name = agent?.name ?? "Yo";
    if (!this.d.screenshot || !agent) {
      this.send({
        t: "reply",
        id: `peek-${randomBlobId()}`,
        agent: name,
        text: PEEK_FAILED,
        at: this.now(),
        peek: true,
      });
      return;
    }
    const now = this.now();
    if (now - this.peekAt < PEEK_EVERY_MS) {
      if (now - this.peekBusyAt >= BUSY_EVERY_MS) {
        this.peekBusyAt = now;
        this.send({ t: "error", agent: name, text: "One peek at a time. Try again in a few seconds." });
      }
      return;
    }
    this.peekAt = now;
    const id = `peek-${randomBlobId()}`;
    let png: Buffer;
    try {
      png = await this.d.screenshot(agent.id);
    } catch (err) {
      log.info(`couldn't take a screenshot for the phone: ${err instanceof Error ? err.message : err}`);
      this.send({ t: "reply", id, agent: name, text: PEEK_FAILED, at: this.now(), peek: true });
      return;
    }
    this.send({ t: "reply", id, agent: name, text: PEEK_TEXT, at: this.now(), pics: 1, peek: true });
    this.pictures = this.pictures
      .then(() =>
        this.sendPictures(id, agent.id, [{ src: "", alt: "Yo's screen" }], undefined, async () => png),
      )
      .catch((err) => log.warn("couldn't send the screen to the phone", err));
  }

  private async onHello(m: Extract<PhoneIn, { t: "hello" }>) {
    if (typeof m.device === "string" && m.device.trim())
      this.saveState({ device: clip(m.device.trim(), 80) });
    this.send({
      t: "hello",
      agent: { name: this.activeAgent()?.name ?? "Yo" },
      at: this.now(),
      caps: this.caps(),
    });
    // A phone that just opened (or came back) needs its cards that are still open.
    for (const e of this.d.orchestrator.pendingRequestEntries()) if (this.isOwn(e)) this.sendCard(e, true);
    // v2.3: the first open of the day claims the morning brief, with brief.claim's rules (once a day across the Mac
    // and the phone). It's the phone's own turn, so the brief comes back here as a reply.
    if (typeof m.localDate === "string")
      await claimBrief(
        {
          store: this.d.store,
          now: this.now,
          send: async (agentId, text) =>
            this.own(agentId, await sendBriefRequest(this.d.orchestrator, agentId, text, { noSteer: true })),
        },
        m.localDate,
      );
  }

  private async onMsg(m: Extract<PhoneIn, { t: "msg" }>) {
    const text = typeof m.text === "string" ? m.text.trim().slice(0, MAX_IN_TEXT) : "";
    const pics = Array.isArray(m.pics) ? m.pics.slice(0, MAX_IN_PICS) : [];
    if (!text && !pics.length) return;
    const agent = this.activeAgent();
    // Fail closed: a message without a time, or an old one (replayed, or stuck for too long), isn't run.
    if (typeof m.at !== "number" || !Number.isFinite(m.at) || this.now() - m.at > MAX_MSG_AGE_MS) {
      this.send({
        t: "error",
        agent: agent?.name ?? "Yo",
        text: "That message is too old to run; send it again.",
      });
      return;
    }
    if (!agent) {
      this.send({ t: "error", agent: "Yo", text: "You don't have any agents yet. Create one in Yo." });
      return;
    }
    const now = this.now();
    if (!this.roomFor(agent.name)) return;
    const attachments: Attachment[] = [];
    let missing = 0;
    for (const [i, p] of pics.entries()) {
      const a = await this.fetchPhoto(p, i).catch((err) => {
        log.info(`couldn't get a photo from the phone: ${err instanceof Error ? err.message : err}`);
        return null;
      });
      if (a) attachments.push(a);
      else missing++;
    }
    if (missing)
      this.send({
        t: "error",
        agent: agent.name,
        text:
          missing === 1
            ? "Yo couldn't get one of your photos. Send it again."
            : `Yo couldn't get ${missing} of your photos. Send them again.`,
      });
    if (!text && !attachments.length) return;
    try {
      // Always its own turn: phone text is never steered into a turn someone else started.
      const res = await this.d.orchestrator.send(agent.id, text, attachments, "user", undefined, "auto", {
        noSteer: true,
      });
      this.sentAt.push(now);
      this.own(agent.id, res);
    } catch (err) {
      this.send({
        t: "error",
        agent: agent.name,
        text: `Couldn't send that: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Flood cap: a few in flight and a few a minute, so a link can't bury Yo (or the owner's queue). A refused task
   * Start is always told (the phone waits to hear whether it started), up to MAX_TASK_REFUSALS_PER_MINUTE.
   */
  private roomFor(agentName: string, task = false): boolean {
    const now = this.now();
    this.sentAt = this.sentAt.filter((t) => now - t < 60_000);
    if (this.queued.size + this.openTurns.size < MAX_IN_FLIGHT && this.sentAt.length < MAX_PER_MINUTE)
      return true;
    if (task) {
      this.taskRefusedAt = this.taskRefusedAt.filter((t) => now - t < 60_000);
      if (this.taskRefusedAt.length < MAX_TASK_REFUSALS_PER_MINUTE) {
        this.taskRefusedAt.push(now);
        this.send({ t: "error", agent: agentName, text: TASK_BUSY });
      }
      return false;
    }
    // Each post costs relay commands on a shared database: say it once a minute, not once per message.
    if (now - this.busyAt >= BUSY_EVERY_MS) {
      this.busyAt = now;
      this.send({ t: "error", agent: agentName, text: BUSY });
    }
    return false;
  }

  /** A message the phone sent (or a task or brief it started): its turn's reply, cards and status go to the phone. */
  private own(agentId: string, res: { turnId: string; queuedId?: string }) {
    if (res.turnId === "queued") {
      if (res.queuedId) {
        this.queued.set(res.queuedId, agentId);
        while (this.queued.size > MAX_QUEUED) this.queued.delete(this.queued.keys().next().value!);
      }
      this.send({ t: "status", agent: this.d.store.getAgent(agentId)?.name ?? "Yo", state: "queued" });
    } else {
      this.addOwnTurn(res.turnId, agentId);
      this.sendWorking(agentId, true);
    }
  }

  /* ---------------------------------- tasks --------------------------------- */

  /** This phone asked for tasks (v2.3), so from now on it also gets the list when the ledger changes. */
  private wantsTasks() {
    if (!this.state().tasksCap) this.saveState({ tasksCap: true });
  }

  /** The Tasks page of the active space's main agent (tasks.list), as the phone shows it. */
  private async sendTasks() {
    const items = fitTasks(phoneTasks(await this.tasks["tasks.list"]({})));
    this.tasksSent = tasksShown(items);
    this.send({ t: "tasks", items, at: this.now() });
  }

  /**
   * Start, Hide or check off a task, with the Tasks page's own rules (tasks.ts). Only the active space's main
   * agent's tasks. Refusals come back as an `error` in plain words; the list follows either way, so the phone
   * shows what's really there.
   */
  private async onTask(m: Extract<PhoneIn, { t: "task" }>) {
    this.wantsTasks();
    const agent = activeSpaceAgent(this.d.store, this.now());
    const name = agent?.name ?? "Yo";
    if (typeof m.taskId !== "string" || !TASK_ACTIONS.has(m.action)) {
      this.send({ t: "error", agent: name, text: "I can't do that to a task from the phone." });
      return;
    }
    try {
      const t = this.d.store.getTask(m.taskId);
      if (!agent) throw new Error("You don't have any agents yet. Create one in Yo.");
      if (!t) throw new Error("That task isn't on the list any more.");
      if (t.ownerId !== agent.id) throw new Error("That task is on another agent's list. Open it in Yo.");
      if (m.action === "start") {
        if (this.roomFor(name, true)) {
          await this.tasks["tasks.start"]({ id: t.id });
          this.sentAt.push(this.now());
        }
      } else {
        await this.tasks["tasks.update"]({ id: t.id, status: m.action === "hide" ? "hidden" : "done" });
      }
    } catch (err) {
      this.send({
        t: "error",
        agent: name,
        text: clip(err instanceof Error ? err.message : String(err), 300),
      });
    }
    await this.sendTasks();
  }

  /**
   * A ledger task changed: push the list to a phone that has asked for tasks, gathered over TASKS_PUSH_MS, and only
   * if it differs from what the phone shows (the relay's database is a shared free one). None to a phone that
   * hasn't been seen in TASKS_PUSH_SEEN_MS: a closed phone would only find them piled up in its mailbox.
   */
  private onTaskChange(t: LedgerTask) {
    if (!this.keys || this.tasksTimer) return;
    const st = this.state();
    if (!st.tasksCap || !st.lastSeenAt || this.now() - st.lastSeenAt > TASKS_PUSH_SEEN_MS) return;
    if (t.ownerId !== activeSpaceAgent(this.d.store, this.now())?.id) return;
    this.tasksTimer = setTimeout(() => {
      this.tasksTimer = null;
      void this.pushTasks().catch((err) => log.warn("couldn't send tasks to the phone", err));
    }, this.t.tasks);
    this.tasksTimer.unref?.();
  }

  private async pushTasks() {
    if (!this.keys || !this.state().tasksCap) return;
    const items = fitTasks(phoneTasks(await this.tasks["tasks.list"]({})));
    const shown = tasksShown(items);
    if (shown === this.tasksSent) return;
    this.tasksSent = shown;
    this.send({ t: "tasks", items, at: this.now() });
  }

  private stopTaskPush() {
    if (this.tasksTimer) clearTimeout(this.tasksTimer);
    this.tasksTimer = null;
  }

  /** A phone turn the owner joined: forget it, and close its cards on the phone. */
  private disown(turnId: string, agentId: string) {
    this.ownTurns.delete(turnId);
    this.openTurns.delete(turnId);
    for (const c of [...this.cards.values()])
      if (c.turnId === turnId && !c.resolved) this.resolve(c, "Continued in Yo on your computer");
    if (!this.busyFor(agentId)) this.sendIdle(agentId);
  }

  private addOwnTurn(turnId: string, agentId: string) {
    this.ownTurns.set(turnId, agentId);
    this.openTurns.add(turnId);
    while (this.ownTurns.size > MAX_OWN_TURNS) {
      const oldest = this.ownTurns.keys().next().value!;
      this.ownTurns.delete(oldest);
      this.openTurns.delete(oldest);
    }
  }

  /** Whether a timeline entry (a request card) belongs to a turn the phone started. */
  private isOwn(e: TimelineEntry): boolean {
    return !!e.turnId && this.ownTurns.has(e.turnId);
  }

  /** The phone's turn running on this agent right now, if any. */
  private openTurnOf(agentId: string): string | undefined {
    for (const t of this.openTurns) if (this.ownTurns.get(t) === agentId) return t;
    return undefined;
  }

  /** Something of the phone's still going on this agent (a running turn, or a message waiting its turn). */
  private busyFor(agentId: string): boolean {
    return !!this.openTurnOf(agentId) || [...this.queued.values()].includes(agentId);
  }

  private async onRespond(m: Extract<PhoneIn, { t: "respond" }>) {
    if (typeof m.requestId !== "string") return;
    // Exactly approve or deny; anything else is ignored, never treated as a yes.
    if (m.decision !== "approve" && m.decision !== "deny") return;
    // Only the phone's own cards: never a request from a turn the owner started.
    const card =
      [...this.cards.values()].find((c) => c.requestId === m.requestId) ??
      this.cardFor(
        this.d.orchestrator
          .pendingRequestEntries()
          .find((e) => e.request?.requestId === m.requestId && this.isOwn(e)),
      );
    if (!card) {
      this.send({ t: "resolved", requestId: m.requestId, outcome: "No longer pending" });
      return;
    }
    if (card.kind === "open_yo") return; // Mac changes, takeovers and secure forms are only answered in Yo.
    const entry = this.d.store.getEntry(card.entryId);
    if (entry?.request?.status !== "pending") {
      this.resolve(card, STATUS_LABEL[entry?.request?.status ?? ""] ?? "No longer pending");
      return;
    }
    const decision: Decision = m.decision === "approve" ? "allow" : "deny";
    const answer = typeof m.answer === "string" ? clip(m.answer.trim(), 2000) : "";
    if (card.kind === "question" && decision === "allow" && !answer) return;
    // Mark first: respond() pushes the resolved entry synchronously, which would label it "in Yo".
    card.resolved = true;
    const outcome =
      decision === "deny"
        ? "Denied from your phone"
        : card.kind === "question"
          ? `Answered from your phone: ${clip(answer, 200)}`
          : "Approved from your phone";
    try {
      if (card.kind === "question" && decision === "allow") {
        const answers = Object.fromEntries(card.questions.map((q) => [q, answer]));
        await this.d.orchestrator.respond(card.agentId, card.requestId, decision, answers, answer);
      } else {
        await this.d.orchestrator.respond(card.agentId, card.requestId, decision);
      }
    } catch (err) {
      log.info(`phone response not applied: ${err instanceof Error ? err.message : err}`);
      this.resolve(card, "No longer pending");
      return;
    }
    this.resolve(card, outcome);
  }

  /**
   * Stop the phone's own turn. A turn the owner started isn't the phone's to stop. Its messages still waiting in
   * line stay tracked: they run (and get their replies) after this one.
   */
  private async onStop() {
    const a = this.activeAgent();
    if (!a) return;
    if (!this.openTurnOf(a.id)) {
      if (!this.busyFor(a.id)) this.send({ t: "status", agent: a.name, state: "idle" });
      return;
    }
    await this.d.orchestrator.interrupt(a.id);
  }

  /**
   * The agent phone messages go to: the one the phone is in the middle of a task with (so a reply, a stop or a
   * follow-up isn't split when work hours end mid-task), else the main agent of the space right now (Yo for Work,
   * Pip for Personal; the primary when spaces are off).
   */
  private activeAgent(): Agent | undefined {
    for (const t of this.openTurns) {
      const id = this.ownTurns.get(t);
      const a = id ? this.d.store.getAgent(id) : null;
      if (a && !a.archivedAt && a.kind !== "helper") return a;
    }
    return activeSpaceAgent(this.d.store, this.now()) ?? undefined;
  }

  /* -------------------------------- outbound -------------------------------- */

  /** Queue a message for the phone; posted in order. */
  private send(body: OutBody) {
    if (!this.keys) return;
    if (this.outbox.length >= MAX_OUTBOX) {
      log.warn("phone outbox is full; dropping a message");
      return;
    }
    this.outbox.push(body);
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
    for (let body = this.outbox.shift(); body; body = this.outbox.shift()) {
      const keys = this.keys;
      const creds = this.creds;
      const signKey = this.signKey;
      if (!keys || !creds || !signKey) return;
      let reregistered = false;
      // One counter per message, kept across retries: if a "failed" post did land, the phone drops the copy.
      const n = this.nextOutN();
      for (let attempt = 0; ; attempt++) {
        try {
          const box = await seal(keys, { v: 1, n, ...body }, "out");
          // Signed, so the phone only shows what this core wrote (v2).
          const sig = await signOut(signKey, box);
          await this.relay("POST", "out", { box, sig }, { creds });
          break;
        } catch (err) {
          // The relay forgot the mailbox (it expired, say): register it again, once.
          if (err instanceof RelayError && err.status === 404 && !reregistered && this.keys === keys) {
            reregistered = true;
            try {
              await this.register(creds);
              continue;
            } catch (e) {
              this.lastError = e instanceof Error ? e.message : String(e);
            }
          }
          if (
            attempt < 2 &&
            this.keys === keys &&
            !(err instanceof RelayError && (err.status === 413 || err.status === 401))
          ) {
            await this.sleep(1000 * (attempt + 1));
            continue;
          }
          log.warn("couldn't post to the phone", err instanceof Error ? err.message : err);
          break;
        }
      }
    }
  }

  /** "Typing…" with what the agent is doing, at most once per STATUS_EVERY_MS while it works. */
  private sendWorking(agentId: string, force = false) {
    const last = this.statusAt.get(agentId) ?? Number.NEGATIVE_INFINITY;
    if (!force && this.now() - last < this.t.status) return;
    this.statusAt.set(agentId, this.now());
    const detail = this.detail.get(agentId);
    const helpers = this.helpersOf(agentId);
    this.helpersSent.set(agentId, helpers);
    this.send({
      t: "status",
      agent: this.d.store.getAgent(agentId)?.name ?? "Yo",
      state: "working",
      ...(detail ? { detail } : {}),
      ...(helpers ? { helpers } : {}),
    });
  }

  private sendIdle(agentId: string) {
    this.statusAt.delete(agentId);
    this.detail.delete(agentId);
    const helpers = this.helpersOf(agentId);
    this.helpersSent.set(agentId, helpers);
    this.send({
      t: "status",
      agent: this.d.store.getAgent(agentId)?.name ?? "Yo",
      state: "idle",
      ...(helpers ? { helpers } : {}),
    });
  }

  /** Helpers this agent started that are still at it. */
  private helpersOf(agentId: string): number {
    let n = 0;
    for (const h of this.helperState.values()) if (h.parentId === agentId && h.active) n++;
    return n;
  }

  /**
   * A helper started, finished or stopped. If the phone has been talking to its parent, tell it how many are still
   * working ("2 helpers working"). Only on a change, so it costs one post per helper start and end.
   */
  private onHelper(a: ApiPushes["agent.updated"]) {
    if (a.kind !== "helper" || !a.parentId) return;
    const active = !a.archivedAt && (a.activity === "working" || a.activity === "waiting");
    if (a.archivedAt) this.helperState.delete(a.id);
    else this.helperState.set(a.id, { parentId: a.parentId, active });
    while (this.helperState.size > 200) this.helperState.delete(this.helperState.keys().next().value!);
    const parent = a.parentId;
    if (!this.ownTurns.size || this.activeAgent()?.id !== parent) return;
    const n = this.helpersOf(parent);
    if ((this.helpersSent.get(parent) ?? 0) === n) return;
    if (this.openTurnOf(parent)) this.sendWorking(parent, true);
    else if (!this.busyFor(parent)) this.sendIdle(parent);
    else this.helpersSent.set(parent, n);
  }

  /* -------------------------------- pictures -------------------------------- */

  /** Pictures sent so far today (UTC), for the daily budget. */
  private picsToday() {
    const day = Math.floor(this.now() / DAY_MS);
    const p = this.state().pics;
    return p && p.day === day ? p : { day, count: 0, bytes: 0 };
  }

  /**
   * Shrinks, encrypts and stores a reply's pictures on the relay (at most MAX_PICS_PER_REPLY, within the daily
   * budget), then sends one `images` message pointing at them. Whatever doesn't go is counted in `more`, so the
   * phone can say "N more pictures in Yo". A relay without blob routes (older) just makes everything `more`.
   */
  private async sendPictures(
    replyId: string,
    agentId: string,
    refs: Array<{ src: string; alt: string }>,
    stored: Record<string, string> | undefined,
    /** Reads the pictures instead of `readImage` (a peek's screenshot). */
    read?: (ref: { src: string; alt: string }) => Promise<Buffer>,
  ) {
    const keys = this.keys;
    const creds = this.creds;
    if (!keys || !creds) return;
    const items: PicRef[] = [];
    let more = 0;
    let relayRefused = false;
    for (const [i, ref] of refs.entries()) {
      if (i >= MAX_PICS_PER_REPLY || !(read || this.d.readImage) || relayRefused) {
        more++;
        continue;
      }
      try {
        const raw = read ? await read(ref) : await this.d.readImage!(agentId, ref.src, stored?.[ref.src]);
        const pic = (this.d.shrink ?? shrinkImage)(raw);
        const today = this.picsToday();
        if (
          !pic ||
          today.count >= MAX_PICS_PER_DAY ||
          today.bytes + pic.bytes.length > MAX_PIC_BYTES_PER_DAY
        ) {
          more++;
          continue;
        }
        const id = randomBlobId();
        const bytes = new Uint8Array(pic.bytes);
        const box = await sealBlob(keys, bytes, "out", id);
        await this.relay("POST", "blob/out", { id, box }, { creds });
        const after = this.picsToday();
        this.saveState({
          pics: { day: after.day, count: after.count + 1, bytes: after.bytes + bytes.length },
        });
        items.push({
          id,
          mime: pic.mime,
          w: pic.width,
          h: pic.height,
          size: bytes.length,
          hash: await hashOf(bytes),
          ...(ref.src ? { src: ref.src } : {}),
          ...(ref.alt ? { alt: clip(ref.alt, 200) } : {}),
        });
      } catch (err) {
        more++;
        // An older relay (no blob routes) or one over its daily budget: don't try the rest.
        if (err instanceof RelayError && [404, 405, 429].includes(err.status)) relayRefused = true;
        log.info(`a picture didn't go to the phone: ${err instanceof Error ? err.message : err}`);
      }
      if (this.keys !== keys) return;
    }
    this.send({ t: "images", replyId, items, more });
  }

  /** A photo the phone sent with a message: fetched from the relay, decrypted and checked, as an attachment. */
  private async fetchPhoto(p: PicRef, i: number): Promise<Attachment | null> {
    const keys = this.keys;
    if (!keys || !p || typeof p.id !== "string" || !BLOB_ID_RE.test(p.id) || typeof p.hash !== "string")
      return null;
    const { box } = await this.relay<{ box: string }>("GET", `blob/in?id=${p.id}`);
    const bytes = await openBlob(keys, box, "in", p.id);
    if (bytes.length > MAX_IN_PIC_BYTES || (await hashOf(bytes)) !== p.hash) return null;
    const info = imageInfo(Buffer.from(bytes));
    if (!info || !IN_PIC_TYPES.has(info.mime)) return null;
    const ext = info.mime === "image/jpeg" ? "jpg" : info.mime.slice(6);
    return {
      name: `phone-photo-${i + 1}.${ext}`,
      mediaType: info.mime,
      data: Buffer.from(bytes).toString("base64"),
    };
  }

  private onPush(channel: ApiPushChannel, data: unknown) {
    if (!this.keys) return;
    if (channel === "timeline.upsert") this.onEntry(data as TimelineEntry);
    else if (channel === "agent.updated") {
      const a = data as ApiPushes["agent.updated"];
      if (a.kind === "helper") this.onHelper(a);
      else if (a.activity === "working" && this.openTurnOf(a.id)) this.sendWorking(a.id);
    }
  }

  /**
   * Replies are routed by turn: a queued phone message only gets a turnId when it starts, and only the turns the
   * phone's messages started send anything back (never a turn started in Yo, even one running meanwhile).
   */
  private onTurn(e: TurnEvent) {
    if (!this.keys) return;
    if (e.type === "steered") {
      if (this.queued.delete(e.queuedId)) {
        // Merged into a turn someone else started (core doesn't steer phone text, but just in case): that turn's
        // reply isn't the phone's to see.
        if (!this.busyFor(e.agentId)) this.sendIdle(e.agentId);
      } else if (this.ownTurns.has(e.turnId)) {
        // The owner steered their own message into the phone's turn: from here on it's the owner's turn, so no
        // more replies or cards from it go to the phone.
        this.disown(e.turnId, e.agentId);
      }
      return;
    }
    if (e.type === "started") {
      if (e.queuedId && this.queued.delete(e.queuedId)) {
        this.addOwnTurn(e.turnId, e.agentId);
        this.sendWorking(e.agentId, true);
      }
      return;
    }
    if (!this.openTurns.delete(e.turnId)) return;
    const agent = this.d.store.getAgent(e.agentId)?.name ?? "Yo";
    if (e.status === "completed") {
      const turn = this.d.store.listTimeline(e.agentId, undefined, 200).filter((x) => x.turnId === e.turnId);
      const reply = turn.filter((x) => x.item.kind === "assistant_message" && x.item.text?.trim()).at(-1);
      // v2.3: the brief card and the quick replies ride on the reply (an older phone ignores them).
      const extras = turnExtras(turn);
      const { briefEntryId, replies } = extras;
      if (reply || briefEntryId) {
        const brief = extras.brief && phoneBrief(extras.brief);
        // Yo wrote nothing besides the brief: its titles in words, for phones that can't draw the card.
        const text = reply?.item.text ?? (brief ? briefFallbackText(brief) : BRIEF_ONLY);
        const pictures = reply ? computerImageRefs(text) : [];
        const body: Extract<OutBody, { t: "reply" }> = {
          t: "reply",
          id: reply?.id ?? briefEntryId!,
          agent,
          text:
            text.length > MAX_REPLY ? `${text.slice(0, MAX_REPLY - REST_IN_YO.length)}${REST_IN_YO}` : text,
          at: this.now(),
          ...(pictures.length ? { pics: Math.min(pictures.length, MAX_PICS_PER_REPLY) } : {}),
          ...(brief ? { brief, ...(reply ? {} : { briefText: true as const }) } : {}),
          ...(replies ? { replies } : {}),
        };
        // Past the relay's size limit the whole reply would be lost: the card goes (the text has its titles, or
        // Yo's own words), never the reply.
        if (body.brief && jsonBytes(body) > MAX_OUT_JSON_BYTES) {
          delete body.brief;
          delete body.briefText;
          log.warn("a brief was too big for the phone; sent the reply without its card");
        }
        this.send(body);
        if (reply && pictures.length)
          this.pictures = this.pictures
            .then(() => this.sendPictures(reply.id, e.agentId, pictures, reply.item.images))
            .catch((err) => log.warn("couldn't send pictures to the phone", err));
      }
    } else if (e.status === "failed") {
      this.send({ t: "error", agent, text: clip(e.error || "Something went wrong.", 1000) });
    }
    if (!this.busyFor(e.agentId)) this.sendIdle(e.agentId);
    else if (!this.openTurnOf(e.agentId)) this.send({ t: "status", agent, state: "queued" });
  }

  private onEntry(e: TimelineEntry) {
    // What a working agent is doing, for the typing indicator.
    if (
      !e.request &&
      e.item.kind === "tool" &&
      e.item.status === "running" &&
      e.item.title &&
      this.isOwn(e)
    ) {
      this.detail.set(e.agentId, clip(e.item.title, 80));
      this.sendWorking(e.agentId);
    }
    if (!e.request) return;
    const card = this.cards.get(e.id);
    if (e.request.status === "pending") {
      // Only cards from the phone's own turns: the owner's approvals never reach the link.
      if (!card && this.isOwn(e)) this.sendCard(e);
    } else if (card && !card.resolved) {
      this.resolve(card, STATUS_LABEL[e.request.status] ?? "Handled in Yo");
    }
  }

  private cardFor(e: TimelineEntry | undefined): Card | undefined {
    const req = e?.request;
    if (!e || !req) return undefined;
    const kind =
      req.deviceWrite ||
      req.deviceAction ||
      req.toolName === DEVICE_WRITE_TOOL ||
      req.toolName === "request_takeover" ||
      e.item.toolName === "request_takeover" ||
      // Private values are only typed into Yo's own card, never on the phone.
      req.secureForm ||
      req.toolName === SECURE_INPUT_TOOL
        ? "open_yo"
        : req.kind === "user_input"
          ? "question"
          : "approval";
    return {
      entryId: e.id,
      turnId: e.turnId,
      agentId: e.agentId,
      requestId: req.requestId,
      kind,
      questions: (req.questions ?? []).map((q) => q.question),
      resolved: false,
    };
  }

  /** Send a request card. `again`: resend one the phone may already have (after a hello). */
  private sendCard(e: TimelineEntry, again = false) {
    const req = e.request;
    if (!req || (!again && this.cards.has(e.id))) return;
    const card = this.cards.get(e.id) ?? this.cardFor(e);
    if (!card) return;
    this.cards.set(e.id, card);
    const name = this.d.store.getAgent(e.agentId)?.name ?? "Agent";
    const base = { t: "request" as const, requestId: req.requestId, agent: name, kind: card.kind };
    if (card.kind === "open_yo" && (req.secureForm || req.toolName === SECURE_INPUT_TOOL)) {
      this.send({
        ...base,
        title: `${name} needs something private for ${req.secureForm?.site ?? "a website"}`,
        detail: clip(`${req.detail ? `${req.detail}\n` : ""}Open Yo to fill this in securely.`, 600),
      });
    } else if (card.kind === "open_yo") {
      const takeover = req.toolName === "request_takeover" || e.item.toolName === "request_takeover";
      this.send({
        ...base,
        title: takeover
          ? `${name} needs you to take over its screen`
          : `${name} wants to change something on your Mac`,
        detail: clip(takeover ? req.detail || req.title : req.title, 600),
      });
    } else if (card.kind === "question") {
      const q = req.questions?.[0];
      this.send({
        ...base,
        title: clip(q?.question || req.title, 1500),
        detail: q?.header ? clip(q.header, 200) : "",
        options: (q?.options ?? []).slice(0, 8).map((o) => clip(o.label, 60)),
      });
    } else {
      const input = (req.input ?? {}) as Record<string, unknown>;
      const chips = Object.entries(input)
        .filter(
          ([k, v]) =>
            ["category", "total", "recipient", "url", "amount"].includes(k) && typeof v === "string",
        )
        .map(([k, v]) => `${k}: ${clip(String(v), 200)}`);
      this.send({
        ...base,
        title: clip(req.title, 300),
        detail: [req.detail ? clip(req.detail, 1500) : "", chips.join(" · ")].filter(Boolean).join("\n"),
      });
    }
  }

  private resolve(card: Card, outcome: string) {
    card.resolved = true;
    this.cards.delete(card.entryId);
    this.send({ t: "resolved", requestId: card.requestId, outcome });
  }
}
