/**
 * Unix-socket server used by yo-mcp shims. Protocol: line-delimited JSON.
 *   shim -> agentd: {callId, agentId, sessionKey?, tool, args}
 *   agentd -> shim: {callId, ok, text}
 * agentd forwards calls to yo-core as `tool.call` pushes and routes `tool.result` back.
 * Pending calls survive control reconnects (re-pushed after hello); they have no timeout.
 */
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { errMsg, type Logger } from "./log";

export interface ToolCall {
  callId: string;
  agentId: string;
  sessionKey?: string;
  tool: string;
  args: Record<string, unknown>;
}

interface Pending {
  call: ToolCall;
  socket: net.Socket;
}

export class ToolBridge {
  private server: net.Server | null = null;
  private pending = new Map<string, Pending>();

  constructor(
    private readonly socketPath: string,
    private readonly log: Logger,
    /** Forward to yo-core; returns false if core isn't connected (call stays pending). */
    private readonly forward: (call: ToolCall) => boolean,
  ) {}

  async listen(): Promise<void> {
    mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    rmSync(this.socketPath, { force: true });
    this.server = net.createServer((sock) => this.onConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
    chmodSync(this.socketPath, 0o600);
    this.log.info("tool bridge listening", { socket: this.socketPath });
  }

  private onConnection(sock: net.Socket): void {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > 8 * 1024 * 1024) {
        sock.destroy();
        return;
      }
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this.onLine(sock, line);
        idx = buf.indexOf("\n");
      }
    });
    sock.on("error", () => undefined);
    sock.on("close", () => {
      for (const [id, p] of this.pending) if (p.socket === sock) this.pending.delete(id);
    });
  }

  private onLine(sock: net.Socket, line: string): void {
    let msg: Partial<ToolCall>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.callId !== "string" || typeof msg.tool !== "string" || typeof msg.agentId !== "string") {
      if (typeof msg.callId === "string")
        this.write(sock, { callId: msg.callId, ok: false, text: "malformed tool call" });
      return;
    }
    const call: ToolCall = {
      callId: msg.callId,
      agentId: msg.agentId,
      sessionKey: typeof msg.sessionKey === "string" && msg.sessionKey ? msg.sessionKey : undefined,
      tool: msg.tool,
      args: msg.args && typeof msg.args === "object" ? (msg.args as Record<string, unknown>) : {},
    };
    const dup = this.pending.get(call.callId);
    this.pending.set(call.callId, { call, socket: sock });
    if (dup) return; // re-sent by a reconnecting shim; core already has it
    this.log.info("tool call", { callId: call.callId, agentId: call.agentId, tool: call.tool });
    if (!this.forward(call)) this.log.warn("core not connected; tool call queued", { callId: call.callId });
  }

  /** Resolve a pending call with core's result. Returns false if unknown. */
  resolve(callId: string, ok: boolean, text: string): boolean {
    const p = this.pending.get(callId);
    if (!p) return false;
    this.pending.delete(callId);
    this.write(p.socket, { callId, ok, text });
    return true;
  }

  pendingCalls(): ToolCall[] {
    return [...this.pending.values()].map((p) => p.call);
  }

  private write(sock: net.Socket, msg: { callId: string; ok: boolean; text: string }): void {
    try {
      sock.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      this.log.warn("tool bridge write failed", { err: errMsg(err) });
    }
  }

  close(): void {
    this.server?.close();
    rmSync(this.socketPath, { force: true });
  }
}
