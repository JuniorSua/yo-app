import { describe, expect, it, vi } from "vitest";
import { createRelay } from "../api/relay.js";
import { admitFor, boxFor, coreCredFor } from "../lib/crypto.js";
import { createUpstashStore, upstashFromEnv } from "../lib/upstashStore.js";

function mockFetch(responder) {
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const out = responder(body);
    return new Response(JSON.stringify(out.body ?? out), { status: out.status ?? 200 });
  });
  return { fetch, calls };
}

describe("Upstash store", () => {
  it("posts the commands to /pipeline with the bearer token, all as strings", async () => {
    const { fetch, calls } = mockFetch((cmds) => cmds.map((_, i) => ({ result: i === 0 ? 3 : "OK" })));
    const store = createUpstashStore({ url: "https://x.upstash.io/", token: "tok", fetch });
    const res = await store.pipeline([
      ["LLEN", "yo:phone:b:in"],
      ["EXPIRE", "yo:phone:b:in", 2592000],
    ]);
    expect(res).toEqual([3, "OK"]);
    expect(calls[0].url).toBe("https://x.upstash.io/pipeline");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok");
    expect(calls[0].body).toEqual([
      ["LLEN", "yo:phone:b:in"],
      ["EXPIRE", "yo:phone:b:in", "2592000"],
    ]);
  });

  it("throws on HTTP errors and per-command errors", async () => {
    const bad = createUpstashStore({
      url: "https://x",
      token: "t",
      fetch: mockFetch(() => ({ status: 401, body: {} })).fetch,
    });
    await expect(bad.pipeline([["GET", "k"]])).rejects.toThrow(/401/);
    const err = createUpstashStore({
      url: "https://x",
      token: "t",
      fetch: mockFetch(() => [{ error: "WRONGTYPE" }]).fetch,
    });
    await expect(err.pipeline([["GET", "k"]])).rejects.toThrow(/WRONGTYPE/);
  });

  it("reads the env with KV_ names first", () => {
    expect(upstashFromEnv({})).toBeNull();
    expect(upstashFromEnv({ UPSTASH_REDIS_REST_URL: "https://u" })).toBeNull();
    expect(upstashFromEnv({ UPSTASH_REDIS_REST_URL: "https://u", UPSTASH_REDIS_REST_TOKEN: "t" })?.kind).toBe(
      "upstash",
    );
    expect(upstashFromEnv({ KV_REST_API_URL: "https://k", KV_REST_API_TOKEN: "t" })?.kind).toBe("upstash");
  });

  it("drives the relay: only yo:phone: keys, no scans, TTL on writes", async () => {
    const seenCmds = [];
    const { fetch } = mockFetch((cmds) => {
      seenCmds.push(...cmds);
      const results = { INCR: 7, EXISTS: 1, RPUSH: 1, LRANGE: [], GET: null, SET: null, DEL: 5 };
      return cmds.map(([name]) => ({ result: name in results ? results[name] : 1 }));
    });
    const relay = createRelay(createUpstashStore({ url: "https://x", token: "t", fetch }), {
      registerKey: "rk",
    });
    const token = "Z".repeat(43);
    const box = await boxFor(token);
    const auth = {
      Authorization: `Bearer ${token}`,
      "X-Yo-Admit": await admitFor("rk", box),
      "X-Yo-Core": await coreCredFor("rk", box),
    };
    const post = (p, body, extra = {}) =>
      relay(
        new Request(`https://r${p}`, {
          method: "POST",
          headers: { ...auth, ...extra },
          body: JSON.stringify(body),
        }),
      );
    expect((await post("/api/relay/register", {})).status).toBe(200);
    expect(await (await post("/api/relay/out", { box: "e".repeat(60), sig: "s".repeat(86) })).json()).toEqual(
      {
        seq: 7,
      },
    );
    expect((await post("/api/relay/in", { box: "e".repeat(60) })).status).toBe(200);
    await relay(new Request("https://r/api/relay/in?beat=1", { headers: auth }));
    await relay(new Request("https://r/api/relay/out?after=0", { headers: auth }));
    expect(
      (await relay(new Request("https://r/api/relay/box", { method: "DELETE", headers: auth }))).status,
    ).toBe(200);

    expect(seenCmds.every(([, ...keys]) => keys[0].startsWith("yo:phone:"))).toBe(true);
    const del = seenCmds.find(([n]) => n === "DEL");
    expect(del.slice(1).every((k) => k.startsWith("yo:phone:"))).toBe(true);
    expect(del.slice(1).map((k) => k.split(":").at(-1))).toEqual(["ok", "in", "out", "outseq", "seen"]);
    expect(seenCmds.some(([n]) => /^(KEYS|SCAN|FLUSH)/.test(n))).toBe(false);
    const written = new Set(seenCmds.filter(([n]) => ["RPUSH", "INCR", "SET"].includes(n)).map(([, k]) => k));
    for (const key of written) {
      const hasTtl =
        seenCmds.some(([n, k]) => n === "EXPIRE" && k === key) ||
        seenCmds.some(([n, k, , ex]) => n === "SET" && k === key && ex === "EX");
      expect(hasTtl, key).toBe(true);
    }
  });
});
