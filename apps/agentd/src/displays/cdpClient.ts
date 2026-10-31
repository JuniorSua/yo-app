/** A long-lived CDP connection to Chromium's browser target (loopback only), for agentd's own calls. */
import WebSocket from "ws";

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  closed = false;

  private constructor(
    private readonly ws: WebSocket,
    readonly port: number,
  ) {
    ws.on("message", (raw) => {
      let m: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id!);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message ?? "CDP error"));
      else p.resolve(m.result);
    });
    const fail = () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    };
    ws.on("close", fail);
    ws.on("error", fail);
  }

  static async connect(port: number, timeoutMs = 5000): Promise<CdpClient> {
    const version = (await (
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    ).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        ws.terminate(); // or a late "open" leaves a socket nobody uses or closes
        reject(new Error("CDP connect timed out"));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
    return new CdpClient(ws, port);
  }

  call<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  /** Page targets (from the HTTP list, which is cheap and needs no attach). */
  async pages(): Promise<CdpTarget[]> {
    const list = (await (
      await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(5000) })
    ).json()) as CdpTarget[];
    return list.filter((t) => t.type === "page");
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}
