/**
 * Yo in a browser (the PC edition, docs/web-app/README.md): cookie sessions, /auth/me and /auth/signout, one-time
 * sign-in links, Settings → Browsers & apps (auth.clients.*), YO_DENY_PEERS, and the PC edition's release check.
 * Real cores against the mock agentd; keys are throwaway Ed25519 pairs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { SIGN_IN_TOKEN_TTL_MS, signedText } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ControllerAuth } from "../src/auth/ControllerAuth";
import { type CoreConfig, loadConfig } from "../src/config";
import { openMemoryDb } from "../src/db/db";
import { normalizeAddress, PeerDenyList } from "../src/http/denyPeers";
import { isNewerRelease, parseRelease } from "../src/http/releaseCheck";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { MockAgentd } from "./mockAgentd";

const TOKEN = "t".repeat(64);
type Core = Awaited<ReturnType<typeof startCore>>;

let dataDir: string;
let mock: MockAgentd;
let agentdUrl: string;
let cores: Core[] = [];
let closers: (() => Promise<void> | void)[] = [];
let port = 26100 + Math.floor(Math.random() * 800);

async function until(fn: () => boolean | Promise<boolean>, ms = 5000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function boot(cfgPatch: Partial<CoreConfig> = {}, overrides: { release?: string | null } = {}) {
  process.env.YO_AGENTD_TOKEN = TOKEN;
  const cfg: CoreConfig = {
    ...loadConfig({}),
    port: port++,
    dataDir,
    agentdUrl,
    computerMode: "remote",
    secrets: "file",
    webDist: null,
    dev: false,
    ...cfgPatch,
  };
  const core = await startCore(cfg, { secrets: new MemorySecretStore(), ...overrides });
  cores.push(core);
  return core;
}

const base = (core: Core) => `http://127.0.0.1:${core.cfg.port}`;
const origin = (core: Core) => `http://127.0.0.1:${core.cfg.port}`;

async function post(core: Core, p: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base(core)}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: (await res.json().catch(() => ({}))) as any };
}

async function getJson(core: Core, p: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base(core)}${p}`, { headers });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

const keyPair = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey, pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
};

/** Enroll a key with this token (the file token when none is given). */
async function enroll(core: Core, token?: string, label = "Test browser") {
  let t = token;
  if (!t) {
    t = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(path.join(dataDir, "enroll-token"), t, { mode: 0o600 });
  }
  const key = keyPair();
  const e = await post(core, "/auth/enroll", { token: t, publicKey: key.pub, label });
  return { status: e.status, controllerId: e.json.controllerId as string, key };
}

/** Sign a fresh challenge and POST /auth/session with these extras (e.g. cookie: true). */
async function session(
  core: Core,
  c: { controllerId: string; key: ReturnType<typeof keyPair> },
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const ch = await post(core, "/auth/challenge", {});
  const signature = crypto
    .sign(null, Buffer.from(signedText.controllerSession(ch.json.nonce, c.controllerId)), c.key.privateKey)
    .toString("base64");
  return post(
    core,
    "/auth/session",
    { controllerId: c.controllerId, nonce: ch.json.nonce, signature, ...extra },
    headers,
  );
}

/** A browser signed in with a cookie: returns the cookie pair ("yo_session=…") and its Set-Cookie line. */
async function browserSignIn(core: Core, label?: string) {
  const c = await enroll(core, undefined, label);
  expect(c.status).toBe(200);
  const s = await session(core, c, { cookie: true }, { origin: origin(core) });
  expect(s.status).toBe(200);
  const setCookie = s.headers.get("set-cookie") ?? "";
  return { ...c, cookie: setCookie.split(";")[0]!, setCookie, res: s };
}

function openWs(core: Core, cookie: string, p = "/ws") {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${core.cfg.port}${p}`, {
      headers: { cookie, origin: origin(core) },
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function wsCall(ws: WebSocket, method: string, params: unknown) {
  const id = crypto.randomUUID();
  return new Promise<{ result?: any; error?: string }>((resolve) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const f = JSON.parse(raw.toString());
      if (f.id !== id) return;
      ws.off("message", onMessage);
      resolve(f);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-browser-auth-"));
  mock = new MockAgentd(TOKEN);
  agentdUrl = await mock.listen();
});

afterEach(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  for (const close of closers) await close();
  closers = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("/auth/info", () => {
  it("says browsers can sign in, and which edition and helper command this is", async () => {
    const mac = await boot(); // loadConfig({}): the Mac app's core
    expect((await getJson(mac, "/auth/info")).json).toEqual({
      protocol: 1,
      authRequired: true,
      enrolled: false,
      coreId: expect.any(String),
      browserSignIn: true,
      edition: "mac",
      helperCommand: null,
    });
    await mac.shutdown();
    cores = [];
    const pc = await boot({ edition: "pc", helperCommand: "yo-app" });
    expect((await getJson(pc, "/auth/info")).json).toMatchObject({ edition: "pc", helperCommand: "yo-app" });
  });

  it("reads YO_EDITION, YO_HELPER_COMMAND, YO_DENY_PEERS and YO_COOKIE_SECURE", () => {
    expect(loadConfig({}).edition).toBe("mac");
    expect(loadConfig({ YO_COMPUTER_MODE: "remote" }).edition).toBe("home-server");
    expect(loadConfig({ YO_EDITION: "pc", YO_COMPUTER_MODE: "remote" }).edition).toBe("pc");
    expect(loadConfig({ YO_EDITION: "windows" }).edition).toBe("mac");
    const pc = loadConfig({
      YO_HELPER_COMMAND: "yo-app",
      YO_DENY_PEERS: "yo-computer, other ,",
      YO_COOKIE_SECURE: "1",
    });
    expect(pc).toMatchObject({
      helperCommand: "yo-app",
      denyPeers: ["yo-computer", "other"],
      cookieSecure: true,
    });
    expect(loadConfig({}).cookieSecure).toBe(false);
  });
});

describe("cookie sessions", () => {
  it("sets an HttpOnly, SameSite=Strict cookie only for an allowed Origin, and never returns the token", async () => {
    const core = await boot();
    const c = await enroll(core);

    // A browser always sends Origin; without one there's no cookie (non-browser callers use bearer tokens).
    expect((await session(core, c, { cookie: true })).status).toBe(403);
    expect((await session(core, c, { cookie: true }, { origin: "http://evil.example" })).status).toBe(403);

    const s = await session(core, c, { cookie: true }, { origin: origin(core) });
    expect(s.status).toBe(200);
    expect(s.json).toEqual({ ok: true, expiresAt: expect.any(Number) });
    expect(s.json.expiresAt - Date.now()).toBeGreaterThan(11.9 * 3600_000);
    const setCookie = s.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(
      new RegExp(
        `^yo_session_${core.cfg.port}=[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Strict; Max-Age=(43199|43200)$`,
      ),
    );
    const cookie = setCookie.split(";")[0]!;
    expect((await getJson(core, "/api/version", { cookie })).status).toBe(200);

    // Without `cookie` it's the bearer token, as the Mac app and yo-ops expect.
    const plain = await session(core, c);
    expect(plain.json).toEqual({
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
      expiresAt: expect.any(Number),
    });
    expect(plain.headers.get("set-cookie")).toBeNull();
  });

  it("marks the cookie Secure behind HTTPS (YO_COOKIE_SECURE=1)", async () => {
    const core = await boot({ cookieSecure: true });
    const b = await browserSignIn(core);
    expect(b.setCookie).toMatch(/; Secure$/);
  });

  it("/auth/me answers signed in (cookie or bearer), signed out, or dev", async () => {
    const core = await boot();
    expect((await getJson(core, "/auth/me")).json).toEqual({ signedIn: false });
    expect((await getJson(core, "/auth/me", { cookie: "yo_session=nope" })).json).toEqual({
      signedIn: false,
    });

    const b = await browserSignIn(core);
    expect((await getJson(core, "/auth/me", { cookie: b.cookie })).json).toEqual({
      signedIn: true,
      kind: "controller",
      controllerId: b.controllerId,
      expiresAt: b.res.json.expiresAt,
    });
    const bearer = await session(core, b);
    expect(
      (await getJson(core, "/auth/me", { authorization: `Bearer ${bearer.json.token}` })).json,
    ).toMatchObject({ signedIn: true, kind: "controller", controllerId: b.controllerId });
    // Another site can't ask.
    expect(
      (await getJson(core, "/auth/me", { cookie: b.cookie, origin: "http://evil.example" })).status,
    ).toBe(403);

    await core.shutdown();
    cores = [];
    const dev = await boot({ dev: true });
    expect((await getJson(dev, "/auth/me")).json).toEqual({ signedIn: true, kind: "dev" });
  });

  it("signing out ends the session, clears the cookie and disconnects the browser's windows", async () => {
    const core = await boot();
    const b = await browserSignIn(core);
    const ws = await openWs(core, b.cookie);
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));

    expect(
      (await post(core, "/auth/signout", {}, { cookie: b.cookie, origin: "http://evil.example" })).status,
    ).toBe(403);
    expect((await getJson(core, "/auth/me", { cookie: b.cookie })).json.signedIn).toBe(true);

    const out = await post(core, "/auth/signout", {}, { cookie: b.cookie, origin: origin(core) });
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ ok: true });
    expect(out.headers.get("set-cookie")).toBe(
      `yo_session_${core.cfg.port}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
    expect(await closed).toBe(4401);
    expect((await getJson(core, "/auth/me", { cookie: b.cookie })).json).toEqual({ signedIn: false });
    expect((await fetch(`${base(core)}/api/version`, { headers: { cookie: b.cookie } })).status).toBe(401);
    // The browser stays enrolled: it signs a new challenge and is back.
    expect((await session(core, b, { cookie: true }, { origin: origin(core) })).status).toBe(200);
    // Signing out with no session is harmless.
    expect((await post(core, "/auth/signout", {})).status).toBe(200);
  });
});

describe("hardening (security review)", () => {
  /** A raw WebSocket upgrade, answered with the status line (or "closed" when the socket just ends). */
  function rawUpgrade(core: Core, headers: Record<string, string>, p = "/ws") {
    return new Promise<string>((resolve) => {
      const sock = net.connect(core.cfg.port, "127.0.0.1", () => {
        const lines = [
          `GET ${p} HTTP/1.1`,
          `Host: 127.0.0.1:${core.cfg.port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`,
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        ];
        sock.write(`${lines.join("\r\n")}\r\n\r\n`);
      });
      let data = "";
      sock.on("data", (b) => {
        data += b.toString();
      });
      sock.on("close", () => resolve(data.split("\r\n")[0] || "closed"));
      sock.on("error", () => resolve("closed"));
    });
  }

  it("a malformed session cookie is no session, and never takes core down", async () => {
    const core = await boot();
    expect(await rawUpgrade(core, { Cookie: "yo_session=%" })).toContain("401");
    expect(await rawUpgrade(core, { Cookie: `yo_session_${core.cfg.port}=%E0%A4%A` })).toContain("401");
    expect((await getJson(core, "/auth/me", { cookie: "yo_session=%" })).json).toEqual({ signedIn: false });
    // Still up and answering.
    expect((await fetch(`${base(core)}/healthz`)).status).toBe(200);
  });

  it("Vite's port 5173 is only trusted in YO_DEV", async () => {
    const core = await boot();
    const b = await browserSignIn(core);
    expect(await rawUpgrade(core, { Cookie: b.cookie, Origin: "http://localhost:5173" })).toContain("403");
    expect((await session(core, b, { cookie: true }, { origin: "http://localhost:5173" })).status).toBe(403);
    const dev = await boot({ dev: true });
    expect((await post(dev, "/auth/challenge", {}, { origin: "http://localhost:5173" })).status).toBe(200);
  });

  it("PC edition: requests must name this machine in Host (no DNS rebinding)", async () => {
    const core = await boot({ edition: "pc" });
    const get = (host: string, p = "/auth/info") =>
      new Promise<number>((resolve) => {
        http
          .get({ host: "127.0.0.1", port: core.cfg.port, path: p, headers: { host } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on("error", () => resolve(0));
      });
    expect(await get(`127.0.0.1:${core.cfg.port}`)).toBe(200);
    expect(await get(`localhost:${core.cfg.port}`)).toBe(200);
    expect(await get(`evil.example:${core.cfg.port}`)).toBe(421);
    expect(await get(`evil.example:${core.cfg.port}`, "/")).toBe(421);
    // The health check stays open (Docker's probe).
    expect(await get(`evil.example:${core.cfg.port}`, "/healthz")).toBe(200);
    // Other editions keep their setups (LAN names, tunnels).
    const mac = await boot();
    const res = await fetch(`${base(mac)}/auth/info`);
    expect(res.status).toBe(200);
  });

  it("a flood of challenges or bad enrollments doesn't lock a signed-in browser out", async () => {
    const core = await boot();
    const b = await browserSignIn(core);
    for (let i = 0; i < 1100; i++) await post(core, "/auth/challenge", {});
    for (let i = 0; i < 25; i++)
      await post(core, "/auth/enroll", { token: "x".repeat(64), publicKey: b.key.pub });
    // New enrollments are braked for a minute...
    expect((await enroll(core)).status).toBe(429);
    // ...but the browser that's already enrolled renews its session as usual.
    expect((await session(core, b, { cookie: true }, { origin: origin(core) })).status).toBe(200);
  });

  it("a browser that revokes itself gets the answer before its windows close", async () => {
    const core = await boot();
    const b = await browserSignIn(core);
    const ws = await openWs(core, b.cookie);
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    const res = await wsCall(ws, "auth.clients.revoke", { id: b.controllerId });
    expect(res).toMatchObject({ result: { ok: true } });
    expect(await closed).toBe(4401);
  });
});

describe("sign-in links", () => {
  it("work once, in time, alongside the file token", async () => {
    const core = await boot();
    const link = await core.api["auth.signInLink.create"]({});
    expect(link.token).toMatch(/^[0-9a-f]{64}$/);
    expect(link.expiresAt - Date.now()).toBeGreaterThan(SIGN_IN_TOKEN_TTL_MS - 5000);

    const first = await enroll(core, link.token, "Edge on the PC");
    expect(first.status).toBe(200);
    expect((await enroll(core, link.token)).status).toBe(401);
    expect((await enroll(core, "f".repeat(64))).status).toBe(401);
    // The owner's file token (`yo-app signin`) still works next to links.
    await core.api["auth.signInLink.create"]({});
    expect((await enroll(core)).status).toBe(200);
    expect(fs.existsSync(path.join(dataDir, "enroll-token"))).toBe(false);
  });

  it("expire after SIGN_IN_TOKEN_TTL_MS, and only so many can wait", () => {
    let now = 1_000_000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-links-"));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const auth = new ControllerAuth(openMemoryDb(), dir, false, () => now);
    const pub = keyPair().pub;

    const late = auth.createSignInLink();
    now += SIGN_IN_TOKEN_TTL_MS + 1;
    expect(() => auth.enroll({ token: late.token, publicKey: pub, label: "x" })).toThrow(/expired/);
    // Used up by that attempt too.
    expect(() => auth.enroll({ token: late.token, publicKey: pub, label: "x" })).toThrow(/no enrollment/);

    const inTime = auth.createSignInLink();
    now += SIGN_IN_TOKEN_TTL_MS - 1;
    expect(auth.enroll({ token: inTime.token, publicKey: pub, label: "x" }).controllerId).toMatch(/^ctl_/);

    for (let i = 0; i < 20; i++) auth.createSignInLink();
    expect(() => auth.createSignInLink()).toThrow(/Too many sign-in links/);
    // Expired ones make room again.
    now += SIGN_IN_TOKEN_TTL_MS + 1;
    expect(auth.createSignInLink().token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Browsers & apps (auth.clients.*)", () => {
  it("lists, renames and revokes; revoking closes that browser's open windows with 4401", async () => {
    const core = await boot();
    const a = await browserSignIn(core, "Chrome");
    await new Promise((r) => setTimeout(r, 5));
    const b = await browserSignIn(core, "Firefox");
    const wsA = await openWs(core, a.cookie);
    const wsB = await openWs(core, b.cookie);
    const closedB = new Promise<{ code: number; reason: string }>((r) =>
      wsB.on("close", (code, reason) => r({ code, reason: reason.toString() })),
    );

    const list = await wsCall(wsA, "auth.clients.list", {});
    expect(list.result.map((c: any) => c.label)).toEqual(["Firefox", "Chrome"]);
    expect(list.result[0]).toEqual({
      id: b.controllerId,
      label: "Firefox",
      createdAt: expect.any(Number),
      lastUsedAt: expect.any(Number),
    });

    expect(
      (await wsCall(wsA, "auth.clients.rename", { id: b.controllerId, label: "  Firefox on the laptop " }))
        .result,
    ).toMatchObject({
      id: b.controllerId,
      label: "Firefox on the laptop",
    });
    expect((await wsCall(wsA, "auth.clients.rename", { id: b.controllerId, label: "   " })).error).toMatch(
      /can't be empty/,
    );
    expect(
      (await wsCall(wsA, "auth.clients.rename", { id: b.controllerId, label: "x".repeat(81) })).error,
    ).toMatch(/80 characters/);
    expect((await wsCall(wsA, "auth.clients.rename", { id: "ctl_nope", label: "x" })).error).toMatch(
      /isn't signed in/,
    );
    expect((await wsCall(wsA, "auth.clients.revoke", { id: "ctl_nope" })).error).toMatch(/isn't signed in/);

    expect((await wsCall(wsA, "auth.clients.revoke", { id: b.controllerId })).result).toEqual({ ok: true });
    expect(await closedB).toEqual({ code: 4401, reason: "signed out" });
    expect(wsA.readyState).toBe(WebSocket.OPEN);
    expect((await getJson(core, "/auth/me", { cookie: b.cookie })).json).toEqual({ signedIn: false });
    // Revoked for good: its key can't make a new session, and it's gone from the list.
    expect((await session(core, b, { cookie: true }, { origin: origin(core) })).status).toBe(401);
    expect((await wsCall(wsA, "auth.clients.list", {})).result.map((c: any) => c.id)).toEqual([
      a.controllerId,
    ]);
    expect((await wsCall(wsA, "auth.clients.revoke", { id: b.controllerId })).error).toMatch(
      /isn't signed in/,
    );

    // A sign-in link made over the socket.
    const link = await wsCall(wsA, "auth.signInLink.create", {});
    expect(link.result).toEqual({
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
      expiresAt: expect.any(Number),
    });
    wsA.close();
  });
});

describe("YO_DENY_PEERS", () => {
  it("normalizes addresses and keeps every address it has seen", async () => {
    expect(normalizeAddress("::ffff:172.18.0.3")).toBe("172.18.0.3");
    expect(normalizeAddress("::FFFF:10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeAddress("FE80::1")).toBe("fe80::1");

    let answers: string[] | null = null;
    const list = new PeerDenyList(["yo-computer"], async () => {
      if (!answers) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return answers;
    });
    expect(list.denies("172.18.0.3")).toBe(false);
    await list.refresh();
    expect(list.ready).toBe(false);
    answers = ["172.18.0.3"];
    await list.refresh();
    expect(list.ready).toBe(true);
    expect(list.denies("172.18.0.3")).toBe(true);
    expect(list.denies("::ffff:172.18.0.3")).toBe(true);
    expect(list.denies("172.18.0.2")).toBe(false);
    expect(list.denies(undefined)).toBe(false);
    // A recreated container gets a new address; the old one stays denied.
    answers = ["172.18.0.9"];
    await list.refresh();
    expect(list.denies("172.18.0.3")).toBe(true);
    expect(list.denies("172.18.0.9")).toBe(true);
  });

  it("waits for a first answer before listening, retrying while the name doesn't resolve", async () => {
    let calls = 0;
    const list = new PeerDenyList(["yo-computer"], async () => {
      calls++;
      if (calls < 3) throw new Error("ENOTFOUND");
      return ["10.1.2.3"];
    });
    closers.push(() => list.stop());
    await list.start();
    expect(calls).toBe(3);
    expect(list.denies("10.1.2.3")).toBe(true);
  });

  it("drops connections from a denied peer before answering anything", async () => {
    const core = await boot({ denyPeers: ["localhost"] });
    const result = await new Promise<{ data: string; closed: boolean }>((resolve) => {
      let data = "";
      const s = net.connect(core.cfg.port, "127.0.0.1", () =>
        s.write("GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n"),
      );
      s.on("data", (d) => {
        data += d.toString();
      });
      s.on("error", () => {});
      s.on("close", () => resolve({ data, closed: true }));
    });
    expect(result).toEqual({ data: "", closed: true });
  });
});

describe("static files", () => {
  it("serves the web app manifest and favicon with their types", async () => {
    const webDist = fs.mkdtempSync(path.join(os.tmpdir(), "yo-web-"));
    closers.push(() => fs.rmSync(webDist, { recursive: true, force: true }));
    fs.writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>Yo</title>");
    fs.writeFileSync(path.join(webDist, "manifest.webmanifest"), '{"name":"Yo"}');
    fs.writeFileSync(path.join(webDist, "favicon.ico"), Buffer.from([0, 0, 1, 0]));
    const core = await boot({ webDist });
    const m = await fetch(`${base(core)}/manifest.webmanifest`);
    expect(m.headers.get("content-type")).toBe("application/manifest+json");
    expect(m.headers.get("cache-control")).toBe("no-cache");
    expect(await m.json()).toEqual({ name: "Yo" });
    const ico = await fetch(`${base(core)}/favicon.ico`);
    expect(ico.headers.get("content-type")).toBe("image/x-icon");
  });
});

describe("PC edition release check", () => {
  let latest = {
    tag_name: "v0.1.313",
    html_url: "https://github.com/JuniorSua/yo-app/releases/tag/v0.1.313",
  };
  let hits = 0;
  let agents: string[] = [];

  async function fakeGitHub() {
    hits = 0;
    agents = [];
    const server = http.createServer((req, res) => {
      hits++;
      agents.push(String(req.headers["user-agent"] ?? ""));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(latest));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases/latest`;
  }

  async function version(core: Core) {
    const b = await browserSignIn(core);
    return async () => (await getJson(core, "/api/version", { cookie: b.cookie })).json.release;
  }

  it("compares release numbers numerically", () => {
    expect(parseRelease("v0.1.312")).toEqual([0, 1, 312]);
    expect(parseRelease("0.1.0-dev")).toBeNull();
    expect(parseRelease(null)).toBeNull();
    expect(isNewerRelease("0.1.10", "0.1.9")).toBe(true);
    expect(isNewerRelease("0.1.9", "0.1.10")).toBe(false);
    expect(isNewerRelease("0.2.0", "0.1.99")).toBe(true);
    expect(isNewerRelease("0.1.5", "0.1.5")).toBe(false);
    expect(isNewerRelease("junk", "0.1.5")).toBe(false);
  });

  it("offers a newer release on /api/version", async () => {
    latest = { tag_name: "v0.1.313", html_url: "https://github.com/JuniorSua/yo-app/releases/tag/v0.1.313" };
    const url = await fakeGitHub();
    const core = await boot({ edition: "pc", releasesUrl: url }, { release: "0.1.300" });
    const get = await version(core);
    await until(async () => (await get()) !== null, 5000, "release");
    expect(await get()).toEqual({
      version: "0.1.313",
      url: "https://github.com/JuniorSua/yo-app/releases/tag/v0.1.313",
    });
    expect(agents[0]).toBe("yo-core/0.1.300");
  });

  it("says nothing when this core is current or newer", async () => {
    latest = { tag_name: "v0.1.299", html_url: "https://github.com/JuniorSua/yo-app/releases/tag/v0.1.299" };
    const url = await fakeGitHub();
    const core = await boot({ edition: "pc", releasesUrl: url }, { release: "0.1.300" });
    const get = await version(core);
    await until(() => hits > 0, 5000, "release check");
    expect(await get()).toBeNull();
  });

  it("only checks in the PC edition, and only for release builds", async () => {
    const url = await fakeGitHub();
    const home = await boot({ edition: "home-server", releasesUrl: url }, { release: "0.1.300" });
    expect(await (await version(home))()).toBeNull();
    await home.shutdown();
    cores = [];
    const fromSource = await boot({ edition: "pc", releasesUrl: url }, { release: null });
    expect(await (await version(fromSource))()).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(hits).toBe(0);
  });
});
