/**
 * End-to-end tests for signing in, pairing a Mac and the `mac_*` tools: a real core, the real Mac-side
 * DeviceAgent (Electron-free), a fake native helper, and the scripted fake agent computer.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson, signedText, writeDigestInput } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DeviceAgent, type DeviceState } from "../../desktop/src/device/DeviceAgent";
import { loadConfig } from "../src/config";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { FakeHelper } from "./fakeHelper";
import { MockAgentd } from "./mockAgentd";

const TOKEN = "t".repeat(64);
type Core = Awaited<ReturnType<typeof startCore>>;

async function until(fn: () => boolean | Promise<boolean>, ms = 5000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let dataDir: string;
let mock: MockAgentd;
let agentdUrl: string;
let cores: Core[] = [];
let agents: DeviceAgent[] = [];
let port = 19800 + Math.floor(Math.random() * 1000);

async function boot(opts: { dev?: boolean; port?: number } = {}) {
  process.env.YO_AGENTD_TOKEN = TOKEN;
  const cfg = {
    ...loadConfig({}),
    port: opts.port ?? port++,
    dataDir,
    agentdUrl,
    computerMode: "remote" as const,
    secrets: "file" as const,
    webDist: null,
    dev: opts.dev ?? false,
  };
  const core = await startCore(cfg, { secrets: new MemorySecretStore() });
  cores.push(core);
  await core.agentd.waitReady(5000);
  return core;
}

const base = (core: Core) => `http://127.0.0.1:${core.cfg.port}`;

async function post(core: Core, p: string, body: unknown, token?: string) {
  const res = await fetch(`${base(core)}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

const keyPair = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey, pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
};
const sign = (k: crypto.KeyObject, text: string) =>
  crypto.sign(null, Buffer.from(text), k).toString("base64");

/** Enroll a controller and return a session token. */
async function signIn(core: Core) {
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(dataDir, "enroll-token"), token, { mode: 0o600 });
  const k = keyPair();
  const e = await post(core, "/auth/enroll", { token, publicKey: k.pub, label: "test" });
  expect(e.status).toBe(200);
  const c = await post(core, "/auth/challenge", {});
  const s = await post(core, "/auth/session", {
    controllerId: e.json.controllerId,
    nonce: c.json.nonce,
    signature: sign(k.privateKey, signedText.controllerSession(c.json.nonce, e.json.controllerId)),
  });
  expect(s.status).toBe(200);
  return { session: s.json.token as string, controllerId: e.json.controllerId as string, key: k };
}

function memoryState(): { load(): DeviceState; save(s: DeviceState): void; saved: DeviceState | null } {
  const st = {
    saved: null as DeviceState | null,
    load: () => st.saved ?? { grants: [], paused: false, journal: [] },
    save: (s: DeviceState) => {
      st.saved = JSON.parse(JSON.stringify(s));
    },
  };
  return st;
}

/** Pair a device with core and connect its DeviceAgent. */
async function pairDevice(core: Core, session: string, helper = new FakeHelper()) {
  const start = await core.api["devices.pair.start"]({});
  const k = keyPair();
  const deviceId = `dev_${crypto.randomBytes(8).toString("hex")}`;
  const res = await post(
    core,
    "/auth/pair-device",
    {
      challenge: start.challenge,
      deviceId,
      publicKey: k.pub,
      signature: sign(k.privateKey, signedText.pairing(start.challenge, deviceId, k.pub)),
      name: "Test Mac",
      osVersion: "macOS 27",
      appVersion: "0.1.0",
    },
    session,
  );
  expect(res.status).toBe(200);
  const state = memoryState();
  const agent = new DeviceAgent({
    wsUrl: `ws://127.0.0.1:${core.cfg.port}/device`,
    pairing: {
      deviceId,
      coreId: start.coreId,
      corePublicKey: start.corePublicKey,
      sign: (t) => sign(k.privateKey, t),
    },
    helper,
    state,
    appVersion: "0.1.0",
    helperVersion: "0.3.0",
    osVersion: "macOS 27",
    permissions: async () => ({ contacts: "not-requested" }),
  });
  agents.push(agent);
  agent.start();
  await until(() => agent.connected && core.execution.devices.isOnline(deviceId), 5000, "device online");
  return { agent, deviceId, helper, state, key: k, start };
}

const primary = (core: Core) => core.store.listAgents().find((a) => a.isPrimary)!;

/** Have the fake model call a tool and return what the tool answered. */
async function modelCalls(
  core: Core,
  tool: string,
  args: Record<string, unknown>,
  route?: "auto" | "agent-computer",
) {
  const agent = primary(core);
  const before = core.store.listTimeline(agent.id).length;
  await core.api["chat.send"]({ agentId: agent.id, text: `tool ${tool} ${JSON.stringify(args)}`, route });
  let text = "";
  await until(
    () => {
      const e = core.store
        .listTimeline(agent.id)
        .slice(before)
        .find((x) => x.item.kind === "assistant_message" && x.item.status === "completed");
      if (e) text = String(e.item.text ?? "");
      return !!e;
    },
    8000,
    `${tool} reply`,
  );
  await until(() => core.orchestrator.activityOf(agent.id) !== "working", 5000, "turn end");
  return text.replace(/^tool: /, "");
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-dev-test-"));
  mock = new MockAgentd(TOKEN);
  agentdUrl = await mock.listen();
});

afterEach(async () => {
  for (const a of agents) a.stop();
  agents = [];
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("controller sign-in", () => {
  it("requires a one-time owner token to enroll, and a signed nonce for each session", async () => {
    const core = await boot();
    const info = await (await fetch(`${base(core)}/auth/info`)).json();
    expect(info).toMatchObject({ protocol: 1, authRequired: true, enrolled: false });

    const k = keyPair();
    expect((await post(core, "/auth/enroll", { token: "x".repeat(64), publicKey: k.pub })).status).toBe(401);
    fs.writeFileSync(path.join(dataDir, "enroll-token"), "a".repeat(64));
    expect((await post(core, "/auth/enroll", { token: "b".repeat(64), publicKey: k.pub })).status).toBe(401);
    // Expired tokens are refused and removed.
    const old = (Date.now() - 11 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(dataDir, "enroll-token"), old, old);
    expect((await post(core, "/auth/enroll", { token: "a".repeat(64), publicKey: k.pub })).status).toBe(401);
    expect(fs.existsSync(path.join(dataDir, "enroll-token"))).toBe(false);

    const { session, controllerId, key } = await signIn(core);
    expect(session).toMatch(/^[0-9a-f]{64}$/);
    // The token worked once and is gone.
    expect(fs.existsSync(path.join(dataDir, "enroll-token"))).toBe(false);

    // A nonce is single-use, and only the enrolled key can sign it.
    const c = await post(core, "/auth/challenge", {});
    const good = sign(key.privateKey, signedText.controllerSession(c.json.nonce, controllerId));
    const other = sign(keyPair().privateKey, signedText.controllerSession(c.json.nonce, controllerId));
    expect(
      (await post(core, "/auth/session", { controllerId, nonce: c.json.nonce, signature: other })).status,
    ).toBe(401);
    expect(
      (await post(core, "/auth/session", { controllerId, nonce: c.json.nonce, signature: good })).status,
    ).toBe(401);
  });

  it("locks the API, live view and terminal behind a session; YO_DEV is the only bypass", async () => {
    const core = await boot();
    expect((await fetch(`${base(core)}/api/artifacts/nope`)).status).toBe(401);
    const { session } = await signIn(core);
    expect(
      (await fetch(`${base(core)}/api/artifacts/nope`, { headers: { authorization: `Bearer ${session}` } }))
        .status,
    ).toBe(404);
    expect(
      (await fetch(`${base(core)}/api/artifacts/nope`, { headers: { cookie: `yo_session=${session}` } }))
        .status,
    ).toBe(404);

    const denied = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${core.cfg.port}/ws`);
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve(101));
      ws.on("error", () => undefined);
    });
    expect(denied).toBe(401);
    for (const p of ["/api/vnc/agt_x", "/api/pty/p1"]) {
      const code = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${core.cfg.port}${p}`);
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("open", () => resolve(101));
        ws.on("error", () => undefined);
      });
      expect(code).toBe(401);
    }

    const result = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${core.cfg.port}/ws`, {
        headers: { cookie: `yo_session=${session}` },
      });
      ws.on("open", () => ws.send(JSON.stringify({ id: "1", method: "bootstrap", params: {} })));
      ws.on("message", (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.id === "1") {
          ws.close();
          resolve(f.result);
        }
      });
      ws.on("error", reject);
    });
    expect(result.agents).toHaveLength(1);
    expect(result.execution.flags).toEqual({ devices: false, deviceWrites: false, control: false });

    await core.shutdown();
    cores = [];
    const dev = await boot({ dev: true });
    expect((await fetch(`${base(dev)}/api/artifacts/nope`)).status).toBe(404);
  });

  it("serves agent-made artifacts as sandboxed downloads, never active content", async () => {
    const core = await boot();
    const { session } = await signIn(core);
    const stored = path.join(dataDir, "evil.html");
    fs.writeFileSync(stored, "<script>alert(1)</script>");
    const art = core.store.addArtifact({
      agentId: primary(core).id,
      title: "x",
      path: "/x.html",
      mime: "text/html",
      size: 25,
      storedPath: stored,
    });
    const res = await fetch(`${base(core)}/api/artifacts/${art.id}?inline=1`, {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("pairing", () => {
  it("needs a signed-in controller and proof of the device key; the device checks it reached the paired core", async () => {
    const core = await boot();
    const { session } = await signIn(core);
    const start = await core.api["devices.pair.start"]({});
    const k = keyPair();
    const body = {
      challenge: start.challenge,
      deviceId: "dev_aaaaaaaaaaaa",
      publicKey: k.pub,
      signature: sign(keyPair().privateKey, signedText.pairing(start.challenge, "dev_aaaaaaaaaaaa", k.pub)),
      name: "Mac",
      osVersion: "",
      appVersion: "",
    };
    expect((await post(core, "/auth/pair-device", body)).status).toBe(401);
    expect((await post(core, "/auth/pair-device", body, session)).status).toBe(400);
    // The challenge was consumed by the failed attempt.
    body.signature = sign(k.privateKey, signedText.pairing(start.challenge, "dev_aaaaaaaaaaaa", k.pub));
    expect((await post(core, "/auth/pair-device", body, session)).status).toBe(400);

    const { deviceId } = await pairDevice(core, session);
    expect(core.execution.devices.view(deviceId)).toMatchObject({ online: true, name: "Test Mac" });

    // An impostor with the right id but another key can't connect.
    const impostor = new DeviceAgent({
      wsUrl: `ws://127.0.0.1:${core.cfg.port}/device`,
      pairing: {
        deviceId,
        coreId: start.coreId,
        corePublicKey: start.corePublicKey,
        sign: (t) => sign(keyPair().privateKey, t),
      },
      helper: new FakeHelper(),
      state: memoryState(),
      appVersion: "x",
      helperVersion: "x",
      osVersion: "x",
    });
    agents.push(impostor);
    impostor.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(impostor.connected).toBe(false);

    // A device pinned to a different core key refuses to talk to this core.
    const other = keyPair();
    const fooled = new DeviceAgent({
      wsUrl: `ws://127.0.0.1:${core.cfg.port}/device`,
      pairing: { deviceId, coreId: start.coreId, corePublicKey: other.pub, sign: (t) => t },
      helper: new FakeHelper(),
      state: memoryState(),
      appVersion: "x",
      helperVersion: "x",
      osVersion: "x",
    });
    agents.push(fooled);
    fooled.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(fooled.connected).toBe(false);
  });
});

describe("mac_* tools", () => {
  async function setup(mode: "read" | "read-write" = "read") {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const { session } = await signIn(core);
    const dev = await pairDevice(core, session);
    dev.helper.folder("bm-docs", { "notes.txt": "hello from the mac", "plan.md": "# plan" });
    const grant = dev.agent.addGrant({
      bookmark: "bm-docs",
      kind: "dir",
      displayPath: "~/Documents/Docs",
      name: "Docs",
      mode,
      expiresAt: null,
    });
    await until(() => core.execution.store.getGrant(grant.id) != null, 5000, "grant mirrored");
    return { core, session, ...dev, grant };
  }

  it("is off until the user turns on Mac access, and respects “Agent computer only”", async () => {
    const { core } = await setup();
    expect(await modelCalls(core, "mac_read_file", { folder: "Docs", path: "notes.txt" })).toMatch(
      /turned off/,
    );
    core.store.updateSettings({ macAccess: true });
    expect(
      await modelCalls(core, "mac_read_file", { folder: "Docs", path: "notes.txt" }, "agent-computer"),
    ).toMatch(/Agent computer only/);
    const routes = await core.api["routes.list"]({ agentId: primary(core).id });
    expect(routes.map((r) => r.reason)).toEqual(["route-restricted", "disabled"]);
  });

  it("reads and lists only inside the shared folder, and records why it used the Mac", async () => {
    const { core, helper } = await setup();
    core.store.updateSettings({ macAccess: true });
    expect(await modelCalls(core, "mac_access", {})).toMatch(
      /Docs — ~\/Documents\/Docs \(folder, read only\)/,
    );
    expect(await modelCalls(core, "mac_read_file", { folder: "Docs", path: "notes.txt" })).toContain(
      "hello from the mac",
    );
    expect(await modelCalls(core, "mac_list_files", { folder: "Docs" })).toMatch(
      /notes\.txt[\s\S]*plan\.md|plan\.md[\s\S]*notes\.txt/,
    );
    expect(await modelCalls(core, "mac_read_file", { folder: "Docs", path: "../.ssh/id_ed25519" })).toMatch(
      /leaves the shared folder/,
    );
    expect(await modelCalls(core, "mac_read_file", { folder: "Desktop", path: "x" })).toMatch(
      /isn't one of the folders/,
    );
    expect(helper.calls.filter((c) => c.method === "files.read")).toHaveLength(1);
    const routes = await core.api["routes.list"]({ agentId: primary(core).id });
    expect(routes.some((r) => r.reason === "dedicated-command" && r.target === "device")).toBe(true);
    const ops = await core.api["operations.list"]({});
    expect(ops.filter((o) => o.status === "succeeded").length).toBeGreaterThanOrEqual(2);
  });

  it("copies a Mac file into the agent's computer", async () => {
    const { core } = await setup();
    core.store.updateSettings({ macAccess: true });
    expect(await modelCalls(core, "mac_copy_to_computer", { folder: "Docs", path: "plan.md" })).toMatch(
      /to ~\/from-mac\/plan\.md/,
    );
    expect(mock.written[0]!.data.toString()).toBe("# plan");
  });

  it("refuses writes on a read-only share, and when the user paused or unshared", async () => {
    const { core, agent, grant } = await setup();
    core.store.updateSettings({ macAccess: true, macWrites: true });
    expect(await modelCalls(core, "mac_write_file", { folder: "Docs", path: "x.txt", content: "x" })).toMatch(
      /read-only/,
    );
    agent.setPaused(true);
    await until(() => core.execution.devices.view((agent as any).o.pairing.deviceId)!.paused);
    expect(await modelCalls(core, "mac_read_file", { folder: "Docs", path: "notes.txt" })).toMatch(/paused/);
    agent.setPaused(false);
    await until(() => !core.execution.devices.view((agent as any).o.pairing.deviceId)!.paused);
    await core.api["grants.revoke"]({ grantId: grant.id });
    await until(
      () => agent.grants().find((g) => g.id === grant.id)!.revokedAt != null,
      5000,
      "revoke reaches Mac",
    );
    expect(await modelCalls(core, "mac_read_file", { folder: "Docs", path: "notes.txt" })).toMatch(
      /hasn't shared any folders/,
    );
  });

  it("writes exactly the approved bytes, once, after the user approves", async () => {
    const { core, agent, grant, helper } = await setup();
    core.store.updateSettings({ macAccess: true, macWrites: true });
    agent.setMode(grant.id, "read-write");
    await until(() => core.execution.store.getGrant(grant.id)!.mode === "read-write");

    const a = primary(core);
    const reply = modelCalls(core, "mac_write_file", {
      folder: "Docs",
      path: "notes.txt",
      content: "new text",
    });
    await until(() => core.store.pendingRequests().length === 1, 5000, "approval card");
    const card = core.store.pendingRequests()[0]!;
    expect(card.request!.deviceWrite).toMatchObject({
      displayPath: "~/Documents/Docs/notes.txt",
      bytes: 8,
      replaces: { bytes: 18 },
      preview: "new text",
    });
    expect(helper.folders.get("bm-docs")!.get("notes.txt")!.toString()).toBe("hello from the mac");
    await core.api["request.respond"]({
      agentId: a.id,
      requestId: card.request!.requestId,
      decision: "allowAlways",
    });
    expect(await reply).toMatch(/Saved ~\/Documents\/Docs\/notes\.txt .*verified/);
    expect(helper.folders.get("bm-docs")!.get("notes.txt")!.toString()).toBe("new text");
    // "Always" is never remembered for Mac writes.
    expect(core.store.listRules()).toHaveLength(0);
    const op = (await core.api["operations.list"]({})).find((o) => o.capability === "files.write")!;
    expect(op.status).toBe("succeeded");
  });

  it("writes nothing when the user declines or the file changed after the preview", async () => {
    const { core, agent, grant, helper } = await setup();
    core.store.updateSettings({ macAccess: true, macWrites: true });
    agent.setMode(grant.id, "read-write");
    await until(() => core.execution.store.getGrant(grant.id)!.mode === "read-write");
    const a = primary(core);

    let reply = modelCalls(core, "mac_write_file", { folder: "Docs", path: "notes.txt", content: "A" });
    await until(() => core.store.pendingRequests().length === 1);
    let card = core.store.pendingRequests()[0]!;
    await core.api["request.respond"]({
      agentId: a.id,
      requestId: card.request!.requestId,
      decision: "deny",
    });
    expect(await reply).toMatch(/declined/);
    expect(helper.folders.get("bm-docs")!.get("notes.txt")!.toString()).toBe("hello from the mac");

    reply = modelCalls(core, "mac_write_file", { folder: "Docs", path: "notes.txt", content: "B" });
    await until(() => core.store.pendingRequests().length === 1);
    card = core.store.pendingRequests()[0]!;
    helper.folders.get("bm-docs")!.set("notes.txt", Buffer.from("edited by the user meanwhile"));
    await core.api["request.respond"]({
      agentId: a.id,
      requestId: card.request!.requestId,
      decision: "allow",
    });
    expect(await reply).toMatch(/changed since this was prepared/);
    expect(helper.folders.get("bm-docs")!.get("notes.txt")!.toString()).toBe("edited by the user meanwhile");
  });

  it("never resends a write whose result was lost; it asks the Mac when it's back", async () => {
    const { core, agent, grant, helper } = await setup();
    core.store.updateSettings({ macAccess: true, macWrites: true });
    agent.setMode(grant.id, "read-write");
    await until(() => core.execution.store.getGrant(grant.id)!.mode === "read-write");
    helper.writeDelayMs = 400;
    const a = primary(core);
    const reply = modelCalls(core, "mac_write_file", { folder: "Docs", path: "new.txt", content: "fresh" });
    await until(() => core.store.pendingRequests().length === 1);
    const card = core.store.pendingRequests()[0]!;
    await core.api["request.respond"]({
      agentId: a.id,
      requestId: card.request!.requestId,
      decision: "allow",
    });
    await until(() => helper.calls.some((c) => c.method === "files.write"), 5000, "write started");
    agent.stop(); // connection drops while the Mac is writing
    expect(await reply).toMatch(/don't know yet whether it was saved/);
    let op = (await core.api["operations.list"]({})).find((o) => o.capability === "files.write")!;
    expect(op.status).toBe("unknown-outcome");
    await new Promise((r) => setTimeout(r, 500)); // the write finishes on the Mac
    agent.start();
    await until(
      async () => {
        op = (await core.api["operations.list"]({})).find((o) => o.capability === "files.write")!;
        return op.status === "succeeded";
      },
      8000,
      "reconciled",
    );
    expect(helper.calls.filter((c) => c.method === "files.write")).toHaveLength(1);
    expect(helper.folders.get("bm-docs")!.get("new.txt")!.toString()).toBe("fresh");
  });

  it("rejects tool calls from a session that isn't the agent's", async () => {
    const { core } = await setup();
    core.store.updateSettings({ macAccess: true });
    await modelCalls(core, "mac_access", {});
    const res = await mock.forgeToolCall(primary(core).id, "ses_forged", "mac_read_file", {
      folder: "Docs",
      path: "notes.txt",
    });
    expect(res).toMatch(/rejected/);
  });
});

describe("Mac-side enforcement (DeviceAgent)", () => {
  /** Drive DeviceAgent.runCommand directly with crafted frames, as if core were compromised or buggy. */
  function harness() {
    const core = keyPair();
    const helper = new FakeHelper();
    helper.folder("bm", { "a.txt": "old" });
    const state = memoryState();
    const agent = new DeviceAgent({
      wsUrl: "ws://127.0.0.1:1/device",
      pairing: { deviceId: "dev_testtesttest", coreId: "core_x", corePublicKey: core.pub, sign: (t) => t },
      helper,
      state,
      appVersion: "x",
      helperVersion: "x",
      osVersion: "x",
    });
    const g = agent.addGrant({
      bookmark: "bm",
      kind: "dir",
      displayPath: "~/D",
      name: "D",
      mode: "read-write",
      expiresAt: null,
    });
    const sent: any[] = [];
    (agent as any).send = (f: any) => sent.push(f);
    const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
    const writeFrame = (
      content: string,
      opts: { signer?: crypto.KeyObject; relPath?: string; opId?: string } = {},
    ) => {
      const args = {
        relPath: "a.txt",
        dataBase64: Buffer.from(content).toString("base64"),
        sha256: sha(content),
        size: content.length,
        expectedSha256: sha("old"),
      };
      const digest = sha(
        writeDigestInput("dev_testtesttest", g.id, g.revision, { ...args, relPath: opts.relPath ?? "a.txt" }),
      );
      const body = {
        operationId: opts.opId ?? "op_1",
        deviceId: "dev_testtesttest",
        grantId: g.id,
        grantRevision: g.revision,
        command: "files.write" as const,
        argsDigest: digest,
        expiresAt: Date.now() + 60_000,
      };
      return {
        type: "command" as const,
        commandId: `cmd_${crypto.randomBytes(4).toString("hex")}`,
        operationId: body.operationId,
        command: "files.write" as const,
        grantId: g.id,
        grantRevision: g.revision,
        args,
        argsDigest: digest,
        receipt: { ...body, signature: sign(opts.signer ?? core.privateKey, signedText.approval(body)) },
        expiresAt: Date.now() + 60_000,
      };
    };
    const run = async (f: any) => {
      sent.length = 0;
      await (agent as any).runCommand(f);
      return sent[0];
    };
    return { agent, helper, g, writeFrame, run, core };
  }

  it("rejects writes without a valid receipt for exactly these bytes, and replays", async () => {
    const h = harness();
    expect((await h.run({ ...h.writeFrame("new"), receipt: null })).error.code).toBe("denied");
    expect((await h.run(h.writeFrame("new", { signer: keyPair().privateKey }))).error.code).toBe("denied");
    const tampered = h.writeFrame("new");
    tampered.args.dataBase64 = Buffer.from("evil").toString("base64");
    expect((await h.run(tampered)).error.code).toBe("denied");
    expect((await h.run(h.writeFrame("new", { relPath: "other.txt" }))).error.code).toBe("denied");
    expect(h.helper.folders.get("bm")!.get("a.txt")!.toString()).toBe("old");

    const good = h.writeFrame("new", { opId: "op_good" });
    expect((await h.run(good)).ok).toBe(true);
    expect(h.helper.folders.get("bm")!.get("a.txt")!.toString()).toBe("new");
    // Same approval again (new command id): refused.
    expect((await h.run({ ...good, commandId: "cmd_again" })).error.code).toBe("duplicate");
  });

  it("enforces local pause, revocation and scope changes even if core asks", async () => {
    const h = harness();
    const read = {
      type: "command",
      commandId: "cmd_r1",
      operationId: "op_r",
      command: "files.read",
      grantId: h.g.id,
      grantRevision: h.g.revision,
      args: { relPath: "a.txt", maxBytes: 100 },
      argsDigest: crypto
        .createHash("sha256")
        .update(canonicalJson({ relPath: "a.txt", maxBytes: 100 }))
        .digest("hex"),
      receipt: null,
      expiresAt: Date.now() + 60_000,
    };
    expect((await h.run(read)).ok).toBe(true);
    h.agent.setPaused(true);
    expect((await h.run({ ...read, commandId: "cmd_r2" })).error.code).toBe("paused");
    h.agent.setPaused(false);
    expect(
      (await h.run({ ...read, commandId: "cmd_r3", args: { relPath: "a.txt", maxBytes: 99 } })).error.code,
    ).toBe("denied");
    h.agent.setMode(h.g.id, "read");
    expect((await h.run({ ...read, commandId: "cmd_r4" })).error.code).toBe("revoked"); // revision moved on
    h.agent.revokeGrant(h.g.id);
    expect((await h.run({ ...read, commandId: "cmd_r5", grantRevision: h.g.revision + 1 })).error.code).toBe(
      "revoked",
    );
  });
});

describe("restart recovery", () => {
  it("expires approvals that were waiting when core stopped", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const { session } = await signIn(core);
    const dev = await pairDevice(core, session);
    dev.helper.folder("bm", { "a.txt": "x" });
    const g = dev.agent.addGrant({
      bookmark: "bm",
      kind: "dir",
      displayPath: "~/D",
      name: "D",
      mode: "read-write",
      expiresAt: null,
    });
    await until(() => core.execution.store.getGrant(g.id) != null);
    core.store.updateSettings({ macAccess: true, macWrites: true });
    void modelCalls(core, "mac_write_file", { folder: "D", path: "a.txt", content: "y" }).catch(
      () => undefined,
    );
    await until(() => core.store.pendingRequests().length === 1);
    const p = core.cfg.port;
    dev.agent.stop();
    await core.shutdown();
    cores = [];
    const again = await boot({ port: p });
    const op = (await again.api["operations.list"]({})).find((o) => o.capability === "files.write")!;
    expect(op.status).toBe("expired");
    expect(dev.helper.folders.get("bm")!.get("a.txt")!.toString()).toBe("x");
  });
});

describe("Mac apps (R2): Calendar, Contacts, Reminders", () => {
  async function setupApps(mode: "read" | "read-write" = "read-write") {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const { session } = await signIn(core);
    const dev = await pairDevice(core, session);
    core.store.updateSettings({ macAccess: true, macWrites: true, timezone: "America/New_York" });
    const grant = (app: "calendar" | "contacts" | "reminders") =>
      dev.agent.addGrant({
        bookmark: "",
        kind: "app",
        app,
        displayPath: app,
        name: app,
        mode,
        expiresAt: null,
      });
    return { core, ...dev, grant };
  }

  it("needs the app shared; a folder grant never opens Calendar", async () => {
    const { core, agent } = await setupApps();
    agent.addGrant({
      bookmark: "bm",
      kind: "dir",
      displayPath: "~/D",
      name: "D",
      mode: "read-write",
      expiresAt: null,
    });
    await until(() => core.execution.store.listGrants().length === 1);
    expect(await modelCalls(core, "mac_calendar_events", { start: "2026-10-02", end: "2026-10-03" })).toMatch(
      /hasn't shared their Mac's Calendar/,
    );
  });

  it("lists events with their calendar and account, live", async () => {
    const { core, helper, grant } = await setupApps("read");
    const g = grant("calendar");
    await until(() => core.execution.store.getGrant(g.id) != null);
    const day = Date.parse("2026-10-02T14:00:00-04:00");
    helper.events.push(
      {
        id: "e1",
        calendarId: "cal-work",
        title: "Desk review",
        start: day,
        end: day + 3600_000,
        allDay: false,
        location: null,
        lastModified: 5,
      },
      {
        id: "e2",
        calendarId: "cal-home",
        title: "Dinner",
        start: day + 5 * 3600_000,
        end: day + 6 * 3600_000,
        allDay: false,
        location: "Miami",
        lastModified: 5,
      },
    );
    const out = await modelCalls(core, "mac_calendar_events", { start: "2026-10-02", end: "2026-10-03" });
    expect(out).toMatch(/live, all 3 calendars/);
    expect(out).toMatch(/2:00 PM – 3:00 PM · Desk review · Work \(Google\)/);
    expect(out).toMatch(/Dinner · Miami · Home \(iCloud\)/);
    // Read-only share: no changes.
    expect(
      await modelCalls(core, "mac_calendar_create_event", {
        calendar: "Home",
        title: "X",
        start: "2026-10-03T10:00",
        end: "2026-10-03T11:00",
      }),
    ).toMatch(/read-only/);
  });

  it("adds an event only after the user approves the exact details", async () => {
    const { core, helper, grant } = await setupApps();
    const g = grant("calendar");
    await until(() => core.execution.store.getGrant(g.id) != null);
    const a = primary(core);
    const reply = modelCalls(core, "mac_calendar_create_event", {
      calendar: "Home",
      title: "Call Alex",
      start: "2026-10-03T10:00:00-04:00",
      end: "2026-10-03T10:30:00-04:00",
    });
    await until(() => core.store.pendingRequests().length === 1, 5000, "card");
    const card = core.store.pendingRequests()[0]!;
    expect(card.request!.deviceAction!.lines).toEqual(
      expect.arrayContaining([
        { label: "Calendar", value: "Home · iCloud" },
        { label: "Title", value: "Call Alex" },
        { label: "Invites", value: "None (nobody is notified)" },
      ]),
    );
    expect(helper.events).toHaveLength(0);
    await core.api["request.respond"]({
      agentId: a.id,
      requestId: card.request!.requestId,
      decision: "allow",
    });
    expect(await reply).toMatch(/Added “Call Alex”/);
    expect(helper.events.map((e) => [e.calendarId, e.title])).toEqual([["cal-home", "Call Alex"]]);
    // Subscribed calendars can't be written.
    expect(
      await modelCalls(core, "mac_calendar_create_event", {
        calendar: "Holidays",
        title: "X",
        start: "2026-10-03",
        end: "2026-10-03",
        all_day: true,
      }),
    ).toMatch(/read-only/);
  });

  it("refuses to change an event that changed after the user looked", async () => {
    const { core, helper, grant } = await setupApps();
    const g = grant("calendar");
    await until(() => core.execution.store.getGrant(g.id) != null);
    const day = Date.parse("2026-10-02T14:00:00-04:00");
    helper.events.push({
      id: "e1",
      calendarId: "cal-work",
      title: "Desk review",
      start: day,
      end: day + 3600_000,
      allDay: false,
      location: null,
      lastModified: 5,
    });
    await modelCalls(core, "mac_calendar_events", { start: "2026-10-02", end: "2026-10-03" });
    const a = primary(core);
    const reply = modelCalls(core, "mac_calendar_update_event", {
      event_id: "e1",
      start: "2026-10-02T15:00:00-04:00",
      end: "2026-10-02T16:00:00-04:00",
    });
    await until(() => core.store.pendingRequests().length === 1);
    const card = core.store.pendingRequests()[0]!;
    expect(card.request!.deviceAction!.lines[0]).toMatchObject({ label: "Event" });
    helper.events[0]!.lastModified = 99; // someone edited it meanwhile
    await core.api["request.respond"]({
      agentId: a.id,
      requestId: card.request!.requestId,
      decision: "allow",
    });
    expect(await reply).toMatch(/changed since you looked/);
    expect(helper.events[0]!.start).toBe(day);
  });

  it("asks which person when several contacts match, and reports denied macOS access honestly", async () => {
    const { core, helper, grant } = await setupApps("read");
    const g1 = grant("contacts");
    const g2 = grant("calendar");
    await until(
      () => core.execution.store.getGrant(g1.id) != null && core.execution.store.getGrant(g2.id) != null,
    );
    const out = await modelCalls(core, "mac_contacts_search", { query: "Alex" });
    expect(out).toMatch(/Alex Rivera[\s\S]*Alex Chen \(Polestar\)[\s\S]*ask the user which person/);
    helper.calendarAccess = "denied";
    expect(await modelCalls(core, "mac_calendar_list", {})).toMatch(/isn't allowed for Yo in macOS/);
  });

  it("adds and completes reminders with approval", async () => {
    const { core, helper, grant } = await setupApps();
    const g = grant("reminders");
    await until(() => core.execution.store.getGrant(g.id) != null);
    const a = primary(core);
    let reply = modelCalls(core, "mac_reminders_create", {
      list: "Reminders",
      title: "Send Jupiter quote",
      due: "2026-10-03",
    });
    await until(() => core.store.pendingRequests().length === 1);
    let card = core.store.pendingRequests()[0]!;
    await core.api["request.respond"]({
      agentId: a.id,
      requestId: card.request!.requestId,
      decision: "allow",
    });
    expect(await reply).toMatch(/Added the reminder/);
    expect(helper.reminders[0]).toMatchObject({
      title: "Send Jupiter quote",
      dueAllDay: true,
      completed: false,
    });
    expect(await modelCalls(core, "mac_reminders", {})).toMatch(/Send Jupiter quote · due Sat, Oct 3, 2026/);
    reply = modelCalls(core, "mac_reminders_complete", { reminder_id: helper.reminders[0]!.id });
    await until(() => core.store.pendingRequests().length === 1);
    card = core.store.pendingRequests()[0]!;
    await core.api["request.respond"]({
      agentId: a.id,
      requestId: card.request!.requestId,
      decision: "deny",
    });
    expect(await reply).toMatch(/declined/);
    expect(helper.reminders[0]!.completed).toBe(false);
  });

  it("the Mac refuses app changes without a receipt for exactly those arguments", async () => {
    const { agent, grant } = await setupApps();
    const g = grant("calendar");
    const sent: any[] = [];
    (agent as any).send = (f: any) => sent.push(f);
    const args = {
      calendarId: "cal-home",
      title: "X",
      start: 1,
      end: 2,
      allDay: false,
      location: null,
      notes: null,
      timeZone: null,
    };
    const frame = {
      type: "command",
      commandId: "cmd_x",
      operationId: "op_x",
      command: "calendar.createEvent",
      grantId: g.id,
      grantRevision: g.revision,
      args,
      argsDigest: "0".repeat(64),
      receipt: null,
      expiresAt: Date.now() + 60_000,
    };
    await (agent as any).runCommand(frame);
    expect(sent[0].error.code).toBe("denied");
    // A file-style command against an app grant is refused too.
    await (agent as any).runCommand({
      ...frame,
      commandId: "cmd_y",
      command: "files.read",
      args: { relPath: "", maxBytes: 10 },
    });
    expect(sent[1].error.code).toBe("denied");
  });
});

describe("Notes + Mail (R4) and window sessions (R3)", () => {
  async function setup() {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const { session } = await signIn(core);
    const dev = await pairDevice(core, session);
    core.store.updateSettings({ macAccess: true, macWrites: true });
    const grant = (app: "notes" | "mail" | "screen", mode: "read" | "read-write" = "read-write") =>
      dev.agent.addGrant({
        bookmark: "",
        kind: "app",
        app,
        displayPath: app,
        name: app,
        mode,
        expiresAt: null,
      });
    return { core, ...dev, grant };
  }
  const approveNext = async (core: Core, decision: "allow" | "deny" = "allow") => {
    await until(() => core.store.pendingRequests().length === 1, 5000, "card");
    const card = core.store.pendingRequests()[0]!;
    await core.api["request.respond"]({
      agentId: primary(core).id,
      requestId: card.request!.requestId,
      decision,
    });
    return card;
  };

  it("searches and reads notes, and creates one only after approval", async () => {
    const { core, helper, grant } = await setup();
    const g = grant("notes");
    await until(() => core.execution.store.getGrant(g.id) != null);
    expect(await modelCalls(core, "mac_notes_search", { query: "jupiter" })).toMatch(
      /Jupiter desk notes · Notes/,
    );
    expect(await modelCalls(core, "mac_notes_read", { note_id: "n1" })).toMatch(/Dealer discount 23,000/);
    const reply = modelCalls(core, "mac_notes_create", { title: "Quote follow-ups", body: "Call Alex" });
    const card = await approveNext(core);
    expect(card.request!.deviceAction!.app).toBe("notes");
    expect(await reply).toMatch(/Created the note/);
    expect(helper.notes.map((n) => n.name)).toContain("Quote follow-ups");
  });

  it("only ever drafts mail, after approval, and never sends", async () => {
    const { core, helper, grant } = await setup();
    const g = grant("mail");
    await until(() => core.execution.store.getGrant(g.id) != null);
    expect(await modelCalls(core, "mac_mail_draft", { to: ["Alex"], subject: "Quote", body: "Hi" })).toMatch(
      /isn't an email address/,
    );
    const reply = modelCalls(core, "mac_mail_draft", {
      to: ["alex@example.com"],
      subject: "Quote",
      body: "Hi Alex",
    });
    const card = await approveNext(core);
    expect(card.request!.deviceAction!.lines).toEqual(
      expect.arrayContaining([{ label: "Sending", value: expect.stringMatching(/Not sent/) }]),
    );
    expect(await reply).toMatch(/NOT sent/);
    expect(helper.drafts).toEqual([{ to: ["alex@example.com"], subject: "Quote", body: "Hi Alex" }]);
    expect(helper.calls.some((c) => /send/i.test(c.method))).toBe(false);
  });

  it("window sessions need the switch, the Mac grant, and an approved session for exactly one window", async () => {
    const { core, helper, agent, grant } = await setup();
    expect(await modelCalls(core, "mac_windows", {})).toMatch(/turned off/);
    core.store.updateSettings({ macControl: true });
    expect(await modelCalls(core, "mac_windows", {})).toMatch(/hasn't shared their Mac's Window control/);
    const g = grant("screen", "read");
    await until(() => core.execution.store.getGrant(g.id) != null);
    expect(await modelCalls(core, "mac_windows", {})).toMatch(/\[101\] Chrome — CDK Desking/);
    // Look-only grant: no control session.
    expect(
      await modelCalls(core, "mac_window_session", { window_id: 101, purpose: "fill the quote" }),
    ).toMatch(/only look/);
    agent.setMode(g.id, "read-write");
    await until(() => core.execution.store.getGrant(g.id)!.mode === "read-write");
    expect(await modelCalls(core, "mac_window_click", { x: 0.5, y: 0.5 })).toMatch(/No window session/);

    const reply = modelCalls(core, "mac_window_session", {
      window_id: 101,
      purpose: "Fill in the quote",
      minutes: 5,
    });
    const card = await approveNext(core);
    expect(card.request!.deviceAction).toMatchObject({ app: "screen" });
    expect(card.request!.deviceAction!.lines).toEqual(
      expect.arrayContaining([
        { label: "Window", value: "CDK Desking" },
        { label: "Allowed", value: "See, click and type in this window only" },
      ]),
    );
    expect(await reply).toMatch(/may see and use/);
    expect(agent.activeLease).toMatchObject({ windowId: 101, control: true });

    expect(await modelCalls(core, "mac_window_look", {})).toMatch(
      /saved at ~\/from-mac\/mac-window-\d+\.png \(800×600\)/,
    );
    expect(await modelCalls(core, "mac_window_click", { x: 0.25, y: 0.75 })).toMatch(/Done/);
    expect(helper.inputs.at(-1)).toEqual({
      method: "window.click",
      params: { windowId: 101, x: 0.25, y: 0.75, button: "left", count: 1 },
    });

    // The user presses Stop on the Mac: no further input, and core forgets the session.
    agent.endLease("stopped by the user");
    await new Promise((r) => setTimeout(r, 100));
    expect(await modelCalls(core, "mac_window_type", { text: "x" })).toMatch(/No window session/);
    expect(helper.inputs).toHaveLength(1);
  });

  it("the Mac refuses window input outside the approved session", async () => {
    const { agent, grant } = await setup();
    const g = grant("screen");
    const sent: any[] = [];
    (agent as any).send = (f: any) => sent.push(f);
    const args = { windowId: 101, x: 0.5, y: 0.5, button: "left", count: 1 };
    const frame = {
      type: "command",
      commandId: "cmd_w1",
      operationId: "op_w1",
      command: "window.click",
      grantId: g.id,
      grantRevision: g.revision,
      args,
      argsDigest: (await import("node:crypto"))
        .createHash("sha256")
        .update(canonicalJson(args))
        .digest("hex"),
      receipt: null,
      expiresAt: Date.now() + 60_000,
    };
    await (agent as any).runCommand(frame);
    expect(sent[0].error.code).toBe("no_session");
    const session = {
      ...frame,
      commandId: "cmd_w2",
      command: "window.session",
      args: { windowId: 101, bundleId: "com.google.Chrome", title: "X", minutes: 5, control: true },
    };
    await (agent as any).runCommand(session);
    expect(sent[1].error.code).toBe("denied"); // no signed approval
    expect(agent.activeLease).toBeNull();
  });
});
