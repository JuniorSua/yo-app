/**
 * Real native helper end to end (macOS only, opt-in: YO_NATIVE_ITEST=1 after `apps/desktop/native/build.sh`).
 * Core + the Mac-side DeviceAgent + the actual YoDeviceBridge binary, in a temporary folder under $HOME
 * (helper scopes must live in the home folder), removed afterwards.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signedText } from "@yo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeviceAgent, type DeviceState } from "../../desktop/src/device/DeviceAgent";
import { HelperClient } from "../../desktop/src/device/HelperClient";
import { loadConfig } from "../src/config";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { MockAgentd } from "./mockAgentd";

const BIN = path.resolve(__dirname, "../../desktop/native/bin/YoDeviceBridge");
const enabled = process.platform === "darwin" && process.env.YO_NATIVE_ITEST === "1" && fs.existsSync(BIN);

describe.skipIf(!enabled)("native helper end to end", () => {
  const TOKEN = "n".repeat(64);
  let dataDir: string;
  let folder: string;
  let mock: MockAgentd;
  let core: Awaited<ReturnType<typeof startCore>>;
  let agent: DeviceAgent;
  let helper: HelperClient;

  const until = async (fn: () => boolean, ms = 8000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("timeout");
  };

  async function model(tool: string, args: Record<string, unknown>) {
    const a = core.store.listAgents().find((x) => x.isPrimary)!;
    const before = core.store.listTimeline(a.id).length;
    await core.api["chat.send"]({ agentId: a.id, text: `tool ${tool} ${JSON.stringify(args)}` });
    let out = "";
    await until(() => {
      const e = core.store
        .listTimeline(a.id)
        .slice(before)
        .find((x) => x.item.kind === "assistant_message" && x.item.status === "completed");
      out = String(e?.item.text ?? "");
      return !!e;
    }, 15000);
    await until(() => core.orchestrator.activityOf(a.id) !== "working");
    return out.replace(/^tool: /, "");
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-native-"));
    folder = fs.mkdtempSync(path.join(os.homedir(), "yo-native-itest-"));
    fs.writeFileSync(path.join(folder, "notes.txt"), "real file on this Mac");
    fs.mkdirSync(path.join(folder, ".ssh"));
    fs.writeFileSync(path.join(folder, ".ssh", "id_ed25519"), "secret");
    fs.symlinkSync("/etc/hosts", path.join(folder, "link"));

    mock = new MockAgentd(TOKEN);
    const agentdUrl = await mock.listen();
    process.env.YO_AGENTD_TOKEN = TOKEN;
    core = await startCore(
      {
        ...loadConfig({}),
        port: 21800 + Math.floor(Math.random() * 500),
        dataDir,
        agentdUrl,
        computerMode: "remote",
        secrets: "file",
        webDist: null,
      },
      { secrets: new MemorySecretStore() },
    );
    await core.agentd.waitReady(5000);
    await until(() => core.store.listAccounts().some((x) => x.status === "authenticated"));
    core.store.updateSettings({ macAccess: true, macWrites: true });

    // Controller + pairing, exactly as the desktop app does it.
    const base = `http://127.0.0.1:${core.cfg.port}`;
    const post = async (p: string, body: unknown, bearer?: string) =>
      (
        await fetch(`${base}${p}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          },
          body: JSON.stringify(body),
        })
      ).json() as Promise<any>;
    const kp = () => crypto.generateKeyPairSync("ed25519");
    const pubOf = (k: crypto.KeyObject) => k.export({ type: "spki", format: "der" }).toString("base64");
    const token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(path.join(dataDir, "enroll-token"), token, { mode: 0o600 });
    const ctl = kp();
    const { controllerId } = await post("/auth/enroll", { token, publicKey: pubOf(ctl.publicKey) });
    const { nonce } = await post("/auth/challenge", {});
    const sig = crypto.sign(
      null,
      Buffer.from(signedText.controllerSession(nonce, controllerId)),
      ctl.privateKey,
    );
    const { token: session } = await post("/auth/session", {
      controllerId,
      nonce,
      signature: sig.toString("base64"),
    });
    const start = await core.api["devices.pair.start"]({});
    const dev = kp();
    const deviceId = `dev_${crypto.randomBytes(8).toString("hex")}`;
    const pub = pubOf(dev.publicKey);
    await post(
      "/auth/pair-device",
      {
        challenge: start.challenge,
        deviceId,
        publicKey: pub,
        signature: crypto
          .sign(null, Buffer.from(signedText.pairing(start.challenge, deviceId, pub)), dev.privateKey)
          .toString("base64"),
        name: "This Mac",
        osVersion: os.release(),
        appVersion: "test",
      },
      session,
    );

    helper = new HelperClient(BIN);
    const info = await helper.ensure();
    let state: DeviceState = { grants: [], paused: false, journal: [] };
    agent = new DeviceAgent({
      wsUrl: `ws://127.0.0.1:${core.cfg.port}/device`,
      pairing: {
        deviceId,
        coreId: start.coreId,
        corePublicKey: start.corePublicKey,
        sign: (t) => crypto.sign(null, Buffer.from(t), dev.privateKey).toString("base64"),
      },
      helper,
      state: { load: () => state, save: (s) => (state = s) },
      appVersion: "test",
      helperVersion: info.version,
      osVersion: info.macos,
    });
    agent.start();
    await until(() => agent.connected);
    const scope = await helper.call("scope.create", { path: folder });
    const g = agent.addGrant({
      bookmark: scope.bookmark,
      kind: scope.kind,
      displayPath: scope.displayPath,
      name: path.basename(folder),
      mode: "read-write",
      expiresAt: null,
    });
    await until(() => core.execution.store.getGrant(g.id) != null);
  }, 60_000);

  afterAll(async () => {
    agent?.stop();
    helper?.stop();
    await core?.shutdown();
    await mock?.close();
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("reads through the real helper and refuses secrets and links", async () => {
    const name = path.basename(folder);
    expect(await model("mac_read_file", { folder: name, path: "notes.txt" })).toContain(
      "real file on this Mac",
    );
    expect(await model("mac_read_file", { folder: name, path: ".ssh/id_ed25519" })).toMatch(/protected/);
    expect(await model("mac_read_file", { folder: name, path: "link" })).toMatch(/link/);
    const listing = await model("mac_list_files", { folder: name });
    expect(listing).toContain("notes.txt");
    expect(listing).not.toContain(".ssh");
  }, 60_000);

  it("writes atomically through the real helper after approval", async () => {
    const name = path.basename(folder);
    const a = core.store.listAgents().find((x) => x.isPrimary)!;
    const reply = model("mac_write_file", { folder: name, path: "notes.txt", content: "approved change" });
    await until(() => core.store.pendingRequests().length === 1);
    const card = core.store.pendingRequests()[0]!;
    await core.api["request.respond"]({
      agentId: a.id,
      requestId: card.request!.requestId,
      decision: "allow",
    });
    expect(await reply).toMatch(/verified/);
    expect(fs.readFileSync(path.join(folder, "notes.txt"), "utf8")).toBe("approved change");
    expect(fs.readdirSync(folder).filter((f) => f.startsWith(".yo-tmp"))).toEqual([]);
  }, 60_000);

  it("app commands reach the real helper with valid arguments (no macOS access here → 'not allowed', never 'invalid')", async () => {
    const perms = await helper.call("permissions.status", {});
    if (perms.calendars === "granted" || perms.reminders === "granted" || perms.contacts === "granted")
      return; // can't assert denial on a granted Mac
    core.store.updateSettings({ timezone: "America/New_York" });
    for (const app of ["calendar", "contacts", "reminders"] as const)
      agent.addGrant({
        bookmark: "",
        kind: "app",
        app,
        displayPath: app,
        name: app,
        mode: "read-write",
        expiresAt: null,
      });
    await until(() => core.execution.store.listGrants().filter((g) => g.kind === "app").length === 3);
    const notAllowed = /isn't allowed for Yo in macOS/;
    expect(await model("mac_calendar_list", {})).toMatch(notAllowed);
    expect(await model("mac_contacts_search", { query: "Alex" })).toMatch(notAllowed);
    expect(await model("mac_reminders", {})).toMatch(notAllowed);
    const calls: string[] = [];
    const orig = helper.call.bind(helper);
    helper.call = async (m: string, p: Record<string, unknown>) => {
      calls.push(m);
      return orig(m, p);
    };
    expect(await model("mac_calendar_events", { start: "2026-10-02", end: "2026-10-03" })).toMatch(
      notAllowed,
    );
    helper.call = orig;
    expect(calls).toContain("calendar.calendars");
  }, 60_000);

  it("every app command shape core sends is accepted by the real helper's validation", async () => {
    const shapes: [string, Record<string, unknown>][] = [
      ["contacts.search", { query: "Alex", limit: 20 }],
      ["calendar.calendars", {}],
      ["calendar.events", { start: 1790900000000, end: 1790986400000, calendarIds: null, limit: 200 }],
      ["calendar.events", { start: 1790900000000, end: 1790986400000, calendarIds: ["cal-1"], limit: 200 }],
      [
        "calendar.createEvent",
        {
          calendarId: "cal-1",
          title: "Call Alex",
          start: 1790900000000,
          end: 1790901800000,
          allDay: false,
          location: null,
          notes: null,
          timeZone: "America/New_York",
        },
      ],
      [
        "calendar.updateEvent",
        {
          id: "ev-1",
          occurrenceDate: 1790900000000,
          expectedLastModified: 1790800000000,
          changes: { title: "New", location: null },
        },
      ],
      ["reminders.lists", {}],
      ["reminders.list", { listIds: null, includeCompleted: false, limit: 200 }],
      [
        "reminders.create",
        { listId: "rl-1", title: "Send quote", due: 1790900000000, dueAllDay: true, notes: null },
      ],
      ["reminders.create", { listId: "rl-1", title: "No date", due: null, dueAllDay: false, notes: null }],
      ["reminders.complete", { id: "rm-1", completed: true }],
      // Window commands on a window id that doesn't exist: validated, then refused before any input.
      ["window.click", { windowId: 4294967295, x: 0.5, y: 0.5, button: "left", count: 1 }],
      ["window.type", { windowId: 4294967295, text: "hi" }],
      ["window.key", { windowId: 4294967295, key: "return", modifiers: [] }],
      ["window.scroll", { windowId: 4294967295, dx: 0, dy: 120 }],
    ];
    for (const [method, params] of shapes) {
      const code = await helper.call(method, params).then(
        () => "ok",
        (err: { code?: string }) => err.code,
      );
      // Validation runs before the OS access check: anything but invalid_params proves the shape matches.
      expect([method, code]).not.toEqual([method, "invalid_params"]);
    }
  }, 60_000);
});
