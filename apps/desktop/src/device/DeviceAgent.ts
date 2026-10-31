/**
 * The Mac's side of the device connection (runs in Electron main; no Electron imports so it's testable).
 *
 * This is the second, independent enforcement point. Core already checked everything, but the Mac only
 * trusts what it can verify itself:
 *  - grants live here, created from a native picker by the user; core's copy is a mirror
 *  - every command must name a live local grant at its current revision, within its mode
 *  - every write needs core's signed receipt for exactly these bytes (sha256 + size + path + grant revision),
 *    verified against the core key pinned at pairing, and is journaled so it can never run twice
 *  - "Pause Mac access" here overrides everything, even when core is unreachable
 * File access itself goes through the native helper, which re-validates paths component by component.
 */
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
  APP_COMMANDS,
  appWriteDigestInput,
  type CoreToDevice,
  CoreToDevice as CoreToDeviceSchema,
  canonicalJson,
  DEVICE_PROTOCOL_VERSION,
  type DeviceApp,
  type DeviceCapability,
  type DeviceError,
  type DeviceGrant,
  type DeviceToCore,
  FilesListArgs,
  FilesReadArgs,
  FilesStatArgs,
  FilesWriteArgs,
  type GrantMode,
  NoArgs,
  type OsPermissionState,
  signedText,
  WINDOW_COMMANDS,
  WindowEndArgs,
  WindowSessionArgs,
  writeDigestInput,
} from "@yo/contracts";
import WebSocket from "ws";

export const FILE_CAPABILITIES: DeviceCapability[] = ["files.list", "files.read", "files.write"];
export const APP_CAPABILITIES: DeviceCapability[] = [
  "contacts.read",
  "calendar.read",
  "calendar.write",
  "reminders.read",
  "reminders.write",
];

export const R3_R4_CAPABILITIES: DeviceCapability[] = [
  "notes.read",
  "notes.write",
  "mail.read",
  "mail.draft",
  "window.observe",
  "window.control",
];

/** What this helper version can actually do (Contacts/Calendar/Reminders arrived in helper 0.2.0). */
export function capabilitiesFor(helperVersion: string | null): DeviceCapability[] {
  if (!helperVersion) return [];
  const [maj = 0, min = 0] = helperVersion.split(".").map(Number);
  if (maj === 0 && min < 2) return FILE_CAPABILITIES;
  if (maj === 0 && min < 3) return [...FILE_CAPABILITIES, ...APP_CAPABILITIES];
  return [...FILE_CAPABILITIES, ...APP_CAPABILITIES, ...R3_R4_CAPABILITIES];
}

export interface HelperApi {
  call(method: string, params: Record<string, unknown>): Promise<any>;
}

/** Thrown by HelperApi for a structured helper error (code from the helper protocol). */
export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LocalGrant extends DeviceGrant {
  /** macOS bookmark (base64) for the picked folder/file; resolved by the helper on every use. */
  bookmark: string;
}

export interface JournalEntry {
  commandId: string;
  operationId: string;
  command: string;
  state: "started" | "done";
  at: number;
  ok?: boolean;
  result?: unknown;
  error?: DeviceError;
}

export interface DeviceState {
  grants: LocalGrant[];
  paused: boolean;
  journal: JournalEntry[];
}

export interface DeviceStateStore {
  load(): DeviceState;
  save(state: DeviceState): void;
}

export interface Pairing {
  deviceId: string;
  coreId: string;
  /** Core's Ed25519 key (SPKI DER base64), pinned at pairing. */
  corePublicKey: string;
  sign(text: string): string;
}

export interface DeviceAgentOptions {
  wsUrl: string;
  pairing: Pairing;
  helper: HelperApi;
  state: DeviceStateStore;
  appVersion: string;
  helperVersion: string | null;
  osVersion: string;
  permissions?: () => Promise<Record<string, OsPermissionState>>;
  now?: () => number;
}

const JOURNAL_MAX = 2000;
const JOURNAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class DeviceAgent extends EventEmitter<{
  connected: [];
  disconnected: [];
  unpaired: [];
  changed: [];
}> {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private state: DeviceState;
  private ready = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly o: DeviceAgentOptions) {
    super();
    this.now = o.now ?? Date.now;
    this.state = o.state.load();
  }

  get connected() {
    return this.ready;
  }

  get paused() {
    return this.state.paused;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.endLease("Yo on this Mac stopped");
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close(1000, "stopping");
    this.ws = null;
    this.ready = false;
  }

  /* --------------------------- local (trusted) actions --------------------------- */

  grants(): DeviceGrant[] {
    return this.state.grants.map(publicGrant);
  }

  /** Called by trusted main-process UI after the user picked a folder/file natively. */
  addGrant(input: {
    bookmark: string;
    kind: "dir" | "file" | "app";
    app?: DeviceApp;
    displayPath: string;
    name: string;
    mode: GrantMode;
    expiresAt: number | null;
  }): DeviceGrant {
    const g: LocalGrant = {
      id: `grt_${crypto.randomBytes(12).toString("hex")}`,
      deviceId: this.o.pairing.deviceId,
      kind: input.kind,
      ...(input.kind === "app" ? { app: input.app } : {}),
      displayPath: input.displayPath.slice(0, 1024),
      name: input.name.slice(0, 255),
      mode: input.mode,
      expiresAt: input.expiresAt,
      revision: 1,
      createdAt: this.now(),
      revokedAt: null,
      bookmark: input.bookmark,
    };
    this.state.grants.push(g);
    this.persistAndSync();
    return publicGrant(g);
  }

  setMode(grantId: string, mode: GrantMode): DeviceGrant | null {
    const g = this.state.grants.find((x) => x.id === grantId && !x.revokedAt);
    if (!g || g.mode === mode) return g ? publicGrant(g) : null;
    g.mode = mode;
    g.revision += 1; // invalidates approvals made under the old scope
    this.persistAndSync();
    return publicGrant(g);
  }

  revokeGrant(grantId: string) {
    const g = this.state.grants.find((x) => x.id === grantId);
    if (!g || g.revokedAt) return;
    g.revokedAt = this.now();
    g.revision += 1;
    this.persistAndSync();
  }

  setPaused(paused: boolean) {
    if (paused) this.endLease("paused by the user");
    if (this.state.paused === paused) return;
    this.state.paused = paused;
    this.o.state.save(this.state);
    this.emit("changed");
    void this.sendState();
  }

  /** Re-send OS permission states (e.g. after the user changed them in System Settings). */
  async refreshPermissions() {
    await this.sendState();
  }

  private persistAndSync() {
    this.o.state.save(this.state);
    this.emit("changed");
    if (this.ready) this.send({ type: "grants", grants: this.grants() });
  }

  /* -------------------------------- connection -------------------------------- */

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.o.wsUrl, { maxPayload: 40 * 1024 * 1024 });
    this.ws = ws;
    const clientNonce = crypto.randomBytes(32).toString("hex");
    let stage: "challenge" | "welcome" | "ready" = "challenge";
    let nonce = "";

    ws.on("open", () => {
      this.send({ type: "init", deviceId: this.o.pairing.deviceId, clientNonce });
    });
    ws.on("message", async (raw) => {
      let frame: CoreToDevice;
      try {
        frame = CoreToDeviceSchema.parse(JSON.parse(raw.toString()));
      } catch {
        return ws.close(4400, "invalid frame");
      }
      if (stage === "challenge") {
        if (frame.type !== "challenge" || frame.protocol !== DEVICE_PROTOCOL_VERSION)
          return ws.close(4400, "expected challenge");
        if (
          frame.coreId !== this.o.pairing.coreId ||
          !verify(
            this.o.pairing.corePublicKey,
            signedText.coreHello(clientNonce, frame.nonce, this.o.pairing.deviceId),
            frame.coreSignature,
          )
        )
          return ws.close(4401, "not the paired core");
        nonce = frame.nonce;
        stage = "welcome";
        this.send({
          type: "hello",
          protocol: DEVICE_PROTOCOL_VERSION,
          deviceId: this.o.pairing.deviceId,
          signature: this.o.pairing.sign(signedText.deviceHello(nonce, clientNonce, this.o.pairing.deviceId)),
          appVersion: this.o.appVersion,
          helperVersion: this.o.helperVersion,
          osVersion: this.o.osVersion,
          capabilities: capabilitiesFor(this.o.helperVersion),
          permissions: (await this.o.permissions?.().catch(() => ({}))) ?? {},
          paused: this.state.paused,
        });
        return;
      }
      if (stage === "welcome") {
        if (frame.type !== "welcome") return ws.close(4400, "expected welcome");
        let changed = false;
        for (const id of frame.revokedGrantIds) {
          const g = this.state.grants.find((x) => x.id === id && !x.revokedAt);
          if (g) {
            g.revokedAt = this.now();
            g.revision += 1;
            changed = true;
          }
        }
        if (changed) {
          this.o.state.save(this.state);
          this.emit("changed");
        }
        stage = "ready";
        this.ready = true;
        this.attempts = 0;
        this.send({ type: "grants", grants: this.grants() });
        this.emit("connected");
        return;
      }
      this.onFrame(frame);
    });
    ws.on("close", (code) => {
      const wasReady = this.ready;
      this.ready = false;
      if (this.ws === ws) this.ws = null;
      if (wasReady) this.emit("disconnected");
      if (code === 4401 && stage !== "challenge") {
        // Core no longer knows this device (unpaired). Don't hammer it; main will forget the pairing.
        this.stopped = true;
        this.emit("unpaired");
        return;
      }
      this.scheduleReconnect();
    });
    ws.on("error", () => undefined);
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)) * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  private send(frame: DeviceToCore) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private async sendState() {
    if (!this.ready) return;
    const permissions = (await this.o.permissions?.().catch(() => ({}))) ?? {};
    this.send({ type: "state", paused: this.state.paused, permissions });
  }

  private onFrame(frame: CoreToDevice) {
    switch (frame.type) {
      case "command":
        // One command at a time, in order.
        this.queue = this.queue.then(() => this.runCommand(frame)).catch(() => undefined);
        return;
      case "status.query": {
        const j = this.state.journal.find((e) => e.commandId === frame.commandId);
        this.send({
          type: "status",
          commandId: frame.commandId,
          state: j ? j.state : "unknown",
          ...(j?.state === "done" ? { ok: j.ok, result: j.result, error: j.error } : {}),
        });
        return;
      }
      case "revoke":
        this.revokeGrant(frame.grantId);
        return;
      case "unpaired":
        this.stopped = true;
        this.emit("unpaired");
        return;
      default:
        return;
    }
  }

  /* --------------------------------- commands --------------------------------- */

  private async runCommand(f: Extract<CoreToDevice, { type: "command" }>) {
    const reply = (ok: boolean, result?: unknown, error?: DeviceError) =>
      this.send({ type: "result", commandId: f.commandId, ok, ...(ok ? { result } : { error }) });
    const fail = (code: string, message = code) => reply(false, undefined, { code, message });

    if (this.state.journal.some((e) => e.commandId === f.commandId))
      return fail("duplicate", "already handled");
    if (this.state.paused) return fail("paused", "Mac access is paused");
    if (f.expiresAt < this.now()) return fail("expired", "command expired");
    const g = this.state.grants.find((x) => x.id === f.grantId);
    if (!g || g.revokedAt || (g.expiresAt != null && g.expiresAt <= this.now()))
      return fail("revoked", "not shared anymore");
    if (g.revision !== f.grantRevision) return fail("revoked", "sharing changed");

    try {
      if (
        f.command === "windows.list" ||
        f.command === "window.session" ||
        f.command === "window.end" ||
        WINDOW_COMMANDS[f.command]
      )
        return await this.windowCommand(f, g, reply, fail);
      const app = APP_COMMANDS[f.command];
      if (app) return await this.appCommand(f, g, app, reply, fail);
      if (g.kind === "app") return fail("denied", "not a folder or file grant");
      switch (f.command) {
        case "files.list": {
          const args = FilesListArgs.parse(f.args);
          if (!digestOk(args, f.argsDigest)) return fail("denied", "argument mismatch");
          return reply(true, await this.o.helper.call("files.list", { bookmark: g.bookmark, ...args }));
        }
        case "files.stat": {
          const args = FilesStatArgs.parse(f.args);
          if (!digestOk(args, f.argsDigest)) return fail("denied", "argument mismatch");
          const r = await this.o.helper.call("files.stat", { bookmark: g.bookmark, ...args });
          return reply(true, { kind: r.kind, size: r.size, mtimeMs: r.mtimeMs, sha256: r.sha256 ?? null });
        }
        case "files.read": {
          const args = FilesReadArgs.parse(f.args);
          if (!digestOk(args, f.argsDigest)) return fail("denied", "argument mismatch");
          return reply(true, await this.o.helper.call("files.read", { bookmark: g.bookmark, ...args }));
        }
        case "files.write":
          return await this.write(f, g, reply, fail);
      }
    } catch (err) {
      if (err instanceof HelperError) return fail(err.code, err.message.slice(0, 200));
      return fail("invalid_params", "invalid command");
    }
  }

  private async write(
    f: Extract<CoreToDevice, { type: "command" }>,
    g: LocalGrant,
    reply: (ok: boolean, result?: unknown, error?: DeviceError) => void,
    fail: (code: string, message?: string) => void,
  ) {
    if (g.mode !== "read-write") return fail("denied", "shared read-only");
    if (!f.receipt) return fail("denied", "no approval");
    const args = FilesWriteArgs.parse(f.args);
    const data = Buffer.from(args.dataBase64, "base64");
    if (data.length !== args.size || sha256(data) !== args.sha256)
      return fail("denied", "content doesn't match approval");
    const digest = sha256(writeDigestInput(this.o.pairing.deviceId, g.id, g.revision, args));
    if (!this.receiptOk(f, g, digest)) return fail("denied", "approval doesn't match");
    // Single use: one approval, one write.
    if (this.state.journal.some((e) => e.operationId === f.operationId && e.command === "files.write"))
      return fail("duplicate", "already handled");

    const entry: JournalEntry = {
      commandId: f.commandId,
      operationId: f.operationId,
      command: "files.write",
      state: "started",
      at: this.now(),
    };
    this.journal(entry);
    try {
      const res = await this.o.helper.call("files.write", {
        bookmark: g.bookmark,
        relPath: args.relPath,
        dataBase64: args.dataBase64,
        expectedSha256: args.expectedSha256,
      });
      Object.assign(entry, { state: "done", ok: true, result: { sha256: res.sha256, size: res.size } });
      this.journal(entry);
      reply(true, { sha256: res.sha256, size: res.size });
      if (g.kind === "file") await this.refreshFileBookmark(g);
    } catch (err) {
      const error =
        err instanceof HelperError
          ? { code: err.code, message: err.message.slice(0, 200) }
          : { code: "io", message: "write failed" };
      Object.assign(entry, { state: "done", ok: false, error });
      this.journal(entry);
      reply(false, undefined, error);
    }
  }

  /**
   * Contacts / Calendar / Reminders. Needs a live grant for exactly that app; reads within its mode; changes
   * need read-and-change, core's signed receipt for exactly these arguments, and run at most once.
   */
  private async appCommand(
    f: Extract<CoreToDevice, { type: "command" }>,
    g: LocalGrant,
    spec: (typeof APP_COMMANDS)[string],
    reply: (ok: boolean, result?: unknown, error?: DeviceError) => void,
    fail: (code: string, message?: string) => void,
  ) {
    if (g.kind !== "app" || g.app !== spec.app) return fail("denied", "that app isn't shared");
    const args = spec.args.parse(f.args) as Record<string, unknown>;
    if (!spec.write) {
      if (!digestOk(args, f.argsDigest)) return fail("denied", "argument mismatch");
      return reply(true, await this.o.helper.call(f.command, args));
    }
    if (g.mode !== "read-write") return fail("denied", "shared read-only");
    const digest = sha256(appWriteDigestInput(this.o.pairing.deviceId, g.id, g.revision, f.command, args));
    if (!this.receiptOk(f, g, digest)) return fail("denied", "approval doesn't match");
    if (this.state.journal.some((e) => e.operationId === f.operationId && e.command === f.command))
      return fail("duplicate", "already handled");
    const entry: JournalEntry = {
      commandId: f.commandId,
      operationId: f.operationId,
      command: f.command,
      state: "started",
      at: this.now(),
    };
    this.journal(entry);
    try {
      const res = await this.o.helper.call(f.command, args);
      Object.assign(entry, { state: "done", ok: true, result: res });
      this.journal(entry);
      reply(true, res);
    } catch (err) {
      const error =
        err instanceof HelperError
          ? { code: err.code, message: err.message.slice(0, 200) }
          : { code: "io", message: "change failed" };
      Object.assign(entry, { state: "done", ok: false, error });
      this.journal(entry);
      reply(false, undefined, error);
    }
  }

  /* ----------------------------- window sessions (R3) ----------------------------- */

  /** The one active window session on this Mac (approved by the user via core's signed receipt). */
  private lease: {
    leaseId: string;
    windowId: number;
    title: string;
    control: boolean;
    expiresAt: number;
    timer: NodeJS.Timeout;
  } | null = null;

  get activeLease() {
    return this.lease
      ? {
          leaseId: this.lease.leaseId,
          windowId: this.lease.windowId,
          title: this.lease.title,
          control: this.lease.control,
          expiresAt: this.lease.expiresAt,
        }
      : null;
  }

  /** End the session right here (Stop button, shortcut, pause, expiry). Core is told if reachable. */
  endLease(reason: string) {
    const l = this.lease;
    if (!l) return;
    clearTimeout(l.timer);
    this.lease = null;
    this.emit("changed");
    this.send({ type: "lease.ended", leaseId: l.leaseId, reason: reason.slice(0, 200) });
  }

  private async windowCommand(
    f: Extract<CoreToDevice, { type: "command" }>,
    g: LocalGrant,
    reply: (ok: boolean, result?: unknown, error?: DeviceError) => void,
    fail: (code: string, message?: string) => void,
  ) {
    if (g.kind !== "app" || g.app !== "screen")
      return fail("denied", "window control isn't allowed on this Mac");
    if (f.command === "windows.list") {
      if (!digestOk(NoArgs.parse(f.args), f.argsDigest)) return fail("denied", "argument mismatch");
      return reply(true, await this.o.helper.call("windows.list", {}));
    }
    if (f.command === "window.end") {
      const args = WindowEndArgs.parse(f.args);
      if (this.lease?.leaseId === args.leaseId) this.endLease("ended by Yo");
      return reply(true, { ended: true });
    }
    if (f.command === "window.session") {
      const args = WindowSessionArgs.parse(f.args);
      if (args.control && g.mode !== "read-write") return fail("denied", "look-only on this Mac");
      const digest = sha256(appWriteDigestInput(this.o.pairing.deviceId, g.id, g.revision, f.command, args));
      if (!this.receiptOk(f, g, digest)) return fail("denied", "approval doesn't match");
      if (this.state.journal.some((e) => e.operationId === f.operationId && e.command === f.command))
        return fail("duplicate", "already handled");
      this.journal({
        commandId: f.commandId,
        operationId: f.operationId,
        command: f.command,
        state: "done",
        at: this.now(),
        ok: true,
      });
      if (this.lease) this.endLease("replaced by a new session");
      const expiresAt = this.now() + args.minutes * 60_000;
      const timer = setTimeout(() => this.endLease("time is up"), args.minutes * 60_000);
      timer.unref?.();
      this.lease = {
        leaseId: f.operationId,
        windowId: args.windowId,
        title: args.title,
        control: args.control,
        expiresAt,
        timer,
      };
      this.emit("changed");
      return reply(true, { leaseId: f.operationId, expiresAt });
    }
    const spec = WINDOW_COMMANDS[f.command]!;
    const args = spec.args.parse(f.args) as { windowId: number };
    if (!digestOk(args, f.argsDigest)) return fail("denied", "argument mismatch");
    const l = this.lease;
    if (!l || l.expiresAt <= this.now()) return fail("no_session", "no active window session");
    if (l.windowId !== args.windowId) return fail("denied", "not the approved window");
    if (spec.control && (!l.control || g.mode !== "read-write")) return fail("denied", "look-only session");
    try {
      // The helper only acts on windows it has listed in its current run (it may have restarted while idle).
      await this.o.helper.call("windows.list", {});
      return reply(true, await this.o.helper.call(f.command, args));
    } catch (err) {
      // The window went away or was taken over: the session can't continue safely.
      if (err instanceof HelperError && (err.code === "not_found" || err.code === "denied"))
        this.endLease(`window unavailable (${err.code})`);
      throw err;
    }
  }

  /** Core's signed approval for exactly this operation, grant revision, command and argument digest. */
  private receiptOk(f: Extract<CoreToDevice, { type: "command" }>, g: LocalGrant, digest: string): boolean {
    const r = f.receipt;
    if (!r) return false;
    const { signature, ...body } = r;
    return (
      r.deviceId === this.o.pairing.deviceId &&
      r.grantId === g.id &&
      r.grantRevision === g.revision &&
      r.operationId === f.operationId &&
      r.command === f.command &&
      r.argsDigest === digest &&
      f.argsDigest === digest &&
      r.expiresAt >= this.now() &&
      verify(this.o.pairing.corePublicKey, signedText.approval(body), signature)
    );
  }

  /** Replacing a shared single file gives it a new identity; re-point the bookmark at the same path. */
  private async refreshFileBookmark(g: LocalGrant) {
    try {
      const r = await this.o.helper.call("scope.resolve", { bookmark: g.bookmark });
      if (!r.stale) return;
      const fresh = await this.o.helper.call("scope.create", { path: r.canonicalPath });
      if (fresh.kind === "file") {
        g.bookmark = fresh.bookmark;
        this.o.state.save(this.state);
      }
    } catch {
      // The next use reports stale_scope and the user can share it again.
    }
  }

  private journal(entry: JournalEntry) {
    const cutoff = this.now() - JOURNAL_TTL_MS;
    const others = this.state.journal.filter((e) => e !== entry && e.at > cutoff);
    this.state.journal = [...others.slice(-(JOURNAL_MAX - 1)), entry];
    this.o.state.save(this.state);
  }
}

function publicGrant(g: LocalGrant): DeviceGrant {
  const { bookmark: _b, ...rest } = g;
  return rest;
}

const sha256 = (d: string | Buffer) => crypto.createHash("sha256").update(d).digest("hex");

function digestOk(args: unknown, digest: string) {
  return sha256(canonicalJson(args)) === digest;
}

function verify(publicKeyB64: string, text: string, sigB64: string): boolean {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(text), key, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}
