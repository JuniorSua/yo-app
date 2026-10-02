/**
 * yo-mcp: stdio MCP server exposing Yo's own tools (YO_TOOLS) to any provider CLI.
 * Each call is forwarded over agentd's unix socket (YO_SOCKET, line-delimited JSON) and relayed to yo-core.
 * Calls may block for a long time (ask_user / request_approval / request_takeover), so there is no timeout;
 * progress notifications are sent periodically when the client supplied a progressToken.
 *
 * Env: YO_AGENT_ID, YO_SESSION_KEY, YO_SOCKET
 */
import { randomUUID } from "node:crypto";
import net from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { YO_TOOLS } from "@yo/contracts";

const AGENT_ID = process.env.YO_AGENT_ID ?? "";
const SESSION_KEY = process.env.YO_SESSION_KEY ?? "";
const SOCKET = process.env.YO_SOCKET ?? "/tmp/yo/agentd.sock";

const log = (msg: string) => process.stderr.write(`[yo-mcp] ${msg}\n`);

type Result = { ok: boolean; text: string };

class BridgeClient {
  private sock: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private pending = new Map<string, { resolve: (r: Result) => void; payload: string }>();
  private buf = "";

  private connect(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(SOCKET);
      s.setEncoding("utf8");
      s.once("connect", () => {
        this.sock = s;
        this.connecting = null;
        // Send every pending call: new ones, and ones in flight on a previous connection (agentd restarted).
        for (const p of this.pending.values()) s.write(p.payload);
        resolve(s);
      });
      s.once("error", (err) => {
        this.connecting = null;
        reject(err);
      });
      s.on("data", (chunk: string) => this.onData(chunk));
      s.on("close", () => {
        if (this.sock === s) this.sock = null;
        if (this.pending.size > 0) setTimeout(() => void this.reconnect(), 1000);
      });
    });
    return this.connecting;
  }

  private async reconnect(): Promise<void> {
    for (let attempt = 0; this.pending.size > 0; attempt++) {
      try {
        await this.connect();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** attempt)));
      }
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx = this.buf.indexOf("\n");
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      idx = this.buf.indexOf("\n");
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { callId: string; ok: boolean; text: string };
        const p = this.pending.get(msg.callId);
        if (p) {
          this.pending.delete(msg.callId);
          p.resolve({ ok: !!msg.ok, text: String(msg.text ?? "") });
        }
      } catch {
        // ignore malformed
      }
    }
  }

  async call(tool: string, args: Record<string, unknown>): Promise<Result> {
    const callId = `tc_${randomUUID()}`;
    const payload = `${JSON.stringify({ callId, agentId: AGENT_ID, sessionKey: SESSION_KEY, tool, args })}\n`;
    return new Promise<Result>((resolve) => {
      this.pending.set(callId, { resolve, payload });
      if (this.sock && !this.sock.destroyed) {
        this.sock.write(payload);
        return;
      }
      // A fresh connection flushes every pending call (including this one).
      this.connect().catch((err) => {
        log(`agentd socket unavailable: ${err.message}; retrying`);
        void this.reconnect();
      });
    });
  }
}

const bridge = new BridgeClient();

const server = new Server({ name: "yo", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: YO_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as never,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name } = req.params;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  if (!YO_TOOLS.some((t) => t.name === name)) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
  const progressToken = req.params._meta?.progressToken;
  let tick = 0;
  const heartbeat =
    progressToken !== undefined
      ? setInterval(() => {
          tick++;
          extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: tick, message: "waiting for the user" },
            })
            .catch(() => undefined);
        }, 20_000)
      : null;
  try {
    const r = await bridge.call(name, args);
    return { isError: !r.ok, content: [{ type: "text", text: r.text }] };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
});

await server.connect(new StdioServerTransport());
log(`ready (agent=${AGENT_ID} session=${SESSION_KEY})`);
