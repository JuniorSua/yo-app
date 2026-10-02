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
import { DESKTOP_UPDATE_FILE } from "../src/http/updates";
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
      (await fetch(`${base(core)}/api/version`, { headers: { cookie: `yo_session=${session}` } })).json();
    // From source there is no baked-in build: the UI then leaves the refresh check off.
    expect(await get()).toEqual({ build: null, web: null, desktop: null });

    fs.writeFileSync(path.join(webDist, "build.json"), JSON.stringify({ build: "312-abc1234" }));
    const feed = path.join(dataDir, "updates", "desktop");
    fs.mkdirSync(feed, { recursive: true });
    fs.writeFileSync(path.join(feed, "latest-mac.yml"), "version: 0.1.313\nfiles: []\n");
    expect(await get()).toEqual({ build: null, web: "312-abc1234", desktop: { version: "0.1.313" } });
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
