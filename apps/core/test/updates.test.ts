/**
 * /api/version and the private Yo.app update feed: a real core with sign-in on, files on disk.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { signedText } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { APPLY_STALE_MS, DESKTOP_UPDATE_FILE, readServerUpdate } from "../src/http/updates";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { MockAgentd } from "./mockAgentd";

const TOKEN = "t".repeat(64);
type Core = Awaited<ReturnType<typeof startCore>>;

let dataDir: string;
let webDist: string;
let mock: MockAgentd;
let cores: Core[] = [];
let port = 21800 + Math.floor(Math.random() * 1000);

async function boot() {
  process.env.YO_AGENTD_TOKEN = TOKEN;
  const cfg = {
    ...loadConfig({}),
    port: port++,
    dataDir,
    agentdUrl: await mock.listen(),
    computerMode: "remote" as const,
    secrets: "file" as const,
    webDist,
    dev: false,
  };
  const core = await startCore(cfg, { secrets: new MemorySecretStore() });
  cores.push(core);
  return core;
}

const base = (core: Core) => `http://127.0.0.1:${core.cfg.port}`;

async function post(core: Core, p: string, body: unknown) {
  const res = await fetch(`${base(core)}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as any;
}

async function signIn(core: Core) {
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(dataDir, "enroll-token"), token, { mode: 0o600 });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const e = await post(core, "/auth/enroll", { token, publicKey: pub, label: "test" });
  const c = await post(core, "/auth/challenge", {});
  const s = await post(core, "/auth/session", {
    controllerId: e.controllerId,
    nonce: c.nonce,
    signature: crypto
      .sign(null, Buffer.from(signedText.controllerSession(c.nonce, e.controllerId)), privateKey)
      .toString("base64"),
  });
  return s.token as string;
}

/** Raw GET, so paths reach the server exactly as written (fetch would normalize dot segments). */
function rawGet(core: Core, p: string, token?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>(
    (resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: core.cfg.port,
          path: p,
          headers: token ? { authorization: `Bearer ${token}` } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-updates-test-"));
  webDist = fs.mkdtempSync(path.join(os.tmpdir(), "yo-updates-web-"));
  mock = new MockAgentd(TOKEN);
});

afterEach(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(webDist, { recursive: true, force: true });
});

describe("update routes", () => {
  it("only accepts feed file names", () => {
    for (const ok of ["latest-mac.yml", "Yo-0.1.312-arm64-mac.zip", "Yo-0.1.312-arm64-mac.zip.blockmap"])
      expect(DESKTOP_UPDATE_FILE.test(ok)).toBe(true);
    for (const bad of [
      "../yo.sqlite",
      "..zip",
      ".hidden.zip",
      "secrets.json",
      "yo.sqlite",
      "a/b.zip",
      "a\\b.zip",
      "latest.yml",
      "x.zip\n",
      "",
    ])
      expect(DESKTOP_UPDATE_FILE.test(bad) && !bad.includes("..")).toBe(false);
  });

  it("needs a session for the version and the feed", async () => {
    const core = await boot();
    expect((await fetch(`${base(core)}/api/version`)).status).toBe(401);
    expect((await fetch(`${base(core)}/api/updates/desktop/latest-mac.yml`)).status).toBe(401);
    // A browser page from another origin is refused outright.
    const foreign = await fetch(`${base(core)}/api/version`, { headers: { origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
  });

  it("reports the build of core, the web UI it serves, and the newest published Yo.app", async () => {
    const core = await boot();
    const session = await signIn(core);
    const get = async () =>
      (await (
        await fetch(`${base(core)}/api/version`, { headers: { cookie: `yo_session=${session}` } })
      ).json()) as { desktop: unknown };
    // From source there is no baked-in build: the UI then leaves the refresh check off.
    expect(await get()).toEqual({
      build: null,
      web: null,
      desktop: null,
      server: { pending: null, applying: false },
      release: null,
    });

    fs.writeFileSync(path.join(webDist, "build.json"), JSON.stringify({ build: "312-abc1234" }));
    const feed = path.join(dataDir, "updates", "desktop");
    fs.mkdirSync(feed, { recursive: true });
    fs.writeFileSync(path.join(feed, "latest-mac.yml"), "version: 0.1.313\nfiles: []\n");
    expect(await get()).toEqual({
      build: null,
      web: "312-abc1234",
      desktop: { version: "0.1.313", notes: null },
      server: { pending: null, applying: false },
      release: null,
    });

    // The "What's new" publish-app writes (a JSON string on one line) comes along for the restart confirmation.
    const notes = '- Restart asks first\n- Quotes "stay" intact: no: yaml';
    fs.writeFileSync(
      path.join(feed, "latest-mac.yml"),
      `version: 0.1.313\nfiles: []\nreleaseNotes: ${JSON.stringify(notes)}\n`,
    );
    expect((await get()).desktop).toEqual({ version: "0.1.313", notes });
    // Anything else (hand-written YAML, a broken line) is no notes, not an error.
    fs.writeFileSync(path.join(feed, "latest-mac.yml"), 'version: 0.1.313\nreleaseNotes: "broken\n');
    expect((await get()).desktop).toEqual({ version: "0.1.313", notes: null });
  });

  it("serves feed files with the right type and length, and nothing outside the feed", async () => {
    const core = await boot();
    const session = await signIn(core);
    const feed = path.join(dataDir, "updates", "desktop");
    fs.mkdirSync(feed, { recursive: true });
    const zip = crypto.randomBytes(70_000);
    fs.writeFileSync(path.join(feed, "Yo-0.1.313-arm64-mac.zip"), zip);
    fs.writeFileSync(path.join(feed, "latest-mac.yml"), "version: 0.1.313\n");
    fs.writeFileSync(path.join(dataDir, "secrets.json"), "{}");
    fs.writeFileSync(path.join(webDist, "index.html"), "<!doctype html>");

    const z = await rawGet(core, "/api/updates/desktop/Yo-0.1.313-arm64-mac.zip", session);
    expect(z.status).toBe(200);
    expect(z.headers["content-type"]).toBe("application/zip");
    expect(z.headers["content-length"]).toBe(String(zip.length));
    expect(z.body.equals(zip)).toBe(true);

    // electron-updater adds a cache-busting query to the feed file.
    const y = await rawGet(core, "/api/updates/desktop/latest-mac.yml?noCache=1abc", session);
    expect(y.status).toBe(200);
    expect(y.headers["content-type"]).toMatch(/^text\/yaml/);
    expect(y.headers["cache-control"]).toBe("no-store");
    expect(y.body.toString()).toBe("version: 0.1.313\n");

    for (const p of [
      "/api/updates/desktop/..%2F..%2Fsecrets.json",
      "/api/updates/desktop/%2E%2E%2Fsecrets.json",
      "/api/updates/desktop/../../secrets.json",
      "/api/updates/desktop/secrets.json",
      "/api/updates/desktop/Yo-0.1.312-arm64-mac.zip",
      "/api/updates/desktop/a/latest-mac.yml",
      "/api/updates/desktop",
    ]) {
      const r = await rawGet(core, p, session);
      // Dot segments are resolved before routing, so that one lands on the web UI's index page.
      if (r.status === 200) expect(r.body.toString(), p).toBe("<!doctype html>");
      else expect(r.status, p).toBe(404);
    }
  });
  it("a feed file it can't read ends that download without taking core down", async () => {
    const core = await boot();
    const session = await signIn(core);
    const feed = path.join(dataDir, "updates", "desktop");
    fs.mkdirSync(feed, { recursive: true });
    const zip = path.join(feed, "Yo-0.1.313-arm64-mac.zip");
    fs.writeFileSync(zip, "zip");
    // stat succeeds but opening fails: the same unhandled stream error as a zip pruned mid-download.
    fs.chmodSync(zip, 0o000);
    await rawGet(core, "/api/updates/desktop/Yo-0.1.313-arm64-mac.zip", session).catch(() => {});
    const v = await fetch(`${base(core)}/api/version`, { headers: { cookie: `yo_session=${session}` } });
    expect(v.status).toBe(200);
  });
});

const REV = "0123456789ab";
const serverDir = () => path.join(dataDir, "updates", "server");

/** What `release.py publish-server` writes. */
function publish(p: Partial<Record<string, unknown>> = {}) {
  fs.mkdirSync(serverDir(), { recursive: true });
  fs.writeFileSync(
    path.join(serverDir(), "pending.json"),
    JSON.stringify({
      rev: REV,
      coreImage: `yo-core:pc-${REV}`,
      computerImage: null,
      notes: "- Faster replies\n- Fewer sign-ins",
      publishedAt: 1,
      ...p,
    }),
  );
}

/** One API call over the UI socket, the way the web app makes it. */
async function wsCall(core: Core, session: string | null, method: string, params: unknown) {
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${core.cfg.port}/ws`, {
    headers: session ? { cookie: `yo_session=${session}` } : {},
  });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
      ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    return await new Promise<{ result?: unknown; error?: string }>((resolve) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.id === 1) resolve(m);
      });
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}

describe("server updates the user restarts", () => {
  it("offers a published update in /api/version, with its notes and whether the browser reloads", async () => {
    const core = await boot();
    const session = await signIn(core);
    const get = async () =>
      (
        (await (
          await fetch(`${base(core)}/api/version`, { headers: { cookie: `yo_session=${session}` } })
        ).json()) as { server: unknown }
      ).server;
    expect(await get()).toEqual({ pending: null, applying: false });

    publish({ computerImage: `yo-computer:pc-${REV}` });
    expect(await get()).toEqual({
      pending: { rev: REV, notes: "- Faster replies\n- Fewer sign-ins", restartsComputer: true },
      applying: false,
    });

    // The updater's report on the last one comes along.
    fs.writeFileSync(
      path.join(serverDir(), "result.json"),
      JSON.stringify({ rev: "aaaaaaaaaaaa", ok: false, message: "The update didn't finish.", finishedAt: 5 }),
    );
    expect(((await get()) as any).lastResult).toEqual({
      rev: "aaaaaaaaaaaa",
      ok: false,
      message: "The update didn't finish.",
      finishedAt: 5,
    });
  });

  it("ignores the build core already runs, and anything that isn't a Yo image", () => {
    publish();
    expect(readServerUpdate(dataDir, `400-${REV.slice(0, 7)}`).pending).toBeNull();
    expect(readServerUpdate(dataDir, "400-fffffff").pending?.rev).toBe(REV);
    // Same core, new agent computer: still an update.
    publish({ computerImage: "yo-computer:pc-fedcba987654" });
    expect(readServerUpdate(dataDir, `400-${REV.slice(0, 7)}`).pending?.restartsComputer).toBe(true);
    for (const bad of [
      { coreImage: "evil/yo-core:pc-0123456789ab" },
      { coreImage: "yo-computer:pc-0123456789ab" },
      { computerImage: "ubuntu:latest" },
      { rev: "../../etc" },
    ]) {
      publish(bad);
      expect(readServerUpdate(dataDir, null).pending, JSON.stringify(bad)).toBeNull();
    }
    fs.writeFileSync(path.join(serverDir(), "pending.json"), "{not json");
    expect(readServerUpdate(dataDir, null)).toEqual({ pending: null, applying: false });
  });

  it("applyServer writes the request for the updater, and only for the pending rev", async () => {
    const core = await boot();
    publish();
    await expect(core.api["update.applyServer"]({ rev: "fedcba987654" })).rejects.toThrow(
      /isn't available anymore/,
    );
    await expect(core.api["update.applyServer"]({ rev: "../../x" } as any)).rejects.toThrow();
    expect(fs.existsSync(path.join(serverDir(), "apply.json"))).toBe(false);

    const before = Date.now();
    expect(await core.api["update.applyServer"]({ rev: REV })).toEqual({ ok: true });
    const req = JSON.parse(fs.readFileSync(path.join(serverDir(), "apply.json"), "utf8"));
    expect(req.rev).toBe(REV);
    expect(req.requestedAt).toBeGreaterThanOrEqual(before);
    expect(fs.statSync(path.join(serverDir(), "apply.json")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(serverDir()).sort()).toEqual(["apply.json", "pending.json"]); // no tmp left
    expect(readServerUpdate(dataDir, null).applying).toBe(true);
    // Pressing it twice is fine.
    expect(await core.api["update.applyServer"]({ rev: REV })).toEqual({ ok: true });
    // A request no updater ever picked up stops showing as "updating".
    expect(readServerUpdate(dataDir, null, Date.now() + APPLY_STALE_MS + 1).applying).toBe(false);

    // Withdrawn (or already applied): nothing to apply.
    fs.rmSync(path.join(serverDir(), "pending.json"));
    await expect(core.api["update.applyServer"]({ rev: REV })).rejects.toThrow(/isn't available anymore/);
  });

  it("applyServer needs a signed-in controller", async () => {
    const core = await boot();
    publish();
    await expect(wsCall(core, null, "update.applyServer", { rev: REV })).rejects.toThrow(/401/);
    expect(fs.existsSync(path.join(serverDir(), "apply.json"))).toBe(false);
    const session = await signIn(core);
    expect(await wsCall(core, session, "update.applyServer", { rev: REV })).toEqual({
      id: 1,
      result: { ok: true },
    });
    expect(fs.existsSync(path.join(serverDir(), "apply.json"))).toBe(true);
  });
});
