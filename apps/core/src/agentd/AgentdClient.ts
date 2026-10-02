import { EventEmitter } from "node:events";
import {
  type AgentdPush,
  type AgentdReply,
  type AgentdRequest,
  type AgentdResponses,
  newId,
} from "@yo/contracts";
import WebSocket from "ws";
import { type Logger, logger } from "../log";

type ReqOf<T extends AgentdRequest["type"]> = Omit<Extract<AgentdRequest, { type: T }>, "id" | "type">;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | null;
}

export interface AgentdClientEvents {
  push: [AgentdPush];
  connected: [];
  disconnected: [];
}

/**
 * Persistent control connection to agentd. Reconnects with backoff, and on each (re)connect
 * sends `hello` with the last seen seq per session so agentd replays missed events.
 */
export class AgentdClient extends EventEmitter<AgentdClientEvents> {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private lastSeq = new Map<string, number>();
  private closed = false;
  private backoff = 500;
  private ready = false;
  private readyWaiters: (() => void)[] = [];
  private log: Logger = logger("agentd-client");
  info: AgentdResponses["hello"] | null = null;

  constructor(
    private url: string,
    private token: string,
    private coreVersion: string,
  ) {
    super();
  }

  get connected() {
    return this.ready;
  }

  setTarget(url: string, token: string) {
    this.url = url;
    this.token = token;
    this.ws?.close();
  }

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    this.removeAllListeners();
    this.ws?.close();
  }

  /** Seed lastSeq (e.g. from DB) so a fresh core process resumes correctly. */
  seedSeq(sessionKey: string, seq: number) {
    if ((this.lastSeq.get(sessionKey) ?? 0) < seq) this.lastSeq.set(sessionKey, seq);
  }

  /** Call right before session.start: agentd restarts the seq counter + ring buffer for that session. */
  resetSeq(sessionKey: string) {
    this.lastSeq.set(sessionKey, 0);
  }

  waitReady(timeoutMs = 15000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Yo's computer is not connected")), timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private connect() {
    if (this.closed) return;
    const wsUrl = `${this.url.replace(/^http/, "ws")}/control`;
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${this.token}` },
      maxPayload: 64 * 1024 * 1024,
    });
    this.ws = ws;

    ws.on("open", async () => {
      this.backoff = 500;
      try {
        const resume = [...this.lastSeq.entries()].map(([sessionKey, lastSeq]) => ({ sessionKey, lastSeq }));
        this.info = await this.rawRequest("hello", {
          token: this.token,
          coreVersion: this.coreVersion,
          resume,
        });
        this.ready = true;
        this.log.info(`connected to agentd ${this.info.agentdVersion}`);
        for (const w of this.readyWaiters.splice(0)) w();
        this.emit("connected");
      } catch (err) {
        this.log.warn("hello failed", err);
        ws.close();
      }
    });

    ws.on("message", (raw) => {
      let frame: any;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame.type === "ok" || frame.type === "err") {
        const reply = frame as AgentdReply;
        const p = this.pending.get(reply.re);
        if (!p) return;
        this.pending.delete(reply.re);
        if (p.timer) clearTimeout(p.timer);
        if (reply.type === "ok") p.resolve(reply.data);
        else p.reject(new Error(reply.error));
        return;
      }
      const push = frame as AgentdPush;
      if (push.type === "event") {
        const prev = this.lastSeq.get(push.sessionKey) ?? 0;
        if (push.seq <= prev) return; // duplicate (replay overlap)
        this.lastSeq.set(push.sessionKey, push.seq);
      }
      this.emit("push", push);
    });

    const onClose = () => {
      if (this.ws !== ws) return;
      const wasReady = this.ready;
      this.ready = false;
      this.ws = null;
      for (const [id, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error("agentd disconnected"));
        this.pending.delete(id);
      }
      if (wasReady && !this.closed) this.emit("disconnected");
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 10000);
      }
    };
    ws.on("close", onClose);
    ws.on("error", (err) => {
      this.log.debug(`ws error: ${err.message}`);
    });
  }

  private rawRequest<T extends AgentdRequest["type"]>(
    type: T,
    params: ReqOf<T>,
    timeoutMs = 60000,
  ): Promise<AgentdResponses[T]> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("agentd not connected"));
    const id = newId("rq");
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`agentd ${type} timed out`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, type, ...params }));
    });
  }

  async request<T extends AgentdRequest["type"]>(
    type: T,
    params: ReqOf<T>,
    timeoutMs = 60000,
  ): Promise<AgentdResponses[T]> {
    await this.waitReady();
    return this.rawRequest(type, params, timeoutMs);
  }

  /** Fire-and-forget (e.g. pty.input). */
  send<T extends AgentdRequest["type"]>(type: T, params: ReqOf<T>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ id: newId("rq"), type, ...params }));
  }
}
