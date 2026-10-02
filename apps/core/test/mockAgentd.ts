import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentdRequest, ProviderEvent } from "@yo/contracts";
import WebSocket, { WebSocketServer } from "ws";

export interface MockSession {
  sessionKey: string;
  agentId: string;
  accountId: string;
  provider: string;
  model?: string;
  systemAppend: string;
  resumeCursor?: Record<string, unknown>;
  seq: number;
}

/**
 * Scripted fake of agentd for core tests. Behavior is driven by the user's text:
 *  - "ask ..."      -> Yo tool call ask_user, then echoes the answer
 *  - "approve ..."  -> provider request.opened (tool_approval) for tool "Bash"
 *  - "remember X"   -> Yo tool call remember {fact: X}
 *  - "tool NAME {json}" -> Yo tool call NAME with those args, then replies "tool: <result text>"
 *  - "slow"         -> never completes until interrupted
 *  - anything else  -> streams "echo: <text>"
 */
export class MockAgentd {
  server = http.createServer((req, res) => {
    if (req.url === "/healthz") return res.end("ok");
    if (req.headers.authorization !== `Bearer ${this.token}`) return res.writeHead(401).end();
    if (req.url?.startsWith("/files/")) {
      const filePath = new URL(req.url, "http://x").searchParams.get("path") ?? "";
      return res.end(this.files.get(filePath) ?? "file-content");
    }
    res.writeHead(404).end();
  });
  wss = new WebSocketServer({ noServer: true });
  ws: WebSocket | null = null;
  requests: AgentdRequest[] = [];
  /** Every turn's text as core sent it. */
  turnTexts: string[] = [];
  sessions = new Map<string, MockSession>();
  private pendingTools = new Map<string, (text: string) => void>();
  private pendingToolFrames = new Map<string, string>();
  private pendingProvider = new Map<string, (decision: string) => void>();
  private callSeq = 0;
  loginStarts = 0;
  /** When true, resumed sessions fail like Claude does when its conversation is gone (computer moved/reset). */
  forgetConversations = false;
  /** Context size reported per turn (drives auto-compaction). */
  usageContextTokens = 10;
  /** When true, auth.probe reports unauthenticated until a login succeeds. */
  requireLogin = false;
  private loggedIn = new Set<string>();
  private buffers = new Map<string, { seq: number; frame: string }[]>();

  constructor(public token: string) {
    this.server.on("upgrade", (req, socket, head) => {
      if (req.headers.authorization !== `Bearer ${this.token}`) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close() {
    this.ws?.terminate();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Drop the connection (simulates network blip). */
  drop() {
    this.ws?.terminate();
  }

  count(type: string) {
    return this.requests.filter((r) => r.type === type).length;
  }

  last<T extends AgentdRequest["type"]>(type: T): Extract<AgentdRequest, { type: T }> | undefined {
    return [...this.requests].reverse().find((r) => r.type === type) as any;
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private emit(sessionKey: string, event: ProviderEvent) {
    const s = this.sessions.get(sessionKey);
    if (!s) return;
    s.seq += 1;
    const frame = JSON.stringify({ type: "event", sessionKey, seq: s.seq, event });
    const buf = this.buffers.get(sessionKey) ?? [];
    buf.push({ seq: s.seq, frame });
    this.buffers.set(sessionKey, buf);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  private onConnection(ws: WebSocket) {
    this.ws?.terminate();
    this.ws = ws;
    ws.on("message", (raw) => void this.onMessage(JSON.parse(raw.toString()) as AgentdRequest));
  }

  private ok(id: string, data: unknown = {}) {
    this.send({ type: "ok", re: id, data });
  }

  private async onMessage(req: AgentdRequest) {
    this.requests.push(req);
    switch (req.type) {
      case "hello":
        if (req.token !== this.token) return this.send({ type: "err", re: req.id, error: "bad token" });
        this.ok(req.id, {
          agentdVersion: "mock",
          providers: [{ kind: "claude", version: "mock" }],
          ...(this.reportLiveSessions ? { liveSessions: [...this.sessions.keys()] } : {}),
        });
        for (const r of req.resume) {
          for (const b of this.buffers.get(r.sessionKey) ?? []) if (b.seq > r.lastSeq) this.ws?.send(b.frame);
        }
        // Like agentd: tool calls still waiting on core are pushed again after every reconnect.
        for (const frame of this.pendingToolFrames.values()) this.ws?.send(frame);
        return;
      case "computer.ensure":
        return this.ok(req.id, { state: "ready", display: 10 });
      case "computer.status":
        return this.ok(req.id, { agents: [], memMB: 100, memLimitMB: 4500 });
      case "auth.probe":
        if (this.requireLogin && !this.loggedIn.has(req.accountId))
          return this.ok(req.id, {
            accountId: req.accountId,
            provider: req.provider,
            status: "unauthenticated",
          });
        return this.ok(req.id, {
          accountId: req.accountId,
          provider: req.provider,
          status: "authenticated",
          plan: "Claude Max",
        });
      case "models.list":
        return this.ok(req.id, {
          models: [{ id: "claude-sonnet-5-5", label: "Sonnet 5.5", isDefault: true }],
        });
      case "session.start":
        this.buffers.delete(req.sessionKey);
        this.sessions.set(req.sessionKey, {
          sessionKey: req.sessionKey,
          agentId: req.agentId,
          accountId: req.accountId,
          provider: req.provider,
          model: req.model,
          systemAppend: req.systemAppend,
          resumeCursor: req.resumeCursor,
          seq: 0,
        });
        this.ok(req.id, { resumed: !!req.resumeCursor });
        this.emit(req.sessionKey, {
          type: "session.started",
          resumeCursor: { sessionId: `native-${req.sessionKey}` },
        });
        return;
      case "turn.send": {
        if (!this.sessions.has(req.sessionKey))
          return this.send({ type: "err", re: req.id, error: "unknown session" });
        this.ok(req.id);
        void this.runTurn(
          req.sessionKey,
          req.turnId,
          req.input.map((p) => (p.type === "text" ? p.text : "")).join(" "),
        );
        return;
      }
      case "turn.interrupt": {
        this.ok(req.id);
        const t = this.activeTurn.get(req.sessionKey);
        if (t) {
          this.activeTurn.delete(req.sessionKey);
          this.emit(req.sessionKey, { type: "turn.completed", turnId: t, status: "interrupted" });
        }
        return;
      }
      case "tool.result": {
        this.ok(req.id);
        this.pendingTools.get(req.callId)?.(req.text);
        this.pendingTools.delete(req.callId);
        this.pendingToolFrames.delete(req.callId);
        return;
      }
      case "request.respond": {
        this.ok(req.id);
        this.pendingProvider.get(req.requestId)?.(req.decision);
        this.pendingProvider.delete(req.requestId);
        return;
      }
      case "auth.login.start": {
        this.loginStarts++;
        this.ok(req.id);
        const url = `https://claude.example/authorize?state=s${this.loginStarts}`;
        setTimeout(
          () => this.send({ type: "auth.login.prompt", accountId: req.accountId, url, needsInput: true }),
          30,
        );
        return;
      }
      case "auth.login.input": {
        this.ok(req.id);
        const good = req.input === `code#s${this.loginStarts}`;
        if (good) this.loggedIn.add(req.accountId);
        setTimeout(
          () =>
            this.send({
              type: "auth.login.result",
              accountId: req.accountId,
              ok: good,
              message: good ? undefined : "Claude didn't accept that code",
              secrets: good ? { claudeOauthToken: "sk-ant-oat01-test" } : undefined,
            }),
          30,
        );
        return;
      }
      case "fs.write": {
        this.written.push({
          agentId: req.agentId,
          name: req.name,
          data: Buffer.from(req.dataBase64, "base64"),
        });
        return this.ok(req.id, { path: `~/from-mac/${req.name}` });
      }
      case "session.stop":
        this.sessions.delete(req.sessionKey);
        return this.ok(req.id);
      default:
        return this.ok(req.id);
    }
  }

  private activeTurn = new Map<string, string>();
  /** Contents served from the agent's computer at /files (path -> bytes); default "file-content". */
  files = new Map<string, string>();
  /** Files core saved into the agent's computer (fs.write). */
  written: { agentId: string; name: string; data: Buffer }[] = [];

  /** A tool call from any process in the computer, with whatever identity it claims. */
  forgeToolCall(agentId: string, sessionKey: string, tool: string, args: Record<string, unknown>) {
    return this.toolCall(agentId, sessionKey, tool, args);
  }

  sessionKeyOf(agentId: string): string | undefined {
    return [...this.sessions.values()].find((x) => x.agentId === agentId)?.sessionKey;
  }

  private toolCall(agentId: string, sessionKey: string, tool: string, args: Record<string, unknown>) {
    const callId = `call_${++this.callSeq}`;
    return new Promise<string>((resolve) => {
      this.pendingTools.set(callId, resolve);
      const frame = JSON.stringify({ type: "tool.call", callId, agentId, sessionKey, tool, args });
      this.pendingToolFrames.set(callId, frame);
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
    });
  }

  /** Older agentd versions don't say which sessions survived a reconnect. */
  reportLiveSessions = true;

  /** agentd restarted: every provider session (and its buffered events) is gone. */
  restart() {
    this.sessions.clear();
    this.buffers.clear();
    this.activeTurn.clear();
    this.ws?.terminate();
  }

  /** The provider process died (e.g. the CLI crashed). */
  exitSession(sessionKey: string, reason = "Claude exited") {
    this.activeTurn.delete(sessionKey);
    this.emit(sessionKey, { type: "session.exited", reason });
  }

  private async runTurn(sessionKey: string, turnId: string, text: string) {
    const s = this.sessions.get(sessionKey)!;
    this.activeTurn.set(sessionKey, turnId);
    this.emit(sessionKey, { type: "turn.started", turnId });
    if (this.forgetConversations && s.resumeCursor) {
      const error = `No conversation found with session ID: ${String(s.resumeCursor.sessionId)}`;
      this.activeTurn.delete(sessionKey);
      this.emit(sessionKey, { type: "turn.completed", turnId, status: "failed", error });
      this.emit(sessionKey, {
        type: "runtime.error",
        message: `Could not resume Claude session: ${error}`,
        fatal: true,
      });
      this.emit(sessionKey, { type: "session.exited", reason: error });
      return;
    }
    this.turnTexts.push(text);
    // Core stamps each message with the time it was sent, and routines with their label.
    const userText = text
      .replace(/^\[[^\]]*\d{4}[^\]]*\]\s*/, "")
      .replace(/^\[Scheduled routine[^\]]*\]\s*/, "");
    let reply = `echo: ${userText}`;
    if (userText.startsWith("ask")) {
      const answer = await this.toolCall(s.agentId, sessionKey, "ask_user", {
        question: "Which one?",
        options: ["A", "B"],
      });
      reply = `got ${answer}`;
    } else if (userText.startsWith("remember ")) {
      await this.toolCall(s.agentId, sessionKey, "remember", { fact: userText.slice(9) });
      reply = "saved";
    } else if (userText.startsWith("approve")) {
      const requestId = `perm_${++this.callSeq}`;
      const decision = await new Promise<string>((resolve) => {
        this.pendingProvider.set(requestId, resolve);
        this.emit(sessionKey, {
          type: "request.opened",
          turnId,
          request: { requestId, kind: "tool_approval", toolName: "Bash", title: "Run `rm -rf tmp`" },
        });
      });
      this.emit(sessionKey, { type: "request.resolved", requestId, decision: decision as any });
      reply = `decision ${decision}`;
    } else if (userText.startsWith("tool ")) {
      const m = /^tool (\S+)\s*(.*)$/s.exec(userText)!;
      const result = await this.toolCall(s.agentId, sessionKey, m[1]!, m[2] ? JSON.parse(m[2]) : {});
      reply = `tool: ${result}`;
    } else if (userText === "slow") {
      return; // waits for interrupt
    } else if (userText.startsWith("half ")) {
      // Streams part of a reply, then hangs mid-message (until interrupted or the session exits).
      const itemId = `msg_${turnId}`;
      this.emit(sessionKey, {
        type: "item.started",
        turnId,
        item: { id: itemId, kind: "assistant_message", status: "running" },
      });
      for (const chunk of userText.slice(5).match(/.{1,4}/g) ?? [])
        this.emit(sessionKey, { type: "content.delta", turnId, itemId, stream: "text", delta: chunk });
      return;
    } else if (userText === "quiet") {
      reply = "NO_RESPONSE"; // a routine with nothing to report
    }
    const itemId = `msg_${turnId}`;
    this.emit(sessionKey, {
      type: "item.started",
      turnId,
      item: { id: itemId, kind: "assistant_message", status: "running" },
    });
    for (const chunk of reply.match(/.{1,4}/g) ?? []) {
      this.emit(sessionKey, { type: "content.delta", turnId, itemId, stream: "text", delta: chunk });
    }
    this.emit(sessionKey, {
      type: "item.completed",
      turnId,
      item: { id: itemId, kind: "assistant_message", status: "completed", text: reply },
    });
    if (this.activeTurn.get(sessionKey) !== turnId) return;
    this.activeTurn.delete(sessionKey);
    this.emit(sessionKey, {
      type: "turn.completed",
      turnId,
      status: "completed",
      // Summed counters can be huge on multi-step turns; only contextTokens reflects conversation size.
      usage: {
        inputTokens: 10,
        cacheReadTokens: 900_000,
        outputTokens: 5,
        contextTokens: this.usageContextTokens,
      },
      resumeCursor: { sessionId: `native-${sessionKey}`, turns: turnId },
    });
  }
}
