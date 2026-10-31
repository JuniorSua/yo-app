/**
 * Per-agent CDP filtering proxy for the shared browser.
 *
 * Several agents share ONE Chromium (one profile, so logins are shared) on one wide screen. Each agent owns a
 * "seat" (a horizontal tile of that screen) and its playwright-mcp talks to this proxy instead of Chromium.
 * The proxy only shows the agent the pages whose window sits in its seat (plus popups those pages opened),
 * places new tabs/windows inside the seat, and refuses anything that would touch a teammate's pages or
 * tear down the shared browser.
 */
import { mkdirSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { errMsg, type Logger } from "../log";

export interface Seat {
  x: number;
  width: number;
  height: number;
}

/** Window bounds as Chromium reports them (Browser.getWindowBounds / getWindowForTarget). */
export interface WindowBounds {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  windowState?: string;
}

export interface CdpProxyOptions {
  /** Bound on 127.0.0.1 only. 0 picks a free port. */
  listenPort: number;
  /** The shared Chromium's real CDP port (127.0.0.1). */
  upstreamPort: number;
  /** Current tile; may change between agent wake-ups, so it's read on every decision. */
  seat: () => Seat;
  /** Shared mutex across all proxies, so two agents placing tabs at once can't steal each other's windows. */
  createLock: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Optional override for window ownership (e.g. the seat manager's window registry knows a maximized window
   * at left=0 still belongs to tile 3). Returning undefined falls back to `seatOwnsBounds(seat(), bounds)`.
   */
  ownsWindow?: (windowId: number, bounds: WindowBounds) => boolean | undefined;
  /**
   * Shared download staging dir (created if missing). The download setting is browser-wide, so every proxy
   * points Chromium here and links each agent's finished downloads into the folder its Playwright asked for.
   */
  downloadDir: string;
  /**
   * Called with a page's targetId and the CDP method whenever the agent sends it a command (idle-tab
   * cleanup reads this). The method is undefined for raw page connections.
   */
  onActivity?: (targetId: string, method?: string) => void;
  log: Logger;
}

/** True when the window's left edge is inside the seat's [x, x + width). */
export function seatOwnsBounds(seat: Seat, bounds: { left?: number; width?: number }): boolean {
  return typeof bounds.left === "number" && bounds.left >= seat.x && bounds.left < seat.x + seat.width;
}

/** The window bounds that fill the seat exactly. */
export function tileBounds(seat: Seat): {
  left: number;
  top: number;
  width: number;
  height: number;
  windowState: "normal";
} {
  return { left: seat.x, top: 0, width: seat.width, height: seat.height, windowState: "normal" };
}

type Json = Record<string, any>;
interface CdpError {
  code: number;
  message: string;
}
interface CdpMessage {
  id?: number;
  method?: string;
  params?: Json;
  result?: Json;
  error?: CdpError;
  sessionId?: string;
}
type Call = (method: string, params?: Json, sessionId?: string) => Promise<any>;

const NO_TARGET: CdpError = { code: -32602, message: "No target with given id found" };
const NO_SESSION: CdpError = { code: -32001, message: "Session with given id not found." };
const NO_WINDOW: CdpError = { code: -32000, message: "Browser window not found" };
const NOT_ALLOWED: CdpError = {
  code: -32000,
  message: "Not allowed: this browser is shared with your teammates",
};

/** Would tear down or wipe state every agent shares. */
const BLOCKED = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
  "Network.clearBrowserCookies",
]);
/** Commands whose `targetId` param must name a target this agent owns. */
const TARGET_ID_METHODS = new Set([
  "Target.attachToTarget",
  "Target.closeTarget",
  "Target.activateTarget",
  "Target.getTargetInfo",
  "Target.exposeDevToolsProtocol",
  "Target.autoAttachRelated",
  "Target.getDevToolsTarget",
  "Target.openDevTools",
  "Browser.getWindowForTarget",
]);
const CALL_TIMEOUT_MS = 10_000;
/** Max messages held for one not-yet-classified session / the ordered client queue. */
const MAX_DEFERRED = 2_000;
const MAX_OUT_QUEUE = 20_000;
/** A client that stops reading gets cut off rather than growing agentd's memory without bound. */
const MAX_CLIENT_BUFFER = 64 * 1024 * 1024;
const MAX_PRE_OPEN = 1_000;

const noop = () => undefined;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Request/response bookkeeping for the proxy's own CDP calls on an upstream socket. */
class Rpc {
  private next = 1;
  private waiting = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; t: NodeJS.Timeout }
  >();
  constructor(private send: (msg: CdpMessage) => void) {}

  allocId(): number {
    return this.next++;
  }

  call: Call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = this.allocId();
      const t = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} timed out`));
      }, CALL_TIMEOUT_MS);
      this.waiting.set(id, { resolve, reject, t });
      this.send(sessionId ? { id, method, params, sessionId } : { id, method, params });
    });

  /** Settles an internal call; false when the response isn't ours. */
  settle(m: CdpMessage): boolean {
    const w = typeof m.id === "number" ? this.waiting.get(m.id) : undefined;
    if (!w) return false;
    this.waiting.delete(m.id!);
    clearTimeout(w.t);
    if (m.error) w.reject(new Error(m.error.message ?? "CDP error"));
    else w.resolve(m.result ?? {});
    return true;
  }

  failAll(reason: string): void {
    for (const w of this.waiting.values()) {
      clearTimeout(w.t);
      w.reject(new Error(reason));
    }
    this.waiting.clear();
  }
}

function openSocket(url: string, timeoutMs = 5_000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    const t = setTimeout(() => {
      ws.terminate();
      reject(new Error("upstream connect timed out"));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

/** Ownership and placement rules, shared by the HTTP endpoints and the browser connections. */
class SeatPolicy {
  constructor(private o: CdpProxyOptions) {}

  ownsWindow(windowId: number, bounds: WindowBounds): boolean {
    return this.o.ownsWindow?.(windowId, bounds) ?? seatOwnsBounds(this.o.seat(), bounds);
  }

  /**
   * Whether a page belongs to this seat: its opener's owner if the opener is still around (so a popup follows
   * the page that opened it, wherever Chromium put its window), else where its window is.
   * undefined = the target is gone.
   */
  async pageOwned(call: Call, targetId: string, depth = 0): Promise<boolean | undefined> {
    const info = await call("Target.getTargetInfo", { targetId }).then(
      (r) => r.targetInfo as Json | undefined,
      () => undefined,
    );
    if (!info) return undefined;
    if (info.type !== "page") return false;
    if (typeof info.openerId === "string" && depth < 5) {
      const opener = await this.pageOwned(call, info.openerId, depth + 1);
      if (opener !== undefined) {
        if (opener) await this.pullIntoTile(call, targetId);
        return opener;
      }
    }
    const w = await call("Browser.getWindowForTarget", { targetId }).catch(() => undefined);
    if (!w) return false;
    return this.ownsWindow(w.windowId, w.bounds ?? {});
  }

  /** Moves an owned target's window into the tile unless it's already there. */
  async pullIntoTile(call: Call, targetId: string): Promise<void> {
    const w = await call("Browser.getWindowForTarget", { targetId }).catch(() => undefined);
    if (w && !this.ownsWindow(w.windowId, w.bounds ?? {}))
      await this.placeInTile(call, w.windowId, w.bounds ?? {}).catch(noop);
  }

  /** Fills the tile. A maximized/fullscreen window ignores new bounds, so it's made normal first. */
  async placeInTile(call: Call, windowId: number, current: WindowBounds): Promise<void> {
    const { windowState: _, ...rect } = tileBounds(this.o.seat());
    if (current.windowState && current.windowState !== "normal")
      await call("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await call("Browser.setWindowBounds", { windowId, bounds: rect });
  }

  /** Clamps requested bounds inside the tile; maximize/fullscreen means "fill the tile". */
  async setBounds(call: Call, windowId: number, current: WindowBounds, req: WindowBounds): Promise<void> {
    if (req.windowState === "maximized" || req.windowState === "fullscreen")
      return this.placeInTile(call, windowId, current);
    if (req.windowState === "minimized") {
      await call("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
      return;
    }
    const tile = tileBounds(this.o.seat());
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const width = Math.min(Math.max(num(req.width, num(current.width, tile.width)), 100), tile.width);
    const height = Math.min(Math.max(num(req.height, num(current.height, tile.height)), 100), tile.height);
    const left = Math.min(
      Math.max(num(req.left, num(current.left, tile.left)), tile.left),
      tile.left + tile.width - width,
    );
    const top = Math.min(Math.max(num(req.top, num(current.top, 0)), 0), tile.height - height);
    if (current.windowState && current.windowState !== "normal")
      await call("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await call("Browser.setWindowBounds", { windowId, bounds: { left, top, width, height } });
  }

  /**
   * Creates a tab in the seat. A plain new tab first tries the agent's existing window (activate one of its
   * pages so Chromium opens the tab there); if it lands anywhere else it's closed and a new window is opened
   * straight into the tile. `decided` is told the verdict before this returns, so the caller can release the
   * auto-attach event for the new target ahead of the createTarget response (Playwright relies on that order).
   */
  createInSeat(
    call: Call,
    params: Json,
    ownedPages: string[],
    decided: (targetId: string, owned: boolean) => void,
  ): Promise<string> {
    return this.o.createLock(async () => {
      const { newWindow, left: _l, top: _t, width: _w, height: _h, windowState: _s, ...base } = params;
      if (!base.browserContextId && !newWindow && ownedPages.length) {
        let activated = false;
        for (const id of ownedPages) {
          activated = await call("Target.activateTarget", { targetId: id }).then(
            () => true,
            () => false,
          );
          if (activated) break;
        }
        if (activated) {
          const { targetId } = await call("Target.createTarget", base);
          const w = await call("Browser.getWindowForTarget", { targetId }).catch(() => undefined);
          if (w && this.ownsWindow(w.windowId, w.bounds ?? {})) {
            decided(targetId, true);
            return targetId as string;
          }
          decided(targetId, false);
          await call("Target.closeTarget", { targetId }).catch(noop);
        }
      }
      const { windowState: _, ...rect } = tileBounds(this.o.seat());
      const { targetId } = await call("Target.createTarget", { ...base, newWindow: true, ...rect });
      decided(targetId, true);
      const w = await call("Browser.getWindowForTarget", { targetId }).catch(() => undefined);
      const b: WindowBounds = w?.bounds ?? {};
      if (
        w &&
        (b.left !== rect.left || b.top !== rect.top || b.width !== rect.width || b.height !== rect.height)
      )
        await this.placeInTile(call, w.windowId, b).catch(noop);
      return targetId as string;
    });
  }
}

interface Root {
  targetId: string;
  status: "pending" | "owned";
  waitingForDebugger: boolean;
  /** Messages for this session (and its children) that arrived before its owner was known. */
  deferred: { entry: OutEntry; m: CdpMessage }[];
}
interface OutEntry {
  msgs?: string[];
}

/**
 * One agent's browser-level CDP connection, filtered. Everything to the client goes through an ordered queue
 * so a message held back while ownership is resolved can't be overtaken by later ones.
 */
class BrowserConn {
  private up: WebSocket;
  private rpc: Rpc;
  private preOpen: string[] = [];
  private forwarded = new Map<
    number,
    { clientId: number; transform?: (m: CdpMessage) => Promise<CdpMessage> }
  >();
  private out: OutEntry[] = [];
  /** Page targetId -> owned by this seat. */
  private owner = new Map<string, boolean>();
  private resolving = new Map<string, Promise<boolean | undefined>>();
  /** Targets the client has been told about (so their destroy events go through). */
  private seen = new Set<string>();
  /** Any session (top-level or child) -> the top-level page session it hangs off. */
  private sessionRoot = new Map<string, string>();
  private roots = new Map<string, Root>();
  /** Non-page targets (iframes, workers) attached under a page session -> that root session. */
  private childTargets = new Map<string, string>();
  /** Browser contexts this client created (Playwright isolated contexts); it may wipe those. */
  private contexts = new Set<string>();
  /**
   * Extra browser-level sessions (Target.attachToBrowserTarget, used by Playwright's newCDPSession): filtered
   * exactly like the main connection.
   */
  private browserSessions = new Set<string>();
  /** Frames seen under a page session -> that root session (to attribute downloads). */
  private frames = new Map<string, string>();
  /** What the client asked Browser.setDownloadBehavior for (default context); Chromium itself uses downloadDir. */
  private download?: { behavior: string; path?: string };
  private downloads = new Set<string>();
  private closed = false;

  constructor(
    private client: WebSocket,
    upstreamUrl: string,
    private policy: SeatPolicy,
    private o: CdpProxyOptions,
    private log: Logger,
    private onClose: () => void,
  ) {
    this.rpc = new Rpc((m) => this.sendUp(m));
    this.up = new WebSocket(upstreamUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.up.on("open", () => {
      for (const s of this.preOpen) this.up.send(s);
      this.preOpen = [];
    });
    this.up.on("message", (raw) => this.safe(() => this.onUpstream(raw.toString())));
    this.up.on("close", () => this.close("upstream closed"));
    this.up.on("error", (err) => {
      this.log.warn("cdp proxy upstream error", { err: errMsg(err) });
      this.close("upstream error");
    });
    client.on("message", (raw) => this.safe(() => this.onClient(raw.toString())));
    client.on("close", () => this.close("client closed"));
    client.on("error", () => this.close("client error"));
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.log.debug("cdp proxy browser connection closed", { reason });
    this.rpc.failAll(reason);
    for (const ws of [this.up, this.client]) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close(1000);
        else ws.terminate();
      } catch {
        /* already gone */
      }
    }
    this.onClose();
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log.warn("cdp proxy message handling failed", { err: errMsg(err) });
    }
  }

  private call: Call = (method, params, sessionId) => this.rpc.call(method, params, sessionId);

  private sendUp(m: CdpMessage): void {
    const s = JSON.stringify(m);
    if (this.up.readyState === WebSocket.OPEN) this.up.send(s);
    else if (this.up.readyState === WebSocket.CONNECTING && this.preOpen.length < MAX_PRE_OPEN)
      this.preOpen.push(s);
  }

  // ---- client-bound ordered queue ----

  private push(): OutEntry {
    const entry: OutEntry = {};
    this.out.push(entry);
    if (this.out.length > MAX_OUT_QUEUE) {
      this.log.warn("cdp proxy client queue overflow; disconnecting", { queued: this.out.length });
      this.close("queue overflow");
    }
    return entry;
  }

  private fill(entry: OutEntry, msgs: CdpMessage[]): void {
    entry.msgs = msgs.map((m) => JSON.stringify(m));
    this.flush();
  }

  private pushReady(m: CdpMessage): void {
    this.fill(this.push(), [m]);
  }

  private flush(): void {
    while (this.out.length && this.out[0]!.msgs) {
      const { msgs } = this.out.shift()!;
      if (this.closed || this.client.readyState !== WebSocket.OPEN) continue;
      for (const s of msgs!) this.client.send(s);
    }
    if (this.client.bufferedAmount > MAX_CLIENT_BUFFER) {
      this.log.warn("cdp proxy client not reading; disconnecting");
      this.close("client backpressure");
    }
  }

  /** Replies to a request the proxy answers itself; session-scoped requests get the sessionId back, as Chromium does. */
  private reply(req: CdpMessage, result: Json): void {
    this.pushReady(req.sessionId ? { id: req.id, result, sessionId: req.sessionId } : { id: req.id, result });
  }

  private replyError(req: CdpMessage, error: CdpError): void {
    this.pushReady(req.sessionId ? { id: req.id, error, sessionId: req.sessionId } : { id: req.id, error });
  }

  // ---- ownership ----

  private rootOwned(sessionId: string | undefined): boolean {
    const root = sessionId ? this.sessionRoot.get(sessionId) : undefined;
    return !!root && this.roots.get(root)?.status === "owned";
  }

  private resolve(targetId: string): Promise<boolean | undefined> {
    const known = this.owner.get(targetId);
    if (known !== undefined) return Promise.resolve(known);
    let p = this.resolving.get(targetId);
    if (p) return p;
    p = (async () => {
      // If a teammate is mid-placement, the target may be a tab about to be closed or moved: wait for it to settle.
      await withTimeout(
        this.o.createLock(async () => undefined),
        15_000,
        "createLock",
      ).catch(noop);
      const cached = this.owner.get(targetId);
      if (cached !== undefined) return cached;
      const owned = await this.policy.pageOwned(this.call, targetId);
      if (owned !== undefined && !this.owner.has(targetId)) this.owner.set(targetId, owned);
      return this.owner.get(targetId) ?? owned;
    })()
      .catch((err) => {
        this.log.debug("cdp proxy ownership check failed", { targetId, err: errMsg(err) });
        return undefined;
      })
      .finally(() => this.resolving.delete(targetId));
    this.resolving.set(targetId, p);
    return p;
  }

  private async targetAllowed(targetId: unknown): Promise<boolean> {
    if (typeof targetId !== "string") return false;
    const child = this.childTargets.get(targetId);
    if (child) return this.roots.get(child)?.status === "owned";
    return (await this.resolve(targetId)) === true;
  }

  /** Records a verdict and releases (or drops) any auto-attach sessions waiting on it. */
  private decideTarget(targetId: string, owned: boolean): void {
    this.owner.set(targetId, owned);
    for (const [sid, r] of this.roots) if (r.targetId === targetId) this.decideSession(sid, owned);
  }

  private decideSession(sid: string, owned: boolean): void {
    const r = this.roots.get(sid);
    if (r?.status !== "pending") return;
    const deferred = r.deferred;
    r.deferred = [];
    if (owned) {
      r.status = "owned";
      this.seen.add(r.targetId);
      for (const d of deferred) d.entry.msgs = [JSON.stringify(d.m)];
    } else {
      this.forgetRoot(sid);
      for (const d of deferred) d.entry.msgs = [];
      // A teammate's tab: let it run (auto-attach may have paused it for us) and stop listening to it.
      if (r.waitingForDebugger) this.call("Runtime.runIfWaitingForDebugger", {}, sid).catch(noop);
      this.call("Target.detachFromTarget", { sessionId: sid }).catch(noop);
    }
    this.flush();
  }

  private forgetRoot(sid: string): void {
    this.roots.delete(sid);
    for (const [s, root] of this.sessionRoot) if (root === sid) this.sessionRoot.delete(s);
    for (const [t, root] of this.childTargets) if (root === sid) this.childTargets.delete(t);
    for (const [f, root] of this.frames) if (root === sid) this.frames.delete(f);
  }

  private frameOwned(frameId: unknown): boolean {
    if (typeof frameId !== "string") return false;
    if (this.owner.get(frameId) === true) return true;
    const root = this.frames.get(frameId) ?? this.childTargets.get(frameId);
    return !!root && this.roots.get(root)?.status === "owned";
  }

  /** Downloads are browser-wide events: pass on only this agent's, and put the file where its Playwright looks. */
  private onDownload(m: CdpMessage): void {
    const p = m.params ?? {};
    const guid = p.guid as string;
    if (m.method === "Browser.downloadWillBegin") {
      if (!this.frameOwned(p.frameId)) return;
      if (this.download?.behavior === "deny") {
        this.call("Browser.cancelDownload", { guid }).catch(noop);
        return;
      }
      this.downloads.add(guid);
      this.pushReady(m);
      return;
    }
    if (!this.downloads.has(guid)) return;
    if (p.state !== "inProgress") this.downloads.delete(guid);
    const dest = this.download?.path;
    if (p.state !== "completed" || !dest) {
      this.pushReady(m);
      return;
    }
    const entry = this.push();
    mkdir(dest, { recursive: true })
      .then(() => symlink(path.join(this.o.downloadDir, guid), path.join(dest, guid)))
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") this.log.warn("cdp proxy could not link a download", { err: errMsg(err) });
      })
      .finally(() => this.fill(entry, [m]))
      .catch(this.logFailure);
  }

  private logFailure = (err: unknown): void => {
    this.log.warn("cdp proxy message handling failed", { err: errMsg(err) });
  };

  private ownedPages(): string[] {
    return [...this.owner].filter(([, owned]) => owned).map(([id]) => id);
  }

  // ---- upstream -> client ----

  private onUpstream(raw: string): void {
    const m = JSON.parse(raw) as CdpMessage;
    if (typeof m.id === "number") {
      if (this.rpc.settle(m)) return;
      const f = this.forwarded.get(m.id);
      if (!f) return;
      this.forwarded.delete(m.id);
      m.id = f.clientId;
      if (!f.transform) {
        this.pushReady(m);
        return;
      }
      const entry = this.push();
      f.transform(m)
        .then(
          (x) => this.fill(entry, [x]),
          (err) =>
            this.fill(entry, [
              { id: f.clientId, sessionId: m.sessionId, error: { code: -32000, message: errMsg(err) } },
            ]),
        )
        .catch(this.logFailure);
      return;
    }
    if (m.sessionId && !this.browserSessions.has(m.sessionId)) {
      this.onSessionEvent(m);
      return;
    }
    const p = m.params ?? {};
    switch (m.method) {
      case "Target.attachedToTarget": {
        this.onAttached(m);
        return;
      }
      case "Target.detachedFromTarget": {
        if (this.browserSessions.delete(p.sessionId)) {
          this.pushReady(m);
          return;
        }
        const r = this.roots.get(p.sessionId);
        if (!r) return;
        if (r.status === "pending") {
          this.decideSession(p.sessionId, false);
          return;
        }
        this.forgetRoot(p.sessionId);
        this.owner.delete(r.targetId);
        this.pushReady(m);
        return;
      }
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        this.onTargetInfo(m);
        return;
      }
      case "Target.targetDestroyed":
      case "Target.targetCrashed": {
        const id = p.targetId as string;
        if (this.seen.has(id)) this.pushReady(m);
        if (m.method === "Target.targetDestroyed") {
          this.seen.delete(id);
          this.owner.delete(id);
          this.childTargets.delete(id);
        }
        return;
      }
      case "Target.receivedMessageFromTarget":
        if (this.rootOwned(p.sessionId)) this.pushReady(m);
        return;
      case "Browser.downloadWillBegin":
      case "Browser.downloadProgress": {
        this.onDownload(m);
        return;
      }
      default: {
        this.pushReady(m);
        return;
      }
    }
  }

  private onSessionEvent(m: CdpMessage): void {
    const root = this.sessionRoot.get(m.sessionId!);
    const r = root ? this.roots.get(root) : undefined;
    if (!root || !r) return;
    const p = m.params ?? {};
    // Child sessions (iframes, workers) belong to the page session they were attached under.
    if (m.method === "Target.attachedToTarget" && typeof p.sessionId === "string") {
      this.sessionRoot.set(p.sessionId, root);
      if (p.targetInfo?.targetId) this.childTargets.set(p.targetInfo.targetId, root);
    } else if (m.method === "Target.detachedFromTarget" && typeof p.sessionId === "string") {
      this.sessionRoot.delete(p.sessionId);
    } else if (m.method === "Page.frameAttached" && typeof p.frameId === "string") {
      this.frames.set(p.frameId, root);
    } else if (m.method === "Page.frameNavigated" && typeof p.frame?.id === "string") {
      this.frames.set(p.frame.id, root);
    }
    if (r.status === "owned") {
      this.pushReady(m);
      return;
    }
    if (r.deferred.length >= MAX_DEFERRED) {
      this.log.warn("cdp proxy dropped an event for an unclassified tab", { method: m.method });
      return;
    }
    r.deferred.push({ entry: this.push(), m });
  }

  /** The page this command is for (its session's top-level page, or a targetId param), as agent activity. */
  private noteActivity(m: CdpMessage): void {
    const report = this.o.onActivity;
    if (!report) return;
    const root = m.sessionId ? this.sessionRoot.get(m.sessionId) : undefined;
    const target = root ? this.roots.get(root)?.targetId : undefined;
    if (target) report(target, m.method);
    const param = m.params?.targetId;
    if (typeof param === "string") report(param, m.method);
  }

  private onAttached(m: CdpMessage): void {
    const { sessionId, targetInfo, waitingForDebugger } = (m.params ?? {}) as Json;
    if (typeof sessionId !== "string" || !targetInfo) return;
    if (targetInfo.type === "browser") {
      // The client's own Target.attachToBrowserTarget session (it's announced before the command's response).
      this.browserSessions.add(sessionId);
      this.pushReady(m);
      return;
    }
    if (targetInfo.type !== "page") {
      // Service workers, extension pages, browser UI: shared plumbing, hidden from every agent.
      if (waitingForDebugger) this.call("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(noop);
      this.call("Target.detachFromTarget", { sessionId }).catch(noop);
      return;
    }
    const r: Root = {
      targetId: targetInfo.targetId,
      status: "pending",
      waitingForDebugger: !!waitingForDebugger,
      deferred: [],
    };
    this.roots.set(sessionId, r);
    this.sessionRoot.set(sessionId, sessionId);
    r.deferred.push({ entry: this.push(), m });
    const known = this.owner.get(r.targetId);
    if (known !== undefined) {
      this.decideSession(sessionId, known);
      return;
    }
    this.resolve(r.targetId)
      .then((owned) => this.decideSession(sessionId, owned === true))
      .catch(this.logFailure);
  }

  private onTargetInfo(m: CdpMessage): void {
    const info = m.params?.targetInfo as Json | undefined;
    if (!info) return;
    const id = info.targetId as string;
    if (info.type !== "page") {
      const root = this.childTargets.get(id);
      if (root && this.roots.get(root)?.status === "owned") {
        this.seen.add(id);
        this.pushReady(m);
      }
      return;
    }
    const known = this.owner.get(id);
    if (known === false) return;
    if (known === true) {
      this.seen.add(id);
      this.pushReady(m);
      return;
    }
    const entry = this.push();
    this.resolve(id)
      .then((owned) => {
        if (owned) this.seen.add(id);
        this.fill(entry, owned ? [m] : []);
      })
      .catch(this.logFailure);
  }

  // ---- client -> upstream ----

  private onClient(raw: string): void {
    let m: CdpMessage;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof m.id !== "number" || typeof m.method !== "string") return;
    this.handleClient(m)
      .catch((err) => this.replyError(m, { code: -32000, message: errMsg(err) }))
      .catch(this.logFailure);
  }

  private forward(m: CdpMessage, transform?: (m: CdpMessage) => Promise<CdpMessage>): void {
    const uid = this.rpc.allocId();
    this.forwarded.set(uid, { clientId: m.id!, transform });
    this.sendUp({ ...m, id: uid });
  }

  private ownContext(id: unknown): boolean {
    return typeof id === "string" && this.contexts.has(id);
  }

  private async handleClient(m: CdpMessage): Promise<void> {
    const method = m.method!;
    const p = m.params ?? {};
    this.noteActivity(m);
    if (m.sessionId !== undefined && !this.browserSessions.has(m.sessionId) && !this.rootOwned(m.sessionId))
      return this.replyError(m, NO_SESSION);
    if (
      BLOCKED.has(method) ||
      ((method === "Storage.clearCookies" || method === "Browser.resetPermissions") &&
        !this.ownContext(p.browserContextId)) ||
      (method === "Target.disposeBrowserContext" && !this.ownContext(p.browserContextId))
    )
      return this.replyError(m, NOT_ALLOWED);

    if (TARGET_ID_METHODS.has(method)) {
      if (p.targetId === undefined || (await this.targetAllowed(p.targetId))) return this.forward(m);
      return this.replyError(m, NO_TARGET);
    }
    switch (method) {
      case "Target.createTarget": {
        const targetId = await this.policy.createInSeat(this.call, p, this.ownedPages(), (t, owned) =>
          this.decideTarget(t, owned),
        );
        return this.reply(m, { targetId });
      }
      case "Target.getTargets":
        return this.forward(m, async (res) => {
          const infos = (res.result?.targetInfos ?? []) as Json[];
          const keep = await Promise.all(
            infos.map((t) =>
              t.type === "page"
                ? this.targetAllowed(t.targetId)
                : Promise.resolve(
                    this.roots.get(this.childTargets.get(t.targetId) ?? "")?.status === "owned",
                  ),
            ),
          );
          return { ...res, result: { ...res.result, targetInfos: infos.filter((_, i) => keep[i]) } };
        });
      case "Browser.setDownloadBehavior": {
        if (this.ownContext(p.browserContextId)) return this.forward(m);
        // Browser-wide: never let one agent point everyone's downloads at its private folder (or deny them).
        this.download = { behavior: String(p.behavior ?? "default"), path: p.downloadPath };
        await mkdir(this.o.downloadDir, { recursive: true }).catch(noop);
        await this.call("Browser.setDownloadBehavior", {
          behavior: "allowAndName",
          downloadPath: this.o.downloadDir,
          eventsEnabled: true,
        });
        return this.reply(m, {});
      }
      case "Target.attachToBrowserTarget":
        return this.forward(m, async (res) => {
          if (typeof res.result?.sessionId === "string") this.browserSessions.add(res.result.sessionId);
          return res;
        });
      case "Target.createBrowserContext":
        return this.forward(m, async (res) => {
          if (typeof res.result?.browserContextId === "string")
            this.contexts.add(res.result.browserContextId);
          return res;
        });
      case "Target.detachFromTarget":
      case "Target.sendMessageToTarget": {
        const ok =
          typeof p.sessionId === "string"
            ? this.rootOwned(p.sessionId) || this.browserSessions.has(p.sessionId)
            : await this.targetAllowed(p.targetId);
        return ok ? this.forward(m) : this.replyError(m, NO_SESSION);
      }
      case "Browser.getWindowBounds":
      case "Browser.setWindowBounds":
      case "Browser.setContentsSize": {
        const windowId = p.windowId as number;
        const cur = await this.call("Browser.getWindowBounds", { windowId }).catch(() => undefined);
        const bounds = (cur?.bounds ?? {}) as WindowBounds;
        if (!cur || !this.policy.ownsWindow(windowId, bounds)) return this.replyError(m, NO_WINDOW);
        if (method === "Browser.getWindowBounds") return this.reply(m, { bounds });
        if (method === "Browser.setContentsSize") return this.forward(m);
        await this.policy.setBounds(this.call, windowId, bounds, (p.bounds ?? {}) as WindowBounds);
        return this.reply(m, {});
      }
      default:
        return this.forward(m);
    }
  }
}

function sendHttp(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type":
      typeof body === "string" ? "text/plain; charset=UTF-8" : "application/json; charset=UTF-8",
  });
  res.end(text);
}

function refuseUpgrade(socket: Duplex, status = "404 Not Found"): void {
  try {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
}

/** Starts one agent's proxy on 127.0.0.1:listenPort. */
export async function startCdpProxy(o: CdpProxyOptions): Promise<{ port: number; close(): Promise<void> }> {
  const log = o.log;
  try {
    mkdirSync(o.downloadDir, { recursive: true });
  } catch (err) {
    log.warn("cdp proxy could not create the download dir", { dir: o.downloadDir, err: errMsg(err) });
  }
  const policy = new SeatPolicy(o);
  const upHttp = `http://127.0.0.1:${o.upstreamPort}`;
  const live = new Set<{ close(reason: string): void }>();
  let port = o.listenPort;

  const upstreamJson = async (pathname: string, method = "GET"): Promise<any> => {
    const r = await fetch(`${upHttp}${pathname}`, { method, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) throw new Error(`upstream ${pathname}: HTTP ${r.status}`);
    return r.json();
  };

  /** Runs `fn` over a short-lived upstream browser connection (for the HTTP endpoints and page pipes). */
  const oneShot = async <T>(fn: (call: Call) => Promise<T>): Promise<T> => {
    const version = await upstreamJson("/json/version");
    const ws = await openSocket(version.webSocketDebuggerUrl);
    const rpc = new Rpc((m) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    });
    ws.on("message", (raw) => {
      try {
        rpc.settle(JSON.parse(raw.toString()));
      } catch {
        /* ignore */
      }
    });
    ws.on("error", noop);
    ws.on("close", () => rpc.failAll("upstream closed"));
    try {
      return await fn(rpc.call);
    } finally {
      ws.close();
    }
  };

  const ownedPageIds = (call: Call): Promise<string[]> =>
    call("Target.getTargets").then(async ({ targetInfos }: { targetInfos: Json[] }) => {
      const pages = targetInfos.filter((t) => t.type === "page");
      const owned = await Promise.all(pages.map((t) => policy.pageOwned(call, t.targetId)));
      return pages.filter((_, i) => owned[i] === true).map((t) => t.targetId as string);
    });

  const rewriteTarget = (t: Json): Json => {
    const ws = `127.0.0.1:${port}/devtools/page/${t.id}`;
    const out: Json = { ...t, webSocketDebuggerUrl: `ws://${ws}` };
    if (typeof t.devtoolsFrontendUrl === "string")
      out.devtoolsFrontendUrl = t.devtoolsFrontendUrl.replace(/([?&]ws=)[^&#]*/, `$1${ws}`);
    return out;
  };

  const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "");
    if (req.method !== "GET" && req.method !== "PUT") return sendHttp(res, 405, "Method not allowed");
    if (path === "/json/version") {
      const v = await upstreamJson("/json/version");
      const browserId = String(v.webSocketDebuggerUrl ?? "").split("/devtools/browser/")[1] ?? "";
      return sendHttp(res, 200, {
        ...v,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${browserId}`,
      });
    }
    if (path === "/json" || path === "/json/list") {
      const owned = new Set(await oneShot(ownedPageIds));
      const list = (await upstreamJson("/json/list")) as Json[];
      return sendHttp(res, 200, list.filter((t) => t.type === "page" && owned.has(t.id)).map(rewriteTarget));
    }
    if (path === "/json/new") {
      const raw = (req.url ?? "").split("?").slice(1).join("?");
      let target = raw;
      try {
        target = decodeURIComponent(raw);
      } catch {
        /* keep it raw */
      }
      const targetId = await oneShot(async (call) =>
        policy.createInSeat(call, { url: target || "about:blank" }, await ownedPageIds(call), noop),
      );
      for (let i = 0; i < 20; i++) {
        const list = (await upstreamJson("/json/list")) as Json[];
        const t = list.find((x) => x.id === targetId);
        if (t) return sendHttp(res, 200, rewriteTarget(t));
        await new Promise((r) => setTimeout(r, 100));
      }
      return sendHttp(res, 200, rewriteTarget({ id: targetId, type: "page", url: target || "about:blank" }));
    }
    const m = /^\/json\/(activate|close)\/([^/]+)$/.exec(path);
    if (m) {
      const targetId = decodeURIComponent(m[2]!);
      const owned = await oneShot((call) => policy.pageOwned(call, targetId));
      if (owned !== true) return sendHttp(res, 404, `No such target id: ${targetId}`);
      const r = await fetch(`${upHttp}/json/${m[1]}/${encodeURIComponent(targetId)}`, {
        signal: AbortSignal.timeout(5_000),
      });
      return sendHttp(res, r.status, await r.text());
    }
    return sendHttp(res, 404, "Not found");
  };

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 256 * 1024 * 1024,
  });

  /** An owned page's own endpoint: nothing to filter, so it's a raw two-way pipe. */
  const pipePage = async (req: http.IncomingMessage, socket: Duplex, head: Buffer, targetId: string) => {
    const owned = await oneShot((call) => policy.pageOwned(call, targetId));
    if (owned !== true) return refuseUpgrade(socket);
    const up = await openSocket(
      `ws://127.0.0.1:${o.upstreamPort}/devtools/page/${encodeURIComponent(targetId)}`,
    );
    if (socket.destroyed) return up.close();
    wss.handleUpgrade(req, socket, head, (client) => {
      const conn = {
        close: () => {
          live.delete(conn);
          for (const ws of [up, client]) {
            try {
              if (ws.readyState === WebSocket.OPEN) ws.close(1000);
              else ws.terminate();
            } catch {
              /* already gone */
            }
          }
        },
      };
      live.add(conn);
      client.on("message", (data, isBinary) => {
        o.onActivity?.(targetId);
        if (up.readyState === WebSocket.OPEN) up.send(data, { binary: isBinary });
      });
      up.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      for (const ws of [up, client]) {
        ws.on("close", () => conn.close());
        ws.on("error", () => conn.close());
      }
    });
  };

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      log.warn("cdp proxy http request failed", { url: req.url, err: errMsg(err) });
      sendHttp(res, 500, errMsg(err));
    });
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", noop);
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const page = /^\/devtools\/page\/([^/]+)$/.exec(path);
    if (page) {
      pipePage(req, socket, head, decodeURIComponent(page[1]!)).catch((err) => {
        log.warn("cdp proxy page connection failed", { err: errMsg(err) });
        refuseUpgrade(socket, "502 Bad Gateway");
      });
      return;
    }
    const browser = /^\/devtools\/browser\/([^/]*)$/.exec(path);
    if (!browser) return refuseUpgrade(socket);
    wss.handleUpgrade(req, socket, head, (client) => {
      try {
        const conn: BrowserConn = new BrowserConn(
          client,
          `ws://127.0.0.1:${o.upstreamPort}/devtools/browser/${browser[1]}`,
          policy,
          o,
          log,
          () => live.delete(conn),
        );
        live.add(conn);
      } catch (err) {
        log.warn("cdp proxy browser connection failed", { err: errMsg(err) });
        client.terminate();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.listenPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (err) => log.warn("cdp proxy server error", { err: errMsg(err) }));
  port = (server.address() as { port: number }).port;
  log.info("cdp proxy listening", { port, upstreamPort: o.upstreamPort });

  return {
    port,
    close: async () => {
      for (const c of [...live]) c.close("proxy closed");
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
