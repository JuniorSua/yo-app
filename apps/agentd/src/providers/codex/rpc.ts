/**
 * Minimal JSON-RPC-over-stdio (JSONL) client for `codex app-server`.
 * Codex's wire format is JSON-RPC 2.0 without the `"jsonrpc"` field:
 *   request  {"id":1,"method":"thread/start","params":{...}}
 *   response {"id":1,"result":{...}} | {"id":1,"error":{"code":-32600,"message":"..."}}
 *   notif    {"method":"turn/started","params":{...}}
 * The server also sends requests to us (approvals, user input), which we answer by id.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { errMessage } from "../shared/util";

export type RequestId = string | number;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface RpcProcessOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  log?: (msg: string) => void;
  /** Default timeout for requests (ms). */
  requestTimeoutMs?: number;
}

type NotificationHandler = (method: string, params: unknown) => void;
type ServerRequestHandler = (method: string, params: unknown, id: RequestId) => Promise<unknown>;

export class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<
    RequestId,
    { resolve(v: unknown): void; reject(e: unknown): void; timer?: NodeJS.Timeout }
  >();
  private buf = "";
  private notificationHandlers: NotificationHandler[] = [];
  private requestHandler: ServerRequestHandler | undefined;
  private exitHandlers: ((info: { code: number | null; signal: string | null; stderr: string }) => void)[] =
    [];
  private stderrTail = "";
  private _exited = false;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;

  constructor(private readonly opts: RpcProcessOptions) {
    this.child = spawn(opts.command, opts.args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => {
      const onEnd = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this._exited) return;
        this._exited = true;
        const err = new RpcError(
          `codex app-server exited (${signal ?? code})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-400)}` : ""}`,
        );
        for (const p of this.pending.values()) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        for (const h of this.exitHandlers) h({ code, signal, stderr: this.stderrTail });
        resolve({ code, signal });
      };
      this.child.on("exit", onEnd);
      this.child.on("error", (e) => {
        this.stderrTail += `\n${e.message}`;
        onEnd(null, null);
      });
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d: string) => this.onData(d));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    this.child.stdin.on("error", () => {
      // EPIPE after exit; surfaced through `exited`.
    });
  }

  get isExited(): boolean {
    return this._exited;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  onNotification(h: NotificationHandler): void {
    this.notificationHandlers.push(h);
  }

  onServerRequest(h: ServerRequestHandler): void {
    this.requestHandler = h;
  }

  onExit(h: (info: { code: number | null; signal: string | null; stderr: string }) => void): void {
    this.exitHandlers.push(h);
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this._exited) return Promise.reject(new RpcError("codex app-server is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const ms = timeoutMs ?? this.opts.requestTimeoutMs ?? 60_000;
      const timer =
        ms > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new RpcError(`${method} timed out after ${ms}ms`));
            }, ms)
          : undefined;
      timer?.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params !== undefined ? { params } : {}) });
  }

  close(): void {
    if (this._exited) return;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    this.child.kill("SIGTERM");
    const t = setTimeout(() => {
      if (!this._exited) this.child.kill("SIGKILL");
    }, 3000);
    t.unref?.();
  }

  private write(msg: unknown): void {
    if (this._exited) return;
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
      nl = this.buf.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.opts.log?.(`codex: non-JSON line: ${line.slice(0, 200)}`);
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && typeof msg.method === "string") {
      void this.handleServerRequest(msg.id as RequestId, msg.method, msg.params);
      return;
    }
    if (hasId) {
      const p = this.pending.get(msg.id as RequestId);
      if (!p) return;
      this.pending.delete(msg.id as RequestId);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error as { message?: string; code?: number; data?: unknown };
        p.reject(new RpcError(e.message ?? "codex error", e.code, e.data));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string") {
      for (const h of this.notificationHandlers) {
        try {
          h(msg.method, msg.params);
        } catch (err) {
          this.opts.log?.(`codex notification handler error: ${errMessage(err)}`);
        }
      }
    }
  }

  private async handleServerRequest(id: RequestId, method: string, params: unknown): Promise<void> {
    if (!this.requestHandler) {
      this.write({ id, error: { code: -32601, message: `unhandled ${method}` } });
      return;
    }
    try {
      const result = await this.requestHandler(method, params, id);
      this.write({ id, result });
    } catch (err) {
      this.write({
        id,
        error: { code: err instanceof RpcError && err.code ? err.code : -32000, message: errMessage(err) },
      });
    }
  }
}
