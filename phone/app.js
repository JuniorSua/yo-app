// Yo Phone app. Talks to the relay (/api/relay/*) with end-to-end encrypted envelopes; see docs/phone/PROTOCOL.md.
import {
  canVerifyEd25519,
  deriveKeys,
  hashOf,
  openBlob,
  randomBlobId,
  randomId,
  seal,
  sealBlob,
} from "/lib/crypto.js";
import { acceptOut, isTurnedOff } from "/lib/inbox.js";
import { escapeHtml, imageSources, renderMarkdown, toSpeech } from "/lib/markdown.js";
import {
  attachImages,
  expireQueued,
  helpersLabel,
  loosePics,
  moreLabel,
  picForSrc,
  QUEUE_FOR_MS,
  resendable,
  waitingForPics,
} from "/lib/pics.js";
import {
  activeGroups,
  afterAction,
  briefFold,
  briefGreeting,
  briefStartText,
  briefTextShows,
  normalizeBrief,
  normalizeReplies,
  normalizeTasks,
  START_WAIT_MS,
  startLanded,
  statusWord,
  tasksBadge,
  upNext,
} from "/lib/tasks.js";
import {
  composerHeight,
  fitViewport,
  isPhoneSideways,
  localDate,
  presenceView,
  quickReplies,
  workingView,
} from "/lib/view.js";

const VERSION = "1.3.1";
const POLL_MS = 3000;
const POLL_MAX_MS = 15000;
const HISTORY_MAX = 300;
const HELLO_EVERY_MS = 30 * 60 * 1000;
const COUNTDOWN_S = 3;
/** How long a peek waits for the screen before saying it couldn't get it. */
const PEEK_WAIT_MS = 30_000;
/** Photos per message, and the longest side they're sent at. */
const MAX_PHOTOS = 3;
const PHOTO_SIDE = 1600;
const PHOTO_MAX_BYTES = 1_200_000;
/** Pictures kept on this phone (decrypted, in Cache Storage) so they show offline and don't cost the relay twice. */
const PIC_CACHE = "yo-phone-pics";
const PIC_CACHE_MAX = 80;
/** The task list is asked for at most this often (opening Tasks again soon after shows what's here). */
const TASKS_ASK_MS = 15_000;

const OLD_LINK = "This link is from an older version. Ask Yo for a new one.";
const BAD_LINK = "That doesn't look like a Yo phone link. Copy the whole link from Yo and try again.";
const NO_ED25519 =
  "This browser can't check that replies really come from your Yo. Update to iOS 17 or later, then open the link again.";

const LS = {
  key: "yo-phone:key",
  admit: "yo-phone:admit",
  signPub: "yo-phone:signPub",
  history: "yo-phone:history",
  cursor: "yo-phone:cursor",
  outN: "yo-phone:outN",
  agent: "yo-phone:agent",
  pairedAt: "yo-phone:pairedAt",
  hello: "yo-phone:lastHello",
  read: "yo-phone:readAloud",
  drive: "yo-phone:drive",
  tip: "yo-phone:tipDismissed",
  revoked: "yo-phone:revoked",
  caps: "yo-phone:caps",
  kb: "yo-phone:kbHeight",
  helloDate: "yo-phone:helloDate",
  /** The app version that last said hello: a new version asks the core what it can do right away. */
  helloVersion: "yo-phone:helloVersion",
  tasks: "yo-phone:tasks",
  tasksView: "yo-phone:tasksView",
};

const $ = (id) => document.getElementById(id);
const el = {
  app: $("app"),
  welcome: $("welcome"),
  chat: $("chat"),
  pasteForm: $("paste-form"),
  pasteInput: $("paste-input"),
  pasteError: $("paste-error"),
  revoked: $("revoked"),
  installSteps: $("install-steps"),
  agentName: $("agent-name"),
  presence: $("presence"),
  presenceText: $("presence-text"),
  driveBtn: $("drive-btn"),
  settingsBtn: $("settings-btn"),
  banner: $("banner"),
  log: $("log"),
  tip: $("install-tip"),
  tipClose: $("tip-close"),
  empty: $("empty"),
  thread: $("thread"),
  live: $("live"),
  liveTitle: $("live-title"),
  liveElapsed: $("live-elapsed"),
  liveStep: $("live-step"),
  liveHelpers: $("live-helpers"),
  liveHelpersText: $("live-helpers-text"),
  quick: $("quick"),
  jump: $("jump-btn"),
  jumpNew: $("jump-new"),
  bannerText: $("banner-text"),
  peekBtn: $("peek-btn"),
  menu: $("msg-menu"),
  stopBtn: $("stop-btn"),
  drivePanel: $("drive-panel"),
  driveTranscript: $("drive-transcript"),
  driveHint: $("drive-hint"),
  mic: $("mic-btn"),
  countdown: $("countdown"),
  countdownLabel: $("countdown-label"),
  driveFallback: $("drive-fallback"),
  form: $("form"),
  input: $("input"),
  send: $("send-btn"),
  settings: $("settings"),
  settingsClose: $("settings-close"),
  setAgent: $("set-agent"),
  setSeen: $("set-seen"),
  setLink: $("set-link"),
  setRead: $("set-read"),
  forget: $("forget-btn"),
  version: $("version"),
  toast: $("toast"),
  top: $("top"),
  avatar: $("avatar"),
  ptr: $("ptr"),
  suggest: $("suggest"),
  helpersRow: $("helpers-row"),
  helpersText: $("helpers-text"),
  tray: $("tray"),
  photoBtn: $("photo-btn"),
  photoInput: $("photo-input"),
  viewer: $("viewer"),
  viewerStage: $("viewer-stage"),
  viewerImg: $("viewer-img"),
  viewerClose: $("viewer-close"),
  viewerCopy: $("viewer-copy"),
  viewerCaption: $("viewer-caption"),
  tabbar: $("tabbar"),
  tabChat: $("tab-chat"),
  tabTasks: $("tab-tasks"),
  tasksBadge: $("tasks-badge"),
  tasksView: $("tasks-view"),
  tasksScroll: $("tasks-scroll"),
  tasksPtr: $("tasks-ptr"),
  tasksSub: $("tasks-sub"),
  tasksSeg: $("tasks-seg"),
  tasksBody: $("tasks-body"),
};

const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
document.documentElement.classList.toggle("standalone", standalone);

// Portrait only on phones: sideways shows "Turn your phone upright" (iOS ignores the manifest's orientation).
function checkSideways() {
  document.documentElement.classList.toggle(
    "sideways",
    isPhoneSideways({
      orientationType: screen.orientation?.type,
      legacyOrientation: typeof window.orientation === "number" ? window.orientation : undefined,
      screenW: screen.width,
      screenH: screen.height,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      coarse: matchMedia("(pointer: coarse)").matches,
    }),
  );
}
checkSideways();
screen.orientation?.addEventListener?.("change", checkSideways);
window.addEventListener("orientationchange", checkSideways);
window.addEventListener("resize", checkSideways);

// ------------------------------------------------------------------ state

const S = {
  secret: null,
  auth: null,
  encKey: null,
  admit: null,
  signPub: null,
  /** @type {Array<any>} */
  messages: [],
  cursor: 0,
  /** The core's counter on the last message accepted (null until one arrives with a counter). */
  lastN: null,
  agent: "Yo",
  pairedAt: null,
  seen: undefined, // undefined = not polled yet, null = never/expired, number = ms
  netDown: false,
  working: null, // { state, detail, at, since, stopping }
  drive: false,
  readAloud: false,
  /** What the core understands beyond v2 (its hello says): "images", "photos", "helpers". */
  caps: [],
  /** Helpers Yo started that are still working. */
  helpers: 0,
  /** Photos picked for the next message: { bytes, mime, w, h, thumb } */
  photos: [],
  /** A peek at the screen on its way: { at } */
  peek: null,
  /** Which screen shows: "chat", or "tasks" (only when the core has the `tasks` cap). */
  tab: "chat",
  /** The main agent's tasks (v2.3), null until the core has sent them. */
  tasks: null,
  /** Tasks' segment: "active" or "upnext" (kept between launches). */
  tasksView: "active",
};

const load = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // storage full or private mode: keep going in memory
  }
};
const saveHistory = () => save(LS.history, S.messages.slice(-HISTORY_MAX));

// --------------------------------------------------------------- relay api

class RelayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api/relay/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${S.auth}`,
        "X-Yo-Admit": S.admit,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new RelayError(0, "No connection");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new RelayError(res.status, data.error || `Error ${res.status}`);
  return data;
}

async function sendIn(msg) {
  const box = await seal(S.encKey, { v: 1, ...msg }, "in");
  try {
    await api("POST", "in", { box });
  } catch (err) {
    if (isTurnedOff(err)) onRevoked();
    throw err;
  }
}

// The owner turned the link off (or made a new one): the mailbox no longer takes messages.
function onRevoked() {
  stopPolling();
  setDrive(false, { quiet: true });
  for (const k of [
    LS.key,
    LS.admit,
    LS.signPub,
    LS.history,
    LS.cursor,
    LS.outN,
    LS.hello,
    LS.agent,
    LS.pairedAt,
    LS.caps,
    LS.helloDate,
    LS.tasks,
  ])
    localStorage.removeItem(k);
  save(LS.revoked, true);
  clearPictures();
  Object.assign(S, {
    secret: null,
    auth: null,
    encKey: null,
    admit: null,
    signPub: null,
    messages: [],
    cursor: 0,
    lastN: null,
    seen: undefined,
    working: null,
    tasks: null,
    caps: [],
  });
  setTab("chat");
  if (el.settings.open) el.settings.close();
  showWelcome();
}

function sendErrorText(err) {
  if (err.status === 429) return "Yo has a lot waiting. Try again in a minute.";
  if (err.status === 413) return "That message is too long.";
  if (err.status === 0) return "No connection.";
  return "Couldn't send.";
}

// ------------------------------------------------------------------ pairing

class LinkError extends Error {}

/**
 * Reads a phone link (or the fragment of one): `#k=<secret>&a=<admit>&p=<signPub>`, each 43 base64url characters.
 * Returns null if there's no key at all, and `{ old: true }` for a v1 link (key only).
 */
function parseLink(text) {
  const t = String(text || "").trim();
  const get = (name) => new RegExp(`[#&?]${name}=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])`).exec(t)?.[1] ?? null;
  const k = get("k");
  if (!k) return /^[A-Za-z0-9_-]{43}$/.test(t) ? { old: true } : null;
  const a = get("a");
  const p = get("p");
  if (!a || !p) return { old: true };
  return { k, a, p };
}

async function pair(link) {
  if (!link || link.old) throw new LinkError(link ? OLD_LINK : BAD_LINK);
  if (!(await canVerifyEd25519(link.p))) throw new LinkError(NO_ED25519);
  const keys = await deriveKeys(link.k);
  const changed = load(LS.key, null) !== link.k;
  if (changed) {
    // A new link is a new mailbox: start clean.
    for (const k of [
      LS.history,
      LS.cursor,
      LS.outN,
      LS.hello,
      LS.helloDate,
      LS.helloVersion,
      LS.agent,
      LS.caps,
      LS.tasks,
    ])
      localStorage.removeItem(k);
    save(LS.pairedAt, Date.now());
    clearPictures();
  }
  localStorage.removeItem(LS.revoked);
  save(LS.key, link.k);
  save(LS.admit, link.a);
  save(LS.signPub, link.p);
  await start(link, keys);
  if (changed) sayHello(true);
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad|Macintosh.*Mobile/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : "Browser";
  return standalone ? `${kind} (Home Screen)` : kind;
}

/**
 * Tell the core this phone is here (at most every 30 minutes, and on a new day). v2.3: with the phone's own date,
 * so a core with the morning brief can post today's when the user's day starts.
 */
async function sayHello(force = false) {
  const last = load(LS.hello, 0);
  const today = localDate();
  const sameVersion = load(LS.helloVersion, "") === VERSION;
  if (!force && sameVersion && Date.now() - last < HELLO_EVERY_MS && load(LS.helloDate, "") === today) return;
  try {
    await sendIn({ t: "hello", id: randomId(), device: deviceLabel(), localDate: today });
    save(LS.hello, Date.now());
    save(LS.helloDate, today);
    save(LS.helloVersion, VERSION);
    pollSoon(800);
  } catch {
    // try again next launch
  }
}

// ------------------------------------------------------------------ boot

async function boot() {
  el.version.textContent = `Yo Phone ${VERSION}`;
  try {
    if (sessionStorage.getItem("yo-phone:updated")) {
      sessionStorage.removeItem("yo-phone:updated");
      setTimeout(() => toast(`Updated to Yo Phone ${VERSION}`), 600);
    }
  } catch {}
  const hash = location.hash;
  if (hash) history.replaceState(null, "", location.pathname + location.search);
  const fromHash = hash ? parseLink(hash) : null;
  if (fromHash) {
    try {
      await pair(fromHash);
      if (!standalone && !load(LS.tip, false)) el.tip.hidden = false;
    } catch (err) {
      showWelcome(err instanceof LinkError ? err.message : BAD_LINK);
    }
    return;
  }
  const stored = { k: load(LS.key, null), a: load(LS.admit, null), p: load(LS.signPub, null) };
  if (stored.k && (!stored.a || !stored.p)) {
    // Saved by the v1 app: that link can't work with this relay any more.
    for (const k of [LS.key, LS.history, LS.cursor, LS.hello]) localStorage.removeItem(k);
    showWelcome(OLD_LINK);
    return;
  }
  if (stored.k) {
    try {
      await start(stored, await deriveKeys(stored.k));
      // A phone that has never heard what its core can do (just updated from 1.0) asks right away.
      sayHello(load(LS.caps, null) === null);
      return;
    } catch {
      for (const k of [LS.key, LS.admit, LS.signPub]) localStorage.removeItem(k);
    }
  }
  showWelcome();
}

function showWelcome(error = "") {
  const revoked = load(LS.revoked, false);
  el.chat.hidden = true;
  el.welcome.hidden = false;
  el.revoked.hidden = !revoked;
  el.installSteps.hidden = revoked;
  el.pasteError.textContent = error;
  stopPolling();
}

async function start(link, keys) {
  S.secret = link.k;
  S.admit = link.a;
  S.signPub = link.p;
  S.auth = keys.authToken;
  S.encKey = keys.encKey;
  S.messages = load(LS.history, []);
  // Anything still "sending" from a previous session may not have made it: send it again while Yo would still
  // run it (the core drops a repeated id, so a copy that did arrive isn't run twice).
  for (const m of S.messages) {
    if (m.k === "me" && m.st === "sending") m.st = "queued";
    if (m.k === "card") m.pending = null;
    rendered.add(m.id);
  }
  expireQueued(S.messages);
  S.caps = load(LS.caps, []);
  S.tasks = Array.isArray(load(LS.tasks, null)?.items) ? normalizeTasks(load(LS.tasks, null).items) : null;
  S.tasksView = load(LS.tasksView, "active") === "upnext" ? "upnext" : "active";
  tasksAskedAt = 0;
  S.cursor = load(LS.cursor, 0);
  S.lastN = load(LS.outN, null);
  S.agent = load(LS.agent, "Yo");
  S.pairedAt = load(LS.pairedAt, null);
  S.readAloud = load(LS.read, false);
  S.seen = undefined;
  S.working = null;
  el.welcome.hidden = true;
  el.chat.hidden = false;
  el.setRead.checked = S.readAloud;
  setDrive(load(LS.drive, false), { quiet: true });
  setTab("chat");
  renderAll();
  scrollToBottom(true);
  startPolling();
  requestTasks();
  setTimeout(flushQueue, 500);
}

// ------------------------------------------------------------------ polling

let pollTimer = 0;
/** Dropped seqs already warned about (a dropped item comes back on every poll). */
const warned = new Set();
let pollDelay = POLL_MS;
let polling = false;

function startPolling() {
  stopPolling();
  if (document.visibilityState === "visible") poll();
}
function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = 0;
}
function schedule(ms) {
  clearTimeout(pollTimer);
  if (!S.auth || document.visibilityState !== "visible") return;
  pollTimer = setTimeout(poll, ms);
}
function pollSoon(ms = 300) {
  schedule(ms);
}

async function poll() {
  if (!S.auth || polling) return;
  polling = true;
  try {
    // The relay sends at most ~1 MB per response and sets `more` when there's another page. Pages are fetched
    // after the highest seq seen, but the saved cursor only moves past items that were accepted (lib/inbox.js).
    let after = S.cursor;
    for (let page = 0; page < 25; page++) {
      const data = await api("GET", `out?after=${after}`);
      const items = data.items || [];
      if (data.reset) S.cursor = after = 0;
      const res = await acceptOut(items, {
        cursor: S.cursor,
        lastN: S.lastN,
        signPub: S.signPub,
        encKey: S.encKey,
      });
      for (const d of res.dropped) {
        if (warned.has(d.seq)) continue;
        warned.add(d.seq);
        console.warn(
          d.why === "signature"
            ? `Yo Phone: dropped reply #${d.seq}, its signature is missing or wrong`
            : `Yo Phone: dropped reply #${d.seq}, it's older than one already shown (replayed or out of order)`,
        );
      }
      S.cursor = res.cursor;
      S.lastN = res.lastN;
      save(LS.cursor, S.cursor);
      save(LS.outN, S.lastN);
      for (const msg of res.messages) handleOut(msg);
      S.seen = typeof data.seen === "number" ? data.seen : null;
      if (!data.more || !items.length || !S.auth || res.maxSeq <= after) break;
      after = res.maxSeq;
    }
    const wasDown = S.netDown;
    S.netDown = false;
    pollDelay = POLL_MS;
    if (wasDown || resendable(S.messages).length) setTimeout(flushQueue, 0);
  } catch (err) {
    if (isTurnedOff(err)) {
      polling = false;
      onRevoked();
      return;
    }
    S.netDown = true;
    pollDelay = Math.min(POLL_MAX_MS, pollDelay * 1.6);
  } finally {
    polling = false;
    renderPresence();
    schedule(S.netDown ? pollDelay : POLL_MS);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    pollSoon(0);
    // Back after a while (or on a new day): say hello again. Ask for the tasks too, whichever tab shows: the core
    // only pushes them to a phone it saw in the last 15 minutes, so a phone that slept may have missed changes.
    if (S.auth) sayHello();
    requestTasks();
  } else stopPolling();
});
window.addEventListener("focus", () => pollSoon(0));
window.addEventListener("online", () => {
  pollSoon(0);
  flushQueue();
});
setInterval(renderPresence, 30_000);

// --------------------------------------------------------- incoming messages

function handleOut(msg) {
  if (msg?.v !== 1) return;
  switch (msg.t) {
    case "hello":
      if (msg.agent?.name) {
        S.agent = String(msg.agent.name).slice(0, 60);
        save(LS.agent, S.agent);
      }
      // v2.1: what this core understands (an older core sends none, and the photo button stays hidden).
      S.caps = Array.isArray(msg.caps) ? msg.caps.filter((c) => typeof c === "string").slice(0, 20) : [];
      save(LS.caps, S.caps);
      // v2.3: a core with Tasks gets asked for them once (the badge), and pushes changes from then on.
      if (S.caps.includes("tasks")) requestTasks();
      else if (S.tasks) {
        S.tasks = null;
        localStorage.removeItem(LS.tasks);
      }
      break;
    case "tasks": {
      if (!Array.isArray(msg.items)) break;
      S.tasks = normalizeTasks(msg.items);
      save(LS.tasks, { items: S.tasks, at: Number(msg.at) || Date.now() });
      settleStarts();
      renderTasks();
      break;
    }
    case "ack": {
      const ids = new Set(Array.isArray(msg.ids) ? msg.ids : []);
      for (const m of S.messages) if (m.k === "me" && ids.has(m.id)) m.st = "delivered";
      saveHistory();
      break;
    }
    case "status": {
      const helpers = Number(msg.helpers);
      S.helpers = Number.isFinite(helpers) && helpers > 0 ? Math.min(Math.round(helpers), 99) : 0;
      if (msg.state === "working" || msg.state === "queued") {
        S.working = {
          state: msg.state,
          detail: msg.detail ? String(msg.detail).slice(0, 120) : "",
          agent: msg.agent,
          at: Date.now(),
          since: S.working?.since ?? Date.now(),
          stopping: S.working?.stopping ?? false,
        };
      } else S.working = null;
      break;
    }
    case "reply": {
      if (S.messages.some((m) => m.k === "yo" && m.id === msg.id)) break;
      const text = String(msg.text ?? "");
      const pics = Number(msg.pics);
      const peek = msg.peek === true;
      // v2.3: the morning brief this turn posted, and the quick replies Yo picked for it.
      const brief = peek ? null : normalizeBrief(msg.brief);
      const replies = peek ? null : normalizeReplies(msg.replies);
      S.messages.push({
        k: "yo",
        id: msg.id || randomId(),
        text,
        at: Number(msg.at) || Date.now(),
        agent: msg.agent,
        ...(Number.isFinite(pics) && pics > 0 ? { pics: Math.min(Math.round(pics), 8) } : {}),
        ...(peek ? { peek: true } : {}),
        ...(brief ? { brief, ...(msg.briefText === true ? { briefText: true } : {}) } : {}),
        ...(replies ? { replies } : {}),
      });
      if (peek) {
        // A look at the screen isn't the turn's answer: Yo may still be working.
        S.peek = null;
        saveHistory();
        break;
      }
      S.working = null;
      // A reply means everything before it reached Yo, even if the ack got lost.
      for (const m of S.messages) if (m.k === "me" && m.st === "sent") m.st = "delivered";
      saveHistory();
      speak(text);
      break;
    }
    case "request": {
      if (!msg.requestId) break;
      const existing = S.messages.find((m) => m.k === "card" && m.id === msg.requestId);
      const card = {
        k: "card",
        id: msg.requestId,
        kind: ["approval", "question", "open_yo"].includes(msg.kind) ? msg.kind : "approval",
        title: String(msg.title ?? "Yo needs you"),
        detail: msg.detail ? String(msg.detail) : "",
        options: Array.isArray(msg.options) ? msg.options.map(String).slice(0, 8) : [],
        agent: msg.agent,
        at: existing?.at ?? Date.now(),
      };
      if (existing) Object.assign(existing, card);
      else {
        S.messages.push(card);
        speak(
          card.kind === "open_yo"
            ? `${card.title}. Open Yo on your computer.`
            : `Yo needs you: ${card.title}`,
        );
      }
      saveHistory();
      break;
    }
    case "resolved": {
      const card = S.messages.find((m) => m.k === "card" && m.id === msg.requestId);
      if (card) {
        card.outcome = String(msg.outcome ?? "Done");
        card.pending = null;
        saveHistory();
      }
      break;
    }
    case "images":
      // v2.1: the pictures of a reply that came just before.
      if (attachImages(S.messages, msg)) saveHistory();
      break;
    case "error":
      // A task action that didn't work says why here too (the chat is out of sight on Tasks). A refused Start
      // comes as an error before the list, so a Start waiting to land stops waiting: this says why.
      if (taskStarting.size) clearStarts();
      if (S.tab === "tasks") toast(String(msg.text ?? "Something went wrong"));
      S.messages.push({
        k: "err",
        id: randomId(),
        text: String(msg.text ?? "Something went wrong"),
        at: Date.now(),
      });
      S.working = null;
      saveHistory();
      speak(`Something went wrong. ${msg.text ?? ""}`);
      break;
  }
  renderAll();
}

// ------------------------------------------------------------------ sending

/** Photo bytes waiting to go with a message (kept in memory only; the message keeps small thumbnails). */
const photoData = new Map();

async function sendText(raw) {
  const text = String(raw).trim().slice(0, 8000);
  const photos = S.photos;
  if (!text && !photos.length) return;
  S.photos = [];
  renderTray();
  const m = { k: "me", id: randomId(), text, at: Date.now(), st: "sending" };
  if (photos.length) {
    m.thumbs = photos.map((p) => p.thumb);
    photoData.set(m.id, photos);
  }
  S.messages.push(m);
  saveHistory();
  renderAll();
  scrollToBottom(true);
  haptic();
  await deliver(m);
}

/** A tiny buzz where the phone supports it (Android); iPhones get the visual feedback only. */
function haptic(ms = 8) {
  try {
    navigator.vibrate?.(ms);
  } catch {}
}

/** Ask the core for a picture of Yo's screen right now (v2.2). */
async function peekScreen() {
  if (S.peek) return;
  S.peek = { at: Date.now() };
  haptic();
  renderAll();
  scrollToBottom(true);
  try {
    await sendIn({ t: "peek", id: randomId() });
    pollSoon(1200);
  } catch (err) {
    S.peek = null;
    toast(sendErrorText(err));
    renderAll();
    return;
  }
  setTimeout(() => {
    if (S.peek && Date.now() - S.peek.at >= PEEK_WAIT_MS - 50) {
      S.peek = null;
      renderAll();
      toast(`Couldn't see ${S.agent}'s screen. Try again in a moment.`);
    }
  }, PEEK_WAIT_MS);
}

/** Store a message's photos on the relay (encrypted), once; returns what the message points at. */
async function uploadPhotos(m) {
  if (m.picRefs) return m.picRefs;
  const photos = photoData.get(m.id);
  if (!photos) return null;
  const refs = [];
  for (const p of photos) {
    const id = randomBlobId();
    const box = await sealBlob(S.encKey, p.bytes, "in", id);
    await api("POST", "blob/in", { id, box });
    refs.push({ id, mime: p.mime, w: p.w, h: p.h, size: p.bytes.length, hash: await hashOf(p.bytes) });
  }
  m.picRefs = refs;
  return refs;
}

const delivering = new Set();
async function deliver(m) {
  if (delivering.has(m.id)) return;
  delivering.add(m.id);
  m.st = "sending";
  m.err = "";
  renderAll();
  try {
    let pics = null;
    if (m.thumbs?.length) {
      pics = await uploadPhotos(m);
      if (!pics) throw Object.assign(new Error("lost"), { status: -1 });
    }
    // `at` is when it was sent (the core won't run a message more than 10 minutes old).
    await sendIn({ t: "msg", id: m.id, text: m.text, at: Date.now(), ...(pics ? { pics } : {}) });
    if (m.st === "sending") m.st = "sent";
    photoData.delete(m.id);
  } catch (err) {
    if (err.status === 0 && Date.now() - m.at < QUEUE_FOR_MS) {
      // No connection: it waits and goes by itself when the phone is back online.
      m.st = "queued";
    } else {
      m.st = "failed";
      m.err = err.status === -1 ? "Photo lost. Attach it again." : sendErrorText(err);
    }
  } finally {
    delivering.delete(m.id);
  }
  saveHistory();
  renderAll();
  pollSoon(1200);
}

let flushing = false;
/** Send what waited for a connection, oldest first. */
async function flushQueue() {
  if (flushing || !S.auth) return;
  flushing = true;
  try {
    if (expireQueued(S.messages)) {
      saveHistory();
      renderAll();
    }
    for (const m of resendable(S.messages)) {
      await deliver(m);
      if (m.st === "queued") break; // still offline
    }
  } finally {
    flushing = false;
  }
}

async function respond(card, decision, answer) {
  card.pending = answer ?? decision;
  haptic();
  renderAll();
  try {
    await sendIn({
      t: "respond",
      id: randomId(),
      requestId: card.id,
      decision,
      ...(answer ? { answer } : {}),
    });
    pollSoon(800);
  } catch (err) {
    card.pending = null;
    toast(sendErrorText(err));
  }
  renderAll();
}

async function stopTurn() {
  if (!S.working) return;
  S.working.stopping = true;
  haptic();
  renderLive();
  try {
    await sendIn({ t: "stop", id: randomId() });
    pollSoon(800);
  } catch (err) {
    S.working.stopping = false;
    toast(sendErrorText(err));
    renderLive();
  }
}

// ------------------------------------------------------------------ render

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return dayFmt.format(d);
  return dateFmt.format(d);
}

const rendered = new Set();
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_LAPTOP =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M2 19h20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

const ICON_COPY =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M15.5 5.6A2.4 2.4 0 0 0 13.2 4H6.4A2.4 2.4 0 0 0 4 6.4v6.8a2.4 2.4 0 0 0 1.6 2.3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
const ICON_COPIED = ICON_CHECK.replace(/width="18" height="18"/, 'width="16" height="16"');
const ICON_TICK = ICON_CHECK.replace(/width="18" height="18"/, 'class="tick" width="13" height="13"');
const ICON_ALERT =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.8v5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="16.3" r="1.2" fill="currentColor"/></svg>';
const ICON_SCREEN =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="3" y="4" width="18" height="12.5" rx="2.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 20.5h6M12 16.5v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** Yo's reply as HTML: a Copy button on each code block, and its pictures in place (or under it). */
function yoBody(m) {
  const text = m.text;
  const inline = [];
  let html = renderMarkdown(text, {
    image: (src, alt) => {
      const p = picForSrc(m, src);
      if (p) {
        inline.push(src);
        return picFigure(p);
      }
      // Still on its way: a placeholder. An older core (or a picture that didn't make it): say where it is.
      if (waitingForPics(m)) return picPlaceholder(alt);
      if (/^https?:/i.test(src)) return null;
      return `<span class="img-missing">${ICON_IMAGE}<span>${escapeHtml(alt || "Picture")} · in Yo</span></span>`;
    },
  })
    .replace(
      /<pre>/g,
      `<div class="code"><button class="copy-code" type="button" data-copy-code aria-label="Copy code">${ICON_COPY}</button><pre>`,
    )
    .replace(/<\/pre>/g, "</pre></div>");
  const loose = loosePics(m, inline);
  if (loose.length) html += `<div class="pics">${loose.map(picFigure).join("")}</div>`;
  else if (waitingForPics(m) && !imageSources(text).length)
    html += `<div class="pics">${Array.from({ length: m.pics }, () => picPlaceholder("")).join("")}</div>`;
  if (m.more > 0)
    html += `<p class="pic-more">${ICON_IMAGE}<span>${escapeHtml(moreLabel(m.more))}</span></p>`;
  return html;
}

function renderAll() {
  const msgs = S.messages;
  const nearBottom = isNearBottom();
  const before = el.thread.childElementCount;
  const lastMine = [...msgs].reverse().find((m) => m.k === "me");
  const html = [];
  let prev = null;
  let lastAt = null;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const next = msgs[i + 1];
    if (lastAt === null || m.at - lastAt > 15 * 60 * 1000 || dayLabel(m.at) !== dayLabel(lastAt)) {
      html.push(
        `<p class="when"><strong>${escapeHtml(dayLabel(m.at))}</strong> ${escapeHtml(timeFmt.format(m.at))}</p>`,
      );
      prev = null;
    }
    const fresh = rendered.has(m.id) ? "" : " fresh";
    if (m.k === "yo" && m.brief) {
      // The morning brief: its card, then the reply's own text (if any) under it. A brief-only reply's text is the
      // card's titles in words, for phones without the card: not shown twice.
      html.push(renderBrief(m, fresh));
      prev = null;
      if (!briefTextShows(m)) {
        lastAt = m.at;
        rendered.add(m.id);
        continue;
      }
    }
    if (m.k === "me" || m.k === "yo") {
      const same = (a, b) => a && b && a.k === b.k && Math.abs(b.at - a.at) < 3 * 60 * 1000;
      const first = !same(prev, m);
      const last = !same(m, next) || (next && next.k === "me" && next.st === "failed") || m.st === "failed";
      const pics = m.k === "yo" && (m.images?.length || waitingForPics(m)) ? " has-pics" : "";
      const st = m.k === "me" && ["failed", "queued", "sending"].includes(m.st) ? ` ${m.st}` : "";
      const cls = `msg ${m.k}${first ? " first" : ""}${last ? " last" : ""}${st}${pics}${fresh}`;
      const body = m.k === "yo" ? yoBody(m) : meBody(m);
      let meta = "";
      if (m.k === "me" && m.st === "queued") {
        meta = `<div class="meta"><span class="state queued">${ICON_CLOCK}Waiting for a connection</span></div>`;
      } else if (m.k === "me" && m.st === "failed") {
        meta = `<div class="meta"><span class="state failed">${escapeHtml(m.err || "Not sent")}</span><button class="retry" type="button" data-retry="${escapeHtml(m.id)}">Retry</button></div>`;
      } else if (last) {
        const parts = [];
        if (m.peek)
          parts.push(`<span class="peek-tag">${ICON_SCREEN}Screen</span><span aria-hidden="true">·</span>`);
        parts.push(`<span>${escapeHtml(timeFmt.format(m.at))}</span>`);
        if (m.k === "me" && (m === lastMine || m.st === "sending")) {
          const label = { sending: "Sending…", sent: "Sent", delivered: "Delivered" }[m.st] ?? "";
          if (label)
            parts.push(
              `<span aria-hidden="true">·</span><span class="state ${m.st}">${m.st === "delivered" ? ICON_TICK : ""}${label}</span>`,
            );
        }
        meta = `<div class="meta">${parts.join("")}</div>`;
      }
      const who = m.k === "me" ? "You" : escapeHtml(m.agent || S.agent);
      html.push(
        `<div class="${cls}" data-id="${escapeHtml(m.id)}"><span class="sr-only">${who}: </span><div class="bubble">${body}</div>${meta}</div>`,
      );
    } else if (m.k === "card") {
      html.push(renderCard(m, fresh));
    } else if (m.k === "err") {
      html.push(`<p class="note${fresh}" role="alert">${ICON_ALERT}<span>${escapeHtml(m.text)}</span></p>`);
    }
    prev = m.k === "me" || m.k === "yo" ? m : null;
    lastAt = m.at;
    rendered.add(m.id);
  }
  if (S.peek)
    html.push(
      `<div class="msg yo first last${rendered.has("peek") ? "" : " fresh"} has-pics" aria-label="Taking a look at the screen"><div class="bubble"><p>Taking a look at my screen…</p>${picPlaceholder("", 16, 10)}</div></div>`,
    );
  rendered.add("peek");
  if (!S.peek) rendered.delete("peek");
  el.thread.innerHTML = html.join("");
  el.empty.hidden = msgs.length > 0 || !!S.peek;
  el.photoBtn.hidden = !S.caps.includes("photos");
  el.peekBtn.hidden = !S.caps.includes("peek");
  el.peekBtn.classList.toggle("busy", !!S.peek);
  el.agentName.textContent = S.agent;
  el.input.placeholder = `Text ${S.agent}`;
  renderLive();
  renderQuick();
  renderPresence();
  renderTabs();
  if (nearBottom) scrollToBottom();
  else if (el.thread.childElementCount > before) {
    // Something new arrived while reading back: the jump button says so.
    unseen = true;
    renderJump();
  }
}

const KICKER_ICON = {
  approval:
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3.5 5 6v5.2c0 4.3 2.9 7.9 7 9.3 4.1-1.4 7-5 7-9.3V6l-7-2.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="m9 12 2.2 2.2L15.5 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  question:
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.1" fill="currentColor"/></svg>',
};

function renderCard(c, fresh) {
  const who = escapeHtml(c.agent || S.agent);
  const kicker =
    c.outcome != null
      ? "Answered"
      : c.kind === "question"
        ? `${who} has a question`
        : c.kind === "open_yo"
          ? "Needs your computer"
          : `${who} needs your approval`;
  const icon =
    c.outcome != null
      ? ICON_TICK
      : c.kind === "open_yo"
        ? ICON_LAPTOP.replace(/width="18" height="18"/, 'width="14" height="14"')
        : KICKER_ICON[c.kind] || KICKER_ICON.approval;
  let actions = "";
  if (c.outcome != null) {
    actions = `<p class="req-outcome"><span>${escapeHtml(c.outcome)}</span></p>`;
  } else if (c.kind === "open_yo") {
    actions = `<p class="req-note">${ICON_LAPTOP}<span>Open Yo on your computer</span></p>`;
  } else if (c.kind === "question" && c.options.length) {
    const btns = c.options
      .map(
        (o, i) =>
          `<button class="req-btn${i === 0 ? " primary" : ""}" type="button" data-card="${escapeHtml(c.id)}" data-answer="${escapeHtml(o)}"${c.pending ? " disabled" : ""}>${escapeHtml(c.pending === o ? "Sending…" : o)}</button>`,
      )
      .join("");
    actions = `<div class="req-actions stack">${btns}</div>`;
  } else if (c.kind === "question") {
    actions = `<p class="req-note">${ICON_LAPTOP}<span>Answer this in Yo on your computer</span></p>`;
  } else {
    const label = (d, text) => (c.pending === d ? "Sending…" : text);
    actions = `<div class="req-actions"><button class="req-btn" type="button" data-card="${escapeHtml(c.id)}" data-decision="deny"${c.pending ? " disabled" : ""}>${label("deny", "Refuse")}</button><button class="req-btn primary" type="button" data-card="${escapeHtml(c.id)}" data-decision="approve"${c.pending ? " disabled" : ""}>${label("approve", "Allow")}</button></div>`;
  }
  const detail = c.detail ? `<p class="req-detail">${escapeHtml(c.detail)}</p>` : "";
  return `<article class="req card${c.outcome != null ? " resolved" : ""}${fresh}" aria-label="${kicker}: ${escapeHtml(c.title)}"><span class="req-icon" aria-hidden="true">${icon}</span><div class="req-main"><p class="req-kicker">${kicker}</p><h3>${escapeHtml(c.title)}</h3>${detail}</div>${actions}</article>`;
}

// ------------------------------------------------------------------ morning brief (v2.3)

const ICON_ARROW =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const briefDateFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
/** Brief sections the user unfolded ("Show N more"), by `${messageId}:${section}`. */
const briefOpen = new Set();

/**
 * The brief card: the date, a greeting, what needs the user (each with Start, which sends "Take care of: {title}"
 * as their own message), what can wait, today's calendar, and what Yo couldn't check.
 */
function renderBrief(m, fresh) {
  const b = m.brief;
  const started = new Set(m.briefStarted ?? []);
  const id = escapeHtml(m.id);
  const section = (key, label, rows, row) => {
    if (!rows.length) return "";
    const { shown, more } = briefFold(rows.length, briefOpen.has(`${m.id}:${key}`));
    const items = rows
      .slice(0, shown)
      .map((it, i) => `<li class="brief-item">${row(it, i)}</li>`)
      .join("");
    const btn = more
      ? `<button class="brief-more" type="button" data-brief="${id}" data-brief-more="${key}" aria-label="Show ${more} more in ${label}">Show ${more} more</button>`
      : "";
    return `<section class="brief-sec" aria-label="${label}"><h4>${label}</h4><ul>${items}</ul>${btn}</section>`;
  };
  const detail = (it) => (it.detail ? `<span class="brief-detail">${escapeHtml(it.detail)}</span>` : "");
  const needs = (it, i) => {
    const action = started.has(it.title)
      ? `<span class="brief-started">${ICON_TICK}Started</span>`
      : `<button class="brief-start" type="button" data-brief="${id}" data-brief-start="${i}" aria-label="Start: ${escapeHtml(it.title)}">Start${ICON_ARROW}</button>`;
    return `<span class="brief-title">${escapeHtml(it.title)}</span>${detail(it)}${action}`;
  };
  const plain = (it) =>
    `<span class="brief-row">${it.time ? `<span class="brief-time">${escapeHtml(it.time)}</span>` : ""}<span class="brief-text"><span class="brief-title">${escapeHtml(it.title)}</span>${detail(it)}</span></span>`;
  const empty =
    !b.needsYou.length && !b.canWait.length && !b.today.length
      ? `<p class="brief-empty">Nothing new needs you, and your calendar is clear today.</p>`
      : "";
  const cnc = b.couldNotCheck.length
    ? `<ul class="brief-cnc">${b.couldNotCheck.map((n) => `<li>Couldn't check ${escapeHtml(n.source)}${n.why ? `: ${escapeHtml(n.why)}` : ""}</li>`).join("")}</ul>`
    : "";
  return `<article class="brief card${fresh}" aria-label="Morning brief" data-brief-card="${id}"><p class="brief-date">${escapeHtml(briefDateFmt.format(m.at))}</p><p class="brief-hello">${briefGreeting(new Date(m.at).getHours())}</p>${empty}${section("needs", "Needs you", b.needsYou, needs)}${section("wait", "Can wait", b.canWait, plain)}${section("today", "Today", b.today, plain)}${cnc}</article>`;
}

function startFromBrief(m, i) {
  const item = m.brief?.needsYou?.[i];
  if (!item || m.briefStarted?.includes(item.title)) return;
  m.briefStarted = [...(m.briefStarted ?? []), item.title];
  saveHistory();
  sendText(briefStartText(item));
}

// ------------------------------------------------------------------ tabs and Tasks (v2.3)

const hasTasks = () => S.caps.includes("tasks");

/** Chat or Tasks. Tasks asks the core for a fresh list each time it opens (at most every 15 s). */
function setTab(tab) {
  if (tab === "tasks" && !(hasTasks() && S.auth)) tab = "chat";
  const changed = S.tab !== tab;
  S.tab = tab;
  el.chat.classList.toggle("on-tasks", tab === "tasks");
  el.tasksView.hidden = tab !== "tasks";
  el.tabChat.setAttribute("aria-current", tab === "chat" ? "page" : "false");
  el.tabTasks.setAttribute("aria-current", tab === "tasks" ? "page" : "false");
  if (!changed) return;
  closeMenu();
  // The header's hairline follows whichever list is showing.
  el.chat.classList.toggle("scrolled", tab === "tasks" ? el.tasksScroll.scrollTop > 4 : el.log.scrollTop > 4);
  if (tab === "tasks") {
    if (document.activeElement === el.input) el.input.blur();
    renderTasks();
    el.tasksScroll.scrollTop = 0;
    requestTasks();
  } else {
    scrollToBottom(true);
  }
}

function renderTabs() {
  const show = !!S.auth && hasTasks();
  el.tabbar.hidden = !show;
  el.app.classList.toggle("tabs", show);
  if (!show && S.tab === "tasks") setTab("chat");
  const n = S.tasks ? tasksBadge(S.tasks) : 0;
  el.tasksBadge.hidden = !n;
  el.tasksBadge.textContent = n > 99 ? "99+" : String(n);
  el.tabTasks.setAttribute("aria-label", n ? `Tasks, ${n} waiting on you` : "Tasks");
}

let tasksAskedAt = 0;
/** Ask the core for the task list. After the first ask the core also pushes changes by itself. */
async function requestTasks(force = false) {
  if (!S.auth || !hasTasks()) return;
  if (!force && Date.now() - tasksAskedAt < TASKS_ASK_MS) return;
  tasksAskedAt = Date.now();
  try {
    await sendIn({ t: "tasks", id: randomId() });
    pollSoon(900);
  } catch {
    tasksAskedAt = 0;
  }
}

/**
 * Rows being checked off (the check lands before the row moves to Resolved), rows whose action is being sent, and
 * Starts the core hasn't confirmed yet (id -> give-up timer): "Started" only shows once its list has them under way.
 */
const taskLanded = new Set();
const taskBusy = new Set();
const taskStarting = new Map();
let resolvedOpen = false;

/** A Start was sent: wait quietly for the core's list to show it under way, or give up after START_WAIT_MS. */
function awaitStart(id) {
  clearTimeout(taskStarting.get(id));
  taskStarting.set(
    id,
    setTimeout(() => {
      if (!taskStarting.delete(id)) return;
      toast("Couldn't start it. Try again.");
      renderTasks();
    }, START_WAIT_MS),
  );
}

/** The core's list came: Starts it shows under way are confirmed. */
function settleStarts() {
  let landed = false;
  for (const [id, timer] of taskStarting)
    if (startLanded(S.tasks, id)) {
      clearTimeout(timer);
      taskStarting.delete(id);
      landed = true;
    }
  if (landed) toast("Started. I'm on it.");
}

/** Stop waiting on every Start (an error came that says why, or the link changed). */
function clearStarts() {
  for (const timer of taskStarting.values()) clearTimeout(timer);
  taskStarting.clear();
  renderTasks();
}

async function taskAction(id, action) {
  const t = S.tasks?.find((x) => x.id === id);
  if (!t || taskBusy.has(id) || taskStarting.has(id)) {
    // Gone from the list (or already on its way): nothing to send, so the row mustn't stay half-checked.
    taskLanded.delete(id);
    if (!t) taskBusy.delete(id);
    renderTasks();
    return;
  }
  taskBusy.add(id);
  renderTasks();
  try {
    await sendIn({ t: "task", id: randomId(), taskId: id, action });
    // Hide and check off show right away (the list the core sends back replaces them). A Start waits for it.
    if (action === "start") awaitStart(id);
    else {
      S.tasks = S.tasks.map((x) => (x.id === id ? afterAction(x, action) : x));
      save(LS.tasks, { items: S.tasks, at: Date.now() });
    }
    pollSoon(900);
  } catch (err) {
    toast(sendErrorText(err));
  } finally {
    taskBusy.delete(id);
    taskLanded.delete(id);
    renderTasks();
    renderTabs();
  }
}

function checkOff(id) {
  if (taskLanded.has(id) || taskBusy.has(id)) return;
  taskLanded.add(id);
  haptic();
  renderTasks();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  setTimeout(() => taskAction(id, "done"), reduced ? 0 : 420);
}

const ICON_CHECK_MARK = ICON_CHECK.replace(
  /width="18" height="18"/,
  'class="check-mark" width="14" height="14"',
);
const ICON_SPARK =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M10 4.5l1.4 3.9a3 3 0 0 0 1.8 1.8L17 11.6l-3.8 1.4a3 3 0 0 0-1.8 1.8L10 18.7l-1.4-3.9a3 3 0 0 0-1.8-1.8L3 11.6l3.8-1.4a3 3 0 0 0 1.8-1.8L10 4.5ZM18 3v4M20 5h-4M18.5 16.5v3M20 18h-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CHEVRON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" class="chev"><path d="m9.5 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_INBOX =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 13.5h4.2l1.3 2.5h5l1.3-2.5H20M6.3 5.5h11.4L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18v-4.5l2.3-8Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

function taskRow(t) {
  const done = t.status === "done";
  const checked = done || taskLanded.has(t.id);
  const word = statusWord(t);
  const id = escapeHtml(t.id);
  const spin = t.status === "in_progress" ? '<span class="spin" aria-hidden="true"></span>' : "";
  const note = t.note ? `<span class="task-note"> · ${escapeHtml(t.note)}</span>` : "";
  return `<li class="task-row${done ? " done" : ""}" data-task-id="${id}"><button class="task-check${checked ? " checked" : ""}${taskLanded.has(t.id) ? " landing" : ""}" type="button" data-check="${id}" aria-pressed="${checked}" aria-label="${done ? "Done" : `Check off “${escapeHtml(t.title)}”`}"${done ? " disabled" : ""}><span class="check-ring">${ICON_CHECK_MARK}</span></button><button class="task-open" type="button" data-open="${id}"><span class="task-text"><span class="task-title">${escapeHtml(t.title)}</span><span class="task-line">${spin}<span class="task-line-text">${word ? `<span class="task-word" data-status="${t.status}">${escapeHtml(word)}</span>` : ""}${note}</span></span></span>${ICON_CHEVRON}</button></li>`;
}

function groupHead(label, count, toggle = "") {
  return `<div class="group-head"><h3 class="group-title">${escapeHtml(label)}</h3><span class="count">${count}</span>${toggle}</div>`;
}

function renderActive(tasks) {
  const groups = activeGroups(tasks);
  const open = groups.filter((g) => g.id !== "done");
  const resolved = groups.find((g) => g.id === "done");
  const parts = [];
  if (!open.length) {
    const hint = upNext(tasks).suggestions.length
      ? " Start one from Up next, or just text me."
      : " Text me anything you'd like done.";
    parts.push(
      `<div class="tasks-empty"><span class="tasks-empty-icon">${ICON_INBOX}</span><p>Nothing active right now.${hint}</p></div>`,
    );
  }
  for (const g of open)
    parts.push(
      `<section class="task-group" data-group="${g.id}" aria-label="${escapeHtml(g.label)}">${groupHead(g.label, g.tasks.length)}<ul class="task-list">${g.tasks.map(taskRow).join("")}</ul></section>`,
    );
  if (resolved) {
    const toggle = `<button class="group-toggle" type="button" data-resolved aria-expanded="${resolvedOpen}">${resolvedOpen ? "Hide" : "Show"}</button>`;
    parts.push(
      `<section class="task-group" data-group="done" aria-label="Resolved">${groupHead("Resolved", resolved.tasks.length, toggle)}${resolvedOpen ? `<ul class="task-list">${resolved.tasks.map(taskRow).join("")}</ul>` : ""}</section>`,
    );
  }
  return parts.join("");
}

function renderUpNext(tasks) {
  const { suggestions, saved } = upNext(tasks);
  if (!suggestions.length && !saved.length)
    return `<div class="tasks-empty"><span class="tasks-empty-icon">${ICON_INBOX}</span><p>Nothing new right now. I'll keep checking.</p></div>`;
  const busy = (t) => (taskBusy.has(t.id) || taskStarting.has(t.id) ? " disabled" : "");
  // A Start on its way: the button says so quietly until the core's list has it under way.
  const startLabel = (t) => (taskStarting.has(t.id) ? "Starting…" : "Start");
  const cards = suggestions
    .map(
      (t) =>
        `<article class="sugg card" data-task-id="${escapeHtml(t.id)}"><p class="sugg-kicker">${ICON_SPARK}<span>${escapeHtml(S.agent)} could take this on</span></p><h3 class="sugg-title">${escapeHtml(t.title)}</h3>${t.why ? `<p class="sugg-why">${escapeHtml(t.why)}</p>` : ""}<div class="sugg-actions"><button class="pill" type="button" data-hide="${escapeHtml(t.id)}"${busy(t)}>Hide</button><button class="pill primary" type="button" data-start="${escapeHtml(t.id)}"${busy(t)}>${startLabel(t)}</button></div></article>`,
    )
    .join("");
  const savedList = saved.length
    ? `<section class="task-group" data-group="saved" aria-label="Saved for later">${groupHead("Saved for later", saved.length)}<ul class="task-list">${saved
        .map(
          (t) =>
            `<li class="saved-row" data-task-id="${escapeHtml(t.id)}"><span class="task-text"><span class="task-title">${escapeHtml(t.title)}</span>${t.note ? `<span class="task-line"><span class="task-line-text task-note">${escapeHtml(t.note)}</span></span>` : ""}</span><button class="pill primary" type="button" data-start="${escapeHtml(t.id)}"${busy(t)}>${startLabel(t)}</button></li>`,
        )
        .join("")}</ul></section>`
    : "";
  return `${cards ? `<div class="sugg-list">${cards}</div>` : ""}${savedList}`;
}

function renderTasks() {
  if (S.tab !== "tasks") return;
  el.tasksSub.textContent = `What ${S.agent} is on, and what's next.`;
  for (const b of el.tasksSeg.querySelectorAll("[data-view]"))
    b.setAttribute("aria-selected", String(b.dataset.view === S.tasksView));
  el.tasksSeg.dataset.view = S.tasksView;
  el.tasksBody.innerHTML = !S.tasks
    ? `<p class="tasks-loading"><span class="spin" aria-hidden="true"></span>Getting your tasks…</p>`
    : S.tasksView === "upnext"
      ? renderUpNext(S.tasks)
      : renderActive(S.tasks);
}

el.tasksScroll.addEventListener(
  "scroll",
  () => {
    if (S.tab === "tasks") el.chat.classList.toggle("scrolled", el.tasksScroll.scrollTop > 4);
  },
  { passive: true },
);
el.tabbar.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (!tab) return;
  haptic();
  if (tab.dataset.tab === S.tab && S.tab === "tasks") {
    el.tasksScroll.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  setTab(tab.dataset.tab);
});
el.tasksSeg.addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (!b || b.dataset.view === S.tasksView) return;
  S.tasksView = b.dataset.view === "upnext" ? "upnext" : "active";
  save(LS.tasksView, S.tasksView);
  haptic();
  renderTasks();
  el.tasksScroll.scrollTop = 0;
});
el.tasksBody.addEventListener("click", (e) => {
  const check = e.target.closest("[data-check]");
  if (check) {
    if (!check.disabled) checkOff(check.dataset.check);
    return;
  }
  if (e.target.closest("[data-open]")) {
    // A task is talked about in the chat: that's where it goes.
    setTab("chat");
    return;
  }
  const start = e.target.closest("[data-start]");
  if (start && !start.disabled) {
    taskAction(start.dataset.start, "start");
    return;
  }
  const hide = e.target.closest("[data-hide]");
  if (hide && !hide.disabled) {
    taskAction(hide.dataset.hide, "hide");
    return;
  }
  if (e.target.closest("[data-resolved]")) {
    resolvedOpen = !resolvedOpen;
    renderTasks();
  }
});

/** The live card while Yo works: what he's doing right now, for how long, his helpers, and Stop. */
function renderLive() {
  const v = workingView({ working: S.working, helpers: S.helpers, agent: S.agent });
  if (!v) S.working = null;
  const wasHidden = el.live.hidden;
  el.live.hidden = !v;
  if (v) {
    el.live.dataset.tone = v.tone;
    el.liveTitle.textContent = v.title;
    el.liveElapsed.textContent = v.elapsed;
    el.liveStep.textContent = v.step;
    el.liveHelpers.hidden = !v.helpers;
    el.liveHelpersText.textContent = v.helpers;
    el.stopBtn.hidden = !v.canStop;
    el.stopBtn.disabled = !v.canStop;
    if (wasHidden && isNearBottom(160)) scrollToBottom();
  }
  // Helpers still going after Yo's answer: a small hint, nothing more.
  const helpers = !v ? helpersLabel(S.helpers) : "";
  el.helpersRow.hidden = !helpers;
  el.helpersText.textContent = helpers;
}

/** Quick replies under Yo's question (not while he's working, and not in hands-free mode). */
let quickKey = "";
function renderQuick() {
  const chips = S.working || S.drive || S.peek ? [] : quickReplies(S.messages);
  const key = `${S.messages.at(-1)?.id ?? ""}|${chips.join("|")}`;
  el.quick.hidden = !chips.length;
  if (key === quickKey) return;
  quickKey = key;
  el.quick.innerHTML = chips
    .map(
      (c) =>
        `<button type="button" class="quick-chip" data-quick="${escapeHtml(c)}">${escapeHtml(c)}</button>`,
    )
    .join("");
}

function renderPresence() {
  if (!S.auth) return;
  const p = presenceView({
    seen: S.seen,
    netDown: S.netDown,
    working: S.working,
    helpers: S.helpers,
    agent: S.agent,
    queuedToSend: resendable(S.messages).length,
  });
  el.presence.dataset.tone = p.tone;
  el.presenceText.textContent = p.text;
  el.avatar.classList.toggle("busy", p.tone === "working");
  el.banner.hidden = !p.banner;
  if (p.banner) {
    el.banner.dataset.tone = p.banner.tone;
    if (el.bannerText.textContent !== p.banner.text) el.bannerText.textContent = p.banner.text;
  }
  el.setAgent.textContent = S.agent;
  el.setSeen.textContent =
    S.seen === undefined ? "Checking…" : p.online ? "Online" : p.text.replace(/^Away · /, "");
  el.setLink.textContent = S.pairedAt
    ? `Linked ${dateFmt.format(new Date(S.pairedAt))}`
    : S.auth
      ? "Linked"
      : "Not linked";
}

function isNearBottom(slack = 120) {
  const l = el.log;
  return l.scrollHeight - l.scrollTop - l.clientHeight < slack;
}
function scrollToBottom(force = false) {
  if (!force && !isNearBottom(400)) return;
  requestAnimationFrame(() => {
    // New messages glide in; opening the app or sending jumps straight to the end.
    if (force || matchMedia("(prefers-reduced-motion: reduce)").matches)
      el.log.scrollTop = el.log.scrollHeight;
    else el.log.scrollTo({ top: el.log.scrollHeight, behavior: "smooth" });
  });
}

/** Jump to latest: shows once you've scrolled back a screen or so, and says "New" if something arrived. */
let unseen = false;
function renderJump() {
  const away = !isNearBottom(Math.max(240, el.log.clientHeight * 0.6));
  if (!away) unseen = false;
  el.jump.classList.toggle("show", away);
  el.jumpNew.hidden = !unseen;
  el.jump.setAttribute(
    "aria-label",
    unseen ? "New messages. Jump to the latest" : "Jump to the latest message",
  );
}
let scrollRaf = 0;
el.log.addEventListener(
  "scroll",
  () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      el.chat.classList.toggle("scrolled", el.log.scrollTop > 4);
      renderJump();
      closeMenu();
    });
  },
  { passive: true },
);
el.jump.hidden = false;
el.jump.addEventListener("click", () => {
  unseen = false;
  haptic();
  el.log.scrollTo({
    top: el.log.scrollHeight,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
});

let toastTimer = 0;
function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 3200);
}

// ------------------------------------------------------------------ composer

/**
 * The text box is exactly one line tall when empty and grows by whole lines up to five. It's measured at height 0,
 * so the box's own height (or iOS's taller default for a textarea) never adds an empty line at the top.
 */
const LINE_H = 22;
const PAD_Y = 18;
function autosize() {
  const ta = el.input;
  if (!ta.value) {
    ta.style.height = `${LINE_H + PAD_Y}px`;
    ta.classList.remove("scrolls");
  } else {
    const wasBottom = isNearBottom();
    ta.style.height = "0px";
    const { height, scroll } = composerHeight(ta.scrollHeight, { lineHeight: LINE_H, padY: PAD_Y, max: 5 });
    ta.style.height = `${height}px`;
    ta.classList.toggle("scrolls", scroll);
    if (wasBottom) el.log.scrollTop = el.log.scrollHeight;
  }
  el.send.disabled = !ta.value.trim() && !S.photos.length;
}

el.input.addEventListener("input", autosize);
el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    el.form.requestSubmit();
  }
});
el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el.input.value;
  if (!text.trim() && !S.photos.length) return;
  el.input.value = "";
  autosize();
  el.input.focus({ preventScroll: true });
  el.send.classList.remove("sent");
  void el.send.offsetWidth;
  el.send.classList.add("sent");
  sendText(text);
});

/** Copy, then flip the button to a check for a moment (and say so). */
async function copyFrom(btn, text) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
  }
  if (!ok) {
    toast("Couldn't copy that here.");
    return;
  }
  toast("Copied");
  haptic();
  if (!btn) return;
  btn.classList.add("copied");
  btn.innerHTML = ICON_COPIED;
  setTimeout(() => {
    btn.classList.remove("copied");
    btn.innerHTML = ICON_COPY;
  }, 1500);
}

el.thread.addEventListener("click", (e) => {
  const copyPic = e.target.closest("[data-copy-pic]");
  if (copyPic) {
    copyPicture(copyPic.dataset.copyPic, copyPic);
    return;
  }
  const openPic = e.target.closest("[data-pic]");
  if (openPic) {
    openViewer(openPic.dataset.pic);
    return;
  }
  const copyCode = e.target.closest("[data-copy-code]");
  if (copyCode) {
    copyFrom(copyCode, copyCode.nextElementSibling?.textContent ?? "");
    return;
  }
  const briefMore = e.target.closest("[data-brief-more]");
  if (briefMore) {
    briefOpen.add(`${briefMore.dataset.brief}:${briefMore.dataset.briefMore}`);
    renderAll();
    return;
  }
  const briefStart = e.target.closest("[data-brief-start]");
  if (briefStart) {
    const m = S.messages.find((x) => x.k === "yo" && x.id === briefStart.dataset.brief);
    if (m) startFromBrief(m, Number(briefStart.dataset.briefStart));
    return;
  }
  const retry = e.target.closest("[data-retry]");
  if (retry) {
    const m = S.messages.find((x) => x.id === retry.dataset.retry);
    if (m) deliver(m);
    return;
  }
  const btn = e.target.closest("[data-card]");
  if (btn && !btn.disabled) {
    const card = S.messages.find((x) => x.k === "card" && x.id === btn.dataset.card);
    if (!card || card.pending || card.outcome != null) return;
    if (btn.dataset.answer != null) respond(card, "approve", btn.dataset.answer);
    else respond(card, btn.dataset.decision === "approve" ? "approve" : "deny");
  }
});
el.stopBtn.addEventListener("click", stopTurn);
el.peekBtn.addEventListener("click", () => {
  setTab("chat");
  peekScreen();
});
el.quick.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-quick]");
  if (!chip) return;
  el.quick.hidden = true;
  sendText(chip.dataset.quick);
});

// ------------------------------------------------------------------ long-press a message to copy

const PRESS = { timer: 0, lift: 0, x: 0, y: 0, msg: null };
let menuFor = null;
function closeMenu() {
  if (el.menu.hidden) return;
  el.menu.hidden = true;
  menuFor = null;
}
function cancelPress() {
  clearTimeout(PRESS.timer);
  clearTimeout(PRESS.lift);
  PRESS.msg?.classList.remove("pressed");
  PRESS.msg = null;
}
function openMenu(msgEl) {
  const bubble = msgEl.querySelector(".bubble");
  if (!bubble) return;
  menuFor = { text: bubble.innerText.trim() };
  haptic(12);
  el.menu.hidden = false;
  // The app box may be moved by the keyboard: place the menu in its coordinates.
  const r = bubble.getBoundingClientRect();
  const app = el.app.getBoundingClientRect();
  const w = el.menu.offsetWidth;
  const h = el.menu.offsetHeight;
  const mine = msgEl.classList.contains("me");
  const x = Math.max(8, Math.min((mine ? r.right - w : r.left) - app.left, app.width - w - 8));
  // Above the bubble if there's room under the header, else just below it.
  const top = el.log.getBoundingClientRect().top - app.top + 8;
  let y = r.top - app.top - h - 8;
  if (y < top) y = Math.max(top, Math.min(r.bottom - app.top + 8, app.height - h - 8));
  el.menu.style.setProperty("--mx", `${Math.round(x)}px`);
  el.menu.style.setProperty("--my", `${Math.round(y)}px`);
}
el.thread.addEventListener("pointerdown", (e) => {
  closeMenu();
  // A mouse selects text the usual way; touch gets the long-press menu.
  if (e.pointerType === "mouse") return;
  const bubble = e.target.closest(".msg[data-id] > .bubble");
  if (!bubble || e.target.closest("button, a, .table-wrap, pre")) return;
  cancelPress();
  PRESS.msg = bubble.parentElement;
  PRESS.x = e.clientX;
  PRESS.y = e.clientY;
  PRESS.lift = setTimeout(() => PRESS.msg?.classList.add("pressed"), 140);
  PRESS.timer = setTimeout(() => {
    const msg = PRESS.msg;
    cancelPress();
    if (msg?.isConnected) openMenu(msg);
  }, 450);
});
el.thread.addEventListener("pointermove", (e) => {
  if (PRESS.msg && Math.hypot(e.clientX - PRESS.x, e.clientY - PRESS.y) > 10) cancelPress();
});
el.thread.addEventListener("pointerup", cancelPress);
el.thread.addEventListener("pointercancel", cancelPress);
el.thread.addEventListener("contextmenu", (e) => {
  if (e.target.closest(".msg[data-id] > .bubble") && !e.target.closest("a, img")) e.preventDefault();
});
el.menu.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn || !menuFor) return;
  const text = menuFor.text;
  closeMenu();
  if (btn.dataset.act === "copy") copyFrom(null, text);
});
document.addEventListener("pointerdown", (e) => {
  if (!el.menu.hidden && !el.menu.contains(e.target) && !el.thread.contains(e.target)) closeMenu();
});
el.tipClose.addEventListener("click", () => {
  el.tip.hidden = true;
  save(LS.tip, true);
});

el.pasteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  el.pasteError.textContent = "";
  try {
    await pair(parseLink(el.pasteInput.value));
    el.pasteInput.value = "";
  } catch (err) {
    el.pasteError.textContent = err instanceof LinkError ? err.message : BAD_LINK;
  }
});

// ------------------------------------------------- keyboard / visual viewport

// The app box is sized to the visual viewport (what's visible above the keyboard) and moved with it, so the
// composer sits on the keyboard and the header stays at the top. iOS only reports the keyboard after it has slid
// in; until then the last keyboard height seen is used, so the layout is already right when iOS checks whether
// the text box is visible and it has no reason to scroll the page.
let lastKb = load(LS.kb, 0);
let guessTimer = 0;
/** The guess only stands in while the keyboard is on its way (a hardware keyboard never sends one). */
let guessUntil = 0;
const GUESS_MS = 1000;
let fitRaf = 0;
function applyViewport() {
  fitRaf = 0;
  const vv = window.visualViewport;
  const focused = document.activeElement === el.input && Date.now() < guessUntil;
  const f = fitViewport({
    innerHeight: window.innerHeight,
    vvHeight: vv?.height,
    vvTop: vv?.offsetTop ?? 0,
    focused: focused && matchMedia("(pointer: coarse)").matches,
    lastKb,
  });
  const wasBottom = isNearBottom();
  el.app.style.setProperty("--app-h", `${f.height}px`);
  el.app.style.setProperty("--app-y", `${f.top}px`);
  document.documentElement.classList.toggle("kb-open", f.kbOpen);
  if (f.kbOpen && !f.guess && f.kb !== lastKb) {
    lastKb = f.kb;
    save(LS.kb, lastKb);
  }
  if (wasBottom) el.log.scrollTop = el.log.scrollHeight;
}
function fitSoon() {
  if (!fitRaf) fitRaf = requestAnimationFrame(applyViewport);
}
if (window.visualViewport) {
  visualViewport.addEventListener("resize", fitSoon);
  visualViewport.addEventListener("scroll", fitSoon);
}
window.addEventListener("resize", fitSoon);
// Only a tap on the box brings the keyboard up (focusing it again after Send doesn't), so only a tap starts a guess.
el.input.addEventListener("pointerdown", () => {
  if (document.activeElement !== el.input) guessUntil = Date.now() + GUESS_MS;
});
el.input.addEventListener("focus", () => {
  applyViewport();
  // If no keyboard shows up (a hardware keyboard), drop the guess.
  clearTimeout(guessTimer);
  guessTimer = setTimeout(applyViewport, GUESS_MS + 20);
});
el.input.addEventListener("blur", () => {
  guessUntil = 0;
  clearTimeout(guessTimer);
  setTimeout(applyViewport, 50);
});
applyViewport();
// Only the message list scrolls: if focus() or a browser nudges the boxes around it, put them back.
for (const box of [el.app, el.chat, el.log.parentElement, el.tasksView])
  box.addEventListener("scroll", () => {
    if (box.scrollTop || box.scrollLeft) box.scrollTo(0, 0);
  });
// The document itself never scrolls (it's fixed); if iOS nudges it anyway, put it back.
window.addEventListener("scroll", () => {
  if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
});

// ------------------------------------------------------------------ voice

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let transcript = "";
let silenceTimer = 0;
let countdownTimer = 0;
let wakeLock = null;

function speak(text) {
  if (!(S.drive || S.readAloud) || !("speechSynthesis" in window)) return;
  const said = toSpeech(text);
  if (!said) return;
  const u = new SpeechSynthesisUtterance(said.slice(0, 1200));
  u.lang = navigator.language || "en-US";
  u.rate = 1.02;
  speechSynthesis.speak(u);
}

async function holdScreen(on) {
  try {
    if (on && "wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    // not supported or denied: fine
  }
}
document.addEventListener("visibilitychange", () => {
  if (S.drive && document.visibilityState === "visible") holdScreen(true);
});

function setDrive(on, { quiet = false } = {}) {
  S.drive = !!on;
  save(LS.drive, S.drive);
  el.driveBtn.setAttribute("aria-pressed", String(S.drive));
  el.driveBtn.setAttribute("aria-label", S.drive ? "Hands-free mode on. Turn off" : "Hands-free mode");
  el.app.classList.toggle("drive", S.drive);
  // Hands-free is a Chat thing: the tab bar steps aside for the big mic.
  if (S.drive) setTab("chat");
  if (S.auth) renderQuick();
  el.app.classList.toggle("no-speech", !SR);
  el.drivePanel.hidden = !S.drive;
  el.drivePanel.classList.toggle("fallback", !SR);
  el.mic.hidden = !SR;
  el.driveHint.hidden = !SR;
  el.driveFallback.hidden = !!SR;
  if (S.drive) {
    holdScreen(true);
    setMicState("idle");
    // Speaking from this tap also unlocks speech on iOS for later replies.
    if (!quiet && "speechSynthesis" in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(SR ? "Hands-free on. Tap the mic to talk." : "Hands-free on.");
      u.lang = navigator.language || "en-US";
      speechSynthesis.speak(u);
    }
  } else {
    holdScreen(false);
    cancelListening();
    cancelCountdown();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }
  scrollToBottom(true);
}

function setMicState(state, hint) {
  el.mic.classList.toggle("listening", state === "listening");
  el.mic.setAttribute("aria-label", state === "listening" ? "Stop and send" : "Start talking");
  el.mic.hidden = !SR || state === "countdown";
  el.countdown.hidden = state !== "countdown";
  el.driveHint.textContent =
    hint ??
    (state === "listening"
      ? "Listening… pause when you're done"
      : state === "countdown"
        ? ""
        : "Tap to talk");
  el.driveHint.hidden = !SR || state === "countdown";
}

function startListening() {
  if (!SR) return;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  cancelCountdown();
  transcript = "";
  el.driveTranscript.textContent = "";
  recog = new SR();
  recog.lang = navigator.language || "en-US";
  recog.interimResults = true;
  recog.continuous = false;
  recog.maxAlternatives = 1;
  recog.onresult = (e) => {
    let text = "";
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    transcript = text.trim();
    el.driveTranscript.textContent = transcript;
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => recog?.stop(), 1800);
  };
  recog.onerror = (e) => {
    const hint =
      e.error === "not-allowed" || e.error === "service-not-allowed"
        ? "Allow the microphone for Yo in Settings, then tap again"
        : e.error === "no-speech"
          ? "Didn't hear anything. Tap to try again"
          : "Couldn't listen. Tap to try again";
    transcript = "";
    setMicState("idle", hint);
  };
  recog.onend = () => {
    clearTimeout(silenceTimer);
    recog = null;
    if (transcript) startCountdown(transcript);
    else if (el.mic.classList.contains("listening"))
      setMicState("idle", "Didn't catch that. Tap to try again");
  };
  try {
    recog.start();
    setMicState("listening");
  } catch {
    setMicState("idle", "Couldn't start the microphone");
  }
}

function cancelListening() {
  clearTimeout(silenceTimer);
  if (recog) {
    recog.onend = null;
    recog.onresult = null;
    try {
      recog.abort();
    } catch {
      // already stopped
    }
    recog = null;
  }
}

function startCountdown(text) {
  let left = COUNTDOWN_S;
  setMicState("countdown");
  el.countdownLabel.textContent = `Sending in ${left}…`;
  el.countdown.classList.remove("running");
  void el.countdown.offsetWidth;
  el.countdown.classList.add("running");
  el.countdown.focus({ preventScroll: true });
  const tick = () => {
    left -= 1;
    if (left <= 0) {
      countdownTimer = 0;
      el.countdown.classList.remove("running");
      el.driveTranscript.textContent = "";
      setMicState("idle", "Sent. Tap to talk again");
      sendText(text);
      return;
    }
    el.countdownLabel.textContent = `Sending in ${left}…`;
    countdownTimer = setTimeout(tick, 1000);
  };
  countdownTimer = setTimeout(tick, 1000);
}

function cancelCountdown() {
  if (!countdownTimer) return false;
  clearTimeout(countdownTimer);
  countdownTimer = 0;
  el.countdown.classList.remove("running");
  return true;
}

el.mic.addEventListener("click", () => {
  if (recog) recog.stop();
  else startListening();
});
el.countdown.addEventListener("click", () => {
  if (cancelCountdown()) {
    el.driveTranscript.textContent = "";
    setMicState("idle", "Canceled. Tap to talk");
  }
});
el.driveBtn.addEventListener("click", () => setDrive(!S.drive));

// ------------------------------------------------------------------ pictures

const ICON_IMAGE =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="9" cy="10.5" r="1.7" fill="currentColor"/><path d="M4 17.5l4.6-4.4a1.6 1.6 0 0 1 2.2 0l2.4 2.3 2.4-2.1a1.6 1.6 0 0 1 2.1 0L20.5 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>';
const ICON_CLOCK =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** Decrypted pictures by blob id: object URLs for <img>, and the Blobs (for copy and share). */
const picUrls = new Map();
const picBlobs = new Map();
const picMeta = new Map();
const picLoading = new Set();
/** Pictures the relay no longer has (they keep 2 days) or that failed their check: shown as "in Yo". */
const picGone = new Set();
/** Pictures that failed for a passing reason (offline): retried after this time. */
const picRetryAt = new Map();

function picFigure(p) {
  picMeta.set(p.id, p);
  const url = picUrls.get(p.id);
  const alt = escapeHtml(p.alt || "Picture");
  if (!url) {
    if (picGone.has(p.id)) return `<span class="img-missing">${ICON_IMAGE}<span>${alt} · in Yo</span></span>`;
    ensurePic(p);
    return picPlaceholder(p.alt, p.w, p.h);
  }
  return `<figure class="pic"><button class="pic-open" type="button" data-pic="${escapeHtml(p.id)}" aria-label="Open picture: ${alt}"><img src="${escapeHtml(url)}" alt="${alt}" width="${p.w}" height="${p.h}" class="pic-img" decoding="async" /></button><button class="pic-copy" type="button" data-copy-pic="${escapeHtml(p.id)}" aria-label="Copy picture">${ICON_COPY}</button></figure>`;
}

/** A shimmering box the size of the picture to come (an SVG viewBox keeps the shape without inline styles). */
function picPlaceholder(alt, w = 16, h = 10) {
  return `<figure class="pic loading" aria-label="${escapeHtml(alt ? `Loading picture: ${alt}` : "Loading picture")}"><svg class="pic-ph" viewBox="0 0 ${Number(w) || 16} ${Number(h) || 10}" aria-hidden="true"></svg></figure>`;
}

let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (S.auth) renderAll();
  });
}

async function picCache() {
  try {
    return "caches" in window ? await caches.open(PIC_CACHE) : null;
  } catch {
    return null;
  }
}

/** Fetch, decrypt and check one picture (or take it from this phone's cache), then show it. */
async function ensurePic(p) {
  if (picUrls.has(p.id) || picLoading.has(p.id) || picGone.has(p.id)) return;
  if ((picRetryAt.get(p.id) ?? 0) > Date.now()) return;
  picLoading.add(p.id);
  try {
    const cache = await picCache();
    const key = `/__pics/${p.id}`;
    let blob = cache ? await (await cache.match(key))?.blob() : null;
    if (!blob) {
      const { box } = await api("GET", `blob/out?id=${encodeURIComponent(p.id)}`);
      const bytes = await openBlob(S.encKey, box, "out", p.id);
      // The signed message says what the picture is; a blob that doesn't match isn't shown.
      if ((await hashOf(bytes)) !== p.hash) throw Object.assign(new Error("bad picture"), { status: 404 });
      blob = new Blob([bytes], { type: p.mime });
      if (cache) {
        await cache.put(key, new Response(blob, { headers: { "Content-Type": p.mime } })).catch(() => {});
        trimPicCache(cache);
      }
    }
    picBlobs.set(p.id, blob);
    picUrls.set(p.id, URL.createObjectURL(blob));
  } catch (err) {
    if (err?.status === 404 || err?.name === "OperationError") picGone.add(p.id);
    else picRetryAt.set(p.id, Date.now() + 15_000);
  } finally {
    picLoading.delete(p.id);
    renderSoon();
  }
}

async function trimPicCache(cache) {
  try {
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - PIC_CACHE_MAX))) await cache.delete(k);
  } catch {}
}

/** A new link or a turned-off one: the old pictures go too. */
function clearPictures() {
  for (const url of picUrls.values()) URL.revokeObjectURL(url);
  picUrls.clear();
  picBlobs.clear();
  picGone.clear();
  picRetryAt.clear();
  if ("caches" in window) caches.delete(PIC_CACHE).catch(() => {});
}

/** Safari puts only PNG on the clipboard: other pictures go through a canvas. */
async function toPng(blob) {
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png"),
  );
}

function flashCopied(btn) {
  if (!btn) return;
  btn.classList.add("copied");
  const before = btn.innerHTML;
  btn.innerHTML = btn.id === "viewer-copy" ? `${ICON_COPIED}<span>Copied</span>` : ICON_COPIED;
  setTimeout(() => {
    btn.classList.remove("copied");
    btn.innerHTML = before;
  }, 1500);
}

/**
 * Copy the picture itself. The clipboard write starts right in the tap (Safari requires that) with a promise for
 * the PNG. Where pictures can't go on the clipboard, the share sheet (Save Image, Messages…), else a download.
 */
function copyPicture(id, btn) {
  const blob = picBlobs.get(id);
  if (!blob) {
    toast("That picture isn't loaded yet.");
    return;
  }
  if (navigator.clipboard?.write && typeof ClipboardItem === "function") {
    try {
      navigator.clipboard
        .write([new ClipboardItem({ "image/png": toPng(blob) })])
        .then(() => {
          toast("Copied");
          flashCopied(btn);
        })
        .catch(() => sharePicture(id, blob));
      return;
    } catch {
      // fall through to sharing
    }
  }
  sharePicture(id, blob);
}

async function sharePicture(id, blob) {
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[
    blob.type
  ];
  const file = new File([blob], `yo-picture.${ext ?? "jpg"}`, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = picUrls.get(id);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast("Saved");
}

// ------------------------------------------------------------------ picture viewer (pinch to zoom)

const Z = { id: null, scale: 1, x: 0, y: 0, pointers: new Map(), base: null, lastTap: 0, swipe: 0 };

function openViewer(id) {
  const url = picUrls.get(id);
  if (!url) return;
  Z.id = id;
  el.viewerImg.src = url;
  el.viewerImg.alt = picMeta.get(id)?.alt || "Picture";
  el.viewerCaption.textContent = picMeta.get(id)?.alt || "";
  resetZoom();
  el.viewer.showModal();
}
function closeViewer() {
  if (el.viewer.open) el.viewer.close();
}
function resetZoom() {
  Object.assign(Z, { scale: 1, x: 0, y: 0, swipe: 0 });
  applyZoom();
}
function applyZoom(animate = false) {
  el.viewerImg.classList.toggle("animate", animate);
  el.viewerImg.style.transform = `translate3d(${Z.x}px, ${Z.y + Z.swipe}px, 0) scale(${Z.scale})`;
  el.viewer.style.setProperty("--fade", String(Math.max(0.35, 1 - Math.abs(Z.swipe) / 400)));
}
function pointerSnapshot() {
  const pts = [...Z.pointers.values()];
  const mid = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), {
    x: 0,
    y: 0,
  });
  const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
  return { mid, dist, scale: Z.scale, x: Z.x, y: Z.y };
}
el.viewerStage.addEventListener("pointerdown", (e) => {
  el.viewerStage.setPointerCapture?.(e.pointerId);
  Z.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  Z.base = pointerSnapshot();
  if (Z.pointers.size === 1) {
    const now = Date.now();
    if (now - Z.lastTap < 300) {
      // Double tap: zoom in on that spot, or back out.
      const r = el.viewerStage.getBoundingClientRect();
      if (Z.scale > 1.05) resetZoom();
      else {
        const s = 2.5;
        Z.x = (r.width / 2 - (e.clientX - r.left)) * (s - 1);
        Z.y = (r.height / 2 - (e.clientY - r.top)) * (s - 1);
        Z.scale = s;
      }
      applyZoom(true);
      Z.lastTap = 0;
      return;
    }
    Z.lastTap = now;
  }
});
el.viewerStage.addEventListener("pointermove", (e) => {
  if (!Z.pointers.has(e.pointerId) || !Z.base) return;
  Z.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const now = pointerSnapshot();
  if (Z.pointers.size >= 2 && Z.base.dist > 0) {
    Z.scale = Math.min(5, Math.max(1, Z.base.scale * (now.dist / Z.base.dist)));
    Z.x = Z.base.x + (now.mid.x - Z.base.mid.x);
    Z.y = Z.base.y + (now.mid.y - Z.base.mid.y);
  } else if (Z.scale > 1.02) {
    Z.x = Z.base.x + (now.mid.x - Z.base.mid.x);
    Z.y = Z.base.y + (now.mid.y - Z.base.mid.y);
  } else {
    // Not zoomed: drag down to close.
    Z.swipe = Math.max(0, now.mid.y - Z.base.mid.y);
  }
  applyZoom();
});
function pointerEnd(e) {
  Z.pointers.delete(e.pointerId);
  Z.base = Z.pointers.size ? pointerSnapshot() : null;
  if (Z.pointers.size) return;
  if (Z.swipe > 110) {
    closeViewer();
    return;
  }
  if (Z.scale <= 1.02) Object.assign(Z, { scale: 1, x: 0, y: 0 });
  Z.swipe = 0;
  applyZoom(true);
}
el.viewerStage.addEventListener("pointerup", pointerEnd);
el.viewerStage.addEventListener("pointercancel", pointerEnd);
el.viewerClose.addEventListener("click", closeViewer);
el.viewerCopy.addEventListener("click", () => Z.id && copyPicture(Z.id, el.viewerCopy));
el.viewer.addEventListener("close", () => {
  el.viewerImg.removeAttribute("src");
  Z.pointers.clear();
  reloadIfCalm();
});

// ------------------------------------------------------------------ photos from the phone

/** Make a phone photo Yo-sized: JPEG, longest side 1600 px, about a megabyte at most, plus a small thumbnail. */
async function preparePhoto(file) {
  const bmp = await createImageBitmap(file);
  const encode = async (side, quality) => {
    const s = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * s));
    canvas.height = Math.max(1, Math.round(bmp.height * s));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
    return { blob, w: canvas.width, h: canvas.height, canvas };
  };
  let out = await encode(PHOTO_SIDE, 0.82);
  if (out.blob.size > PHOTO_MAX_BYTES) out = await encode(PHOTO_SIDE, 0.68);
  if (out.blob.size > PHOTO_MAX_BYTES) out = await encode(1200, 0.68);
  const thumb = await encode(240, 0.6);
  bmp.close?.();
  const dataUrl = await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.readAsDataURL(thumb.blob);
  });
  return {
    bytes: new Uint8Array(await out.blob.arrayBuffer()),
    mime: "image/jpeg",
    w: out.w,
    h: out.h,
    thumb: dataUrl,
  };
}

function renderTray() {
  el.tray.hidden = !S.photos.length;
  el.tray.innerHTML = S.photos
    .map(
      (p, i) =>
        `<span class="tray-item"><img src="${escapeHtml(p.thumb)}" alt="Photo ${i + 1}" /><button type="button" class="tray-x" data-unpick="${i}" aria-label="Remove photo ${i + 1}"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></button></span>`,
    )
    .join("");
  autosize();
}

el.photoBtn.addEventListener("click", () => {
  if (S.photos.length >= MAX_PHOTOS) {
    toast(`Up to ${MAX_PHOTOS} photos at a time.`);
    return;
  }
  el.photoInput.click();
});
el.photoInput.addEventListener("change", async () => {
  const files = [...(el.photoInput.files ?? [])].slice(0, MAX_PHOTOS - S.photos.length);
  el.photoInput.value = "";
  for (const f of files) {
    try {
      S.photos.push(await preparePhoto(f));
    } catch {
      toast("Couldn't read that photo.");
    }
  }
  renderTray();
});
el.tray.addEventListener("click", (e) => {
  const x = e.target.closest("[data-unpick]");
  if (!x) return;
  S.photos.splice(Number(x.dataset.unpick), 1);
  renderTray();
});

/** What the owner sent: their photos (thumbnails), then the text. */
function meBody(m) {
  const thumbs = (m.thumbs ?? [])
    .filter((t) => typeof t === "string" && t.startsWith("data:image/"))
    .map((t) => `<img class="me-pic" src="${escapeHtml(t)}" alt="Photo" />`)
    .join("");
  const text = m.text ? escapeHtml(m.text) : "";
  return thumbs ? `<span class="me-pics">${thumbs}</span>${text}` : text;
}

// ------------------------------------------------------------------ empty state, pull to refresh, header

el.suggest.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-suggest]");
  if (!chip) return;
  el.input.value = chip.dataset.suggest;
  autosize();
  el.input.focus({ preventScroll: true });
  const end = el.input.value.length;
  el.input.setSelectionRange(end, end);
});

// Pull down at the top of the thread (or the task list) to check for new messages (or tasks) now.
function pullToRefresh(scroller, ptr, refresh) {
  const PULL = { y: null, d: 0, busy: false };
  scroller.addEventListener(
    "touchstart",
    (e) => {
      PULL.y = scroller.scrollTop <= 0 && !PULL.busy ? e.touches[0].clientY : null;
      PULL.d = 0;
    },
    { passive: true },
  );
  scroller.addEventListener(
    "touchmove",
    (e) => {
      if (PULL.y === null) return;
      PULL.d = Math.max(0, e.touches[0].clientY - PULL.y);
      if (PULL.d > 4 && scroller.scrollTop <= 0) {
        const d = Math.min(90, PULL.d * 0.5);
        ptr.classList.add("pulling");
        if (PULL.d > 120 && !ptr.classList.contains("ready")) haptic(6);
        ptr.classList.toggle("ready", PULL.d > 120);
        ptr.style.transform = `translate(-50%, ${d}px) rotate(${PULL.d * 2}deg)`;
      }
    },
    { passive: true },
  );
  scroller.addEventListener("touchend", async () => {
    if (PULL.y === null) return;
    const go = PULL.d > 120;
    PULL.y = null;
    ptr.classList.remove("ready");
    if (!go) {
      ptr.classList.remove("pulling");
      ptr.style.transform = "";
      return;
    }
    PULL.busy = true;
    ptr.classList.add("spinning");
    ptr.style.transform = "";
    await Promise.all([refresh(), new Promise((r) => setTimeout(r, 600))]);
    ptr.classList.remove("spinning", "pulling");
    PULL.busy = false;
  });
}
pullToRefresh(el.log, el.ptr, async () => {
  picRetryAt.clear();
  await Promise.all([poll(), flushQueue()]);
  renderAll();
});
pullToRefresh(el.tasksScroll, el.tasksPtr, async () => {
  await requestTasks(true);
  // The core answers within a poll or two: keep the spinner up for one.
  await new Promise((r) => setTimeout(r, 900));
  await poll();
});

// ------------------------------------------------------------------ settings

el.settingsBtn.addEventListener("click", () => {
  renderPresence();
  resetForget();
  el.settings.showModal();
});
el.settingsClose.addEventListener("click", () => el.settings.close());
el.settings.addEventListener("click", (e) => {
  if (e.target === el.settings) el.settings.close();
});
el.setRead.addEventListener("change", () => {
  S.readAloud = el.setRead.checked;
  save(LS.read, S.readAloud);
  if (S.readAloud && "speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance("Replies will be read aloud.");
    u.lang = navigator.language || "en-US";
    speechSynthesis.speak(u);
  }
});

let forgetArmed = false;
function resetForget() {
  forgetArmed = false;
  el.forget.classList.remove("confirm");
  el.forget.textContent = "Forget this phone";
}
el.forget.addEventListener("click", () => {
  if (!forgetArmed) {
    forgetArmed = true;
    el.forget.classList.add("confirm");
    el.forget.textContent = "Tap again to forget";
    return;
  }
  for (const k of Object.values(LS)) localStorage.removeItem(k);
  stopPolling();
  setDrive(false, { quiet: true });
  Object.assign(S, {
    secret: null,
    auth: null,
    encKey: null,
    admit: null,
    signPub: null,
    messages: [],
    cursor: 0,
    lastN: null,
    agent: "Yo",
    seen: undefined,
    tasks: null,
    caps: [],
  });
  setTab("chat");
  el.thread.innerHTML = "";
  el.settings.close();
  showWelcome();
});

// ------------------------------------------------------------------ service worker

// Updates: a new version's service worker takes over by itself; the app then reloads quietly at a calm moment
// (nothing typed, no photo picked, not in Drive mode or the picture viewer) and says "Updated". The link and
// history stay in localStorage, so there's never anything to pair again.
let updateReady = false;
function reloadIfCalm() {
  if (!updateReady) return;
  if (el.input.value.trim() || S.photos.length || S.drive || el.viewer.open || el.settings.open) return;
  if (S.messages.some((m) => m.st === "sending")) return;
  try {
    sessionStorage.setItem("yo-phone:updated", "1");
  } catch {}
  location.reload();
}
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker
    .register("/sw.js")
    .then((reg) => {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
        else reloadIfCalm();
      });
    })
    .catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return; // the very first install, not an update
    updateReady = true;
    reloadIfCalm();
  });
}

// A link opened in a tab that already has Yo Phone loaded only changes the hash; start over so it's read.
window.addEventListener("hashchange", () => {
  if (/[#&]k=/.test(location.hash)) location.reload();
});

boot();
