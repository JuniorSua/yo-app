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
  /** Which build the server runs (GET /api/version); null when it can't be reached or predates it. */
  version(): Promise<ServerVersion | null>;
}

type Listener = (data: any) => void;

export class ApiError extends Error {}

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
  private queue: string[] = [];
  private listeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<(s: ConnectionStatus, reconnected: boolean) => void>();
  private _status: ConnectionStatus = "connecting";
  private attempts = 0;
  private everOpened = false;

  constructor(private url = `${wsBase()}/ws`) {
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
      this.queue = [];
      for (const frame of q) ws.send(frame);
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
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    const delay = Math.min(8000, 400 * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
    this.attempts++;
    window.setTimeout(() => this.connect(), delay);
  }

  call<M extends ApiMethod>(method: M, params: ApiParams<M>): Promise<ApiResult<M>> {
    const id = `c${++this.seq}`;
    const frame = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new ApiError(`${method} timed out`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
      else this.queue.push(frame);
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

export async function initApi(): Promise<YoClient> {
  if (client) return client;
  if (isMockMode()) {
    const { MockClient } = await import("./mock");
    client = new MockClient();
  } else {
    client = new WsClient();
  }
  return client;
}

/** The active client (after initApi resolved). */
export function api(): YoClient {
  if (!client) throw new Error("api not initialized");
  return client;
}
