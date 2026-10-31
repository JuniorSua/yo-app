import { beforeEach, describe, expect, it } from "vitest";
import { createRateLimiter, createRelay, LIMITS } from "../api/relay.js";
import { generateSignKey, signOut } from "../core/sign.mjs";
import {
  admitFor,
  boxFor,
  coreCredFor,
  deriveKeys,
  open,
  randomSecret,
  seal,
  verifyOut,
} from "../lib/crypto.js";
import { createMemoryStore } from "../lib/memoryStore.js";

const TOKEN = "A".repeat(43);
const OTHER = "B".repeat(43);
const ENV = "e".repeat(60); // any base64url string long enough to be an envelope
const env = (i) => `${ENV}${String(i).padStart(4, "0")}`;
const SIG = "s".repeat(86); // shape of an Ed25519 signature (the relay checks format, not validity)
const REGISTER_KEY = "test-register-key-123";
const UNLIMITED = { ipPerMinute: 1e9, phonePerMinute: 1e9, corePerMinute: 1e9 };

let clock;
let mem;
let store;
let relay;

// Wraps the memory store so tests can assert that a request never reached storage.
function spyStore(inner) {
  const spy = {
    kind: inner.kind,
    calls: 0,
    commands: [],
    async pipeline(cmds) {
      spy.calls += 1;
      spy.commands.push(...cmds);
      return inner.pipeline(cmds);
    },
  };
  return spy;
}

const credCache = new Map();
async function credsFor(token, key = REGISTER_KEY) {
  const id = `${key}|${token}`;
  if (!credCache.has(id)) {
    const box = await boxFor(token);
    credCache.set(id, { admit: await admitFor(key, box), core: await coreCredFor(key, box) });
  }
  return credCache.get(id);
}

/** Calls the relay as the core by default (admit + core headers); pass `core: null` to act as the phone. */
async function call(method, path, { token = TOKEN, admit, core, body, raw, headers = {}, ip } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) {
    init.headers.Authorization = `Bearer ${token}`;
    const creds = TOKEN_RE.test(token) ? await credsFor(token) : { admit: "x", core: "x" };
    const a = admit === undefined ? creds.admit : admit;
    const c = core === undefined ? creds.core : core;
    if (a !== null) init.headers["X-Yo-Admit"] = a;
    if (c !== null) init.headers["X-Yo-Core"] = c;
  }
  if (ip) init.headers["X-Forwarded-For"] = ip;
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = JSON.stringify(body);
  return relay(new Request(`https://relay.test${path}`, init));
}
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const phone = (method, path, opts = {}) => call(method, path, { ...opts, core: null });
const postOut = (box, opts = {}) => call("POST", "/api/relay/out", { ...opts, body: { box, sig: SIG } });

async function json(resPromise) {
  const res = await resPromise;
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const register = (token = TOKEN) => call("POST", "/api/relay/register", { token });

beforeEach(async () => {
  clock = 1_800_000_000_000;
  mem = createMemoryStore({ now: () => clock });
  store = spyStore(mem);
  relay = createRelay(store, { now: () => clock, registerKey: REGISTER_KEY, ...UNLIMITED });
  expect((await register()).status).toBe(200);
});

describe("auth and basics", () => {
  it("health needs no auth and reports the store", async () => {
    const r = await json(call("GET", "/api/relay/health", { token: null }));
    expect(r).toMatchObject({ status: 200, body: { ok: true, store: "memory" } });
    expect(r.headers.get("cache-control")).toBe("no-store");
    const missing = await createRelay(null)(new Request("https://relay.test/api/relay/health"));
    expect(await missing.json()).toEqual({ ok: true, store: "missing" });
  });

  it("rejects missing or malformed tokens with 401 on every route", async () => {
    for (const [m, p] of [
      ["POST", "/api/relay/register"],
      ["DELETE", "/api/relay/box"],
      ["POST", "/api/relay/in"],
      ["GET", "/api/relay/in"],
      ["POST", "/api/relay/in/ack"],
      ["POST", "/api/relay/out"],
      ["GET", "/api/relay/out"],
    ]) {
      for (const token of [null, "short", `${"A".repeat(42)}+`, `${TOKEN}A`]) {
        const r = await json(call(m, p, { token, body: m === "POST" ? { box: ENV } : undefined }));
        expect(r.status, `${m} ${p} ${token}`).toBe(401);
        expect(r.headers.get("cache-control")).toBe("no-store");
      }
    }
    const basic = await call("GET", "/api/relay/out", {
      token: null,
      headers: { Authorization: `Basic ${TOKEN}` },
    });
    expect(basic.status).toBe(401);
  });

  it("404s unknown routes and 405s wrong methods", async () => {
    expect((await call("GET", "/api/relay/nope")).status).toBe(404);
    expect((await call("GET", "/api/relay/in/ack")).status).toBe(405);
    expect((await call("POST", "/api/relay/health")).status).toBe(405);
  });

  it("accepts the route from the rewrite's ?route= as well as the path", async () => {
    await call("POST", "/api/relay?route=in", { body: { box: ENV } });
    const r = await json(call("GET", "/api/relay?route=in"));
    expect(r.body.items).toEqual([ENV]);
  });

  it("503s when no store or no register key is configured", async () => {
    relay = createRelay(null, { registerKey: REGISTER_KEY });
    expect((await call("GET", "/api/relay/out")).status).toBe(503);
    relay = createRelay(store, {});
    const before = store.calls;
    expect((await call("GET", "/api/relay/out")).status).toBe(503);
    expect((await register(OTHER)).status).toBe(503);
    expect(store.calls).toBe(before);
  });

  it("502s when the store fails", async () => {
    relay = createRelay(
      { kind: "upstash", pipeline: async () => Promise.reject(new Error("down")) },
      { registerKey: REGISTER_KEY },
    );
    const orig = console.error;
    console.error = () => {};
    try {
      expect((await call("GET", "/api/relay/out")).status).toBe(502);
    } finally {
      console.error = orig;
    }
  });
});

describe("POST /in", () => {
  it("validates the body", async () => {
    expect((await call("POST", "/api/relay/in", { raw: "not json" })).status).toBe(400);
    expect((await call("POST", "/api/relay/in", { body: [] })).status).toBe(400);
    expect((await call("POST", "/api/relay/in", { body: {} })).status).toBe(400);
    expect((await call("POST", "/api/relay/in", { body: { box: 5 } })).status).toBe(400);
    expect((await call("POST", "/api/relay/in", { body: { box: "abc" } })).status).toBe(400);
    expect((await call("POST", "/api/relay/in", { body: { box: `${"a".repeat(50)}=` } })).status).toBe(400);
  });

  it("413s envelopes over 64 KB", async () => {
    const ok = await call("POST", "/api/relay/in", { body: { box: "a".repeat(LIMITS.envelopeChars) } });
    expect(ok.status).toBe(200);
    const big = await call("POST", "/api/relay/in", { body: { box: "a".repeat(LIMITS.envelopeChars + 1) } });
    expect(big.status).toBe(413);
    const huge = await call("POST", "/api/relay/in", { raw: JSON.stringify({ box: "a".repeat(200_000) }) });
    expect(huge.status).toBe(413);
  });

  it("queues with a 30-day TTL and 429s past 100 waiting", async () => {
    for (let i = 0; i < LIMITS.inWaiting; i++) {
      const r = await json(call("POST", "/api/relay/in", { body: { box: env(i) } }));
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
    }
    const box = await boxFor(TOKEN);
    const [ttl] = await store.pipeline([["TTL", `yo:phone:${box}:in`]]);
    expect(ttl).toBe(LIMITS.ttlSeconds);
    const full = await call("POST", "/api/relay/in", { body: { box: ENV } });
    expect(full.status).toBe(429);
    const [len, last] = await store.pipeline([
      ["LLEN", `yo:phone:${box}:in`],
      ["LRANGE", `yo:phone:${box}:in`, -1, -1],
    ]);
    expect(len).toBe(LIMITS.inWaiting);
    expect(last).toEqual([env(LIMITS.inWaiting - 1)]);
  });

  it("holds the cap under concurrent sends", async () => {
    const results = await Promise.all(
      Array.from({ length: 130 }, (_, i) => call("POST", "/api/relay/in", { body: { box: env(i) } })),
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(LIMITS.inWaiting);
    expect(codes.filter((c) => c === 429)).toHaveLength(30);
    const box = await boxFor(TOKEN);
    const [len] = await store.pipeline([["LLEN", `yo:phone:${box}:in`]]);
    expect(len).toBe(LIMITS.inWaiting);
  });
});

describe("GET /in and POST /in/ack", () => {
  it("returns at most 50, oldest first, and ack trims what was read", async () => {
    for (let i = 0; i < 60; i++) await call("POST", "/api/relay/in", { body: { box: env(i) } });
    const first = await json(call("GET", "/api/relay/in"));
    expect(first.body.items).toHaveLength(50);
    expect(first.body.items[0]).toBe(env(0));
    expect(first.body.items[49]).toBe(env(49));

    // a message that arrives between the read and the ack must survive
    await call("POST", "/api/relay/in", { body: { box: env(60) } });
    expect((await json(call("POST", "/api/relay/in/ack", { body: { count: 50 } }))).body).toEqual({
      ok: true,
    });
    const rest = await json(call("GET", "/api/relay/in"));
    expect(rest.body.items).toEqual([...Array.from({ length: 11 }, (_, i) => env(50 + i))]);

    await call("POST", "/api/relay/in/ack", { body: { count: 11 } });
    expect((await json(call("GET", "/api/relay/in"))).body.items).toEqual([]);
  });

  it("validates count", async () => {
    for (const count of [-1, 1.5, "x", null, 101]) {
      expect((await call("POST", "/api/relay/in/ack", { body: { count } })).status, String(count)).toBe(400);
    }
    expect((await call("POST", "/api/relay/in/ack", { body: { count: 0 } })).status).toBe(200);
    expect((await call("POST", "/api/relay/in/ack", { body: { count: "3" } })).status).toBe(200);
  });

  it("keeps mailboxes apart", async () => {
    await register(OTHER);
    await call("POST", "/api/relay/in", { body: { box: ENV } });
    expect((await json(call("GET", "/api/relay/in", { token: OTHER }))).body.items).toEqual([]);
  });
});

describe("beat and seen", () => {
  it("beat=1 sets seen for 10 minutes; plain polls don't", async () => {
    expect((await json(call("GET", "/api/relay/out"))).body.seen).toBeNull();
    await call("GET", "/api/relay/in");
    expect((await json(call("GET", "/api/relay/out"))).body.seen).toBeNull();
    await call("GET", "/api/relay/in?beat=1");
    expect((await json(call("GET", "/api/relay/out"))).body.seen).toBe(clock);
    const box = await boxFor(TOKEN);
    const [ttl] = await store.pipeline([["TTL", `yo:phone:${box}:seen`]]);
    expect(ttl).toBe(600);
    clock += 601_000;
    expect((await json(call("GET", "/api/relay/out"))).body.seen).toBeNull();
  });
});

describe("POST /out and GET /out", () => {
  it("numbers envelopes and filters by after", async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await json(postOut(env(i)));
      expect(r.body).toEqual({ seq: i });
    }
    const all = await json(call("GET", "/api/relay/out"));
    expect(all.body).toEqual({
      items: [
        { seq: 1, box: env(1), sig: SIG },
        { seq: 2, box: env(2), sig: SIG },
        { seq: 3, box: env(3), sig: SIG },
      ],
      seen: null,
    });
    expect((await json(call("GET", "/api/relay/out?after=2"))).body.items).toEqual([
      { seq: 3, box: env(3), sig: SIG },
    ]);
    expect((await json(call("GET", "/api/relay/out?after=3"))).body.items).toEqual([]);
    expect((await call("GET", "/api/relay/out?after=-1")).status).toBe(400);
    expect((await call("GET", "/api/relay/out?after=abc")).status).toBe(400);
  });

  it("keeps the last 300 and sets TTLs on every key", async () => {
    for (let i = 1; i <= 305; i++) await postOut(env(i));
    const r = await json(call("GET", "/api/relay/out"));
    expect(r.body.items).toHaveLength(300);
    expect(r.body.items[0].seq).toBe(6);
    expect(r.body.items.at(-1).seq).toBe(305);
    await call("POST", "/api/relay/in", { body: { box: ENV } });
    await call("GET", "/api/relay/in?beat=1");
    const keys = mem.keys();
    expect(keys.every((k) => k.startsWith("yo:phone:"))).toBe(true);
    expect(keys.sort().map((k) => k.split(":").at(-1))).toEqual(["in", "ok", "out", "outseq", "seen"]);
    const ttls = await store.pipeline(keys.map((k) => ["TTL", k]));
    expect(ttls.every((t) => t > 0)).toBe(true);
  });

  it("validates out bodies like in", async () => {
    expect((await postOut("nope!")).status).toBe(400);
    expect((await postOut("a".repeat(LIMITS.envelopeChars + 1))).status).toBe(413);
  });

  it("flags a reset when the mailbox expired under the phone's cursor", async () => {
    await postOut(env(1));
    const r = await json(call("GET", "/api/relay/out?after=40"));
    expect(r.body).toMatchObject({ items: [{ seq: 1, box: env(1), sig: SIG }], reset: true });
    expect((await json(call("GET", "/api/relay/out?after=1"))).body.reset).toBeUndefined();
  });
});

describe("end to end with real envelopes", () => {
  it("phone → relay → core and back", async () => {
    const secret = randomSecret();
    const { authToken, encKey } = await deriveKeys(secret);
    await register(authToken);
    const msg = { v: 1, t: "msg", id: "m1", text: "hi", at: 1 };
    await call("POST", "/api/relay/in", { token: authToken, body: { box: await seal(encKey, msg, "in") } });
    const inbox = await json(call("GET", "/api/relay/in?beat=1", { token: authToken }));
    expect(await open(encKey, inbox.body.items[0], "in")).toEqual(msg);
    await call("POST", "/api/relay/in/ack", { token: authToken, body: { count: 1 } });
    const reply = { v: 1, t: "reply", id: "r1", agent: "Yo", text: "Got it", at: 2 };
    const sign = await generateSignKey();
    const envelope = await seal(encKey, reply, "out");
    await call("POST", "/api/relay/out", {
      token: authToken,
      body: { box: envelope, sig: await signOut(sign.pkcs8, envelope) },
    });
    const out = await json(phone("GET", "/api/relay/out?after=0", { token: authToken }));
    expect(out.body.seen).toBe(clock);
    const item = out.body.items[0];
    expect(await verifyOut(sign.signPub, item.box, item.sig)).toBe(true);
    expect(await open(encKey, item.box, "out")).toEqual(reply);
    // the relay can't reflect it back the other way
    await expect(open(encKey, out.body.items[0].box, "in")).rejects.toThrow();
  });
});

describe("register", () => {
  it("needs the core credential, not the phone's", async () => {
    const before = store.calls;
    const other = await credsFor(OTHER);
    const reg = (opts) => call("POST", "/api/relay/register", { token: OTHER, ...opts });
    expect((await reg({ core: null })).status).toBe(401);
    expect((await reg({ core: other.admit })).status).toBe(401);
    expect((await reg({ core: (await credsFor(TOKEN)).core })).status).toBe(401);
    // the old X-Yo-Register-Key header is not a way in any more
    expect((await reg({ core: null, headers: { "X-Yo-Register-Key": REGISTER_KEY } })).status).toBe(401);
    expect(store.calls).toBe(before);
  });

  it("sets ok for 30 days and is idempotent", async () => {
    const r = await json(register(OTHER));
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect((await register(OTHER)).status).toBe(200);
    const box = await boxFor(OTHER);
    const [val, ttl] = await mem.pipeline([
      ["GET", `yo:phone:${box}:ok`],
      ["TTL", `yo:phone:${box}:ok`],
    ]);
    expect(val).toBe("1");
    expect(ttl).toBe(LIMITS.ttlSeconds);
  });

  it("never writes for an unknown box: POST in, POST out, GET in with beat, GET out", async () => {
    const before = mem.keys().length;
    const cmdsBefore = store.commands.length;
    const results = [
      await json(phone("POST", "/api/relay/in", { token: OTHER, body: { box: ENV } })),
      await json(postOut(ENV, { token: OTHER })),
      await json(call("GET", "/api/relay/in?beat=1", { token: OTHER })),
      await json(phone("GET", "/api/relay/out", { token: OTHER })),
    ];
    for (const r of results) expect(r).toMatchObject({ status: 404, body: { error: "link_revoked" } });
    expect(mem.keys()).toHaveLength(before);
    const used = store.commands.slice(cmdsBefore).map(([name]) => name);
    expect(used.every((n) => ["EXISTS", "LRANGE", "GET"].includes(n))).toBe(true);
    // a trim on a box nobody can write to is harmless
    expect((await call("POST", "/api/relay/in/ack", { token: OTHER, body: { count: 1 } })).status).toBe(200);
  });

  it("a plain GET in is exactly one LRANGE, even for an unknown box, and writes nothing", async () => {
    await call("POST", "/api/relay/in", { body: { box: ENV } });
    for (const token of [TOKEN, OTHER]) {
      const before = { calls: store.calls, cmds: store.commands.length, keys: mem.keys().length };
      const r = await json(call("GET", "/api/relay/in", { token }));
      expect(r.status).toBe(200);
      expect(r.body.items).toEqual(token === TOKEN ? [ENV] : []);
      expect(store.calls - before.calls).toBe(1);
      expect(store.commands.slice(before.cmds).map(([n]) => n)).toEqual(["LRANGE"]);
      expect(mem.keys()).toHaveLength(before.keys);
    }
  });

  it("a beat checks ok in the same pipeline as LRANGE, then sets seen", async () => {
    const cmds = store.commands.length;
    const calls = store.calls;
    await call("GET", "/api/relay/in?beat=1");
    const used = store.commands.slice(cmds).map(([n]) => n);
    expect(used.slice(0, 3)).toEqual(["EXISTS", "LRANGE", "SET"]);
    expect(store.calls - calls).toBeGreaterThanOrEqual(2); // + the once-a-day TTL refresh here (first beat)
    const box = await boxFor(TOKEN);
    expect((await mem.pipeline([["EXISTS", `yo:phone:${box}:seen`]]))[0]).toBe(1);
  });

  it("a registration that expires stops writes", async () => {
    clock += LIMITS.ttlSeconds * 1000 + 1000;
    expect((await call("POST", "/api/relay/in", { body: { box: ENV } })).status).toBe(404);
  });
});

describe("admission (stateless, before storage)", () => {
  it("rejects a missing, malformed or wrong admit with 401 and zero store calls", async () => {
    const before = store.calls;
    const otherAdmit = (await credsFor(OTHER)).admit;
    const wrongKeyAdmit = (await credsFor(TOKEN, "some-other-register-key")).admit;
    const routes = [
      ["POST", "/api/relay/in"],
      ["GET", "/api/relay/out"],
      ["GET", "/api/relay/in?beat=1"],
      ["POST", "/api/relay/out"],
      ["POST", "/api/relay/register"],
      ["DELETE", "/api/relay/box"],
      ["POST", "/api/relay/in/ack"],
    ];
    for (const admit of [null, "", "short", `${"a".repeat(42)}+`, otherAdmit, wrongKeyAdmit]) {
      for (const [m, p] of routes) {
        const body = m === "POST" ? { box: ENV, sig: SIG, count: 1 } : undefined;
        expect((await call(m, p, { admit, body })).status, `${m} ${p} admit=${admit}`).toBe(401);
      }
    }
    expect(store.calls).toBe(before);
  });

  it("phone routes work with admit alone", async () => {
    expect((await phone("POST", "/api/relay/in", { body: { box: ENV } })).status).toBe(200);
    expect((await phone("GET", "/api/relay/out")).status).toBe(200);
  });

  it("core routes reject the phone credential", async () => {
    const { admit } = await credsFor(TOKEN);
    const before = store.calls;
    for (const [m, p] of [
      ["GET", "/api/relay/in"],
      ["GET", "/api/relay/in?beat=1"],
      ["POST", "/api/relay/in/ack"],
      ["POST", "/api/relay/out"],
      ["DELETE", "/api/relay/box"],
      ["POST", "/api/relay/register"],
    ]) {
      const body = m === "POST" ? { box: ENV, sig: SIG, count: 1 } : undefined;
      expect((await phone(m, p, { body })).status, `${m} ${p} no core`).toBe(401);
      expect((await call(m, p, { core: admit, body })).status, `${m} ${p} admit as core`).toBe(401);
      expect((await call(m, p, { core: "x".repeat(43), body })).status, `${m} ${p} junk core`).toBe(401);
    }
    expect(store.calls).toBe(before);
  });
});

describe("POST /out signatures", () => {
  it("requires a sig of the right shape", async () => {
    const before = store.calls;
    for (const sig of [undefined, null, 5, "", "s".repeat(85), "s".repeat(87), `${"s".repeat(85)}+`]) {
      const res = await call("POST", "/api/relay/out", { body: { box: ENV, sig } });
      expect(res.status, String(sig)).toBe(400);
    }
    expect(store.calls).toBe(before);
    expect((await postOut(ENV)).status).toBe(200);
  });
});

describe("rate limits (in memory, before storage)", () => {
  const limited = (limits) => createRelay(store, { now: () => clock, registerKey: REGISTER_KEY, ...limits });

  it("limits each IP and sends Retry-After", async () => {
    relay = limited({ ipPerMinute: 5, phonePerMinute: 1e9, corePerMinute: 1e9 });
    for (let i = 0; i < 5; i++) {
      expect((await phone("GET", "/api/relay/out", { ip: "1.2.3.4" })).status).toBe(200);
    }
    const before = store.calls;
    const res = await phone("GET", "/api/relay/out", { ip: "1.2.3.4, 203.0.113.9" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    // unauthenticated requests count too, and none of it touches storage
    expect((await call("GET", "/api/relay/out", { token: null, ip: "1.2.3.4" })).status).toBe(429);
    expect(store.calls).toBe(before);
    // another IP is fine; X-Real-IP is used when there's no X-Forwarded-For
    expect((await phone("GET", "/api/relay/out", { ip: "5.6.7.8" })).status).toBe(200);
    const real = await phone("GET", "/api/relay/out", { headers: { "X-Real-IP": "1.2.3.4" } });
    expect(real.status).toBe(429);
    clock += 60_001;
    expect((await phone("GET", "/api/relay/out", { ip: "1.2.3.4" })).status).toBe(200);
  });

  it("limits each box across IPs", async () => {
    relay = limited({ ipPerMinute: 1e9, phonePerMinute: 3, corePerMinute: 1e9 });
    for (let i = 0; i < 3; i++) {
      expect((await phone("GET", "/api/relay/out", { ip: `9.9.9.${i}` })).status).toBe(200);
    }
    const before = store.calls;
    const res = await phone("GET", "/api/relay/out", { ip: "9.9.9.99" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(store.calls).toBe(before);
    await register(OTHER).catch(() => {});
    expect((await phone("GET", "/api/relay/out", { token: OTHER })).status).not.toBe(429);
  });

  it("gives the phone and the core separate budgets per box, so a flood from the link can't starve the core", async () => {
    relay = limited({ ipPerMinute: 1e9, phonePerMinute: 3, corePerMinute: 2 });
    for (let i = 0; i < 3; i++) {
      expect((await phone("GET", "/api/relay/out", { ip: `8.8.8.${i}` })).status).toBe(200);
    }
    expect((await phone("GET", "/api/relay/out")).status).toBe(429);
    expect((await phone("POST", "/api/relay/in", { body: { box: ENV } })).status).toBe(429);
    // The phone's budget is spent; the core's isn't.
    expect((await call("GET", "/api/relay/in")).status).toBe(200);
    expect((await call("GET", "/api/relay/in?beat=1")).status).toBe(200);
    const coreWait = await call("GET", "/api/relay/in");
    expect(coreWait.status).toBe(429);
    expect(coreWait.headers.get("retry-after")).toBeTruthy();
    clock += 60_001;
    expect((await phone("GET", "/api/relay/out")).status).toBe(200);
    expect((await call("GET", "/api/relay/in")).status).toBe(200);
  });

  it("uses the protocol's defaults: 120 a minute per IP, 60 per box for the phone and 90 for the core", () => {
    expect(LIMITS.ipPerMinute).toBe(120);
    expect(LIMITS.phonePerMinute).toBe(60);
    expect(LIMITS.corePerMinute).toBe(90);
  });

  it("keeps its memory bounded", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 50 });
    for (let i = 0; i < 1000; i++) limiter.hit(`ip-${i}`, 0);
    expect(limiter.size).toBeLessThanOrEqual(50);
    expect(limiter.hit("ip-999", 1)).toBeGreaterThan(0); // recent keys survive and still count
    for (let i = 0; i < 100; i++) limiter.hit(`late-${i}`, 5000); // expired windows go first
    expect(limiter.size).toBeLessThanOrEqual(50);
  });
});

describe("DELETE /box", () => {
  it("wipes every key of the box, including ok, and leaves other boxes alone", async () => {
    await register(OTHER);
    await call("POST", "/api/relay/in", { token: OTHER, body: { box: ENV } });
    await call("POST", "/api/relay/in", { body: { box: ENV } });
    await postOut(ENV);
    await call("GET", "/api/relay/in?beat=1");
    const box = await boxFor(TOKEN);
    expect(mem.keys().filter((k) => k.includes(box))).toHaveLength(5);
    const r = await json(call("DELETE", "/api/relay/box"));
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(mem.keys().filter((k) => k.includes(box))).toEqual([]);
    expect((await json(call("POST", "/api/relay/in", { body: { box: ENV } }))).body).toEqual({
      error: "link_revoked",
    });
    const other = await boxFor(OTHER);
    expect(mem.keys().filter((k) => k.includes(other)).length).toBeGreaterThan(0);
  });
});

describe("beat keeps a live mailbox alive", () => {
  const ttlOf = async (name) =>
    (await store.pipeline([["TTL", `yo:phone:${await boxFor(TOKEN)}:${name}`]]))[0];

  it("refreshes ok/in/out/outseq on the first beat of a day, not on every beat", async () => {
    await call("POST", "/api/relay/in", { body: { box: ENV } });
    await postOut(ENV);
    clock += 10 * 24 * 3600 * 1000; // 10 days later, core comes online
    for (const k of ["ok", "in", "out", "outseq"])
      expect(await ttlOf(k)).toBe(LIMITS.ttlSeconds - 10 * 86400);
    await call("GET", "/api/relay/in?beat=1"); // first beat after being offline → refresh
    for (const k of ["ok", "in", "out", "outseq"]) expect(await ttlOf(k), k).toBe(LIMITS.ttlSeconds);

    clock += 2 * 60 * 1000; // a later beat the same day → no refresh
    await call("GET", "/api/relay/in?beat=1");
    expect(await ttlOf("ok")).toBe(LIMITS.ttlSeconds - 120);
  });

  it("refreshes again once the UTC day changes, even with no gap in beats", async () => {
    const DAY = 86_400_000;
    clock = Math.ceil(clock / DAY) * DAY - 60_000; // one minute before midnight UTC
    await call("GET", "/api/relay/in?beat=1");
    clock += 30_000;
    await call("GET", "/api/relay/in?beat=1");
    expect(await ttlOf("ok")).toBe(LIMITS.ttlSeconds - 30);
    clock += 60_000; // past midnight
    await call("GET", "/api/relay/in?beat=1");
    expect(await ttlOf("ok")).toBe(LIMITS.ttlSeconds);
  });

  it("doesn't bring back a revoked box", async () => {
    await call("DELETE", "/api/relay/box");
    await call("GET", "/api/relay/in?beat=1");
    expect(await ttlOf("ok")).toBe(-2);
    expect((await call("POST", "/api/relay/in", { body: { box: ENV } })).status).toBe(404);
  });
});

describe("GET /out response cap", () => {
  it("returns about 1 MB at a time, oldest first, with more: true until done", async () => {
    const big = (i) => `${"b".repeat(60_000)}${String(i).padStart(4, "0")}`;
    for (let i = 1; i <= 40; i++) await postOut(big(i));
    let after = 0;
    const pages = [];
    for (;;) {
      const r = await json(call("GET", `/api/relay/out?after=${after}`));
      const size = r.body.items.reduce((n, i) => n + i.box.length, 0);
      expect(size).toBeLessThanOrEqual(LIMITS.outResponseChars);
      pages.push(r.body.items.map((i) => i.seq));
      after = r.body.items.at(-1).seq;
      if (!r.body.more) break;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(pages[0][0]).toBe(1);
  });

  it("always returns at least one item and no more flag when it all fits", async () => {
    await postOut(ENV);
    const r = await json(call("GET", "/api/relay/out"));
    expect(r.body.more).toBeUndefined();
    expect(r.body.items).toHaveLength(1);
  });
});

describe("pictures (blob routes, v2.1)", () => {
  const ID = "i".repeat(22);
  const ID2 = "j".repeat(22);
  const blob = (n = 1000) => "b".repeat(n);
  const postBlob = (dir, id, box, who = call) => who("POST", `/api/relay/blob/${dir}`, { body: { id, box } });

  it("core posts blob/out, the phone fetches it; and the other way round", async () => {
    expect((await postBlob("out", ID, blob())).status).toBe(200);
    const got = await json(phone("GET", `/api/relay/blob/out?id=${ID}`));
    expect(got).toMatchObject({ status: 200, body: { box: blob() } });
    expect((await postBlob("in", ID2, blob(50), phone)).status).toBe(200);
    const back = await json(call("GET", `/api/relay/blob/in?id=${ID2}`));
    expect(back.body.box).toBe(blob(50));
    // Directions are separate keys.
    expect((await json(phone("GET", `/api/relay/blob/out?id=${ID2}`))).body.error).toBe("gone");
  });

  it("enforces roles: the phone can't write out-pictures or read in-pictures", async () => {
    expect((await postBlob("out", ID, blob(), phone)).status).toBe(401);
    expect((await phone("GET", `/api/relay/blob/in?id=${ID}`)).status).toBe(401);
  });

  it("validates ids and sizes", async () => {
    for (const id of ["short", `${ID}x`, "a/b".repeat(8), 5]) {
      expect((await postBlob("out", id, blob())).status, String(id)).toBe(400);
    }
    expect((await call("GET", "/api/relay/blob/in?id=nope")).status).toBe(400);
    expect((await postBlob("out", ID, blob(LIMITS.blobChars + 1))).status).toBe(413);
    expect((await postBlob("out", ID, "a+b")).status).toBe(400);
  });

  it("sets short TTLs and never overwrites a stored picture", async () => {
    const prefix = `yo:phone:${await boxFor(TOKEN)}:`;
    await postBlob("out", ID, blob(100));
    await postBlob("out", ID, blob(200));
    const [ttl, box] = await mem.pipeline([
      ["TTL", `${prefix}blob:out:${ID}`],
      ["GET", `${prefix}blob:out:${ID}`],
    ]);
    expect(ttl).toBe(LIMITS.blobOutTtlSeconds);
    expect(box).toBe(blob(100));
    await postBlob("in", ID2, blob(60), phone);
    const [inTtl] = await mem.pipeline([["TTL", `${prefix}blob:in:${ID2}`]]);
    expect(inTtl).toBe(LIMITS.blobInTtlSeconds);
  });

  it("refuses unregistered or revoked boxes, for writes and reads", async () => {
    await postBlob("out", ID, blob());
    await call("DELETE", "/api/relay/box");
    const read = await json(phone("GET", `/api/relay/blob/out?id=${ID}`));
    expect(read).toMatchObject({ status: 404, body: { error: "link_revoked" } });
    const write = await json(postBlob("out", ID2, blob()));
    expect(write).toMatchObject({ status: 404, body: { error: "link_revoked" } });
    expect(mem.keys().some((k) => k.endsWith(`blob:out:${ID2}`))).toBe(false);
  });

  it("caps the bytes everyone stores per day, and each box's count per day", async () => {
    relay = createRelay(store, {
      now: () => clock,
      registerKey: REGISTER_KEY,
      ...UNLIMITED,
      blobBytesPerDay: 2500,
      blobsPerBoxPerDay: 100,
    });
    const id = (i) => `${String(i).padStart(2, "0")}${"k".repeat(20)}`;
    expect((await postBlob("out", id(1), blob())).status).toBe(200);
    expect((await postBlob("out", id(2), blob())).status).toBe(200);
    expect((await postBlob("out", id(3), blob())).status).toBe(429);
    expect(mem.keys().some((k) => k.endsWith(id(3)))).toBe(false);
    clock += 24 * 60 * 60 * 1000;
    expect((await register()).status).toBe(200);
    expect((await postBlob("out", id(4), blob())).status).toBe(200);

    relay = createRelay(store, {
      now: () => clock,
      registerKey: REGISTER_KEY,
      ...UNLIMITED,
      blobsPerBoxPerDay: 2,
    });
    expect((await postBlob("in", id(5), blob(60), phone)).status).toBe(200);
    expect((await postBlob("in", id(6), blob(60), phone)).status).toBe(200);
    expect((await postBlob("in", id(7), blob(60), phone)).status).toBe(429);
    // The core's direction has its own count.
    expect((await postBlob("out", id(8), blob(60))).status).toBe(200);
  });

  it("a read costs two commands and a write four", async () => {
    store.commands.length = 0;
    await postBlob("out", ID, blob());
    expect(store.commands.map((c) => c[0])).toEqual(["EXISTS", "INCRBY", "EXPIRE", "SET"]);
    store.commands.length = 0;
    await phone("GET", `/api/relay/blob/out?id=${ID}`);
    expect(store.commands.map((c) => c[0])).toEqual(["EXISTS", "GET"]);
  });
});
