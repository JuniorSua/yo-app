/**
 * Live connections from paired devices (the desktop app's main process on the user's Mac).
 *
 * The device dials out to core (`/device` WebSocket over the existing private tunnel); core never opens a
 * port on the Mac. Handshake (mutual):
 *   device → init {deviceId, clientNonce}
 *   core   → challenge {nonce, coreSignature(clientNonce, nonce, deviceId)}   — device checks the pinned core key
 *   device → hello {signature(nonce, clientNonce, deviceId), versions, capabilities, permissions, paused}
 *   core   → welcome {revokedGrantIds}
 * After that core sends bounded `command`s and the device answers with `result`s.
 */
import { EventEmitter } from "node:events";
import {
  type CoreToDevice,
  DEVICE_PROTOCOL_VERSION,
  type DeviceError,
  DeviceToCore,
  type PairedDevice,
  type PairingChallenge,
  signedText,
} from "@yo/contracts";
import WebSocket from "ws";
import { type CoreIdentity, isEd25519PublicKey, randomHex, verifySignature } from "../auth/identity";
import { logger } from "../log";
import type { DeviceStore } from "./DeviceStore";

const log = logger("devices");

const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 15_000;
const DEAD_AFTER_MS = 45_000;
const PAIRING_TTL_MS = 5 * 60 * 1000;

export class DeviceOfflineError extends Error {}
export class DeviceDisconnectedError extends Error {}
export class DeviceTimeoutError extends Error {}

export interface CommandReply {
  ok: boolean;
  result?: unknown;
  error?: DeviceError;
}

export interface StatusReply {
  state: "unknown" | "started" | "done";
  ok?: boolean;
  result?: unknown;
  error?: DeviceError;
}

interface Conn {
  deviceId: string;
  ws: WebSocket;
  lastPong: number;
  timer: NodeJS.Timeout;
  pending: Map<
    string,
    { resolve: (r: CommandReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >;
  statusQueries: Map<
    string,
    { resolve: (r: StatusReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >;
}

export class DeviceHub extends EventEmitter<{
  updated: [PairedDevice];
  grantsChanged: [string];
  online: [string];
  offline: [string];
  leaseEnded: [string, string, string];
}> {
  private conns = new Map<string, Conn>();
  private pairings = new Map<string, number>();

  constructor(
    private readonly store: DeviceStore,
    private readonly identity: CoreIdentity,
    private readonly coreLabel: string,
  ) {
    super();
  }

  isOnline(deviceId: string) {
    return this.conns.has(deviceId);
  }

  view(deviceId: string): PairedDevice | null {
    const rec = this.store.getDevice(deviceId);
    return rec ? { ...rec.device, online: this.isOnline(deviceId) } : null;
  }

  list(): PairedDevice[] {
    return this.store.listDevices().map((r) => ({ ...r.device, online: this.isOnline(r.device.id) }));
  }

  /* -------------------------------- pairing -------------------------------- */

  startPairing(): PairingChallenge {
    const now = Date.now();
    for (const [c, exp] of this.pairings) if (exp < now) this.pairings.delete(c);
    if (this.pairings.size > 16) throw new Error("Too many pairing attempts in progress");
    const challenge = randomHex(32);
    const expiresAt = now + PAIRING_TTL_MS;
    this.pairings.set(challenge, expiresAt);
    return {
      challenge,
      expiresAt,
      coreId: this.identity.coreId,
      corePublicKey: this.identity.publicKey,
      coreLabel: this.coreLabel,
    };
  }

  /**
   * Finish pairing. Called only with an authenticated controller session from the desktop app's main
   * process, after the user confirmed in a native dialog. Proof of possession of the device key is required.
   */
  finishPairing(input: {
    challenge: unknown;
    deviceId: unknown;
    publicKey: unknown;
    signature: unknown;
    name: unknown;
    osVersion: unknown;
    appVersion: unknown;
  }): PairedDevice {
    const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
    const challenge = s(input.challenge, 128);
    const deviceId = s(input.deviceId, 80);
    const publicKey = s(input.publicKey, 200);
    const exp = this.pairings.get(challenge);
    this.pairings.delete(challenge);
    if (!exp || exp < Date.now()) throw new Error("Pairing expired. Start again.");
    if (!/^dev_[A-Za-z0-9_-]{8,64}$/.test(deviceId)) throw new Error("Invalid device id");
    if (publicKey.length > 120 || !isEd25519PublicKey(publicKey)) throw new Error("Invalid device key");
    if (
      !verifySignature(publicKey, signedText.pairing(challenge, deviceId, publicKey), s(input.signature, 200))
    )
      throw new Error("Pairing signature rejected");
    if (this.store.getDevice(deviceId)) throw new Error("This device id is already paired");
    this.store.addDevice({
      id: deviceId,
      name: s(input.name, 80) || "Mac",
      publicKey,
      osVersion: s(input.osVersion, 128),
      appVersion: s(input.appVersion, 64),
    });
    const view = this.view(deviceId)!;
    this.emit("updated", view);
    return view;
  }

  unpair(deviceId: string) {
    this.store.revokeDevice(deviceId);
    const c = this.conns.get(deviceId);
    if (c) {
      this.sendFrame(c, { type: "unpaired" });
      c.ws.close(4401, "unpaired");
    }
    const v = this.store.getDevice(deviceId);
    if (v) this.emit("updated", { ...v.device, online: false });
    this.emit("grantsChanged", deviceId);
  }

  /** Tell the device a grant was revoked from core. Delivered again in `welcome` if it's offline now. */
  notifyRevoked(deviceId: string, grantId: string) {
    const c = this.conns.get(deviceId);
    if (c) this.sendFrame(c, { type: "revoke", grantId });
  }

  /* ------------------------------- connections ------------------------------ */

  handleSocket(ws: WebSocket) {
    let stage: "init" | "hello" | "ready" = "init";
    let deviceId = "";
    let nonce = "";
    let clientNonce = "";
    let conn: Conn | null = null;
    const handshakeTimer = setTimeout(() => {
      if (stage !== "ready") ws.close(4408, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return ws.close(4400, "binary not supported");
      let msg: DeviceToCore;
      try {
        msg = DeviceToCore.parse(JSON.parse(raw.toString()));
      } catch {
        log.warn("device sent an invalid frame");
        return ws.close(4400, "invalid frame");
      }
      if (stage === "init") {
        if (msg.type !== "init") return ws.close(4400, "expected init");
        const rec = this.store.getDevice(msg.deviceId);
        if (!rec || rec.device.revokedAt) return ws.close(4401, "unknown device");
        deviceId = msg.deviceId;
        clientNonce = msg.clientNonce;
        nonce = randomHex(32);
        stage = "hello";
        this.sendRaw(ws, {
          type: "challenge",
          protocol: DEVICE_PROTOCOL_VERSION,
          nonce,
          coreId: this.identity.coreId,
          coreSignature: this.identity.sign(signedText.coreHello(clientNonce, nonce, deviceId)),
        });
        return;
      }
      if (stage === "hello") {
        if (msg.type !== "hello" || msg.deviceId !== deviceId) return ws.close(4400, "expected hello");
        const rec = this.store.getDevice(deviceId);
        if (!rec || rec.device.revokedAt) return ws.close(4401, "unknown device");
        if (
          !verifySignature(rec.publicKey, signedText.deviceHello(nonce, clientNonce, deviceId), msg.signature)
        )
          return ws.close(4401, "bad signature");
        clearTimeout(handshakeTimer);
        stage = "ready";
        const old = this.conns.get(deviceId);
        if (old) this.drop(old, "replaced by a newer connection");
        conn = {
          deviceId,
          ws,
          lastPong: Date.now(),
          timer: setInterval(() => this.heartbeat(conn!), HEARTBEAT_MS),
          pending: new Map(),
          statusQueries: new Map(),
        };
        conn.timer.unref();
        this.conns.set(deviceId, conn);
        this.store.updateDeviceSeen(deviceId, {
          appVersion: msg.appVersion,
          helperVersion: msg.helperVersion,
          osVersion: msg.osVersion,
          capabilities: msg.capabilities,
          permissions: msg.permissions,
          paused: msg.paused,
        });
        this.sendFrame(conn, { type: "welcome", revokedGrantIds: this.store.revokedGrantIds(deviceId) });
        log.info(`device ${deviceId} connected`);
        this.emit("online", deviceId);
        this.emit("updated", this.view(deviceId)!);
        return;
      }
      if (conn) this.onReadyMessage(conn, msg);
    });
    ws.on("pong", () => {
      if (conn) conn.lastPong = Date.now();
    });
    ws.on("close", () => {
      clearTimeout(handshakeTimer);
      if (conn && this.conns.get(conn.deviceId) === conn) this.drop(conn, "disconnected");
    });
    ws.on("error", () => undefined);
  }

  private onReadyMessage(c: Conn, msg: DeviceToCore) {
    switch (msg.type) {
      case "grants": {
        const changed = this.store.syncGrants(c.deviceId, msg.grants);
        this.store.updateDeviceSeen(c.deviceId, {});
        if (changed.length) this.emit("grantsChanged", c.deviceId);
        return;
      }
      case "state": {
        this.store.updateDeviceSeen(c.deviceId, { paused: msg.paused, permissions: msg.permissions });
        this.emit("updated", this.view(c.deviceId)!);
        return;
      }
      case "lease.ended": {
        this.emit("leaseEnded", c.deviceId, msg.leaseId, msg.reason);
        return;
      }
      case "result": {
        const p = c.pending.get(msg.commandId);
        if (!p) return;
        c.pending.delete(msg.commandId);
        clearTimeout(p.timer);
        p.resolve({ ok: msg.ok, result: msg.result, error: msg.error });
        return;
      }
      case "status": {
        const q = c.statusQueries.get(msg.commandId);
        if (!q) return;
        c.statusQueries.delete(msg.commandId);
        clearTimeout(q.timer);
        q.resolve({ state: msg.state, ok: msg.ok, result: msg.result, error: msg.error });
        return;
      }
      default:
        c.ws.close(4400, "unexpected frame");
    }
  }

  /** Send one command and wait for its result. */
  command(
    deviceId: string,
    frame: Extract<CoreToDevice, { type: "command" }>,
    timeoutMs: number,
  ): Promise<CommandReply> {
    const c = this.conns.get(deviceId);
    if (!c) return Promise.reject(new DeviceOfflineError("device offline"));
    return new Promise<CommandReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pending.delete(frame.commandId);
        reject(new DeviceTimeoutError("device did not answer in time"));
      }, timeoutMs);
      c.pending.set(frame.commandId, { resolve, reject, timer });
      if (!this.sendFrame(c, frame)) {
        clearTimeout(timer);
        c.pending.delete(frame.commandId);
        reject(new DeviceDisconnectedError("send failed"));
      }
    });
  }

  /** Ask the device's journal what happened to a command (after a lost result). */
  queryStatus(deviceId: string, commandId: string, timeoutMs = 15_000): Promise<StatusReply> {
    const c = this.conns.get(deviceId);
    if (!c) return Promise.reject(new DeviceOfflineError("device offline"));
    return new Promise<StatusReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        c.statusQueries.delete(commandId);
        reject(new DeviceTimeoutError("no status answer"));
      }, timeoutMs);
      c.statusQueries.set(commandId, { resolve, reject, timer });
      this.sendFrame(c, { type: "status.query", commandId });
    });
  }

  private heartbeat(c: Conn) {
    if (Date.now() - c.lastPong > DEAD_AFTER_MS) {
      this.drop(c, "heartbeat timeout");
      c.ws.terminate();
      return;
    }
    try {
      c.ws.ping();
    } catch {
      /* closed */
    }
  }

  private drop(c: Conn, why: string) {
    clearInterval(c.timer);
    if (this.conns.get(c.deviceId) === c) this.conns.delete(c.deviceId);
    for (const [, p] of c.pending) {
      clearTimeout(p.timer);
      p.reject(new DeviceDisconnectedError(why));
    }
    c.pending.clear();
    for (const [, q] of c.statusQueries) {
      clearTimeout(q.timer);
      q.reject(new DeviceDisconnectedError(why));
    }
    c.statusQueries.clear();
    if (c.ws.readyState === WebSocket.OPEN) c.ws.close(4000, why);
    log.info(`device ${c.deviceId} ${why}`);
    this.store.updateDeviceSeen(c.deviceId, {});
    this.emit("offline", c.deviceId);
    const v = this.view(c.deviceId);
    if (v) this.emit("updated", v);
  }

  private sendFrame(c: Conn, frame: CoreToDevice): boolean {
    return this.sendRaw(c.ws, frame);
  }

  private sendRaw(ws: WebSocket, frame: CoreToDevice): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    for (const c of [...this.conns.values()]) {
      this.drop(c, "core shutting down");
      c.ws.terminate();
    }
  }
}
