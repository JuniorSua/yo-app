// Yo Phone relay: a dumb mailbox for encrypted envelopes (docs/phone/PROTOCOL.md, "v2: admission, roles and
// signatures"). One Vercel Node function for every /api/relay/* route (vercel.json rewrites them here with
// ?route=<rest>). It can't read the envelopes.
//
// Every request is admitted statelessly before any Redis call: the relay recomputes the mailbox id from the bearer
// token and checks X-Yo-Admit (and, for core routes, X-Yo-Core) as HMACs under YO_PHONE_REGISTER_KEY. Per-IP and
// per-box rate limits also run before Redis, with a separate per-box budget for each role, so a flood from a link
// holder can't use up the core's budget. Unregistered mailboxes are never written to.
//
// Redis keys are `yo:phone:<box>:{ok,in,out,outseq,seen}`, plus pictures (v2.1) at `yo:phone:<box>:blob:<dir>:<id>`
// (short TTL, read only while the box is registered) and one global byte counter a day, `yo:phone:blobday:<n>`. The database may be shared with other projects, so this
// never uses KEYS/SCAN/FLUSH and every key it writes gets a TTL.
//
// It also holds Yo's bug mailbox (docs/phone/PROTOCOL.md, "Bug mailbox"): any Yo can POST /api/relay/bugs a bug
// report encrypted to the owner's bug-inbox public key, and only the owner's core (X-Yo-Core for BUGS_BOX) can
// list and ack them. Keys: `yo:bugs:inbox` (a list, 14-day TTL, at most 200 items) and `yo:bugs:day:<n>` (the
// global daily counter). A report costs 3 commands (INCR, RPUSH, LTRIM); an idle poll 1 (LRANGE). Per-IP and
// per-install caps live in memory, so a flood is refused before it reaches Redis. Reports are never logged.

import {
  admitFor,
  BLOB_ID_RE,
  BUGS_BOX,
  boxFor,
  coreCredFor,
  isB64url,
  MIN_ENVELOPE_CHARS,
} from "../lib/crypto.js";
import { upstashFromEnv } from "../lib/upstashStore.js";

export const LIMITS = Object.freeze({
  envelopeChars: 64 * 1024,
  bodyBytes: 64 * 1024 + 1024,
  inWaiting: 100,
  inBatch: 50,
  outKeep: 300,
  ttlSeconds: 30 * 24 * 60 * 60,
  seenSeconds: 600,
  outResponseChars: 1_000_000,
  ipPerMinute: 120,
  /** Per box, for the phone's routes (it polls every 3 s while open, about 20 a minute, plus sends). */
  phonePerMinute: 60,
  /** Per box, for the core's routes (it polls every 1.5 s while a conversation is live, plus posts). */
  corePerMinute: 90,
  rateWindowMs: 60_000,
  rateMaxKeys: 10_000,
  /** Bug mailbox: the whole POST body (an encrypted report of ~450 KB at most, as base64url). */
  bugBodyBytes: 600 * 1024,
  bugKeep: 200,
  bugTtlSeconds: 14 * 24 * 60 * 60,
  /** Per IP (in memory, per function instance). */
  bugsPerIpPerHour: 10,
  /** Per hashed install id (in memory, per function instance). */
  bugsPerInstallPerDay: 20,
  /** Everyone together (one Redis counter a day). */
  bugsPerDay: 300,
  /** Reports per GET (each up to ~600 KB, and Vercel answers at most 4.5 MB). */
  bugBatch: 5,
  bugResponseChars: 3_500_000,
  /** Pictures (blobs, v2.1): one encrypted picture as base64url, about 540 KB of image at most. */
  blobChars: 720_000,
  blobBodyBytes: 730_000,
  /** Core → phone pictures wait 2 days for the phone; phone → core photos 6 hours (core runs a message within 10 min). */
  blobOutTtlSeconds: 2 * 24 * 60 * 60,
  blobInTtlSeconds: 6 * 60 * 60,
  /** Everyone together, per UTC day (one Redis counter): keeps pictures from crowding the shared free database. */
  blobBytesPerDay: 25_000_000,
  /** Per box and direction, per day (in memory, per function instance). */
  blobsPerBoxPerDay: 60,
});

/** The bug mailbox's Redis keys. Not under yo:phone: it isn't a phone mailbox. */
export const BUG_KEYS = Object.freeze({ inbox: "yo:bugs:inbox", dayPrefix: "yo:bugs:day:" });
/** The only fields a bug envelope may have (see validateBugEnvelope). */
const BUG_FIELDS = ["v", "install", "epk", "iv", "ct"];
const BUG_INSTALL_RE = /^[0-9a-f]{32}$/;
const BUG_EPK_RE = /^[A-Za-z0-9_-]{43}$/; // X25519 public key: 32 bytes
const BUG_IV_RE = /^[A-Za-z0-9_-]{16}$/; // AES-GCM iv: 12 bytes
const BUG_ID_RE = /^YO-[A-Z0-9]{6}$/;
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const HOUR_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const REVOKED = "link_revoked";
const CRED_RE = /^[A-Za-z0-9_-]{43}$/; // authToken, admit, coreCred: 32 bytes as base64url
const SIG_RE = /^[A-Za-z0-9_-]{86}$/; // Ed25519 signature: 64 bytes as base64url
const enc = new TextEncoder();

/** Which credential each route needs. Phone routes need admit; core routes need admit + X-Yo-Core. */
export const ROLES = Object.freeze({
  "POST register": "core",
  "DELETE box": "core",
  "GET in": "core",
  "POST in/ack": "core",
  "POST out": "core",
  "POST in": "phone",
  "GET out": "phone",
  // v2.1 pictures: each side writes its own direction and reads the other's
  "POST blob/out": "core",
  "GET blob/in": "core",
  "POST blob/in": "phone",
  "GET blob/out": "phone",
});

/** The global daily byte counter for pictures. Not under a box: it's for the whole relay. */
export const BLOB_DAY_PREFIX = "yo:phone:blobday:";

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Constant-time comparison of two equal-length credential strings. */
function sameCred(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Fixed-window counters held in memory (per function instance). The map is bounded: when it's full, expired
 * windows are dropped first, then the oldest entries.
 */
export function createRateLimiter({ limit, windowMs = LIMITS.rateWindowMs, maxKeys = LIMITS.rateMaxKeys }) {
  const windows = new Map();
  return {
    /** @returns {number} 0 if allowed, else seconds until the window resets (for Retry-After) */
    hit(key, t) {
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        if (w) windows.delete(key);
        if (windows.size >= maxKeys) {
          for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
          for (const k of windows.keys()) {
            if (windows.size < maxKeys) break;
            windows.delete(k);
          }
        }
        w = { count: 0, resetAt: t + windowMs };
        windows.set(key, w);
      }
      w.count += 1;
      return w.count > limit ? Math.max(1, Math.ceil((w.resetAt - t) / 1000)) : 0;
    },
    get size() {
      return windows.size;
    },
  };
}

function clientIp(request) {
  const fwd = request.headers.get("x-forwarded-for");
  const first = fwd?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip")?.trim() || "unknown";
}

function routeOf(url) {
  const fromQuery = url.searchParams.get("route");
  const raw = fromQuery ?? url.pathname.replace(/^\/api\/relay\/?/, "");
  return raw.replace(/^\/+|\/+$/g, "");
}

async function readJson(request, max = LIMITS.bodyBytes) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > max) throw new HttpError(413, "Too large");
  const text = await request.text();
  if (enc.encode(text).length > max) throw new HttpError(413, "Too large");
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}

function envelopeFrom(body) {
  const box = body.box;
  if (typeof box !== "string") throw new HttpError(400, "box must be a string");
  if (box.length > LIMITS.envelopeChars) throw new HttpError(413, "Envelope too large");
  if (box.length < MIN_ENVELOPE_CHARS || !isB64url(box)) throw new HttpError(400, "box must be an envelope");
  return box;
}

/**
 * A bug report as the relay sees it: `{ v: 1, install, epk, iv, ct }` and nothing else. `install` is a hash of
 * the sender's install id (for the per-install cap); the rest is ciphertext only the owner's core can open.
 */
export function validateBugEnvelope(body) {
  const keys = Object.keys(body);
  if (keys.length !== BUG_FIELDS.length || !BUG_FIELDS.every((k) => keys.includes(k)))
    throw new HttpError(400, `A bug report has exactly these fields: ${BUG_FIELDS.join(", ")}`);
  if (body.v !== 1) throw new HttpError(400, "v must be 1");
  if (typeof body.install !== "string" || !BUG_INSTALL_RE.test(body.install))
    throw new HttpError(400, "install must be 32 hex characters");
  if (typeof body.epk !== "string" || !BUG_EPK_RE.test(body.epk))
    throw new HttpError(400, "epk must be a 32-byte key in base64url");
  if (typeof body.iv !== "string" || !BUG_IV_RE.test(body.iv))
    throw new HttpError(400, "iv must be 12 bytes in base64url");
  // At least the 16-byte tag (22 characters).
  if (typeof body.ct !== "string" || body.ct.length < 22 || !isB64url(body.ct))
    throw new HttpError(400, "ct must be base64url");
  return { v: 1, install: body.install, epk: body.epk, iv: body.iv, ct: body.ct };
}

function newReportId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return `YO-${Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("")}`;
}

function nonNegInt(value, name, max = Number.MAX_SAFE_INTEGER) {
  const str = String(value ?? "");
  if (!/^\d{1,16}$/.test(str) || Number(str) > max)
    throw new HttpError(400, `${name} must be a whole number`);
  return Number(str);
}

/**
 * @param {{ kind?: string, pipeline: (cmds: Array<Array<string|number>>) => Promise<any[]> } | null} store
 * @param {{ now?: () => number, registerKey?: string, ipPerMinute?: number, phonePerMinute?: number,
 *   corePerMinute?: number, bugsPerIpPerHour?: number, bugsPerInstallPerDay?: number, bugsPerDay?: number,
 *   blobsPerBoxPerDay?: number, blobBytesPerDay?: number }} [opts]
 *   registerKey: YO_PHONE_REGISTER_KEY, the HMAC key for admit and coreCred
 * @returns {(request: Request) => Promise<Response>}
 */
export function createRelay(store, opts = {}) {
  const now = opts.now ?? Date.now;
  const registerKey = opts.registerKey ?? "";
  const ipLimiter = createRateLimiter({ limit: opts.ipPerMinute ?? LIMITS.ipPerMinute });
  // One budget per role and box: phone traffic (anyone holding the link) can't starve the core's polls.
  const boxLimiters = {
    phone: createRateLimiter({ limit: opts.phonePerMinute ?? LIMITS.phonePerMinute }),
    core: createRateLimiter({ limit: opts.corePerMinute ?? LIMITS.corePerMinute }),
  };

  const tooMany = (retryAfter) =>
    json(429, { error: "Too many requests" }, { "Retry-After": String(retryAfter) });

  // Bug mailbox caps that run before any Redis call (in memory, so per function instance).
  const bugIpLimiter = createRateLimiter({
    limit: opts.bugsPerIpPerHour ?? LIMITS.bugsPerIpPerHour,
    windowMs: HOUR_MS,
  });
  const bugInstallLimiter = createRateLimiter({
    limit: opts.bugsPerInstallPerDay ?? LIMITS.bugsPerInstallPerDay,
    windowMs: DAY_MS,
  });
  const bugsPerDay = opts.bugsPerDay ?? LIMITS.bugsPerDay;
  const blobBoxLimiter = createRateLimiter({
    limit: opts.blobsPerBoxPerDay ?? LIMITS.blobsPerBoxPerDay,
    windowMs: DAY_MS,
  });
  const blobBytesPerDay = opts.blobBytesPerDay ?? LIMITS.blobBytesPerDay;

  /** POST blob/<dir>: store one encrypted picture for the other side to fetch once. */
  const postBlob = (dir) => async (req, k) => {
    const body = await readJson(req, LIMITS.blobBodyBytes);
    const { id, box } = body;
    if (typeof id !== "string" || !BLOB_ID_RE.test(id)) throw new HttpError(400, "id must be a blob id");
    if (typeof box !== "string") throw new HttpError(400, "box must be a string");
    if (box.length > LIMITS.blobChars) throw new HttpError(413, "Picture too large");
    if (box.length < MIN_ENVELOPE_CHARS || !isB64url(box)) throw new HttpError(400, "box must be a blob");
    const t = now();
    const wait = blobBoxLimiter.hit(`${k.prefix}${dir}`, t);
    if (wait) throw new HttpError(429, "Too many pictures today");
    const day = Math.floor(t / DAY_MS);
    const dayKey = `${BLOB_DAY_PREFIX}${day}`;
    const [ok, total] = await store.pipeline([
      ["EXISTS", k.ok],
      ["INCRBY", dayKey, box.length],
      ["EXPIRE", dayKey, 2 * 24 * 60 * 60],
    ]);
    if (Number(ok) !== 1) throw new HttpError(404, REVOKED);
    if (Number(total) > blobBytesPerDay) throw new HttpError(429, "Too many pictures today");
    const ttl = dir === "out" ? LIMITS.blobOutTtlSeconds : LIMITS.blobInTtlSeconds;
    await store.pipeline([["SET", `${k.prefix}blob:${dir}:${id}`, box, "EX", ttl, "NX"]]);
    return json(200, { ok: true });
  };

  /** GET blob/<dir>?id=: one picture the other side stored. Needs the box to still be registered. */
  const getBlob = (dir) => async (_req, k, url) => {
    const id = url.searchParams.get("id") ?? "";
    if (!BLOB_ID_RE.test(id)) throw new HttpError(400, "id must be a blob id");
    const [ok, box] = await store.pipeline([
      ["EXISTS", k.ok],
      ["GET", `${k.prefix}blob:${dir}:${id}`],
    ]);
    if (Number(ok) !== 1) throw new HttpError(404, REVOKED);
    if (typeof box !== "string" || !box) throw new HttpError(404, "gone");
    return json(200, { box });
  };

  const bugRoutes = {
    // any Yo: drop an encrypted report in the owner's mailbox
    "POST bugs": async (req, t) => {
      const ipWait = bugIpLimiter.hit(clientIp(req), t);
      if (ipWait) return tooMany(ipWait);
      const env = validateBugEnvelope(await readJson(req, LIMITS.bugBodyBytes));
      const installWait = bugInstallLimiter.hit(env.install, t);
      if (installWait) return tooMany(installWait);
      const day = Math.floor(t / DAY_MS);
      const dayKey = `${BUG_KEYS.dayPrefix}${day}`;
      const [count] = await store.pipeline([["INCR", dayKey]]);
      if (Number(count) > bugsPerDay) return tooMany(Math.max(1, Math.ceil(((day + 1) * DAY_MS - t) / 1000)));
      const reportId = newReportId();
      const first = Number(count) === 1;
      const cmds = [
        ["RPUSH", BUG_KEYS.inbox, JSON.stringify({ id: reportId, at: t, ...env })],
        ["LTRIM", BUG_KEYS.inbox, -LIMITS.bugKeep, -1],
      ];
      // The day's first report sets the counter's TTL and refreshes the mailbox's, so a report usually costs
      // three commands.
      if (first)
        cmds.push(["EXPIRE", dayKey, 2 * 24 * 60 * 60], ["EXPIRE", BUG_KEYS.inbox, LIMITS.bugTtlSeconds]);
      const [length] = await store.pipeline(cmds);
      // A list this push created has no TTL yet.
      if (!first && Number(length) === 1)
        await store.pipeline([["EXPIRE", BUG_KEYS.inbox, LIMITS.bugTtlSeconds]]);
      return json(200, { ok: true, reportId });
    },
    // the owner's core: the oldest reports (one command)
    "GET bugs": async () => {
      const [raw] = await store.pipeline([["LRANGE", BUG_KEYS.inbox, 0, LIMITS.bugBatch - 1]]);
      const list = Array.isArray(raw) ? raw : [];
      const items = [];
      let size = 0;
      let more = list.length === LIMITS.bugBatch;
      for (const entry of list) {
        let item;
        try {
          item = typeof entry === "string" ? JSON.parse(entry) : entry;
        } catch {
          continue;
        }
        if (typeof item?.id !== "string" || typeof item.ct !== "string") continue;
        if (items.length > 0 && size + item.ct.length > LIMITS.bugResponseChars) {
          more = true;
          break;
        }
        items.push(item);
        size += item.ct.length;
      }
      return json(200, more ? { items, more: true } : { items });
    },
    // the owner's core, after filing: remove these reports (one LRANGE, then one LREM per report)
    "POST bugs/ack": async (req) => {
      const { ids } = await readJson(req);
      if (
        !Array.isArray(ids) ||
        ids.length > LIMITS.bugBatch * 2 ||
        !ids.every((id) => typeof id === "string" && BUG_ID_RE.test(id))
      )
        throw new HttpError(400, "ids must be a list of report ids");
      if (ids.length === 0) return json(200, { ok: true, removed: 0 });
      const [raw] = await store.pipeline([["LRANGE", BUG_KEYS.inbox, 0, LIMITS.bugBatch * 2 - 1]]);
      const want = new Set(ids);
      const rem = [];
      for (const entry of Array.isArray(raw) ? raw : []) {
        // Items are written by "POST bugs" above, so the id is always first.
        const id = /^\{"id":"(YO-[A-Z0-9]{6})"/.exec(String(entry))?.[1];
        if (id && want.has(id)) rem.push(["LREM", BUG_KEYS.inbox, 1, entry]);
      }
      if (rem.length) await store.pipeline(rem);
      return json(200, { ok: true, removed: rem.length });
    },
  };

  /** /api/relay/bugs and bugs/ack. Posting is open to any Yo; listing and acking need the bug core credential. */
  async function bugs(request, key, t) {
    const handler = bugRoutes[key];
    if (!handler) return json(405, { error: "Method not allowed" });
    if (key !== "POST bugs") {
      if (!registerKey) return json(503, { error: "This relay isn't set up yet" });
      const core = request.headers.get("x-yo-core") ?? "";
      if (!CRED_RE.test(core) || !sameCred(core, await coreCredFor(registerKey, BUGS_BOX)))
        return json(401, { error: "Unauthorized" });
      const wait = boxLimiters.core.hit(BUGS_BOX, t);
      if (wait) return tooMany(wait);
    }
    if (!store) return json(503, { error: "The relay has no storage configured" });
    try {
      return await handler(request, t);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      // Only what went wrong with storage: never the request or the report.
      console.error("relay error (bugs):", err instanceof Error ? err.message : "unknown");
      return json(502, { error: "Storage unavailable" });
    }
  }

  const routes = {
    // core, when it pairs and on every start: allow this mailbox to be written for 30 days
    "POST register": async (_req, k) => {
      await store.pipeline([["SET", k.ok, "1", "EX", LIMITS.ttlSeconds]]);
      return json(200, { ok: true });
    },
    // core, when revoking a link: delete everything in the mailbox
    "DELETE box": async (_req, k) => {
      await store.pipeline([["DEL", k.ok, k.in, k.out, k.outseq, k.seen]]);
      return json(200, { ok: true });
    },
    // phone → core
    "POST in": async (req, k) => {
      const box = envelopeFrom(await readJson(req));
      const [ok] = await store.pipeline([["EXISTS", k.ok]]);
      if (Number(ok) !== 1) throw new HttpError(404, REVOKED);
      const [length] = await store.pipeline([
        ["RPUSH", k.in, box],
        ["EXPIRE", k.in, LIMITS.ttlSeconds],
      ]);
      if (Number(length) > LIMITS.inWaiting) {
        // Over the cap: take ours back off the tail. Concurrent over-cap pushes each pop one, so the list
        // settles at the cap.
        await store.pipeline([["RPOP", k.in]]);
        throw new HttpError(429, "Too many messages waiting");
      }
      return json(200, { ok: true });
    },
    // core reads its inbox (and optionally says it's alive)
    "GET in": async (_req, k, url) => {
      const beat = url.searchParams.get("beat") === "1";
      // A plain poll is one command. It needs no registration check: `in` can only hold items if the box is
      // registered (POST in requires ok), so an unregistered box just reads as empty and nothing is written.
      // Beats also check `ok`, so the core notices a lost registration within one beat.
      const range = ["LRANGE", k.in, 0, LIMITS.inBatch - 1];
      const [first, second] = await store.pipeline(beat ? [["EXISTS", k.ok], range] : [range]);
      const items = beat ? second : first;
      if (beat && Number(first) !== 1) throw new HttpError(404, REVOKED);
      if (beat) {
        const t = now();
        const [prevSeen] = await store.pipeline([
          ["SET", k.seen, String(t), "EX", LIMITS.seenSeconds, "GET"],
        ]);
        // Keep a live mailbox alive. To save commands this runs on the first beat of each UTC day, or the first
        // beat after the core was offline for 10+ minutes, rather than on every beat.
        const prev = Number(prevSeen);
        if (!prevSeen || !Number.isFinite(prev) || Math.floor(prev / DAY_MS) !== Math.floor(t / DAY_MS)) {
          await store.pipeline([
            ["EXPIRE", k.ok, LIMITS.ttlSeconds],
            ["EXPIRE", k.in, LIMITS.ttlSeconds],
            ["EXPIRE", k.out, LIMITS.ttlSeconds],
            ["EXPIRE", k.outseq, LIMITS.ttlSeconds],
          ]);
        }
      }
      return json(200, { items: Array.isArray(items) ? items : [] });
    },
    "POST in/ack": async (req, k) => {
      const body = await readJson(req);
      const count = nonNegInt(body.count, "count", LIMITS.inWaiting);
      if (count > 0) await store.pipeline([["LTRIM", k.in, count, -1]]);
      return json(200, { ok: true });
    },
    // core → phone: every item carries the core's Ed25519 signature, which the phone checks before decrypting
    "POST out": async (req, k) => {
      const body = await readJson(req);
      const box = envelopeFrom(body);
      if (typeof body.sig !== "string" || !SIG_RE.test(body.sig)) {
        throw new HttpError(400, "sig must be a 64-byte Ed25519 signature in base64url");
      }
      const [ok] = await store.pipeline([["EXISTS", k.ok]]);
      if (Number(ok) !== 1) throw new HttpError(404, REVOKED);
      const [seq] = await store.pipeline([
        ["INCR", k.outseq],
        ["EXPIRE", k.outseq, LIMITS.ttlSeconds],
      ]);
      const n = Number(seq);
      await store.pipeline([
        ["RPUSH", k.out, JSON.stringify({ seq: n, box, sig: body.sig })],
        ["LTRIM", k.out, -LIMITS.outKeep, -1],
        ["EXPIRE", k.out, LIMITS.ttlSeconds],
      ]);
      return json(200, { seq: n });
    },
    "GET out": async (_req, k, url) => {
      const after = nonNegInt(url.searchParams.get("after") ?? "0", "after");
      const [ok, raw, seenRaw] = await store.pipeline([
        ["EXISTS", k.ok],
        ["LRANGE", k.out, -LIMITS.outKeep, -1],
        ["GET", k.seen],
      ]);
      if (Number(ok) !== 1) throw new HttpError(404, REVOKED);
      const all = [];
      for (const entry of Array.isArray(raw) ? raw : []) {
        try {
          const item = typeof entry === "string" ? JSON.parse(entry) : entry;
          if (Number.isSafeInteger(item?.seq) && typeof item.box === "string")
            all.push({ seq: item.seq, box: item.box, sig: typeof item.sig === "string" ? item.sig : null });
        } catch {
          // skip a corrupt entry rather than failing the whole poll
        }
      }
      all.sort((a, b) => a.seq - b.seq);
      const seenNum = seenRaw == null ? null : Number(seenRaw);
      const seen = Number.isFinite(seenNum) ? seenNum : null;
      // If every stored seq is below the phone's cursor, the mailbox expired and the counter restarted. Hand back
      // everything with `reset: true` so the phone can rewind its cursor.
      const maxSeq = all.reduce((m, i) => Math.max(m, i.seq), 0);
      const reset = after > 0 && all.length > 0 && maxSeq < after;
      const pending = reset ? all : all.filter((i) => i.seq > after);
      // At most ~1 MB of envelopes per response, oldest first; `more: true` asks the phone to fetch again.
      const items = [];
      let size = 0;
      for (const item of pending) {
        if (items.length > 0 && size + item.box.length > LIMITS.outResponseChars) break;
        items.push(item);
        size += item.box.length;
      }
      const res = { items, seen };
      if (reset) res.reset = true;
      if (items.length < pending.length) res.more = true;
      return json(200, res);
    },
    "POST blob/out": postBlob("out"),
    "GET blob/out": getBlob("out"),
    "POST blob/in": postBlob("in"),
    "GET blob/in": getBlob("in"),
  };

  return async function relay(request) {
    let url;
    try {
      url = new URL(request.url, "http://localhost");
    } catch {
      return json(400, { error: "Bad URL" });
    }
    const route = routeOf(url);
    const method = request.method.toUpperCase();

    if (route === "health") {
      if (method !== "GET") return json(405, { error: "Method not allowed" });
      return json(200, { ok: true, store: store ? (store.kind ?? "upstash") : "missing" });
    }

    // Everything below happens before any storage call.
    const t = now();
    const ipWait = ipLimiter.hit(clientIp(request), t);
    if (ipWait) return tooMany(ipWait);

    if (route === "bugs" || route === "bugs/ack") return bugs(request, `${method} ${route}`, t);

    const auth = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
    const token = auth?.[1];
    if (!token || !CRED_RE.test(token)) return json(401, { error: "Unauthorized" });
    if (!registerKey) return json(503, { error: "This relay isn't set up yet" });

    const box = await boxFor(token);
    const admit = request.headers.get("x-yo-admit") ?? "";
    if (!CRED_RE.test(admit) || !sameCred(admit, await admitFor(registerKey, box))) {
      return json(401, { error: "Unauthorized" });
    }

    const key = `${method} ${route}`;
    const role = ROLES[key];
    if (!role) {
      const known = Object.keys(ROLES).some((r) => r.endsWith(` ${route}`));
      return json(known ? 405 : 404, { error: known ? "Method not allowed" : "Not found" });
    }
    if (role === "core") {
      const core = request.headers.get("x-yo-core") ?? "";
      if (!CRED_RE.test(core) || !sameCred(core, await coreCredFor(registerKey, box))) {
        return json(401, { error: "Unauthorized" });
      }
    }

    const boxWait = boxLimiters[role].hit(box, t);
    if (boxWait) return tooMany(boxWait);
    if (!store) return json(503, { error: "The relay has no storage configured" });

    const prefix = `yo:phone:${box}:`;
    const keys = {
      prefix,
      ok: `${prefix}ok`,
      in: `${prefix}in`,
      out: `${prefix}out`,
      outseq: `${prefix}outseq`,
      seen: `${prefix}seen`,
    };
    try {
      return await routes[key](request, keys, url);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error("relay error:", err);
      return json(502, { error: "Storage unavailable" });
    }
  };
}

let envRelay;
function fromEnv() {
  envRelay ??= createRelay(upstashFromEnv(process.env), { registerKey: process.env.YO_PHONE_REGISTER_KEY });
  return envRelay;
}

// Vercel Node runtime, Web-standard handlers.
export function GET(request) {
  return fromEnv()(request);
}
export function POST(request) {
  return fromEnv()(request);
}
export function DELETE(request) {
  return fromEnv()(request);
}
