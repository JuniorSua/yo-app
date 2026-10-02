/**
 * agentd HTTP + WebSocket server.
 *
 *   GET /healthz                 (no auth)
 *   WS  /control                 yo-core control channel (hello + token; newest connection wins)
 *   WS  /vnc/:agentId            RFB bridge to the display's loopback x11vnc (bearer)
 *   GET /screenshot/:agentId     PNG (bearer)
 *   GET /files/:agentId?path=    download from the agent's home (bearer)
 */
import { createReadStream, promises as fsp } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  type AgentdPush,
  type AgentdReply,
  AgentdRequest,
  type AgentdResponses,
  type ProviderEvent,
  type ProviderKind,
} from "@yo/contracts";
import { WebSocket, WebSocketServer } from "ws";
import { AccountStore } from "./accounts";
import { bearerFrom, checkBearer, isLocalPeer, safeEqual } from "./auth";
import { getAgentEnv, getMcpServers, initComputer } from "./computer";
import { AGENTD_VERSION, assertSafeId, config } from "./config";
import { DisplayManager } from "./displays/DisplayManager";
import { SessionEventLog } from "./eventLog";
import { ensureAgentHome, listDir, PathError, resolveConfinedReal, saveIncoming } from "./fs";
import { createLogger, errMsg } from "./log";
import { readMetrics } from "./metrics";
import { ProviderRegistry } from "./providers";
import type { LoginHandle, SessionStartInput } from "./providers/ProviderAdapter";
import { PtyManager } from "./pty/PtyManager";
import { ToolBridge, type ToolCall } from "./toolBridge";
import { bridgeVnc } from "./vnc";

type Req = AgentdRequest;
type ReqOf<T extends Req["type"]> = Extract<Req, { type: T }>;
type Handler<T extends Req["type"]> = (req: ReqOf<T>) => Promise<AgentdResponses[T]>;

const HELLO_TIMEOUT_MS = 10_000;
const STOPPED_SESSION_TTL_MS = 60 * 60_000;

export class AgentdServer {
  private readonly log = createLogger("agentd");
  private readonly http: http.Server;
  private readonly controlWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  private readonly vncWss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  });

  private control: WebSocket | null = null;
  private readonly events = new SessionEventLog<ProviderEvent>(config.ringSize);
  private readonly sessions = new Map<string, { provider: ProviderKind; agentId: string }>();
  private readonly logins = new Map<string, LoginHandle>();
  private readonly loginGen = new Map<string, number>();
  /** Important pushes (auth results) that must survive a control disconnect. */
  private readonly outbox: AgentdPush[] = [];
  /** Session keys currently being stopped by a session.start (their late events are discarded). */
  private readonly restarting = new Set<string>();
  private readonly dropTimers = new Map<string, NodeJS.Timeout>();
  private metricsTimer: NodeJS.Timeout | null = null;

  readonly displays: DisplayManager;
  readonly accounts = new AccountStore((m) => this.log.info(m));
  readonly providers: ProviderRegistry;
  readonly ptys: PtyManager;
  readonly tools: ToolBridge;

  constructor(private readonly token: string) {
    this.displays = new DisplayManager(this.log.child("displays"), (agentId, state, lease, message) =>
      this.push({ type: "computer.state", agentId, state, lease, message }),
    );
    initComputer(this.displays);
    this.providers = new ProviderRegistry((sessionKey, event) => this.emitEvent(sessionKey, event), this.log);
    this.ptys = new PtyManager(
      this.log.child("pty"),
      {
        data: (ptyId, data) => this.push({ type: "pty.data", ptyId, data }),
        exit: (ptyId, code) => this.push({ type: "pty.exit", ptyId, code }),
      },
      (agentId) => getAgentEnv(agentId),
    );
    this.tools = new ToolBridge(config.toolSocket, this.log.child("tools"), (call) =>
      this.forwardToolCall(call),
    );
    this.http = http.createServer((req, res) => {
      this.onHttp(req, res).catch((err) => {
        this.log.error("http handler failed", { url: req.url, err: errMsg(err) });
        if (!res.headersSent) res.writeHead(500).end("internal error");
        else res.destroy();
      });
    });
    this.http.on("upgrade", (req, socket, head) => {
      this.onUpgrade(req, socket, head).catch((err) => {
        this.log.error("upgrade failed", { url: req.url, err: errMsg(err) });
        rejectUpgrade(socket, 500, "Internal Server Error");
      });
    });
  }

  async start(): Promise<void> {
    await this.tools.listen();
    await new Promise<void>((resolve) => this.http.listen(config.port, config.host, resolve));
    this.metricsTimer = setInterval(() => {
      if (this.isConnected()) this.push({ type: "metrics", ...readMetrics() });
    }, config.metricsIntervalMs);
    this.log.info("agentd listening", { host: config.host, port: config.port, version: AGENTD_VERSION });
  }

  async stop(): Promise<void> {
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.control?.close(1001, "shutting down");
    this.ptys.closeAll();
    await this.providers.dispose();
    await this.displays.shutdown();
    this.tools.close();
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  /* --------------------------------- HTTP --------------------------------- */

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://agentd");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (this.isForbiddenPeer(req)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("forbidden: local clients are not allowed");
      return;
    }
    if (!checkBearer(req, this.token)) {
      res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    const shot = /^\/screenshot\/([^/]+)$/.exec(url.pathname);
    if (shot) {
      const agentId = decodeURIComponent(shot[1]!);
      try {
        assertSafeId(agentId, "agentId");
        const png = await this.displays.screenshot(agentId);
        res.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "no-store",
          "content-length": png.length,
        });
        res.end(png);
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        res.writeHead(status, { "content-type": "text/plain" }).end(errMsg(err));
      }
      return;
    }
    const files = /^\/files\/([^/]+)$/.exec(url.pathname);
    if (files) {
      const agentId = decodeURIComponent(files[1]!);
      try {
        assertSafeId(agentId, "agentId");
        await ensureAgentHome(agentId);
        const file = await resolveConfinedReal(agentId, url.searchParams.get("path") ?? "");
        const st = await fsp.stat(file);
        if (!st.isFile()) {
          res.writeHead(400, { "content-type": "text/plain" }).end("not a file");
          return;
        }
        // Files get overwritten in place (e.g. a redone screenshot): always revalidate, cheaply.
        const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
        const validators = { "cache-control": "no-cache", etag, "last-modified": st.mtime.toUTCString() };
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, validators).end();
          return;
        }
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": st.size,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
          "x-content-type-options": "nosniff",
          ...validators,
        });
        createReadStream(file).pipe(res);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const status = err instanceof PathError ? 403 : code === "ENOENT" ? 404 : 400;
        res.writeHead(status, { "content-type": "text/plain" }).end(errMsg(err));
      }
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }

  /** Authenticated endpoints refuse peers inside the container (see isLocalPeer). */
  private isForbiddenPeer(req: IncomingMessage): boolean {
    if (config.allowLocal || !isLocalPeer(req.socket.remoteAddress)) return false;
    this.log.warn("rejected local peer", { peer: req.socket.remoteAddress, url: req.url });
    return true;
  }

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://agentd");
    if (this.isForbiddenPeer(req)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (url.pathname === "/control") {
      const bearer = bearerFrom(req);
      if (bearer !== null && !safeEqual(bearer, this.token)) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      this.controlWss.handleUpgrade(req, socket, head, (ws) => this.onControl(ws, bearer !== null));
      return;
    }
    const vnc = /^\/vnc\/([^/]+)$/.exec(url.pathname);
    if (vnc) {
      if (!checkBearer(req, this.token)) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      const agentId = decodeURIComponent(vnc[1]!);
      try {
        assertSafeId(agentId, "agentId");
      } catch {
        rejectUpgrade(socket, 400, "Bad Request");
        return;
      }
      const display = await this.displays.ensure(agentId);
      this.vncWss.handleUpgrade(req, socket, head, (ws) =>
        bridgeVnc(ws, display.vncPort, this.log.child("vnc"), agentId),
      );
      return;
    }
    rejectUpgrade(socket, 404, "Not Found");
  }

  /* ------------------------------- control WS ------------------------------- */

  private isConnected(): boolean {
    return this.control !== null && this.control.readyState === WebSocket.OPEN;
  }

  private onControl(ws: WebSocket, headerAuthed: boolean): void {
    let authed = false;
    const helloTimer = setTimeout(() => {
      if (!authed) ws.close(4401, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        if (!authed) ws.close(4401, "unauthorized");
        return;
      }
      if (!authed) {
        const parsed = AgentdRequest.safeParse(msg);
        if (
          !parsed.success ||
          parsed.data.type !== "hello" ||
          !(headerAuthed || safeEqual(parsed.data.token, this.token))
        ) {
          this.log.warn("control auth rejected", { headerAuthed });
          ws.close(4401, "unauthorized");
          return;
        }
        authed = true;
        clearTimeout(helloTimer);
        this.onHello(ws, parsed.data).catch((err) => this.log.error("hello failed", { err: errMsg(err) }));
        return;
      }
      void this.dispatch(ws, msg);
    });
    ws.on("close", (code) => {
      clearTimeout(helloTimer);
      if (this.control === ws) {
        this.control = null;
        this.log.info("control disconnected", { code });
      }
    });
    ws.on("error", (err) => this.log.warn("control socket error", { err: errMsg(err) }));
  }

  private async onHello(ws: WebSocket, hello: ReqOf<"hello">): Promise<void> {
    const previous = this.control;
    this.control = ws;
    if (previous && previous !== ws) previous.close(4000, "replaced by newer connection");
    this.log.info("control connected", { coreVersion: hello.coreVersion, resume: hello.resume.length });

    const providers = await this.providers.versions();
    // Which sessions survived lets core tell a network blip (turns carry on) from an agentd restart.
    const liveSessions = [...this.sessions]
      .filter(([key, s]) => this.providers.get(s.provider).hasSession(key))
      .map(([key]) => key);
    this.sendTo(ws, {
      type: "ok",
      re: hello.id,
      data: { agentdVersion: AGENTD_VERSION, providers, liveSessions },
    });

    // Replay buffered session events after the requested seq.
    for (const { sessionKey, lastSeq } of hello.resume) {
      const { entries, gap } = this.events.since(sessionKey, lastSeq);
      if (gap) {
        this.sendTo(ws, {
          type: "log",
          level: "warn",
          message: `event gap for session ${sessionKey}: events after seq ${lastSeq} were evicted`,
        });
      }
      for (const e of entries) this.sendTo(ws, { type: "event", sessionKey, seq: e.seq, event: e.value });
    }
    // Flush queued important pushes, then re-push still-pending tool calls (core dedupes by callId).
    for (const p of this.outbox.splice(0)) this.sendTo(ws, p);
    for (const call of this.tools.pendingCalls()) this.sendTo(ws, toolCallPush(call));
    for (const a of this.displays.status()) {
      if (a.state !== "off")
        this.sendTo(ws, { type: "computer.state", agentId: a.agentId, state: a.state, lease: a.lease });
    }
    this.sendTo(ws, { type: "metrics", ...readMetrics() });
  }

  private sendTo(ws: WebSocket, frame: AgentdPush | AgentdReply): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  push(frame: AgentdPush): boolean {
    const ws = this.control;
    if (ws && this.sendTo(ws, frame)) return true;
    if (frame.type === "auth.login.prompt" || frame.type === "auth.login.result") {
      this.outbox.push(frame);
      if (this.outbox.length > 100) this.outbox.shift();
    }
    return false;
  }

  private emitEvent(sessionKey: string, event: ProviderEvent): void {
    // Events from a run being torn down by session.start must not leak into the fresh run's seq space.
    if (this.restarting.has(sessionKey)) return;
    const entry = this.events.append(sessionKey, event);
    this.push({ type: "event", sessionKey, seq: entry.seq, event });
    if (event.type === "session.exited") this.scheduleDrop(sessionKey);
  }

  /** Forget a finished session's replay buffer after a grace period. */
  private scheduleDrop(sessionKey: string): void {
    clearTimeout(this.dropTimers.get(sessionKey));
    const t = setTimeout(() => {
      this.dropTimers.delete(sessionKey);
      if (!this.sessions.has(sessionKey)) this.events.drop(sessionKey);
    }, STOPPED_SESSION_TTL_MS);
    t.unref();
    this.dropTimers.set(sessionKey, t);
  }

  private forwardToolCall(call: ToolCall): boolean {
    return this.push(toolCallPush(call));
  }

  private async dispatch(ws: WebSocket, msg: unknown): Promise<void> {
    const id = typeof (msg as { id?: unknown })?.id === "string" ? (msg as { id: string }).id : "";
    const parsed = AgentdRequest.safeParse(msg);
    if (!parsed.success) {
      this.sendTo(ws, {
        type: "err",
        re: id,
        error: `invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        code: "invalid_request",
      });
      return;
    }
    const req = parsed.data;
    try {
      const handler = this.handlers[req.type] as Handler<typeof req.type>;
      const data = await handler(req as never);
      this.sendTo(ws, { type: "ok", re: req.id, data });
    } catch (err) {
      this.log.warn("request failed", { type: req.type, err: errMsg(err) });
      this.sendTo(ws, {
        type: "err",
        re: req.id,
        error: errMsg(err),
        code: err instanceof PathError ? "forbidden" : (err as { code?: string }).code,
      });
    }
  }

  /** Adapter owning a live session. Throws "unknown session" (core matches it to auto-resume). */
  private sessionAdapter(sessionKey: string) {
    const s = this.sessions.get(sessionKey);
    const adapter = s ? this.providers.get(s.provider) : this.providers.findBySession(sessionKey);
    if (!adapter?.hasSession(sessionKey)) {
      this.sessions.delete(sessionKey);
      throw Object.assign(new Error(`unknown session ${sessionKey}`), { code: "unknown_session" });
    }
    return adapter;
  }

  private readonly handlers: { [T in Req["type"]]: Handler<T> } = {
    hello: async () => {
      throw new Error("already authenticated");
    },

    "computer.ensure": async ({ agentId }) => {
      const d = await this.displays.ensure(agentId);
      await ensureAgentHome(agentId);
      return { state: d.state, display: d.n };
    },
    "computer.hibernate": async ({ agentId }) => {
      assertSafeId(agentId, "agentId");
      await this.displays.hibernate(agentId);
      return {};
    },
    "computer.lease": async ({ agentId, holder }) => {
      await this.displays.lease(agentId, holder);
      return {};
    },
    "computer.status": async () => {
      const m = readMetrics();
      return { agents: this.displays.status(), memMB: m.memMB, memLimitMB: m.memLimitMB };
    },

    "account.configure": async ({ accountId, provider, secrets }) => {
      this.accounts.configure(accountId, provider, secrets);
      return {};
    },
    "account.remove": async ({ accountId, provider }) => {
      const ctx = this.accounts.get(accountId);
      const adapter = this.providers.get(provider);
      if (ctx && adapter.logout) await adapter.logout(ctx).catch(() => undefined);
      this.logins.get(accountId)?.cancel();
      this.logins.delete(accountId);
      this.accounts.remove(accountId, provider);
      return {};
    },
    "auth.probe": async ({ accountId, provider }) => {
      return this.providers.get(provider).probe(this.accounts.getOrCreate(accountId, provider));
    },
    "auth.login.start": async ({ accountId, provider }) => {
      const account = this.accounts.getOrCreate(accountId, provider);
      // Supersede any previous flow for this account. Its "canceled" result must NOT reach core:
      // it would race the fresh flow's prompt (and a code from the old link can never work anyway).
      const gen = (this.loginGen.get(accountId) ?? 0) + 1;
      this.loginGen.set(accountId, gen);
      this.logins.get(accountId)?.cancel();
      this.logins.delete(accountId);
      const current = () => this.loginGen.get(accountId) === gen;
      this.log.info("login start", { accountId, provider, gen });
      let finished = false;
      const handle = await this.providers.get(provider).login(account, {
        prompt: (p) => {
          if (!current()) return;
          this.log.info("login prompt", { accountId, gen, hasUrl: !!p.url, hasCode: !!p.userCode });
          this.push({
            type: "auth.login.prompt",
            accountId,
            url: p.url,
            userCode: p.userCode,
            needsInput: p.needsInput,
            message: p.message,
          });
        },
        result: (r) => {
          finished = true;
          if (!current()) return;
          this.logins.delete(accountId);
          this.log.info("login result", { accountId, gen, ok: r.ok, message: r.message });
          if (r.secrets) this.accounts.mergeSecrets(accountId, r.secrets);
          this.push({
            type: "auth.login.result",
            accountId,
            ok: r.ok,
            message: r.message,
            secrets: r.secrets,
          });
        },
      });
      if (!finished && current()) this.logins.set(accountId, handle);
      return {};
    },
    "auth.login.input": async ({ accountId, input }) => {
      const h = this.logins.get(accountId);
      if (!h) throw new Error("This sign-in expired. Click Connect to get a fresh link.");
      this.log.info("login input", { accountId, length: input.length });
      h.input(input);
      return {};
    },
    "auth.login.cancel": async ({ accountId }) => {
      this.loginGen.set(accountId, (this.loginGen.get(accountId) ?? 0) + 1);
      this.logins.get(accountId)?.cancel();
      this.logins.delete(accountId);
      return {};
    },
    "models.list": async ({ accountId, provider }) => {
      const models = await this.providers
        .get(provider)
        .listModels(this.accounts.getOrCreate(accountId, provider));
      return { models };
    },

    "session.start": async (r) => {
      assertSafeId(r.agentId, "agentId");
      const adapter = this.providers.get(r.provider);
      // A session.start always begins a fresh run for this key: stop any live run (any provider),
      // then reset seq to 0 and clear the replay buffer. Continuity comes from resumeCursor.
      this.restarting.add(r.sessionKey);
      try {
        const owners = new Set(this.providers.all().filter((a) => a.hasSession(r.sessionKey)));
        const existing = this.sessions.get(r.sessionKey);
        if (existing) owners.add(this.providers.get(existing.provider));
        for (const a of owners) await a.stopSession(r.sessionKey).catch(() => undefined);
        this.sessions.delete(r.sessionKey);
        this.events.drop(r.sessionKey);
        clearTimeout(this.dropTimers.get(r.sessionKey));
        this.dropTimers.delete(r.sessionKey);
      } finally {
        this.restarting.delete(r.sessionKey);
      }
      const account = this.accounts.getOrCreate(r.accountId, r.provider);
      await this.displays.ensure(r.agentId);
      const cwd = await ensureAgentHome(r.agentId);
      const input: SessionStartInput = {
        sessionKey: r.sessionKey,
        agentId: r.agentId,
        account,
        model: r.model,
        effort: r.effort,
        runtimeMode: r.runtimeMode,
        systemAppend: r.systemAppend,
        resumeCursor: r.resumeCursor,
        cwd,
        env: { ...getAgentEnv(r.agentId) },
        mcpServers: getMcpServers(r.agentId, r.sessionKey),
      };
      this.sessions.set(r.sessionKey, { provider: r.provider, agentId: r.agentId });
      try {
        return await adapter.startSession(input);
      } catch (err) {
        this.sessions.delete(r.sessionKey);
        throw err;
      }
    },
    "session.set": async ({ sessionKey, model, runtimeMode }) => {
      const adapter = this.sessionAdapter(sessionKey);
      if (!adapter.setSession) throw new Error(`${adapter.kind} does not support session.set`);
      await adapter.setSession(sessionKey, { model, runtimeMode });
      return {};
    },
    "session.stop": async ({ sessionKey }) => {
      const s = this.sessions.get(sessionKey);
      const adapter = s ? this.providers.get(s.provider) : this.providers.findBySession(sessionKey);
      this.sessions.delete(sessionKey);
      if (adapter) await adapter.stopSession(sessionKey);
      this.scheduleDrop(sessionKey);
      return {};
    },
    "turn.send": async ({ sessionKey, turnId, input }) => {
      const s = this.sessions.get(sessionKey);
      if (s)
        void this.displays
          .get(s.agentId)
          .ensure()
          .catch(() => undefined);
      await this.sessionAdapter(sessionKey).sendTurn(sessionKey, turnId, input);
      return {};
    },
    "turn.interrupt": async ({ sessionKey }) => {
      await this.sessionAdapter(sessionKey).interrupt(sessionKey);
      return {};
    },
    "request.respond": async ({ sessionKey, requestId, decision, answers, message }) => {
      await this.sessionAdapter(sessionKey).respond(sessionKey, { requestId, decision, answers, message });
      return {};
    },
    "tool.result": async ({ callId, ok, text }) => {
      if (!this.tools.resolve(callId, ok, text)) {
        this.log.warn("tool.result for unknown call", { callId });
      }
      return {};
    },

    "pty.open": async ({ ptyId, agentId, cols, rows }) => {
      assertSafeId(agentId, "agentId");
      this.displays.displayNumber(agentId);
      await this.ptys.open(ptyId, agentId, cols, rows);
      return {};
    },
    "pty.input": async ({ ptyId, data }) => {
      this.ptys.input(ptyId, data);
      return {};
    },
    "pty.resize": async ({ ptyId, cols, rows }) => {
      this.ptys.resize(ptyId, cols, rows);
      return {};
    },
    "pty.close": async ({ ptyId }) => {
      this.ptys.close(ptyId);
      return {};
    },
    "fs.list": async ({ agentId, path: p }) => {
      return { entries: await listDir(agentId, p) };
    },
    "fs.write": async ({ agentId, dir, name, dataBase64 }) => {
      return { path: await saveIncoming(agentId, dir, name, Buffer.from(dataBase64, "base64")) };
    },
  };
}

function toolCallPush(call: ToolCall): AgentdPush {
  return {
    type: "tool.call",
    callId: call.callId,
    agentId: call.agentId,
    sessionKey: call.sessionKey,
    tool: call.tool,
    args: call.args,
  };
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // ignore
  }
  socket.destroy();
}
