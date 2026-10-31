/**
 * Typed client for the Yo UI <-> yo-core protocol (see packages/contracts/src/api.ts).
 *
 * Transport: WebSocket at `/ws` on the same origin.
 *   client -> server  { id, method, params }
 *   server -> client  { id, result } | { id, error }   and pushes { push, data }
 *
 * The client reconnects with exponential backoff and notifies listeners so stores can re-bootstrap.
 * `?mock=1` (or VITE_MOCK=1) swaps in the in-memory mock backend from ./mock.
 */
import type {
  ApiMethod,
  ApiParams,
  ApiPushChannel,
  ApiPushes,
  ApiResponseFrame,
  ApiResult,
} from "@yo/contracts";
import type { ServerVersion } from "./updates";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** A terminal stream. Text frames both ways. */
export interface PtyConnection {
  send(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: () => void): () => void;
  close(): void;
}

export interface YoClient {
  readonly mock: boolean;
  call<M extends ApiMethod>(method: M, params: ApiParams<M>): Promise<ApiResult<M>>;
  on<C extends ApiPushChannel>(channel: C, cb: (data: ApiPushes[C]) => void): () => void;
  /** `reconnected` is true when the socket re-opened after a drop (callers should re-bootstrap). */
  onStatus(cb: (status: ConnectionStatus, reconnected: boolean) => void): () => void;
  status(): ConnectionStatus;
  /** Stop waiting out the reconnect backoff and try now (no-op while connected or already connecting). */
  reconnectNow(): void;
  openPty(ptyId: string): PtyConnection;
  /** WebSocket URL for the noVNC RFB stream of an agent's display. */
  vncUrl(agentId: string): string;
  /** HTTP URL for downloading a file from an agent's computer. */
  fileUrl(agentId: string, path: string): string;
  /**
   * A picture on the agent's computer, served for display (png/jpg/gif/webp). `version` makes the URL unique
   * per message: browsers reuse an image already loaded for the same URL, whatever the cache headers say.
   */
  imageUrl(agentId: string, path: string, version?: string): string;
  /** A content-addressed snapshot of a chat picture (see core chatImages.ts). */
  chatImageUrl(name: string): string;
  artifactUrl(artifactId: string): string;
  /** A Page (create_page) as the sandboxed page viewer loads it. */
  pageUrl(artifactId: string): string;
  /** Which build the server runs (GET /api/version); null when it can't be reached or predates it. */
  version(): Promise<ServerVersion | null>;
}

type Listener = (data: any) => void;

export class ApiError extends Error {}

/** Core's answer to a method it doesn't have: an older core than this app (server.ts "Unknown method …"). */
export function isUnknownMethod(e: unknown): boolean {
  return e instanceof ApiError && e.message.startsWith("Unknown method");
}

/**
 * Runs before the socket's first connect and before every reconnect (browser sign-in, lib/browserAuth.ts):
 * "go" opens the socket, "retry" waits out the backoff and asks again, "stop" stays closed until
 * `reconnectNow()` (the sign-in screen calls it once the browser is signed in).
 */
export type ConnectGate = () => Promise<"go" | "retry" | "stop">;

/** WebSocket close code core uses when this browser was signed out or revoked: don't reconnect. */
export const WS_SIGNED_OUT = 4401;

/** Browser sign-in hooks for the socket (lib/browserAuth.ts). */
export interface BrowserSession {
  gate: ConnectGate;
  /** Core closed the socket with WS_SIGNED_OUT. The client stays closed until `reconnectNow()`. */
  onSignedOut: () => void;
}

/** Base URL (http) of yo-core. Same origin by default; `?core=host:port` overrides (dev). */
export function coreHttpBase(): string {
  const override = new URLSearchParams(location.search).get("core");
  if (override) return override.startsWith("http") ? override : `http://${override}`;
  if (location.protocol === "file:") return "http://127.0.0.1:7777";
  return `${location.protocol}//${location.host}`;
}

function wsBase(): string {
  return coreHttpBase().replace(/^http/, "ws");
}

export class WsClient implements YoClient {
  readonly mock = false;
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }
  >();
  private queue = new Map<string, string>();
  private listeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<(s: ConnectionStatus, reconnected: boolean) => void>();
  private _status: ConnectionStatus = "connecting";
  private attempts = 0;
  private everOpened = false;
  private retryTimer: number | null = null;
  /** Bumped by every connect attempt, so a gate that answers late for an older attempt is ignored. */
  private gateRun = 0;

  private gate?: ConnectGate;
  private onSignedOut?: () => void;

  constructor(
    private url = `${wsBase()}/ws`,
    session?: ConnectGate | BrowserSession,
  ) {
    if (typeof session === "function") this.gate = session;
    else if (session) {
      this.gate = session.gate;
      this.onSignedOut = session.onSignedOut;
    }
    this.connect();
  }

  status() {
    return this._status;
  }

  private setStatus(s: ConnectionStatus, reconnected = false) {
    this._status = s;
    for (const cb of this.statusListeners) cb(s, reconnected);
  }

  private connect() {
    if (this.gate) this.connectThroughGate(this.gate);
    else this.openSocket();
  }

  private connectThroughGate(gate: ConnectGate) {
    this.setStatus("connecting");
    const run = ++this.gateRun;
    const answer = (r: "go" | "retry" | "stop") => {
      if (run !== this.gateRun) return;
      if (r === "go") return this.openSocket();
      this.setStatus("closed");
      if (r === "retry") this.scheduleReconnect();
    };
    gate().then(answer, () => answer("retry"));
  }

  private openSocket() {
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.attempts = 0;
      const q = this.queue;
      this.queue = new Map();
      for (const frame of q.values()) ws.send(frame);
      this.setStatus("open", reconnected);
    };
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg && typeof msg.push === "string") {
        const set = this.listeners.get(msg.push);
        if (set) for (const cb of set) cb(msg.data);
        return;
      }
      const frame = msg as ApiResponseFrame;
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if ("error" in frame) p.reject(new ApiError(frame.error));
      else p.resolve(frame.result);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus("closed");
      // Signed out or revoked (browser sign-in): the sign-in screen takes over; no reconnecting. Calls already sent
      // on this socket will never be answered, so they fail now instead of after the 60 s timeout.
      if (this.onSignedOut && ev?.code === WS_SIGNED_OUT) {
        for (const [id, p] of this.pending) {
          if (this.queue.has(id)) continue;
          clearTimeout(p.timer);
          p.reject(new ApiError("This browser was signed out of Yo."));
          this.pending.delete(id);
        }
        return this.onSignedOut();
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    const delay = Math.min(8000, 400 * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
    this.attempts++;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  reconnectNow() {
    if (this._status === "open") return;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    // An attempt still hanging (a PC that went to sleep never answers) is dropped for a fresh one.
    const stale = this.ws;
    if (stale) {
      this.ws = null;
      stale.onclose = null;
      stale.onerror = null;
      stale.close();
    }
    this.attempts = 0;
    this.connect();
  }

  call<M extends ApiMethod>(method: M, params: ApiParams<M>): Promise<ApiResult<M>> {
    const id = `c${++this.seq}`;
    const frame = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        this.queue.delete(id);
        reject(new ApiError(`${method} timed out`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
      else this.queue.set(id, frame);
    });
  }

  on<C extends ApiPushChannel>(channel: C, cb: (data: ApiPushes[C]) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(cb as Listener);
    return () => set.delete(cb as Listener);
  }

  onStatus(cb: (s: ConnectionStatus, reconnected: boolean) => void) {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  /**
   * Terminal protocol (`/api/pty/:ptyId`, WebSocket):
   *   - text frames in both directions carry raw terminal data (UTF-8);
   *   - a text frame that parses as JSON `{"type":"resize","cols":N,"rows":N}` is a resize control
   *     message from the client (core must not forward it to the pty as input);
   *   - the server closes the socket when the process exits.
   * Raw keystrokes that happen to look like that JSON are practically impossible from xterm.
   */
  openPty(ptyId: string): PtyConnection {
    const ws = new WebSocket(`${wsBase()}/api/pty/${encodeURIComponent(ptyId)}`);
    const dataCbs = new Set<(d: string) => void>();
    const exitCbs = new Set<() => void>();
    const early: string[] = [];
    ws.onopen = () => {
      for (const f of early.splice(0)) ws.send(f);
    };
    ws.onmessage = async (ev) => {
      const text = typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text();
      for (const cb of dataCbs) cb(text);
    };
    ws.onclose = () => {
      for (const cb of exitCbs) cb();
    };
    const send = (f: string) => (ws.readyState === WebSocket.OPEN ? ws.send(f) : early.push(f));
    return {
      send,
      resize: (cols, rows) => send(JSON.stringify({ type: "resize", cols, rows })),
      onData: (cb) => {
        dataCbs.add(cb);
        return () => dataCbs.delete(cb);
      },
      onExit: (cb) => {
        exitCbs.add(cb);
        return () => exitCbs.delete(cb);
      },
      close: () => ws.close(),
    };
  }

  vncUrl(agentId: string) {
    return `${wsBase()}/api/vnc/${encodeURIComponent(agentId)}`;
  }

  fileUrl(agentId: string, path: string) {
    return `${coreHttpBase()}/api/files/${encodeURIComponent(agentId)}?path=${encodeURIComponent(path)}`;
  }

  imageUrl(agentId: string, path: string, version?: string) {
    return `${this.fileUrl(agentId, path)}&inline=1${version ? `&v=${encodeURIComponent(version)}` : ""}`;
  }

  chatImageUrl(name: string) {
    return `${coreHttpBase()}/api/chat-images/${encodeURIComponent(name)}`;
  }

  artifactUrl(id: string) {
    return `${coreHttpBase()}/api/artifacts/${encodeURIComponent(id)}`;
  }
  pageUrl(id: string) {
    return `${this.artifactUrl(id)}?view=page`;
  }

  async version(): Promise<ServerVersion | null> {
    try {
      const res = await fetch(`${coreHttpBase()}/api/version`, {
        cache: "no-store",
        credentials: "include",
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok ? ((await res.json()) as ServerVersion) : null;
    } catch {
      return null;
    }
  }
}

export function isMockMode(): boolean {
  const q = new URLSearchParams(location.search);
  if (q.has("mock")) return q.get("mock") !== "0";
  return import.meta.env.VITE_MOCK === "1";
}

let client: YoClient | null = null;

/** `session`: browser sign-in (lib/browserAuth.ts), only in a plain browser against a real core. */
export async function initApi(session?: BrowserSession): Promise<YoClient> {
  if (client) return client;
  if (isMockMode()) {
    const { MockClient } = await import("./mock");
    client = new MockClient();
  } else {
    client = new WsClient(undefined, session);
  }
  return client;
}

/** The active client (after initApi resolved). */
export function api(): YoClient {
  if (!client) throw new Error("api not initialized");
  return client;
}
