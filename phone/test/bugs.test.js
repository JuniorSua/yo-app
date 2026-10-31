// The relay's bug mailbox: any Yo posts an encrypted report; only the owner's core lists and acks them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUG_KEYS, createRelay, LIMITS } from "../api/relay.js";
import { BUGS_BOX, coreCredFor } from "../lib/crypto.js";
import { createMemoryStore } from "../lib/memoryStore.js";

const REGISTER_KEY = "test-register-key-123";
const UNLIMITED = { ipPerMinute: 1e9, phonePerMinute: 1e9, corePerMinute: 1e9 };
const CT_SECRET = "c1phertextNeverLogged";

let clock;
let mem;
let store;
let relay;
let coreCred;

function spyStore(inner) {
  const spy = {
    kind: inner.kind,
    calls: 0,
    commands: [],
    fail: false,
    async pipeline(cmds) {
      spy.calls += 1;
      spy.commands.push(...cmds);
      if (spy.fail) throw new Error("Upstash HTTP 500");
      return inner.pipeline(cmds);
    },
  };
  return spy;
}

let n = 0;
/** A well-formed envelope (the relay checks shape only; it can't open it). */
function envelope(over = {}) {
  n += 1;
  return {
    v: 1,
    install: "a".repeat(31) + (n % 10),
    epk: "E".repeat(43),
    iv: "I".repeat(16),
    ct: `${CT_SECRET}${"x".repeat(40)}${n}`,
    ...over,
  };
}

function post(body, { ip = "203.0.113.1", raw } = {}) {
  return relay(
    new Request("https://relay.test/api/relay/bugs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: raw ?? JSON.stringify(body),
    }),
  );
}

function asCore(method, path, { body, cred = coreCred } = {}) {
  const headers = {};
  if (cred !== null) headers["X-Yo-Core"] = cred;
  return relay(
    new Request(`https://relay.test${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

const list = () => asCore("GET", "/api/relay/bugs");
const ack = (ids, opts) => asCore("POST", "/api/relay/bugs/ack", { body: { ids }, ...opts });
async function json(p) {
  const r = await p;
  return { status: r.status, body: await r.json(), headers: r.headers };
}

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 8, 12);
  mem = createMemoryStore({ now: () => clock });
  store = spyStore(mem);
  relay = createRelay(store, { now: () => clock, registerKey: REGISTER_KEY, ...UNLIMITED });
  coreCred = await coreCredFor(REGISTER_KEY, BUGS_BOX);
});

afterEach(() => vi.restoreAllMocks());

describe("POST /bugs (any Yo)", () => {
  it("stores the envelope and answers a report id, with no other credential", async () => {
    const env = envelope();
    const r = await json(post(env));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, reportId: expect.stringMatching(/^YO-[A-Z2-9]{6}$/) });
    const got = await json(list());
    expect(got.body.items).toEqual([{ id: r.body.reportId, at: clock, ...env }]);
  });

  it("accepts only the exact envelope shape", async () => {
    const bad = [
      { ...envelope(), extra: 1 },
      (({ iv: _iv, ...rest }) => rest)(envelope()),
      envelope({ v: 2 }),
      envelope({ install: "inst_raw_id_not_hashed_000000000" }),
      envelope({ install: "A".repeat(32) }),
      envelope({ epk: "E".repeat(42) }),
      envelope({ iv: "I".repeat(17) }),
      envelope({ ct: "short" }),
      envelope({ ct: `${"x".repeat(40)}+/=` }),
      envelope({ ct: 12 }),
    ];
    // (Each from its own address: every attempt counts towards the per-IP cap, valid or not.)
    for (const [i, body] of bad.entries())
      expect((await post(body, { ip: `198.51.100.${i}` })).status, JSON.stringify(body).slice(0, 80)).toBe(
        400,
      );
    expect((await post(null, { raw: "[1,2]", ip: "198.51.100.200" })).status).toBe(400);
    expect((await post(null, { raw: "not json", ip: "198.51.100.201" })).status).toBe(400);
    expect(store.commands.filter((c) => c[0] === "RPUSH")).toHaveLength(0);
  });

  it("413s bodies over 600 KB before parsing them", async () => {
    const r = await post(envelope({ ct: "x".repeat(LIMITS.bugBodyBytes) }));
    expect(r.status).toBe(413);
    expect(store.calls).toBe(0);
    // Just under the cap is fine.
    expect((await post(envelope({ ct: "x".repeat(LIMITS.bugBodyBytes - 400) }))).status).toBe(200);
  });

  it("costs 3 commands, plus 2 for the day's first report (TTLs on both keys)", async () => {
    await post(envelope());
    expect(store.commands.map((c) => c[0])).toEqual(["INCR", "RPUSH", "LTRIM", "EXPIRE", "EXPIRE"]);
    expect(await mem.pipeline([["TTL", BUG_KEYS.inbox]])).toEqual([LIMITS.bugTtlSeconds]);
    const dayKey = `${BUG_KEYS.dayPrefix}${Math.floor(clock / 86_400_000)}`;
    expect((await mem.pipeline([["TTL", dayKey]]))[0]).toBeGreaterThan(86_400);
    store.commands.length = 0;
    await post(envelope());
    expect(store.commands.map((c) => c[0])).toEqual(["INCR", "RPUSH", "LTRIM"]);
  });

  it("gives a list it re-created a TTL even when it isn't the day's first report", async () => {
    await post(envelope());
    const { body } = await json(list());
    await ack(body.items.map((i) => i.id)); // empty again: the key is gone
    store.commands.length = 0;
    await post(envelope());
    expect(store.commands.map((c) => c[0])).toEqual(["INCR", "RPUSH", "LTRIM", "EXPIRE"]);
    expect(await mem.pipeline([["TTL", BUG_KEYS.inbox]])).toEqual([LIMITS.bugTtlSeconds]);
  });

  it("keeps at most 200 reports (the newest)", async () => {
    for (let i = 0; i < LIMITS.bugKeep + 5; i++) await post(envelope(), { ip: `198.51.100.${i % 250}` });
    expect(await mem.pipeline([["LLEN", BUG_KEYS.inbox]])).toEqual([LIMITS.bugKeep]);
  });

  it("the mailbox expires 14 days after the last refresh", async () => {
    await post(envelope());
    clock += LIMITS.bugTtlSeconds * 1000 + 1;
    expect((await json(list())).body.items).toEqual([]);
    expect(mem.keys().filter((k) => k === BUG_KEYS.inbox)).toEqual([]);
  });

  it("caps each IP at 10 an hour, in memory and before Redis", async () => {
    for (let i = 0; i < 10; i++) expect((await post(envelope())).status).toBe(200);
    const calls = store.calls;
    const r = await post(envelope());
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(store.calls).toBe(calls);
    expect((await post(envelope(), { ip: "203.0.113.2" })).status).toBe(200);
    clock += 60 * 60 * 1000;
    expect((await post(envelope())).status).toBe(200);
  });

  it("caps each install at 20 a day across IPs, before Redis", async () => {
    const install = "b".repeat(32);
    for (let i = 0; i < 20; i++)
      expect((await post(envelope({ install }), { ip: `198.51.100.${i}` })).status).toBe(200);
    const calls = store.calls;
    const r = await post(envelope({ install }), { ip: "198.51.100.99" });
    expect(r.status).toBe(429);
    expect(store.calls).toBe(calls);
    expect((await post(envelope({ install: "c".repeat(32) }), { ip: "198.51.100.99" })).status).toBe(200);
  });

  it("caps everyone together per day with one Redis counter, until the next UTC day", async () => {
    relay = createRelay(store, { now: () => clock, registerKey: REGISTER_KEY, ...UNLIMITED, bugsPerDay: 3 });
    for (let i = 0; i < 3; i++) expect((await post(envelope(), { ip: `198.51.100.${i}` })).status).toBe(200);
    store.commands.length = 0;
    const r = await post(envelope(), { ip: "198.51.100.50" });
    expect(r.status).toBe(429);
    expect(store.commands.map((c) => c[0])).toEqual(["INCR"]); // refused for one command
    const midnight = (Math.floor(clock / 86_400_000) + 1) * 86_400_000;
    expect(Number(r.headers.get("retry-after"))).toBe(Math.ceil((midnight - clock) / 1000));
    clock = midnight + 1;
    expect((await post(envelope(), { ip: "198.51.100.51" })).status).toBe(200);
  });

  it("uses the documented defaults", () => {
    expect(LIMITS).toMatchObject({
      bugsPerIpPerHour: 10,
      bugsPerInstallPerDay: 20,
      bugsPerDay: 300,
      bugKeep: 200,
      bugTtlSeconds: 14 * 86_400,
      bugBodyBytes: 600 * 1024,
    });
  });

  it("works without a register key (sending needs none) but 503s without storage", async () => {
    relay = createRelay(store, { now: () => clock, ...UNLIMITED });
    expect((await post(envelope())).status).toBe(200);
    relay = createRelay(null, { now: () => clock, ...UNLIMITED });
    expect((await post(envelope())).status).toBe(503);
  });

  it("never logs a report, even when storage fails", async () => {
    const spies = ["log", "info", "warn", "error", "debug"].map((m) => vi.spyOn(console, m));
    store.fail = true;
    const r = await post(envelope());
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "Storage unavailable" });
    store.fail = false;
    await post(envelope({ v: 3 }));
    await post(envelope());
    await list();
    for (const s of spies)
      for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain(CT_SECRET);
    expect(spies.find((s) => s.mock.calls.length)).toBeTruthy(); // the failure was logged, without the body
  });
});

describe("GET /bugs and POST /bugs/ack (the owner's core only)", () => {
  it("refuse anyone without the bug core credential, before Redis", async () => {
    const box = "f".repeat(64); // a phone mailbox's core credential isn't the bug one
    const wrong = [
      null,
      "x",
      "A".repeat(43),
      await coreCredFor(REGISTER_KEY, box),
      await coreCredFor("other", BUGS_BOX),
    ];
    for (const cred of wrong) {
      expect((await asCore("GET", "/api/relay/bugs", { cred })).status).toBe(401);
      expect((await ack(["YO-ABCDEF"], { cred })).status).toBe(401);
    }
    expect(store.calls).toBe(0);
    relay = createRelay(store, { now: () => clock });
    expect((await list()).status).toBe(503);
  });

  it("405s other methods", async () => {
    expect((await asCore("DELETE", "/api/relay/bugs")).status).toBe(405);
    expect((await asCore("GET", "/api/relay/bugs/ack")).status).toBe(405);
  });

  it("an idle poll is one LRANGE", async () => {
    const r = await json(list());
    expect(r).toMatchObject({ status: 200, body: { items: [] } });
    expect(store.commands).toEqual([["LRANGE", BUG_KEYS.inbox, 0, LIMITS.bugBatch - 1]]);
  });

  it("lists the oldest 5, says there are more, and ack removes exactly the ids given", async () => {
    const ids = [];
    for (let i = 0; i < 7; i++)
      ids.push((await json(post(envelope(), { ip: `198.51.100.${i}` }))).body.reportId);
    const first = await json(list());
    expect(first.body.items.map((i) => i.id)).toEqual(ids.slice(0, 5));
    expect(first.body.more).toBe(true);
    // The core filed #1 and #3; #2 failed on GitHub and stays.
    store.commands.length = 0;
    const r = await json(ack([ids[0], ids[2], "YO-ZZZZZZ"]));
    expect(r.body).toEqual({ ok: true, removed: 2 });
    expect(store.commands.map((c) => c[0])).toEqual(["LRANGE", "LREM", "LREM"]);
    const next = await json(list());
    expect(next.body.items.map((i) => i.id)).toEqual([ids[1], ids[3], ids[4], ids[5], ids[6]]);
    expect(next.body.more).toBe(true);
    await ack(next.body.items.map((i) => i.id));
    expect((await json(list())).body).toEqual({ items: [] });
  });

  it("validates ack ids", async () => {
    for (const ids of [undefined, "YO-ABCDEF", ["yo-abcdef"], [1], Array(11).fill("YO-ABCDEF")])
      expect((await asCore("POST", "/api/relay/bugs/ack", { body: { ids } })).status).toBe(400);
    expect((await json(ack([]))).body).toEqual({ ok: true, removed: 0 });
  });

  it("keeps a response under Vercel's limit", async () => {
    const big = "y".repeat(500_000);
    for (let i = 0; i < 5; i++) await post(envelope({ ct: `${big}${i}0` }), { ip: `198.51.100.${i}` });
    const r = await json(list());
    const size = r.body.items.reduce((s, i) => s + i.ct.length, 0);
    expect(r.body.items.length).toBe(5);
    expect(size).toBeLessThanOrEqual(LIMITS.bugResponseChars);
  });

  it("doesn't touch phone mailboxes", async () => {
    await post(envelope());
    expect(mem.keys().every((k) => k.startsWith("yo:bugs:"))).toBe(true);
  });
});
