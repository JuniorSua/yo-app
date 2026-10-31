import http from "node:http";
import type { AddressInfo } from "node:net";
import { type AgentdRequest, NO_FREE_SEAT, type ProviderEvent } from "@yo/contracts";
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
  /** Script an automatic team check without changing ordinary user turns. */
  teamCheckReply?: string;
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
  /** Like YO_MAX_AWAKE_SEATS: computer.ensure for one more computer fails with NO_FREE_SEAT (0: no cap). */
  seatCap = 0;
  /** How long computer.ensure takes (a computer that's slow to wake). */
  ensureDelayMs = 0;
  /** When true, turn.interrupt is acknowledged but the provider never confirms it (until completeTurn). */
  ignoreInterrupt = false;
  /** Agents whose computer is awake (computer.ensure minus computer.hibernate / computer.discard). */
  awake = new Set<string>();
  /** Computers discarded for good (helpers that finished). */
  discarded: string[] = [];
  /** Like an agentd from before computer.discard: it refuses the request. */
  discardUnsupported = false;
  private leases = new Map<string, "agent" | "user">();
  /** When true, auth.probe reports unauthenticated until a login succeeds. */
  requireLogin = false;
  /** When set, every auth.probe answers this (e.g. a sign-in check that asked the provider's server). */
  probeResult: { status: "authenticated" | "unauthenticated"; verified?: boolean; plan?: string } | null =
    null;
  /** Play an older agentd whose Claude sign-in sent a token back with the result. */
  legacyLoginSecrets = false;
  /** How long the mock Grok device sign-in takes to be confirmed. */
  grokLoginMs = 120;
  /** Play an older agentd that only knows ChatGPT's one-time code (it refuses "codex-browser"). */
  noCodexBrowser = false;
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

  /** Emit a provider event, including replay/late-event scenarios in integration tests. */
  emit(sessionKey: string, event: ProviderEvent) {
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
        if (this.seatCap && !this.awake.has(req.agentId) && this.awake.size >= this.seatCap)
          return this.send({
            type: "err",
            re: req.id,
            error: `${this.seatCap} agent computers are already awake.`,
            code: NO_FREE_SEAT,
          });
        this.awake.add(req.agentId);
        if (this.ensureDelayMs) await new Promise((r) => setTimeout(r, this.ensureDelayMs));
        return this.ok(req.id, { state: "ready", display: 10 });
      case "computer.hibernate":
        this.awake.delete(req.agentId);
        return this.ok(req.id);
      case "computer.discard":
        // An older agentd doesn't know it (its request parser refuses the type).
        if (this.discardUnsupported)
          return this.send({
            type: "err",
            re: req.id,
            error: "invalid request: type: Invalid discriminator value",
            code: "invalid_request",
          });
        this.awake.delete(req.agentId);
        this.discarded.push(req.agentId);
        return this.ok(req.id);
      case "computer.lease":
        this.leases.set(req.agentId, req.holder);
        return this.ok(req.id);
      case "computer.status":
        return this.ok(req.id, {
          agents: this.seatCap
            ? [...this.awake].map((agentId, i) => ({
                agentId,
                state: "ready",
                display: i + 1,
                lease: this.leases.get(agentId) ?? "agent",
              }))
            : [],
          memMB: 100,
          memLimitMB: 4500,
        });
      case "auth.probe":
        if (this.probeResult)
          return this.ok(req.id, { accountId: req.accountId, provider: req.provider, ...this.probeResult });
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
          ...(req.provider === "grok" ? { label: "Grok account" } : { plan: "Claude Max" }),
        });
      case "models.list":
        return this.ok(req.id, {
          models:
            req.provider === "grok"
              ? [
                  { id: "grok-build", label: "Grok Build", isDefault: true, efforts: ["low", "high"] },
                  { id: "grok-4.3", label: "Grok 4.3" },
                ]
              : [{ id: "claude-sonnet-5-5", label: "Sonnet 5.5", isDefault: true }],
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
        if (this.steerFails && this.activeTurn.has(req.sessionKey))
          return this.send({
            type: "err",
            re: req.id,
            error: "The task ended before the message could be sent.",
          });
        this.ok(req.id);
        const text = req.input.map((p) => (p.type === "text" ? p.text : "")).join(" ");
        const active = this.activeTurn.get(req.sessionKey);
        if (this.steerMidTurn && active) {
          // Like Claude folding a mid-turn message into the running turn: it answers within that turn.
          this.steers.push({ sessionKey: req.sessionKey, turnId: req.turnId, text });
          const itemId = `steer_${req.turnId}`;
          const reply = `noted: ${text.replace(/^\[[^\]]*\d{4}[^\]]*\]\s*/, "")}`;
          this.emit(req.sessionKey, {
            type: "item.completed",
            turnId: active,
            item: { id: itemId, kind: "assistant_message", status: "completed", text: reply },
          });
          return;
        }
        void this.runTurn(req.sessionKey, req.turnId, text);
        return;
      }
      case "turn.interrupt": {
        this.ok(req.id);
        if (this.ignoreInterrupt) return;
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
        if (this.noCodexBrowser && req.method === "codex-browser")
          return this.send({
            type: "err",
            re: req.id,
            error: "invalid request: method: Invalid option",
            code: "invalid_request",
          });
        this.loginStarts++;
        this.ok(req.id);
        if (req.provider === "codex" && req.method === "codex-browser") {
          // Codex's own sign-in page; the person pastes back the address ChatGPT's page sends the browser to.
          const url = `https://auth.openai.com/oauth/authorize?redirect_uri=${encodeURIComponent("http://127.0.0.1:1455/auth/callback")}&state=s${this.loginStarts}`;
          setTimeout(
            () => this.send({ type: "auth.login.prompt", accountId: req.accountId, url, needsInput: true }),
            30,
          );
          return;
        }
        if (req.provider === "grok" || req.provider === "codex") {
          // `grok login --device-auth`: a link + code to confirm on any device; it completes on its own.
          setTimeout(
            () =>
              this.send({
                type: "auth.login.prompt",
                accountId: req.accountId,
                url:
                  req.provider === "grok"
                    ? "https://accounts.x.ai/device?user_code=WXYZ-1234"
                    : "https://auth.openai.com/codex/device",
                userCode: req.provider === "grok" ? "WXYZ-1234" : "ABCD-1234",
                needsInput: false,
              }),
            30,
          );
          setTimeout(() => {
            this.loggedIn.add(req.accountId);
            this.send({ type: "auth.login.result", accountId: req.accountId, ok: true });
          }, this.grokLoginMs);
          return;
        }
        const url = `https://claude.example/authorize?state=s${this.loginStarts}`;
        setTimeout(
          () => this.send({ type: "auth.login.prompt", accountId: req.accountId, url, needsInput: true }),
          30,
        );
        return;
      }
      case "auth.login.input": {
        this.ok(req.id);
        const good =
          req.input === `code#s${this.loginStarts}` ||
          req.input === `http://127.0.0.1:1455/auth/callback?code=good&state=s${this.loginStarts}`;
        if (good) this.loggedIn.add(req.accountId);
        setTimeout(
          () =>
            this.send({
              type: "auth.login.result",
              accountId: req.accountId,
              ok: good,
              message: good ? undefined : "Claude didn't accept that code",
              // Claude Code keeps its own sign-in on Yo's computer: nothing comes back, unless this plays an
              // older agentd that still sent a token (core must drop it).
              secrets:
                good && this.legacyLoginSecrets ? { claudeOauthToken: "sk-ant-oat01-test" } : undefined,
            }),
          30,
        );
        return;
      }
      case "fs.write": {
        // An older computer only had ~/from-mac (its request schema rejects any other folder).
        if (this.onlyFromMac && req.dir !== "from-mac")
          return this.send({
            type: "err",
            re: req.id,
            error: "invalid request: params.dir: Invalid input",
            code: "invalid_request",
          });
        this.written.push({
          agentId: req.agentId,
          dir: req.dir,
          name: req.name,
          data: Buffer.from(req.dataBase64, "base64"),
        });
        return this.ok(req.id, { path: `~/${req.dir}/${req.name}` });
      }
      case "fs.copyHome": {
        this.copies.push({ fromAgentId: req.fromAgentId, toDir: req.toDir });
        if (this.failCopy) return this.send({ type: "err", re: req.id, error: "disk full" });
        return this.ok(req.id, { dir: req.toDir, copied: 3, skipped: 1, failed: 0, bytes: 30 });
      }
      case "browser.fillLogin": {
        if (this.fillUnsupported)
          return this.send({
            type: "err",
            re: req.id,
            error: "invalid request: type: Invalid discriminator value",
            code: "invalid_request",
          });
        if (this.fillFail) return this.send({ type: "err", re: req.id, ...this.fillFail });
        const kinds = req.fields.map((f) => f.kind);
        const found = kinds.filter((k) => this.fillPage.includes(k));
        return this.ok(req.id, {
          host: this.fillHost,
          found,
          filled: req.dryRun
            ? []
            : req.fields.filter((f) => f.value && found.includes(f.kind)).map((f) => f.kind),
          submitted: !req.dryRun,
          stillOnForm: false,
        });
      }
      case "session.set":
        if (this.failSessionSet)
          return this.send({ type: "err", re: req.id, error: "the provider refused that model" });
        {
          const s = this.sessions.get(req.sessionKey);
          if (s && req.model !== undefined) s.model = req.model;
        }
        return this.ok(req.id);
      case "session.stop":
        this.sessions.delete(req.sessionKey);
        return this.ok(req.id);
      default:
        return this.ok(req.id);
    }
  }

  private activeTurn = new Map<string, string>();
  /** When true, a turn.send during a running turn is folded into it (steering), like Claude and Codex do. */
  steerMidTurn = false;
  /** When true, a turn.send during a running turn is refused (the provider couldn't take it). */
  steerFails = false;
  /** When true, session.set is refused (the provider won't change model). */
  failSessionSet = false;
  /** Messages folded into a running turn (steerMidTurn). */
  steers: { sessionKey: string; turnId: string; text: string }[] = [];
  /** Contents served from the agent's computer at /files (path -> bytes); default "file-content". */
  files = new Map<string, string>();
  /** Home folders core asked to copy into the shared folder (fs.copyHome), when an agent is folded into Yo. */
  copies: { fromAgentId: string; toDir: string }[] = [];
  /** When true, fs.copyHome fails (the copy step of the consolidation). */
  failCopy = false;
  /** Files core saved into the agent's computer (fs.write). */
  written: { agentId: string; dir: string; name: string; data: Buffer }[] = [];
  /** When true, fs.write takes only ~/from-mac, like a computer from before chat uploads. */
  onlyFromMac = false;

  /** browser.fillLogin: the sign-in page's host and which fields it shows; an agentd that doesn't know it. */
  fillHost = "github.com";
  fillPage: string[] = ["username", "password"];
  fillUnsupported = false;
  /** browser.fillLogin answers with this error (agentd's FillError: a message and a code). */
  fillFail: { error: string; code: string } | null = null;

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

  /** The provider finally reports a turn as over (e.g. a Stop confirmed late). */
  completeTurn(sessionKey: string, turnId: string, status: "completed" | "interrupted" = "interrupted") {
    if (this.activeTurn.get(sessionKey) === turnId) this.activeTurn.delete(sessionKey);
    this.emit(sessionKey, { type: "turn.completed", turnId, status });
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
    let userText = text
      .replace(/^\[[^\]]*\d{4}[^\]]*\]\s*/, "")
      .replace(/^\[Scheduled routine[^\]]*\]\s*/, "")
      .replace(/^\[(Message|Reply) from your teammate[^\]]*\]\s*/, "")
      // The task ledger line core adds when the ledger changed since the session last saw it.
      .replace(/^\[Open tasks: [^\n]*\]\n/, "")
      // And the team line, when someone joined or left (or got a new job or model) since then.
      .replace(/^\[Your team changed[^\n]*\]\n/, "");
    if (userText.startsWith("[Automatic team check") && this.teamCheckReply !== undefined)
      userText = this.teamCheckReply;
    let reply = `echo: ${userText}`;
    if (userText.startsWith("expired")) {
      // The provider turns the saved sign-in down, as the Claude/Codex adapters report it.
      const message = "Claude's sign-in has expired or was signed out, so I couldn't do this. Sign in again.";
      this.activeTurn.delete(sessionKey);
      this.emit(sessionKey, { type: "runtime.error", message, fatal: false, auth: true });
      this.emit(sessionKey, { type: "turn.completed", turnId, status: "failed", error: message });
      return;
    }
    if (/^fail \d+/.test(userText)) {
      // N browser steps that each fail (like a frozen tab timing out), then a reply.
      const n = Number(/^fail (\d+)/.exec(userText)![1]);
      for (let i = 0; i < n; i++) {
        const item = {
          id: `step_${turnId}_${i}`,
          kind: "browser" as const,
          toolName: "mcp__browser__browser_navigate",
        };
        this.emit(sessionKey, { type: "item.started", turnId, item: { ...item, status: "running" } });
        await new Promise((r) => setTimeout(r, 5));
        this.emit(sessionKey, {
          type: "item.completed",
          turnId,
          item: { ...item, status: "failed", output: "Timed out after 60s waiting for the page" },
        });
      }
      reply = "gave up";
    } else if (userText.startsWith("ask")) {
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
