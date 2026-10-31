/**
 * Yo Phone: the crypto against the phone's test vector, and PhoneChannel against an in-memory relay (the routes
 * in docs/phone/PROTOCOL.md), a real Store/Hub and a fake orchestrator.
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Decision, MORNING_BRIEF_FRAME, newId, type PendingRequest } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  briefFallbackText,
  fitTasks,
  MAX_OUT_JSON_BYTES,
  PhoneChannel,
  type PhoneOut,
  type PhoneTask,
} from "../src/channels/phone";
import {
  admitFor,
  boxOf,
  coreCredFor,
  deriveKeys,
  fromBase64Url,
  importSignKey,
  open,
  openBlob,
  type PhoneKeys,
  randomSecret,
  seal,
  sealBlob,
  signOut,
  toBase64Url,
} from "../src/channels/phoneCrypto";
import { openMemoryDb } from "../src/db/db";
import { Store } from "../src/db/store";
import { Hub } from "../src/hub";
import { redact } from "../src/log";
import type { TurnEvent } from "../src/orchestrator/Orchestrator";
import { MemorySecretStore } from "../src/secrets/SecretStore";

const here = path.dirname(fileURLToPath(import.meta.url));
const VECTOR = path.resolve(here, "..", "..", "..", "phone", "test", "vector.json");
const RELAY = "https://relay.test";
const REG_KEY = "relay-register-key-for-tests-0123456789";

async function until(fn: () => boolean, ms = 3000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/* ------------------------------- crypto -------------------------------- */

describe("phone crypto", () => {
  const vectorFile = fs.existsSync(VECTOR);

  it.skipIf(!vectorFile)("matches phone/test/vector.json (the phone's canonical values)", async () => {
    const v = JSON.parse(fs.readFileSync(VECTOR, "utf8"));
    const keys = await deriveKeys(v.secret);
    expect(keys.authToken).toBe(v.authToken);
    expect(createHash("sha256").update(keys.authToken).digest("hex")).toBe(v.box);
    expect(await open(keys, v.envelope, v.dir)).toEqual(v.plaintext);
    await expect(open(keys, v.envelope, v.dir === "in" ? "out" : "in")).rejects.toThrow();
    // Same iv, same JSON: the same bytes as the phone.
    expect(JSON.stringify(v.plaintext)).toBe(v.plaintextJson);
    expect(await seal(keys, v.plaintext, v.dir, fromBase64Url(v.iv))).toBe(v.envelope);
  });

  it.skipIf(!vectorFile)(
    "matches the v2 admission, core credential, signature and link in vector.json",
    async () => {
      const v = JSON.parse(fs.readFileSync(VECTOR, "utf8"));
      expect(v.signPub, "vector.json has no v2 fields yet").toBeTruthy();
      expect(await boxOf(v.authToken)).toBe(v.box);
      expect(await admitFor(v.registerKey, v.box)).toBe(v.admit);
      expect(await coreCredFor(v.registerKey, v.box)).toBe(v.coreCred);
      // The fixed PKCS8 key's public half is the link's `p`.
      const pub = createPublicKey(
        createPrivateKey({ key: Buffer.from(fromBase64Url(v.signPkcs8)), format: "der", type: "pkcs8" }),
      ).export({ format: "jwk" }).x;
      expect(pub).toBe(v.signPub);
      // Ed25519 is deterministic: the same signature over the vector's envelope, with the same domain prefix.
      expect(v.sigMessage).toBe(`yo-phone/v1/out\n${v.envelope}`);
      expect(await signOut(await importSignKey(v.signPkcs8), v.envelope)).toBe(v.sig);
      expect(`https://yo-phone.vercel.app/#k=${v.secret}&a=${v.admit}&p=${v.signPub}`).toBe(v.link);
    },
  );

  it.runIf(!vectorFile)(
    "phone/test/vector.json is missing (the phone side writes it), so the vector test is skipped",
    () => {
      console.warn(`SKIPPED: ${VECTOR} not found; the cross-implementation vector test didn't run.`);
    },
  );

  it("derives a 43-char auth token and round-trips envelopes one way only", async () => {
    const secret = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i));
    expect(secret).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    const keys = await deriveKeys(secret);
    expect(keys.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await deriveKeys(secret)).authToken).toBe(keys.authToken);
    const env = await seal(keys, { v: 1, t: "msg", id: "a", text: "héllo 👋" }, "in");
    expect(await open(keys, env, "in")).toEqual({ v: 1, t: "msg", id: "a", text: "héllo 👋" });
    await expect(open(keys, env, "out")).rejects.toThrow();
    const other = await deriveKeys(randomSecret());
    await expect(open(other, env, "in")).rejects.toThrow();
    expect(randomSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(deriveKeys("short")).rejects.toThrow(/32 bytes/);
  });
});

/* ----------------------------- fake relay ------------------------------ */

type Box = {
  in: string[];
  out: { seq: number; box: string; sig: string }[];
  seq: number;
  seen: number | null;
};

const hmac64 = (key: string, msg: string) => createHmac("sha256", key).update(msg).digest("base64url");

/**
 * The relay's v2 routes over an in-memory store, keyed by mailbox like the real one: every call needs the token and
 * the link's admit; core routes also need the core credential (both HMACs of the register key).
 */
class FakeRelay {
  boxes = new Map<string, Box>();
  /** Mailboxes core registered (only these accept writes). */
  registered = new Set<string>();
  calls: { method: string; path: string; beat: boolean; box: string; host: string; status?: number }[] = [];
  down = false;
  /** DELETE /box fails while set (to test revoke retries). */
  deleteFails = false;
  /** null: the relay has no register key (503). */
  registerKey: string | null = REG_KEY;
  /** Pictures: `<box>:blob/<dir>:<id>` -> blob. `blobRoutes = false` acts like a relay from before v2.1. */
  blobs = new Map<string, string>();
  blobRoutes = true;

  static id(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  private box(id: string) {
    let b = this.boxes.get(id);
    if (!b) {
      b = { in: [], out: [], seq: 0, seen: null };
      this.boxes.set(id, b);
    }
    return b;
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const p = url.pathname.replace(/^\/api\/relay\//, "");
    const headers = new Headers(init?.headers);
    const auth = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(headers.get("authorization") ?? "");
    const id = auth ? FakeRelay.id(auth[1]!) : "";
    const call: (typeof this.calls)[number] = {
      method,
      path: p,
      beat: url.searchParams.get("beat") === "1",
      box: id,
      host: url.host,
    };
    this.calls.push(call);
    if (this.down) throw new TypeError("fetch failed");
    const json = (body: unknown, status = 200) => {
      call.status = status;
      return new Response(JSON.stringify(body), { status });
    };
    if (!this.registerKey) return json({ error: "no key" }, 503);
    if (!auth) return json({ error: "unauthorized" }, 401);
    if (headers.get("x-yo-admit") !== hmac64(this.registerKey, `yo-phone/v1/admit\n${id}`))
      return json({ error: "unauthorized" }, 401);
    const phoneRoute =
      (method === "POST" && (p === "in" || p === "blob/in")) ||
      (method === "GET" && (p === "out" || p === "blob/out"));
    if (!phoneRoute && headers.get("x-yo-core") !== hmac64(this.registerKey, `yo-phone/v1/core\n${id}`))
      return json({ error: "unauthorized" }, 401);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "POST" && p === "register") {
      this.registered.add(id);
      return json({ ok: true });
    }
    if (method === "DELETE" && p === "box") {
      if (this.deleteFails) return json({ error: "boom" }, 500);
      this.registered.delete(id);
      this.boxes.delete(id);
      return json({ ok: true });
    }
    if (!this.registered.has(id)) return json({ error: "link_revoked" }, 404);
    const b = this.box(id);
    if (method === "GET" && p === "in") {
      if (url.searchParams.get("beat") === "1") b.seen = Date.now();
      return json({ items: b.in.slice(0, 50) });
    }
    if (method === "POST" && p === "in/ack") {
      b.in.splice(0, body.count);
      return json({ ok: true });
    }
    if (method === "POST" && p === "in") {
      b.in.push(body.box);
      return json({ ok: true });
    }
    if (method === "POST" && p === "out") {
      b.out.push({ seq: ++b.seq, box: body.box, sig: body.sig });
      return json({ seq: b.seq });
    }
    // v2.1 pictures (an older relay has no such routes: 404)
    if (this.blobRoutes && p.startsWith("blob/")) {
      const key = `${id}:${p}:${method === "POST" ? body.id : url.searchParams.get("id")}`;
      if (method === "POST") {
        this.blobs.set(key, body.box);
        return json({ ok: true });
      }
      const blob = this.blobs.get(key);
      return blob ? json({ box: blob }) : json({ error: "gone" }, 404);
    }
    return json({ error: "not found" }, 404);
  }) as typeof fetch;

  get polls() {
    return this.calls.filter((c) => c.method === "GET" && c.path === "in");
  }
  of(method: string, path: string) {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }
}

/** The phone side of a v2 link: sends `in` messages and reads (signature-checked) `out` ones. */
class FakePhone {
  private constructor(
    private relay: FakeRelay,
    readonly keys: PhoneKeys,
    readonly admit: string,
    readonly signPub: string,
  ) {}
  static async open(relay: FakeRelay, link: string) {
    const m = /#k=([A-Za-z0-9_-]{43})&a=([A-Za-z0-9_-]{43})&p=([A-Za-z0-9_-]{43})$/.exec(link);
    if (!m) throw new Error(`bad link ${link}`);
    return new FakePhone(relay, await deriveKeys(m[1]!), m[2]!, m[3]!);
  }
  private read = 0;
  /** Seal a message as the phone would (msg gets a fresh `at`). */
  async envelope(m: Record<string, unknown>) {
    return seal(
      this.keys,
      { v: 1, id: newId("pm"), ...(m.t === "msg" ? { at: Date.now() } : {}), ...m },
      "in",
    );
  }
  async send(m: Record<string, unknown>) {
    const box = await this.envelope(m);
    const res = await this.relay.fetch(`${RELAY}/api/relay/in`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.keys.authToken}`, "x-yo-admit": this.admit },
      body: JSON.stringify({ box }),
    });
    return { box, status: res.status };
  }
  get mailbox() {
    return this.relay.boxes.get(FakeRelay.id(this.keys.authToken));
  }
  /** Whether core signed this out item with the link's key. */
  verified(o: { box: string; sig: string }) {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: this.signPub }, format: "jwk" });
    return (
      !!o.sig && verify(null, Buffer.from(`yo-phone/v1/out\n${o.box}`), key, Buffer.from(o.sig, "base64url"))
    );
  }
  /** Every out message so far, as `{ n, ...message }` (each must carry a good signature). */
  async raw(): Promise<(PhoneOut & { n: number })[]> {
    const items = this.mailbox?.out ?? [];
    for (const o of items) if (!this.verified(o)) throw new Error("an out item has a bad signature");
    return Promise.all(items.map((o) => open(this.keys, o.box, "out") as Promise<PhoneOut & { n: number }>));
  }
  /** Every out message so far. Like the phone, it insists the counter `n` goes up, then leaves it out. */
  async all(): Promise<PhoneOut[]> {
    let last = Number.NEGATIVE_INFINITY;
    return (await this.raw()).map(({ n, ...m }) => {
      if (!Number.isSafeInteger(n) || n <= last)
        throw new Error(`out counter didn't go up: ${last} then ${n}`);
      last = n;
      return m as PhoneOut;
    });
  }
  /** Out messages since the last call. */
  async next(): Promise<PhoneOut[]> {
    const all = await this.all();
    const fresh = all.slice(this.read);
    this.read = all.length;
    return fresh;
  }
}

/* ------------------------------ fixtures ------------------------------- */

let store: Store;
let hub: Hub;
let relay: FakeRelay;
let secrets: MemorySecretStore;
let channel: PhoneChannel;
let orch: ReturnType<typeof fakeOrchestrator>;
let primaryId: string;

/**
 * Turns like the real Orchestrator: one runs at a time per agent; a message sent meanwhile waits in "Up next"
 * (`queuedId`) and gets its turnId when it starts. Watchers hear `started` (synchronously, before send returns)
 * and `ended`.
 */
function fakeOrchestrator() {
  const watchers = new Set<(e: TurnEvent) => void>();
  const emit = (e: TurnEvent) => {
    for (const w of watchers) w(e);
  };
  const o = {
    sent: [] as { agentId: string; text: string }[],
    sentOpts: [] as unknown[],
    sentAtt: [] as unknown[],
    responded: [] as {
      agentId: string;
      requestId: string;
      decision: Decision;
      answers?: Record<string, string>;
      message?: string;
    }[],
    interrupted: [] as string[],
    running: null as string | null,
    queue: [] as { queuedId: string; agentId: string; text: string }[],
    onTurn: (cb: (e: TurnEvent) => void) => {
      watchers.add(cb);
      return () => watchers.delete(cb);
    },
    start(agentId: string, queuedId?: string) {
      const turnId = newId("trn");
      o.running = turnId;
      emit({ type: "started", agentId, turnId, ...(queuedId ? { queuedId } : {}) });
      return turnId;
    },
    /** A turn the owner started in Yo. */
    startMac: () => o.start(primaryId),
    /** End the running turn (and start the next queued one, like the real thing). */
    finish(status = "completed", error?: string) {
      const turnId = o.running!;
      o.running = null;
      emit({ type: "ended", agentId: primaryId, turnId, status, ...(error ? { error } : {}) });
      const next = o.queue.shift();
      if (next) o.start(next.agentId, next.queuedId);
      return turnId;
    },
    /** The owner steers a message of their own into the running turn. */
    steerOwner() {
      emit({ type: "steered", agentId: primaryId, turnId: o.running!, queuedId: newId("qmsg") });
    },
    send: async (
      agentId: string,
      text: string,
      att?: unknown,
      _trigger?: unknown,
      _label?: unknown,
      _route?: unknown,
      opts?: unknown,
    ) => {
      o.sent.push({ agentId, text });
      o.sentAtt.push(att);
      o.sentOpts.push(opts);
      if (o.running) {
        const queuedId = newId("qmsg");
        o.queue.push({ queuedId, agentId, text });
        return { turnId: "queued", queuedId };
      }
      return { turnId: o.start(agentId) };
    },
    respond: async (
      agentId: string,
      requestId: string,
      decision: Decision,
      answers?: Record<string, string>,
      message?: string,
    ) => {
      const e = store.pendingRequests().find((x) => x.request?.requestId === requestId);
      if (!e) throw new Error("This request is no longer pending.");
      o.responded.push({ agentId, requestId, decision, answers, message });
      const done = store.setRequestStatus(
        e.id,
        decision === "deny" ? "denied" : answers ? "answered" : "allowed",
      );
      hub.push("timeline.upsert", done!);
    },
    interrupt: async (agentId: string) => {
      o.interrupted.push(agentId);
      if (o.running) o.finish("interrupted");
    },
    pendingRequestEntries: () => store.pendingRequests(),
  };
  return o;
}

function makeChannel(extra: Partial<ConstructorParameters<typeof PhoneChannel>[0]> = {}) {
  return new PhoneChannel({
    store,
    hub,
    orchestrator: orch,
    secrets,
    relayUrl: RELAY,
    fetch: relay.fetch,
    idlePollMs: 5,
    fastPollMs: 5,
    beatEveryMs: 60_000,
    maxBackoffMs: 20,
    revokeRetryMs: 10,
    sleep: (ms, signal) =>
      new Promise((r) => {
        const t = setTimeout(r, Math.min(ms, 30));
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          r();
        });
      }),
    ...extra,
  });
}

/** A pending request card in `turnId` (null: outside any turn). */
function addRequest(
  request: Omit<PendingRequest, "requestId"> & { requestId?: string },
  opts: { toolName?: string; turnId?: string | null } = {},
) {
  const req = { requestId: request.requestId ?? newId("call"), ...request };
  const entry = store.upsertEntry({
    id: newId("req"),
    agentId: primaryId,
    turnId: opts.turnId === undefined ? orch.running : opts.turnId,
    item: { id: newId("itm"), kind: "tool", status: "running", title: req.title, toolName: opts.toolName },
    request: { ...req, status: "pending" },
  });
  hub.push("timeline.upsert", entry);
  return entry;
}

function assistant(text: string, turnId = orch.running) {
  return store.upsertEntry({
    id: newId("ast"),
    agentId: primaryId,
    turnId,
    item: { id: newId("itm"), kind: "assistant_message", status: "completed", text },
  });
}

/** Save the relay key and pair; return the phone holding the link. */
async function pairPhone() {
  await channel.api["channels.phone.configure"]({ registerKey: REG_KEY });
  const { link } = await channel.api["channels.phone.pair"]({});
  return FakePhone.open(relay, link);
}

/** Wait until the phone's `in` box is empty (polled and acked) and everything queued is posted. */
async function delivered(phone: FakePhone) {
  await until(() => (phone.mailbox?.in.length ?? 0) === 0, 3000, "ack");
  await channel.idle();
}

/** The phone sends a message and Yo takes it (it's acked). */
async function text(phone: FakePhone, t: string) {
  const n = orch.sent.length;
  await phone.send({ t: "msg", text: t });
  await until(() => orch.sent.length === n + 1, 3000, "send");
  await delivered(phone);
}

beforeEach(() => {
  store = new Store(openMemoryDb());
  hub = new Hub();
  relay = new FakeRelay();
  secrets = new MemorySecretStore();
  orch = fakeOrchestrator();
  primaryId = store.createAgent({
    name: "Yo",
    role: "",
    instructions: "",
    avatar: { shape: "bubble", color: "yo", eyes: "capsule", accessory: "none" },
    accountId: null,
    model: null,
    effort: null,
    runtimeMode: "full-access",
    isPrimary: true,
    pinned: true,
  }).id;
  channel = makeChannel();
});

afterEach(async () => {
  await channel.stop();
});

/* -------------------------------- tests -------------------------------- */

describe("phone channel", () => {
  it("does nothing until a phone link is made", async () => {
    await channel.start();
    orch.startMac();
    addRequest({ kind: "tool_approval", title: "Buy milk", toolName: "yo:purchase" });
    orch.finish();
    await new Promise((r) => setTimeout(r, 30));
    expect(relay.calls).toEqual([]);
    expect(channel.status()).toMatchObject({
      enabled: false,
      link: null,
      polling: false,
      relayUrl: RELAY,
      registerKeySet: false,
    });
  });

  it("needs the relay key to make a link; the key is write-only and kept out of logs", async () => {
    await expect(channel.api["channels.phone.pair"]({})).rejects.toThrow(
      /isn't available on this copy of Yo yet/,
    );
    expect(await secrets.get("phone-link-secret")).toBeNull();
    const s = await channel.api["channels.phone.configure"]({ registerKey: REG_KEY });
    expect(s.registerKeySet).toBe(true);
    expect(JSON.stringify(s)).not.toContain(REG_KEY);
    expect(await secrets.get("phone-register-key")).toBe(REG_KEY);
    expect(redact(`key ${REG_KEY}`)).not.toContain(REG_KEY);
    // A fresh channel (a restart) knows it's set without being told again.
    const again = makeChannel();
    expect((await again.api["channels.phone.status"]({})).registerKeySet).toBe(true);
    await again.stop();

    relay.registerKey = "a-different-key-the-relay-expects-000";
    await expect(channel.api["channels.phone.pair"]({})).rejects.toThrow(/didn't accept Yo's relay key/);
    relay.registerKey = null;
    await expect(channel.api["channels.phone.pair"]({})).rejects.toThrow(/no register key/);
    expect(channel.status().enabled).toBe(false);

    expect((await channel.api["channels.phone.configure"]({ registerKey: null })).registerKeySet).toBe(false);
    expect(await secrets.get("phone-register-key")).toBeNull();
  });

  it("pairs: registers the box, keeps the secret out of KV and logs, and polls with a beat", async () => {
    const phone = await pairPhone();
    const secret = await secrets.get("phone-link-secret");
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { link } = channel.status();
    // v2: the secret, the relay admit (an HMAC of the relay key) and the link's signing key.
    expect(link).toBe(`${RELAY}/#k=${secret}&a=${phone.admit}&p=${phone.signPub}`);
    const sign = JSON.parse((await secrets.get("phone-sign-key"))!);
    expect(sign.pub).toBe(phone.signPub);
    expect(redact(`oops ${sign.pkcs8}`)).not.toContain(sign.pkcs8);
    expect(JSON.stringify(store.getKv("_phone"))).not.toContain(sign.pkcs8);
    // The core credential never goes in the link.
    expect(link).not.toContain(hmac64(REG_KEY, `yo-phone/v1/core\n${FakeRelay.id(phone.keys.authToken)}`));
    expect(relay.registered.has(FakeRelay.id(phone.keys.authToken))).toBe(true);
    expect(JSON.stringify(store.getKv("_phone"))).not.toContain(secret);
    expect(redact(`oops ${secret}`)).not.toContain(secret);
    expect(redact(`Bearer ${phone.keys.authToken}`)).not.toContain(phone.keys.authToken);
    await until(() => relay.polls.length >= 3, 3000, "polls");
    expect(relay.polls.map((c) => c.beat).slice(0, 3)).toEqual([true, false, false]);
    expect(channel.status()).toMatchObject({ enabled: true, link, polling: true, lastPhoneAt: null });
  });

  it("starts polling on boot when a link was saved, and asks for a new link if it's a v1 one", async () => {
    const phone = await pairPhone();
    await channel.stop();
    relay.calls = [];
    channel = makeChannel();
    await channel.start();
    await until(() => relay.polls.length > 0, 3000, "first poll");
    expect(channel.status()).toMatchObject({ polling: true, link: expect.stringContaining(phone.signPub) });

    // A link saved by the first version (no signing key): no polling, and a clear message.
    await channel.stop();
    await secrets.delete("phone-sign-key");
    await secrets.set("phone-link-secret", randomSecret());
    relay.calls = [];
    channel = makeChannel();
    await channel.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(relay.calls).toEqual([]);
    expect(channel.status().lastError).toMatch(/older version/);
  });

  it("msg → orchestrator.send → ack, working status, then the turn's reply", async () => {
    const phone = await pairPhone();
    await phone.send({ t: "hello", device: "iPhone · Safari" });
    await phone.send({ t: "msg", id: "m1", text: "  what's up  ", at: Date.now() });
    await until(() => orch.sent.length === 1, 3000, "send");
    await delivered(phone);
    expect(orch.sent).toEqual([{ agentId: primaryId, text: "what's up" }]);
    const out = await phone.next();
    expect(out[0]).toMatchObject({ t: "hello", agent: { name: "Yo" } });
    expect(out).toContainEqual(expect.objectContaining({ t: "ack", ids: expect.arrayContaining(["m1"]) }));
    expect(out).toContainEqual({ v: 1, t: "status", agent: "Yo", state: "working" });
    expect(channel.status()).toMatchObject({ device: "iPhone · Safari" });

    const a = assistant("Not much!");
    orch.finish();
    await channel.idle();
    expect(await phone.next()).toEqual([
      { v: 1, t: "reply", id: a.id, agent: "Yo", text: "Not much!", at: expect.any(Number) },
      { v: 1, t: "status", agent: "Yo", state: "idle" },
    ]);

    // A turn started at the Mac is not forwarded.
    orch.startMac();
    assistant("desk reply");
    orch.finish();
    await channel.idle();
    expect(await phone.next()).toEqual([]);
  });

  it("routes replies by turn: a queued phone message gets its own reply, not the Mac turn's", async () => {
    const phone = await pairPhone();
    const mac = orch.startMac();
    await text(phone, "and then?");
    expect(await phone.all()).toContainEqual({ v: 1, t: "status", agent: "Yo", state: "queued" });
    await phone.next();
    // The owner's turn ends with its own reply: nothing for the phone. Then the queued message starts.
    assistant("private answer for the owner", mac);
    orch.finish();
    await channel.idle();
    const mid = await phone.next();
    expect(mid).toEqual([{ v: 1, t: "status", agent: "Yo", state: "working" }]);
    const phoneTurn = orch.running!;
    const a = assistant("answer for the phone", phoneTurn);
    orch.finish();
    await channel.idle();
    const end = await phone.next();
    expect(end.filter((o) => o.t === "reply")).toEqual([
      { v: 1, t: "reply", id: a.id, agent: "Yo", text: "answer for the phone", at: expect.any(Number) },
    ]);
    expect(JSON.stringify(await phone.all())).not.toContain("private answer");
  });

  it("caps long replies and forwards failures of the phone's turn", async () => {
    const phone = await pairPhone();
    await text(phone, "essay");
    await text(phone, "again");
    await phone.next();
    assistant("x".repeat(20_000));
    orch.finish();
    orch.finish("failed", "It broke");
    await channel.idle();
    const out = await phone.next();
    const reply = out.find((o) => o.t === "reply") as Extract<PhoneOut, { t: "reply" }>;
    expect(reply.text.length).toBeLessThanOrEqual(16_000);
    expect(reply.text.endsWith("… the rest is in Yo.")).toBe(true);
    expect(out).toContainEqual({ v: 1, t: "error", agent: "Yo", text: "It broke" });
    // A Mac turn's failure isn't the phone's.
    orch.startMac();
    orch.finish("failed", "owner's problem");
    await channel.idle();
    expect(await phone.next()).toEqual([]);
  });

  it("dedupes message ids across restarts (persisted) but still acks them", async () => {
    const phone = await pairPhone();
    const { box } = await phone.send({ t: "msg", id: "dup", text: "once" });
    await until(() => orch.sent.length === 1, 3000, "send");
    await delivered(phone);
    expect(store.getKv<{ seen: string[] }>("_phone")?.seen).toContain("dup");
    // Restart core, then the same envelope again (the ack got lost, or someone replays it).
    await channel.stop();
    channel = makeChannel();
    await channel.start();
    phone.mailbox!.in.push(box);
    await delivered(phone);
    await new Promise((r) => setTimeout(r, 30));
    expect(orch.sent).toHaveLength(1);
    expect((await phone.all()).filter((o) => o.t === "ack")).toHaveLength(2);
    // Junk and envelopes for the other direction are dropped, not handled.
    phone.mailbox!.in.push(
      "not-an-envelope",
      await seal(phone.keys, { v: 1, t: "msg", id: "x", text: "hi", at: Date.now() }, "out"),
    );
    await delivered(phone);
    expect(orch.sent).toHaveLength(1);
  });

  it("won't run a message older than 10 minutes, or one without a time", async () => {
    const phone = await pairPhone();
    await phone.send({ t: "msg", id: "old", text: "stale", at: Date.now() - 11 * 60_000 });
    await phone.send({ t: "msg", id: "notime", text: "no time", at: undefined });
    await delivered(phone);
    expect(orch.sent).toEqual([]);
    const errors = (await phone.all()).filter((o) => o.t === "error");
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ text: "That message is too old to run; send it again." });
  });

  it("throttles working statuses with what the phone's turn is doing", async () => {
    await channel.stop();
    let clock = Date.now();
    channel = makeChannel({ now: () => clock });
    const phone = await pairPhone();
    await text(phone, "go");
    await phone.next();
    const tool = (title: string) =>
      hub.push(
        "timeline.upsert",
        store.upsertEntry({
          id: newId("tool"),
          agentId: primaryId,
          turnId: orch.running,
          item: { id: newId("itm"), kind: "tool", status: "running", title },
        }),
      );
    tool("Opened amazon.com");
    clock += 5_000;
    tool("Searched for socks");
    await channel.idle();
    expect(await phone.next()).toEqual([]);
    clock += 15_000;
    tool("Added socks to the cart");
    await channel.idle();
    expect(await phone.next()).toEqual([
      { v: 1, t: "status", agent: "Yo", state: "working", detail: "Added socks to the cart" },
    ]);
  });

  it("sends cards from the phone's own turn and answers them with orchestrator.respond", async () => {
    const phone = await pairPhone();
    await text(phone, "buy milk");
    await phone.next();
    const e = addRequest({
      kind: "tool_approval",
      title: "Buy milk",
      toolName: "yo:purchase",
      detail: "From the corner shop",
      input: { category: "purchase", total: "$4" },
    });
    await channel.idle();
    expect(await phone.next()).toEqual([
      {
        v: 1,
        t: "request",
        requestId: e.request!.requestId,
        agent: "Yo",
        kind: "approval",
        title: "Buy milk",
        detail: "From the corner shop\ncategory: purchase · total: $4",
      },
    ]);
    await phone.send({ t: "respond", requestId: e.request!.requestId, decision: "approve" });
    await until(() => orch.responded.length === 1, 3000, "respond");
    await delivered(phone);
    expect(orch.responded[0]).toMatchObject({ requestId: e.request!.requestId, decision: "allow" });
    expect((await phone.next()).filter((o) => o.t === "resolved")).toEqual([
      { v: 1, t: "resolved", requestId: e.request!.requestId, outcome: "Approved from your phone" },
    ]);

    // Questions take an answer.
    const q = addRequest(
      {
        kind: "user_input",
        title: "Which size?",
        questions: [
          { question: "Which size?", options: [{ label: "Small" }, { label: "Large" }], multiSelect: false },
        ],
      },
      { toolName: "ask_user" },
    );
    await channel.idle();
    expect(await phone.next()).toContainEqual(
      expect.objectContaining({ t: "request", kind: "question", options: ["Small", "Large"] }),
    );
    await phone.send({ t: "respond", requestId: q.request!.requestId, decision: "approve", answer: "Large" });
    await until(() => orch.responded.length === 2, 3000, "answer");
    expect(orch.responded[1]).toMatchObject({ answers: { "Which size?": "Large" }, message: "Large" });

    // Handled in Yo: the phone is told, and a late answer from the phone isn't applied.
    const e3 = addRequest({ kind: "tool_approval", title: "Post tweet", toolName: "yo:post" });
    await channel.idle();
    await delivered(phone);
    await phone.next();
    hub.push("timeline.upsert", store.setRequestStatus(e3.id, "denied")!);
    await channel.idle();
    expect(await phone.next()).toEqual([
      { v: 1, t: "resolved", requestId: e3.request!.requestId, outcome: "Denied in Yo" },
    ]);
    await phone.send({ t: "respond", requestId: e3.request!.requestId, decision: "approve" });
    await delivered(phone);
    expect(orch.responded).toHaveLength(2);
  });

  it("never shows or lets the phone answer the owner's own approvals", async () => {
    const phone = await pairPhone();
    await phone.send({ t: "hello" });
    await delivered(phone);
    await phone.next();
    orch.startMac();
    const owners = addRequest({ kind: "tool_approval", title: "Wire $5,000", toolName: "yo:pay" });
    const loose = addRequest({ kind: "tool_approval", title: "No turn", toolName: "yo:x" }, { turnId: null });
    await channel.idle();
    expect(await phone.next()).toEqual([]);
    // Guessing the request id doesn't help.
    for (const r of [owners, loose])
      await phone.send({ t: "respond", requestId: r.request!.requestId, decision: "approve" });
    await delivered(phone);
    expect(orch.responded).toEqual([]);
    expect(store.getEntry(owners.id)?.request?.status).toBe("pending");
    // Nor does a hello.
    await phone.send({ t: "hello" });
    await delivered(phone);
    expect((await phone.next()).filter((o) => o.t === "request")).toEqual([]);
  });

  it("only accepts exactly approve or deny", async () => {
    const phone = await pairPhone();
    await text(phone, "do it");
    const e = addRequest({ kind: "tool_approval", title: "Buy", toolName: "yo:purchase" });
    await channel.idle();
    for (const decision of ["allow", "yes", "allowAlways", "", undefined, 1])
      await phone.send({ t: "respond", requestId: e.request!.requestId, decision });
    await delivered(phone);
    expect(orch.responded).toEqual([]);
    await phone.send({ t: "respond", requestId: e.request!.requestId, decision: "deny" });
    await until(() => orch.responded.length === 1, 3000, "deny");
    expect(orch.responded[0]!.decision).toBe("deny");
  });

  it("never lets the phone answer Mac changes or takeovers, and resends its open cards on hello", async () => {
    const phone = await pairPhone();
    await text(phone, "save my notes");
    await phone.next();
    const mac = addRequest(
      { kind: "tool_approval", title: "Save notes.txt", toolName: "mac_write_file" },
      { toolName: "mac_write_file" },
    );
    addRequest({ kind: "user_input", title: "Take over", toolName: "request_takeover", detail: "2FA code" });
    const secure = addRequest({
      kind: "user_input",
      title: "One-time code for uber.com",
      toolName: "request_secure_input",
      detail: "Uber texted a code.",
      secureForm: {
        site: "uber.com",
        reason: "Uber texted a code.",
        fields: [{ kind: "one_time_code", label: "Code" }],
      },
    });
    await channel.idle();
    const cards = await phone.next();
    expect(cards.map((c) => (c as { kind?: string }).kind)).toEqual(["open_yo", "open_yo", "open_yo"]);
    expect(cards[1]).toMatchObject({ title: "Yo needs you to take over its screen", detail: "2FA code" });
    expect(cards[2]).toMatchObject({
      title: "Yo needs something private for uber.com",
      detail: "Uber texted a code.\nOpen Yo to fill this in securely.",
    });
    await phone.send({ t: "respond", requestId: mac.request!.requestId, decision: "approve" });
    await phone.send({
      t: "respond",
      requestId: secure.request!.requestId,
      decision: "approve",
      answer: "123456",
    });
    await delivered(phone);
    expect(orch.responded).toEqual([]);

    await phone.send({ t: "hello", device: "iPhone" });
    await delivered(phone);
    expect((await phone.next()).filter((o) => o.t === "request")).toHaveLength(3);
  });

  it("stop interrupts the phone's turn only, and keeps its queued messages", async () => {
    const phone = await pairPhone();
    // The owner's turn is running: the phone can't stop it.
    orch.startMac();
    await phone.send({ t: "stop" });
    await delivered(phone);
    expect(orch.interrupted).toEqual([]);
    orch.finish();

    await text(phone, "first");
    await text(phone, "second (queued)");
    await phone.next();
    await phone.send({ t: "stop" });
    await until(() => orch.interrupted.length === 1, 3000, "interrupt");
    await delivered(phone);
    expect(orch.interrupted).toEqual([primaryId]);
    // The queued message started and its reply still comes back.
    const a = assistant("second answer");
    orch.finish();
    await channel.idle();
    expect((await phone.all()).filter((o) => o.t === "reply")).toEqual([
      { v: 1, t: "reply", id: a.id, agent: "Yo", text: "second answer", at: expect.any(Number) },
    ]);
  });

  it("off revokes the mailbox, stops polling and deletes the secret", async () => {
    const phone = await pairPhone();
    await until(() => relay.polls.length > 0, 3000, "poll");
    const s = await channel.api["channels.phone.off"]({});
    expect(s).toMatchObject({ enabled: false, link: null, polling: false });
    expect(await secrets.get("phone-link-secret")).toBeNull();
    expect(relay.of("DELETE", "box").map((c) => c.box)).toEqual([FakeRelay.id(phone.keys.authToken)]);
    expect(relay.registered.size).toBe(0);
    expect((await phone.send({ t: "msg", text: "hi" })).status).toBe(404);
    const n = relay.calls.length;
    orch.startMac();
    addRequest({ kind: "tool_approval", title: "Buy", toolName: "yo:purchase" });
    await new Promise((r) => setTimeout(r, 40));
    expect(relay.calls.length).toBe(n);
  });

  it("a new link rotates the secret, revokes the old box and drops what was queued for it", async () => {
    const old = await pairPhone();
    const oldId = FakeRelay.id(old.keys.authToken);
    await text(old, "hi");
    const fresh = await pairPhone();
    expect(relay.of("DELETE", "box").map((c) => c.box)).toEqual([oldId]);
    expect(relay.registered.has(oldId)).toBe(false);
    expect(relay.registered.has(FakeRelay.id(fresh.keys.authToken))).toBe(true);
    expect((await old.send({ t: "msg", text: "from the old link" })).status).toBe(404);
    // The old turn's reply goes nowhere (it was the old phone's).
    assistant("old reply");
    orch.finish();
    await channel.idle();
    expect(await fresh.all()).toEqual([]);
    await text(fresh, "from the new link");
    expect(orch.sent.at(-1)).toEqual({ agentId: primaryId, text: "from the new link" });
  });

  it("re-registers once when the relay forgot the mailbox", async () => {
    const phone = await pairPhone();
    await text(phone, "hi");
    relay.registered.clear(); // the relay's registration expired
    assistant("hello");
    orch.finish();
    await channel.idle();
    expect(relay.of("POST", "register").length).toBeGreaterThanOrEqual(2);
    expect((await phone.all()).some((o) => o.t === "reply")).toBe(true);
  });

  it("backs off while the relay is down and recovers", async () => {
    await pairPhone();
    await until(() => relay.polls.length > 0, 3000, "poll");
    relay.down = true;
    await until(() => !!channel.status().lastError, 3000, "error");
    expect(channel.status().lastError).toMatch(/Can't reach the phone relay/);
    relay.down = false;
    await until(() => channel.status().lastError === null, 3000, "recovery");
  });

  it("changes the relay URL, and only restarts polling when it really changes", async () => {
    await expect(
      channel.api["channels.phone.configure"]({ relayUrl: "http://evil.example" }),
    ).rejects.toThrow(/https/);
    await pairPhone();
    await until(() => relay.polls.length > 0, 3000, "poll");
    const beats = () => relay.polls.filter((c) => c.beat).length;
    const before = beats();
    // Same URL: nothing restarts (a restart beats again).
    await channel.api["channels.phone.configure"]({ relayUrl: `${RELAY}/` });
    await new Promise((r) => setTimeout(r, 40));
    expect(beats()).toBe(before);
    const s = await channel.api["channels.phone.configure"]({ relayUrl: "https://other.example/" });
    expect(s.relayUrl).toBe("https://other.example");
    expect(s.link?.startsWith("https://other.example/#k=")).toBe(true);
    await until(() => beats() > before, 3000, "restart");
    expect((await channel.api["channels.phone.configure"]({ relayUrl: null })).relayUrl).toBe(RELAY);
  });

  it("signs every reply and authenticates every relay call (v2)", async () => {
    const phone = await pairPhone();
    await text(phone, "hi");
    assistant("hello");
    orch.finish();
    await channel.idle();
    const items = phone.mailbox!.out;
    expect(items.length).toBeGreaterThan(0);
    for (const o of items) expect(phone.verified(o)).toBe(true);
    // A forged item (no or wrong signature) is caught by the phone.
    expect(phone.verified({ box: items[0]!.box, sig: "" })).toBe(false);
    expect(phone.verified({ box: items[0]!.box, sig: items[1]?.sig ?? "x" })).toBe(false);
    // Every core call passed the relay's admission (nothing was rejected).
    expect(relay.calls.filter((c) => c.status === 401)).toEqual([]);
  });

  it("puts a rising counter in every signed message, and keeps it rising across restarts", async () => {
    await channel.stop();
    const clock = Date.now() - 60_000;
    channel = makeChannel({ now: () => clock }); // a stuck clock: the counter still goes up by one
    const phone = await pairPhone();
    await text(phone, "one");
    orch.finish();
    await channel.idle();
    const first = (await phone.raw()).map((m) => m.n);
    expect(first.length).toBeGreaterThan(1);
    expect(first[0]).toBeGreaterThanOrEqual(clock);
    for (let i = 1; i < first.length; i++) expect(first[i]).toBe(first[i - 1]! + 1);
    // After a restart (same link), the next message continues from the saved counter.
    await channel.stop();
    channel = makeChannel({ now: () => clock });
    await channel.start();
    await text(phone, "two");
    const after = (await phone.raw()).map((m) => m.n).slice(first.length);
    expect(after[0]).toBeGreaterThan(first.at(-1)!);
    await phone.all(); // and the whole history still checks out
  });

  it("phone text is always its own turn, never steered", async () => {
    const phone = await pairPhone();
    orch.startMac();
    await text(phone, "later");
    expect(orch.sentOpts).toEqual([{ noSteer: true }]);
  });

  it("when the owner steers into a phone turn, the rest of that turn stays off the phone", async () => {
    const phone = await pairPhone();
    await text(phone, "book a table");
    const card = addRequest({ kind: "tool_approval", title: "Book it", toolName: "yo:book" });
    await channel.idle();
    expect((await phone.next()).some((o) => o.t === "request")).toBe(true);
    orch.steerOwner();
    await channel.idle();
    expect(await phone.next()).toEqual([
      {
        v: 1,
        t: "resolved",
        requestId: card.request!.requestId,
        outcome: "Continued in Yo on your computer",
      },
      { v: 1, t: "status", agent: "Yo", state: "idle" },
    ]);
    // Nothing more from that turn: not its cards, not its reply.
    const later = addRequest({ kind: "tool_approval", title: "Pay deposit", toolName: "yo:pay" });
    assistant("private answer for the owner");
    orch.finish();
    await channel.idle();
    expect(await phone.next()).toEqual([]);
    await phone.send({ t: "respond", requestId: later.request!.requestId, decision: "approve" });
    await delivered(phone);
    expect(orch.responded).toEqual([]);
  });

  it("caps phone messages: 3 in flight", async () => {
    const phone = await pairPhone();
    orch.startMac();
    for (const t of ["one", "two", "three"]) await text(phone, t);
    await phone.send({ t: "msg", text: "four" });
    await delivered(phone);
    expect(orch.sent.map((x) => x.text)).toEqual(["one", "two", "three"]);
    expect(await phone.all()).toContainEqual({
      v: 1,
      t: "error",
      agent: "Yo",
      text: "Yo is busy. Send it again in a minute.",
    });
  });

  it("caps phone messages: 10 a minute", async () => {
    await channel.stop();
    let clock = Date.now();
    channel = makeChannel({ now: () => clock });
    const phone = await pairPhone();
    for (let i = 0; i < 10; i++) {
      await text(phone, `m${i}`);
      orch.finish();
    }
    await phone.send({ t: "msg", text: "eleven", at: clock });
    await delivered(phone);
    expect(orch.sent).toHaveLength(10);
    expect((await phone.all()).filter((o) => o.t === "error")).toHaveLength(1);
    clock += 61_000;
    await phone.send({ t: "msg", text: "a minute later", at: clock });
    await until(() => orch.sent.length === 11, 3000, "accepted again");
  });

  it("says busy at most once a minute, however many messages the link sends", async () => {
    await channel.stop();
    let clock = Date.now();
    channel = makeChannel({ now: () => clock });
    const phone = await pairPhone();
    orch.startMac();
    for (const t of ["one", "two", "three"]) await text(phone, t);
    for (let i = 0; i < 8; i++) await phone.send({ t: "msg", text: `flood ${i}`, at: clock });
    await delivered(phone);
    const busy = async () => (await phone.all()).filter((o) => o.t === "error" && o.text.includes("busy"));
    expect(orch.sent).toHaveLength(3);
    expect(await busy()).toHaveLength(1);
    clock += 30_000;
    await phone.send({ t: "msg", text: "still flooding", at: clock });
    await delivered(phone);
    expect(await busy()).toHaveLength(1);
    clock += 31_000;
    await phone.send({ t: "msg", text: "a minute later", at: clock });
    await delivered(phone);
    expect(await busy()).toHaveLength(2);
  });

  it("retries a failed wipe of the old link, across restarts, until it goes through", async () => {
    const old = await pairPhone();
    const oldId = FakeRelay.id(old.keys.authToken);
    relay.deleteFails = true;
    await channel.api["channels.phone.off"]({});
    expect(channel.status().revokePending).toBe(true);
    expect(await secrets.get("phone-pending-revokes")).toContain(old.keys.authToken);
    expect(relay.registered.has(oldId)).toBe(true);
    // A restart keeps trying.
    await channel.stop();
    channel = makeChannel();
    await channel.start();
    expect(channel.status().revokePending).toBe(true);
    const tries = relay.of("DELETE", "box").length;
    await until(() => relay.of("DELETE", "box").length > tries + 1, 3000, "retries");
    relay.deleteFails = false;
    await until(() => !channel.status().revokePending, 3000, "wiped");
    expect(relay.registered.has(oldId)).toBe(false);
    expect(await secrets.get("phone-pending-revokes")).toBeNull();
  });

  it("drops a pending wipe once the relay answers 401 (its register key changed)", async () => {
    await pairPhone();
    relay.deleteFails = true;
    await channel.api["channels.phone.off"]({});
    expect(channel.status().revokePending).toBe(true);
    const tries = relay.of("DELETE", "box").length;
    await until(() => relay.of("DELETE", "box").length > tries, 3000, "a retry");
    // The relay's key is rotated: the old credentials are void there, so retrying can never work.
    relay.deleteFails = false;
    relay.registerKey = "a-rotated-register-key-0123456789";
    await until(() => !channel.status().revokePending, 3000, "gave up");
    expect(relay.of("DELETE", "box").at(-1)!.status).toBe(401);
    expect(await secrets.get("phone-pending-revokes")).toBeNull();
    const calls = relay.of("DELETE", "box").length;
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.of("DELETE", "box")).toHaveLength(calls);
  });

  it("doesn't queue a wipe the relay refused with 401, and says the relay key was refused", async () => {
    await pairPhone();
    await until(() => relay.polls.length > 0, 3000, "poll");
    relay.registerKey = "a-rotated-register-key-0123456789";
    await until(() => !!channel.status().lastError, 3000, "poll error");
    expect(channel.status().lastError).toMatch(/didn't accept Yo's relay key/);
    await channel.api["channels.phone.off"]({});
    expect(relay.of("DELETE", "box").at(-1)!.status).toBe(401);
    expect(channel.status().revokePending).toBe(false);
    expect(await secrets.get("phone-pending-revokes")).toBeNull();
  });

  it("moving to another relay wipes the box on the old one and registers it on the new one", async () => {
    const phone = await pairPhone();
    await until(() => relay.polls.length > 0, 3000, "poll");
    relay.calls = [];
    await channel.api["channels.phone.configure"]({ relayUrl: "https://other.example" });
    expect(relay.of("DELETE", "box").map((c) => c.host)).toEqual(["relay.test"]);
    expect(relay.of("POST", "register").map((c) => c.host)).toEqual(["other.example"]);
    expect(relay.of("DELETE", "box")[0]!.box).toBe(FakeRelay.id(phone.keys.authToken));
    await until(() => relay.polls.some((c) => c.host === "other.example"), 3000, "polls the new relay");
  });
});

/* ------------------------------ v2.1 ------------------------------- */

describe("phone channel: pictures, photos and helpers (v2.1)", () => {
  /** Stand-ins for a picture file and for imageShrink (its own tests cover the real thing). */
  const picture = (src: string) => Buffer.from(`picture bytes of ${src}`);
  const asIs = (buf: Buffer) => ({ bytes: buf, mime: "image/png" as const, width: 640, height: 400 });
  const reads: { agentId: string; src: string; stored?: string }[] = [];
  const readImage = async (agentId: string, src: string, stored?: string) => {
    reads.push({ agentId, src, stored });
    if (src.includes("missing")) throw new Error("no such file");
    return picture(src);
  };

  /** The phone's message gets a reply with these pictures in it; returns everything the phone got. */
  async function replyWith(phone: FakePhone, text: string) {
    await phone.send({ t: "msg", text: "show me" });
    await until(() => orch.sent.length > 0 && !!orch.running, 3000, "turn");
    await delivered(phone);
    await phone.next();
    const a = assistant(text);
    orch.finish();
    await channel.idle();
    return { entry: a, out: await phone.next() };
  }

  /** Fetch and open a picture the way the phone app does (GET blob/out, AES-GCM, hash check). */
  async function fetchPicture(phone: FakePhone, id: string) {
    const res = await relay.fetch(`${RELAY}/api/relay/blob/out?id=${id}`, {
      headers: { authorization: `Bearer ${phone.keys.authToken}`, "x-yo-admit": phone.admit },
    });
    const { box } = (await res.json()) as { box: string };
    return Buffer.from(await openBlob(phone.keys, box, "out", id));
  }

  beforeEach(() => {
    reads.length = 0;
  });

  it("says what it understands in hello", async () => {
    const phone = await pairPhone();
    await phone.send({ t: "hello" });
    await delivered(phone);
    expect((await phone.next())[0]).toMatchObject({
      t: "hello",
      caps: ["images", "photos", "helpers", "tasks", "brief", "replies"],
    });
  });

  it("sends a reply's pictures as encrypted blobs after the reply, four at most", async () => {
    await channel.stop();
    channel = makeChannel({ readImage, shrink: asIs });
    const phone = await pairPhone();
    const srcs = [1, 2, 3, 4, 5].map((i) => `/home/yo/shot-${i}.png`);
    const text = `Here:\n\n![The cart](${srcs[0]})\n${srcs
      .slice(1)
      .map((s) => `![](${s})`)
      .join("\n")}\n\n![web](https://example.com/x.png)`;
    const { entry, out } = await replyWith(phone, text);
    expect(out[0]).toMatchObject({ t: "reply", id: entry.id, text, pics: 4 });
    const images = out.find((o) => o.t === "images") as Extract<PhoneOut, { t: "images" }>;
    expect(out.indexOf(images)).toBeGreaterThan(0);
    expect(images).toMatchObject({ replyId: entry.id, more: 1 });
    expect(images.items.map((i) => i.src)).toEqual(srcs.slice(0, 4));
    expect(images.items[0]).toMatchObject({ alt: "The cart", mime: "image/png", w: 640, h: 400 });
    // Only the agent's own files are read (never the web picture), and never the fifth.
    expect(reads.map((r) => r.src)).toEqual(srcs.slice(0, 4));
    for (const [i, item] of images.items.entries()) {
      const bytes = await fetchPicture(phone, item.id);
      expect(bytes.equals(picture(srcs[i]!))).toBe(true);
      expect(item.size).toBe(bytes.length);
      expect(item.hash).toBe(createHash("sha256").update(bytes).digest("base64url"));
    }
    // The relay only ever saw ciphertext.
    for (const blob of relay.blobs.values()) expect(blob).not.toContain("picture bytes");
  });

  it("uses the message's snapshot when it has one", async () => {
    await channel.stop();
    channel = makeChannel({ readImage, shrink: asIs });
    const phone = await pairPhone();
    await phone.send({ t: "msg", text: "show me" });
    await until(() => !!orch.running, 3000, "turn");
    await delivered(phone);
    const a = assistant("![x](/home/yo/a.png)");
    store.upsertEntry({ ...a, item: { ...a.item, images: { "/home/yo/a.png": `${"a".repeat(64)}.png` } } });
    orch.finish();
    await channel.idle();
    expect(reads).toEqual([{ agentId: primaryId, src: "/home/yo/a.png", stored: `${"a".repeat(64)}.png` }]);
  });

  it("counts pictures it can't read or shrink as 'more', and keeps going", async () => {
    await channel.stop();
    channel = makeChannel({
      readImage,
      shrink: (b) => (b.toString().includes("huge") ? null : asIs(b)),
    });
    const phone = await pairPhone();
    const { out } = await replyWith(phone, "![](/a/missing.png) ![](/a/huge.png) ![](/a/ok.png)");
    const images = out.find((o) => o.t === "images") as Extract<PhoneOut, { t: "images" }>;
    expect(images.items.map((i) => i.src)).toEqual(["/a/ok.png"]);
    expect(images.more).toBe(2);
  });

  it("an older relay without picture routes: the reply still goes, its pictures are 'in Yo'", async () => {
    await channel.stop();
    channel = makeChannel({ readImage, shrink: asIs });
    relay.blobRoutes = false;
    const phone = await pairPhone();
    const { out } = await replyWith(phone, "![](/a/1.png) ![](/a/2.png)");
    expect(out[0]).toMatchObject({ t: "reply", pics: 2 });
    expect(out.find((o) => o.t === "images")).toMatchObject({ items: [], more: 2 });
    // It stopped at the first refusal instead of trying every picture.
    expect(relay.of("POST", "blob/out")).toHaveLength(1);
  });

  it("keeps to the daily picture budget per link", async () => {
    await channel.stop();
    channel = makeChannel({ readImage, shrink: asIs });
    const phone = await pairPhone();
    const day = Math.floor(Date.now() / 86_400_000);
    store.setKv("_phone", { ...store.getKv<object>("_phone"), pics: { day, count: 39, bytes: 0 } });
    const { out } = await replyWith(phone, "![](/a/1.png) ![](/a/2.png) ![](/a/3.png)");
    expect(out.find((o) => o.t === "images")).toMatchObject({ more: 2 });
    expect(store.getKv<{ pics: { count: number } }>("_phone")?.pics.count).toBe(40);
  });

  it("without a picture reader, replies don't promise pictures it can't send", async () => {
    const phone = await pairPhone();
    const { out } = await replyWith(phone, "![](/a/1.png)");
    expect(out.find((o) => o.t === "images")).toMatchObject({ items: [], more: 1 });
  });

  it("replies without pictures are exactly as before (no pics, no images message)", async () => {
    const phone = await pairPhone();
    const { out } = await replyWith(phone, "Just text, and a [link](https://example.com).");
    expect(out.map((o) => o.t)).toEqual(["reply", "status"]);
    expect(out[0]).not.toHaveProperty("pics");
  });

  /** The phone stores a photo as a blob and sends a message pointing at it, like the app does. */
  async function sendPhoto(phone: FakePhone, bytes: Buffer, text = "what's this?", hash?: string) {
    const id = toBase64Url(new Uint8Array(randomBytes(16)));
    const box = await sealBlob(phone.keys, new Uint8Array(bytes), "in", id);
    await relay.fetch(`${RELAY}/api/relay/blob/in`, {
      method: "POST",
      headers: { authorization: `Bearer ${phone.keys.authToken}`, "x-yo-admit": phone.admit },
      body: JSON.stringify({ id, box }),
    });
    const pic = {
      id,
      mime: "image/jpeg",
      w: 1,
      h: 1,
      size: bytes.length,
      hash: hash ?? createHash("sha256").update(bytes).digest("base64url"),
    };
    await phone.send({ t: "msg", text, pics: [pic] });
  }
  /** Smallest thing imageInfo calls a JPEG: SOI, SOF0 (1×1), EOI. */
  const JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]);

  it("photos from the phone reach Yo as picture attachments", async () => {
    const phone = await pairPhone();
    await sendPhoto(phone, JPEG);
    await until(() => orch.sent.length === 1, 3000, "send");
    expect(orch.sent[0]!.text).toBe("what's this?");
    expect(orch.sentAtt[0]).toEqual([
      { name: "phone-photo-1.jpg", mediaType: "image/jpeg", data: JPEG.toString("base64") },
    ]);
  });

  it("drops a photo whose hash doesn't match (or isn't a picture), and says so", async () => {
    const phone = await pairPhone();
    await sendPhoto(phone, JPEG, "look", "x".repeat(43));
    await until(() => orch.sent.length === 1, 3000, "send");
    expect(orch.sentAtt[0]).toEqual([]);
    await delivered(phone);
    expect(await phone.all()).toContainEqual(
      expect.objectContaining({ t: "error", text: "Yo couldn't get one of your photos. Send it again." }),
    );
    // A photo alone that didn't make it runs nothing.
    await sendPhoto(phone, Buffer.from("not a picture"), "");
    await delivered(phone);
    expect(orch.sent).toHaveLength(1);
  });

  it("tells the phone how many helpers are working, on changes only", async () => {
    const phone = await pairPhone();
    await text(phone, "plan my trip");
    await phone.next();
    const helper = (id: string, activity: string, archivedAt: number | null = null) =>
      hub.push("agent.updated", {
        ...store.getAgent(primaryId)!,
        id,
        name: id,
        kind: "helper",
        parentId: primaryId,
        isPrimary: false,
        archivedAt,
        activity,
        unread: 0,
        preview: null,
        computer: { state: "running", lease: "agent" },
        todos: [],
        lastActiveAt: null,
      } as never);
    helper("h1", "working");
    helper("h2", "working");
    helper("h2", "working");
    await channel.idle();
    const during = (await phone.next()).filter((o) => o.t === "status");
    expect(during.map((s) => (s as { helpers?: number }).helpers)).toEqual([1, 2]);
    expect(during.every((s) => (s as { state: string }).state === "working")).toBe(true);
    orch.finish();
    await channel.idle();
    expect((await phone.next()).filter((o) => o.t === "status")).toEqual([
      { v: 1, t: "status", agent: "Yo", state: "idle", helpers: 2 },
    ]);
    helper("h1", "idle", Date.now());
    await channel.idle();
    expect(await phone.next()).toEqual([{ v: 1, t: "status", agent: "Yo", state: "idle", helpers: 1 }]);
  });
});

describe("phone channel: peek at the screen (v2.2)", () => {
  const png = Buffer.from("png bytes of the agent's screen");
  const asIs = (buf: Buffer) => ({ bytes: buf, mime: "image/png" as const, width: 1280, height: 800 });

  async function peek(phone: FakePhone) {
    await phone.send({ t: "peek" });
    await delivered(phone);
    return (await phone.next()).filter((o) => o.t !== "ack");
  }

  it("says peek in hello only when it can take a screenshot", async () => {
    let phone = await pairPhone();
    await phone.send({ t: "hello" });
    await delivered(phone);
    expect((await phone.next())[0]).toMatchObject({
      caps: ["images", "photos", "helpers", "tasks", "brief", "replies"],
    });
    await channel.stop();
    channel = makeChannel({ screenshot: async () => png, shrink: asIs });
    phone = await pairPhone();
    await phone.send({ t: "hello" });
    await delivered(phone);
    expect((await phone.next())[0]).toMatchObject({
      caps: ["images", "photos", "helpers", "tasks", "brief", "replies", "peek"],
    });
  });

  it("sends the agent's screen as an encrypted picture on a peek reply, without starting a turn", async () => {
    await channel.stop();
    const shots: string[] = [];
    let clock = Date.now();
    channel = makeChannel({
      screenshot: async (agentId) => {
        shots.push(agentId);
        return png;
      },
      shrink: asIs,
      now: () => clock,
    });
    const phone = await pairPhone();
    const out = await peek(phone);
    expect(shots).toEqual([primaryId]);
    expect(orch.sent).toHaveLength(0);
    const reply = out.find((o) => o.t === "reply") as Extract<PhoneOut, { t: "reply" }>;
    expect(reply).toMatchObject({ agent: "Yo", text: "Here's my screen right now.", pics: 1, peek: true });
    const images = out.find((o) => o.t === "images") as Extract<PhoneOut, { t: "images" }>;
    expect(images).toMatchObject({ replyId: reply.id, more: 0 });
    expect(images.items).toHaveLength(1);
    expect(images.items[0]).toMatchObject({ mime: "image/png", w: 1280, h: 800, alt: "Yo's screen" });
    expect(images.items[0]).not.toHaveProperty("src");
    const res = await relay.fetch(`${RELAY}/api/relay/blob/out?id=${images.items[0]!.id}`, {
      headers: { authorization: `Bearer ${phone.keys.authToken}`, "x-yo-admit": phone.admit },
    });
    const { box } = (await res.json()) as { box: string };
    expect(Buffer.from(await openBlob(phone.keys, box, "out", images.items[0]!.id)).equals(png)).toBe(true);
    // Too soon: no second screenshot, and one "wait" (not one per peek).
    expect((await peek(phone)).map((o) => o.t)).toEqual(["error"]);
    expect(await peek(phone)).toEqual([]);
    expect(shots).toHaveLength(1);
    clock += 6_000;
    expect((await peek(phone)).map((o) => o.t)).toEqual(["reply", "images"]);
    expect(shots).toHaveLength(2);
  });

  it("says so when the screen can't be seen (computer not running)", async () => {
    await channel.stop();
    channel = makeChannel({
      screenshot: async () => {
        throw new Error("computer is not running");
      },
      shrink: asIs,
    });
    const phone = await pairPhone();
    const out = await peek(phone);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ t: "reply", peek: true });
    expect(out[0]).not.toHaveProperty("pics");
    expect(relay.of("POST", "blob/out")).toHaveLength(0);
  });
});

describe("phone channel: tasks, morning brief and quick replies (v2.3)", () => {
  const DAY = 24 * 60 * 60_000;
  type Tasks = Extract<PhoneOut, { t: "tasks" }>;
  type Reply = Extract<PhoneOut, { t: "reply" }>;
  type Err = Extract<PhoneOut, { t: "error" }>;

  beforeEach(async () => {
    await channel.stop();
    channel = makeChannel({ tasksPushMs: 20 });
  });

  const task = (title: string, extra: Partial<Parameters<Store["addTask"]>[0]>) =>
    store.addTask({ ownerId: primaryId, title, ...extra });

  /** A tool call in the running turn (the post_brief / suggest_replies the chat draws). */
  function toolCall(toolName: string, input: unknown, status: "completed" | "failed" = "completed") {
    return store.upsertEntry({
      id: newId("tl"),
      agentId: primaryId,
      turnId: orch.running,
      item: { id: newId("itm"), kind: "tool", status, title: toolName, toolName, input },
    });
  }

  /** Send something and return what came back (without acks). */
  async function ask(phone: FakePhone, m: Record<string, unknown>) {
    await phone.send(m);
    await delivered(phone);
    return (await phone.next()).filter((o) => o.t !== "ack");
  }

  /** A second agent (not the one the phone talks to). */
  const addPip = () =>
    store.createAgent({
      name: "Pip",
      role: "",
      instructions: "",
      avatar: { shape: "bubble", color: "yo", eyes: "capsule", accessory: "none" },
      accountId: null,
      model: null,
      effort: null,
      runtimeMode: "full-access",
      isPrimary: false,
      pinned: false,
    });

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("answers a tasks request with the main agent's Tasks page, sorted and clipped", async () => {
    task("Old to-do", { status: "open" });
    task("Report ready", { status: "review", note: "x".repeat(400) });
    task("Plan the trip", {
      status: "suggested",
      origin: "suggestion",
      why: "Your flight is Friday",
      prompt: "Yo's plan",
    });
    const hidden = task("Hidden one", { status: "suggested", origin: "suggestion" });
    store.updateTask(hidden.id, { status: "hidden" });
    task("t".repeat(300), { status: "waiting" });
    const phone = await pairPhone();
    const out = await ask(phone, { t: "tasks" });
    expect(out.map((o) => o.t)).toEqual(["tasks"]);
    const { items } = out[0] as Tasks;
    expect(items.map((t) => t.status)).toEqual(["review", "waiting", "open", "suggested"]);
    expect(items[0]!.note).toHaveLength(300);
    expect(items[1]!.title).toHaveLength(200);
    expect(items[3]).toMatchObject({
      title: "Plan the trip",
      why: "Your flight is Friday",
      origin: "suggestion",
    });
    // Yo's plan (the prompt) never goes to the phone.
    expect(JSON.stringify(items)).not.toContain("Yo's plan");
    expect(channel.status().enabled).toBe(true);
  });

  it("never sends tasks to a phone that didn't ask (an older phone)", async () => {
    const phone = await pairPhone();
    await ask(phone, { t: "hello" });
    task("Something new", { status: "open" });
    await pause(80);
    await channel.idle();
    expect((await phone.next()).map((o) => o.t)).not.toContain("tasks");
  });

  it("pushes the list after a ledger change, gathered, and not when nothing changed", async () => {
    const phone = await pairPhone();
    await ask(phone, { t: "tasks" });
    const a = task("First", { status: "open" });
    store.updateTask(a.id, { status: "in_progress" });
    task("Second", { status: "open" });
    await pause(80);
    await channel.idle();
    const pushed = (await phone.next()).filter((o) => o.t === "tasks") as Tasks[];
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.items.map((t) => t.title)).toEqual(["First", "Second"]);
    // Another agent's ledger isn't this phone's list.
    const other = addPip();
    store.addTask({ ownerId: other.id, title: "Pip's", status: "open" });
    await pause(80);
    await channel.idle();
    expect((await phone.next()).filter((o) => o.t === "tasks")).toEqual([]);
    // After an action the phone gets the list right away; the change it made isn't pushed again.
    const sug = task("Tidy the inbox", { status: "suggested", origin: "suggestion" });
    await pause(80);
    await channel.idle();
    await phone.next();
    const out = await ask(phone, { t: "task", taskId: sug.id, action: "hide" });
    expect(out.map((o) => o.t)).toEqual(["tasks"]);
    await pause(80);
    await channel.idle();
    expect(await phone.next()).toEqual([]);
  });

  it("only pushes to a phone seen in the last 15 minutes (a closed phone's mailbox doesn't fill up)", async () => {
    await channel.stop();
    let clock = Date.now();
    channel = makeChannel({ tasksPushMs: 20, now: () => clock });
    const phone = await pairPhone();
    await ask(phone, { t: "tasks" });
    clock += 14 * 60_000;
    task("Soon", { status: "open" });
    await pause(80);
    await channel.idle();
    expect((await phone.next()).filter((o) => o.t === "tasks")).toHaveLength(1);
    clock += 2 * 60_000;
    task("Late", { status: "open" });
    await pause(80);
    await channel.idle();
    expect((await phone.next()).filter((o) => o.t === "tasks")).toEqual([]);
    // Back in the foreground the phone asks, and pushes go again.
    await ask(phone, { t: "tasks" });
    task("Later still", { status: "open" });
    await pause(80);
    await channel.idle();
    expect((await phone.next()).filter((o) => o.t === "tasks")).toHaveLength(1);
  });

  it("a newer updatedAt alone isn't pushed", async () => {
    const only = task("Only one", { status: "in_progress", note: "Halfway" });
    const phone = await pairPhone();
    await ask(phone, { t: "tasks" });
    await pause(5);
    store.updateTask(only.id, { status: "in_progress", note: "Halfway" });
    expect(store.getTask(only.id)!.updatedAt).toBeGreaterThan(only.updatedAt);
    await pause(80);
    await channel.idle();
    expect((await phone.next()).filter((o) => o.t === "tasks")).toEqual([]);
    store.updateTask(only.id, { note: "Almost done" });
    await pause(80);
    await channel.idle();
    expect((await phone.next()).filter((o) => o.t === "tasks")).toHaveLength(1);
  });

  it("keeps the task list under the relay's size limit: notes and whys go first, then the bottom rows", async () => {
    // 40 tasks of long emoji text: about 70 KB of JSON as it stands.
    const big = "😀".repeat(200);
    for (let i = 0; i < 20; i++) task(`Review ${i} ${big}`, { status: "review", note: big });
    for (let i = 0; i < 20; i++)
      task(`Idea ${i} ${big}`, { status: "suggested", origin: "suggestion", why: big });
    const phone = await pairPhone();
    const out = await ask(phone, { t: "tasks" });
    const { items } = out[0] as Tasks;
    expect(Buffer.byteLength(JSON.stringify(out[0]), "utf8")).toBeLessThanOrEqual(MAX_OUT_JSON_BYTES);
    expect(items).toHaveLength(40);
    // What needs the user keeps its note; the bottom of the list lost its whys.
    expect(items[0]).toMatchObject({ status: "review", note: expect.any(String) });
    expect(items.at(-1)).toMatchObject({ status: "suggested" });
    expect(items.at(-1)).not.toHaveProperty("why");

    const row = (i: number, status: PhoneTask["status"]): PhoneTask => ({
      id: `t${i}`,
      title: "é".repeat(200),
      status,
      note: "x".repeat(300),
      updatedAt: i,
    });
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row(i, "review")),
      ...Array.from({ length: 30 }, (_, i) => row(10 + i, "open")),
    ];
    const fit = fitTasks(rows, 6_000);
    expect(Buffer.byteLength(JSON.stringify(fit), "utf8")).toBeLessThanOrEqual(6_000);
    expect(fit.length).toBeLessThan(40);
    expect(fit.length).toBeGreaterThanOrEqual(10);
    expect(fit.slice(0, 10).every((t) => t.status === "review")).toBe(true);
    expect(fit.every((t) => !("note" in t))).toBe(true);
    // Small lists are untouched.
    expect(fitTasks(rows.slice(0, 3))).toEqual(rows.slice(0, 3));
  });

  it("a Start refused by the flood cap always says so, a few times a minute at most", async () => {
    const ids = Array.from(
      { length: 12 },
      (_, i) => task(`Idea ${i}`, { status: "suggested", origin: "suggestion" }).id,
    );
    const phone = await pairPhone();
    orch.startMac();
    for (const t of ["one", "two", "three"]) await text(phone, t);
    await phone.next();
    // A plain message hears "busy" once a minute...
    await ask(phone, { t: "msg", text: "four", at: Date.now() });
    // ...but every refused Start hears it, right before the list.
    for (const taskId of ids.slice(0, 3)) {
      const out = await ask(phone, { t: "task", taskId, action: "start" });
      expect(out.map((o) => o.t)).toEqual(["error", "tasks"]);
      expect((out[0] as Err).text).toMatch(/busy/);
    }
    for (const taskId of ids.slice(3)) await ask(phone, { t: "task", taskId, action: "start" });
    const refused = (await phone.all()).filter((o) => o.t === "error" && /Try Start again/.test(o.text));
    expect(refused).toHaveLength(10);
    expect(ids.every((id) => store.getTask(id)!.status === "suggested")).toBe(true);
  });

  it("Start sends only the suggestion's title, as the phone's own turn, and its reply comes back", async () => {
    const s = task("Plan the trip", {
      status: "suggested",
      origin: "suggestion",
      why: "Your flight is Friday",
      prompt: "Check flights, then hotels",
    });
    const phone = await pairPhone();
    const out = await ask(phone, { t: "task", taskId: s.id, action: "start" });
    expect(orch.sent).toEqual([{ agentId: primaryId, text: "Plan the trip" }]);
    expect(orch.sentOpts[0]).toMatchObject({ noSteer: true });
    expect(store.getTask(s.id)).toMatchObject({ status: "in_progress", note: "Check flights, then hotels" });
    expect(out.map((o) => o.t)).toEqual(["status", "tasks"]);
    expect((out[1] as Tasks).items[0]).toMatchObject({ id: s.id, status: "in_progress" });
    assistant("On it.");
    orch.finish();
    await channel.idle();
    expect((await phone.next()).find((o) => o.t === "reply")).toMatchObject({ text: "On it." });
  });

  it("a task the user saved starts with their own words; hide and check off follow the Tasks page's rules", async () => {
    const saved = store.addTask({
      ownerId: primaryId,
      title: "Book a dentist",
      note: "Before June",
      status: "open",
      origin: "user",
      prompt: "Book a dentist\n\nBefore June",
    });
    const sug = task("Tidy the inbox", { status: "suggested", origin: "suggestion" });
    const own = task("Yo's own to-do", { status: "open" });
    const review = task("Report", { status: "review" });
    const phone = await pairPhone();

    await ask(phone, { t: "task", taskId: saved.id, action: "start" });
    expect(orch.sent.at(-1)!.text).toBe("Book a dentist\n\nBefore June");
    orch.finish();
    await channel.idle();
    await phone.next();

    const refusals: [string, string, RegExp][] = [
      [own.id, "start", /on Yo's own list/],
      [review.id, "hide", /Only a suggestion can be hidden/],
      [sug.id, "done", /suggestion can't be checked off/],
      ["tsk_gone", "done", /isn't on the list any more/],
    ];
    for (const [taskId, action, text] of refusals) {
      const out = await ask(phone, { t: "task", taskId, action });
      expect(out.map((o) => o.t)).toEqual(["error", "tasks"]);
      expect((out[0] as Err).text).toMatch(text);
    }
    expect(orch.sent).toHaveLength(1);

    await ask(phone, { t: "task", taskId: sug.id, action: "hide" });
    expect(store.getTask(sug.id)!.status).toBe("hidden");
    const out = await ask(phone, { t: "task", taskId: review.id, action: "done" });
    expect(store.getTask(review.id)!.status).toBe("done");
    expect((out.at(-1) as Tasks).items.find((t) => t.id === sug.id)).toBeUndefined();

    // Nonsense actions are refused, never guessed at.
    const bad = await ask(phone, { t: "task", taskId: own.id, action: "delete" });
    expect(bad.map((o) => o.t)).toEqual(["error"]);
    expect(store.getTask(own.id)!.status).toBe("open");
  });

  it("only touches the active space's main agent's tasks", async () => {
    const pip = addPip();
    const theirs = store.addTask({
      ownerId: pip.id,
      title: "Pip's",
      status: "suggested",
      origin: "suggestion",
    });
    const phone = await pairPhone();
    const out = await ask(phone, { t: "task", taskId: theirs.id, action: "start" });
    expect((out[0] as Err).text).toMatch(/another agent's list/);
    expect(orch.sent).toEqual([]);
    expect(store.getTask(theirs.id)!.status).toBe("suggested");
  });

  /** A Yo that's been set up since before today, and a channel whose clock is two days on. */
  async function briefSetup() {
    store.updateSettings({ onboarded: true, computerSetup: "done", timezone: "UTC", spacesOn: false });
    await channel.stop();
    const at = Date.now() + 2 * DAY;
    channel = makeChannel({ tasksPushMs: 20, now: () => at });
    return new Date(at).toISOString().slice(0, 10);
  }

  it("hello with localDate claims the morning brief once a day, and the brief comes back on the reply", async () => {
    const today = await briefSetup();
    const phone = await pairPhone();
    const out = await ask(phone, { t: "hello", localDate: today });
    expect(out.map((o) => o.t)).toEqual(["hello", "status"]);
    expect(orch.sent).toEqual([{ agentId: primaryId, text: MORNING_BRIEF_FRAME }]);
    expect(orch.sentOpts[0]).toMatchObject({ notice: "Morning brief", noSteer: true });
    toolCall("post_brief", {
      needs_you: [{ title: "Reply to Ana", start: "Draft a reply" }],
      today: [{ time: "9:30 AM", title: "Standup" }],
    });
    assistant("Ana is the one that matters today.");
    orch.finish();
    await channel.idle();
    const reply = (await phone.next()).find((o) => o.t === "reply") as Reply;
    expect(reply.text).toBe("Ana is the one that matters today.");
    // Yo's own start notes stay in Yo; Start sends what the row shows.
    expect(reply).not.toHaveProperty("briefText");
    expect(reply.brief).toEqual({
      needsYou: [{ title: "Reply to Ana" }],
      canWait: [],
      today: [{ time: "9:30 AM", title: "Standup" }],
      couldNotCheck: [],
    });
    // Once a day, across the Mac and the phone.
    await ask(phone, { t: "hello", localDate: today });
    expect(orch.sent).toHaveLength(1);
  });

  it("doesn't claim the brief without localDate, with a bad one, or when it's turned off", async () => {
    const today = await briefSetup();
    const phone = await pairPhone();
    await ask(phone, { t: "hello" });
    await ask(phone, { t: "hello", localDate: "2026-02-30" });
    store.updateSettings({ morningBrief: false });
    await ask(phone, { t: "hello", localDate: today });
    expect(orch.sent).toEqual([]);
  });

  it("a brief with no text after it still reaches the phone", async () => {
    const today = await briefSetup();
    const phone = await pairPhone();
    await ask(phone, { t: "hello", localDate: today });
    const call = toolCall("yo__post_brief", { can_wait: [{ title: "3 newsletters" }] });
    orch.finish();
    await channel.idle();
    const reply = (await phone.next()).find((o) => o.t === "reply") as Reply;
    expect(reply).toMatchObject({
      id: call.id,
      text: "Here's your brief. Nothing needs you right now.",
      briefText: true,
      brief: { canWait: [{ title: "3 newsletters" }] },
    });
  });

  it("a brief-only reply reads its Needs you titles, for phones that can't draw the card", async () => {
    const today = await briefSetup();
    const phone = await pairPhone();
    await ask(phone, { t: "hello", localDate: today });
    toolCall("post_brief", {
      needs_you: [
        { title: "Reply to Dana about the lease", start: "Draft it" },
        { title: "Decide on the venue" },
      ],
    });
    orch.finish();
    await channel.idle();
    const reply = (await phone.next()).find((o) => o.t === "reply") as Reply;
    expect(reply.text).toBe("Your brief: • Reply to Dana about the lease • Decide on the venue");
    expect(reply.briefText).toBe(true);
    expect(reply.brief!.needsYou).toEqual([
      { title: "Reply to Dana about the lease" },
      { title: "Decide on the venue" },
    ]);
    const many = briefFallbackText({
      needsYou: Array.from({ length: 7 }, (_, i) => ({ title: `Thing ${i} ${"x".repeat(100)}` })),
      canWait: [],
      today: [],
      couldNotCheck: [],
    });
    expect(many.split("•")).toHaveLength(7);
    expect(many).toMatch(/• and 2 more$/);
    expect(many.length).toBeLessThan(400);
  });

  it("a reply never goes over the relay's size limit because of its brief: the card is left out", async () => {
    const today = await briefSetup();
    const phone = await pairPhone();
    await ask(phone, { t: "hello", localDate: today });
    const long = (n: number) => "é".repeat(n);
    toolCall("post_brief", {
      needs_you: Array.from({ length: 5 }, () => ({ title: long(140), detail: long(280) })),
      today: Array.from({ length: 12 }, () => ({ time: "9:30 AM", title: long(140), detail: long(280) })),
    });
    assistant(long(13_000));
    orch.finish();
    await channel.idle();
    const reply = (await phone.next()).find((o) => o.t === "reply") as Reply;
    expect(reply.text).toHaveLength(13_000);
    expect(reply).not.toHaveProperty("brief");
    expect(reply).not.toHaveProperty("briefText");
    expect(Buffer.byteLength(JSON.stringify(reply), "utf8")).toBeLessThanOrEqual(MAX_OUT_JSON_BYTES);
  });

  it("carries a turn's quick replies, only from its last step", async () => {
    const phone = await pairPhone();
    await text(phone, "flights?");
    await phone.next();
    toolCall("suggest_replies", { replies: ["Yes, book it", "Cheaper ones"] });
    assistant("Book the 9:40?");
    orch.finish();
    await channel.idle();
    const r1 = (await phone.next()).find((o) => o.t === "reply") as Reply;
    expect(r1.replies).toEqual(["Yes, book it", "Cheaper ones"]);
    expect(r1).not.toHaveProperty("brief");

    // Another tool ran after them: they're stale.
    await text(phone, "and hotels?");
    await phone.next();
    toolCall("suggest_replies", { replies: ["Yes", "No"] });
    toolCall("web_search", { q: "hotels" });
    assistant("Here are three hotels.");
    orch.finish();
    await channel.idle();
    expect((await phone.next()).find((o) => o.t === "reply")).not.toHaveProperty("replies");

    // Refused (too long) or failed calls never show.
    await text(phone, "ok");
    await phone.next();
    toolCall("suggest_replies", { replies: ["This one is far too long to fit", "No"] });
    assistant("Which?");
    orch.finish();
    await channel.idle();
    expect((await phone.next()).find((o) => o.t === "reply")).not.toHaveProperty("replies");
  });

  it("a plain reply is exactly as before: no brief, no replies, no tasks", async () => {
    const phone = await pairPhone();
    await text(phone, "hi");
    await phone.next();
    const a = assistant("Hello!");
    orch.finish();
    await channel.idle();
    const out = (await phone.next()).filter((o) => o.t !== "ack");
    expect(out).toEqual([
      { v: 1, t: "reply", id: a.id, agent: "Yo", text: "Hello!", at: expect.any(Number) },
      { v: 1, t: "status", agent: "Yo", state: "idle" },
    ]);
  });
});
