/**
 * Smoke-test client for a running agentd.
 *   YO_AGENTD_TOKEN=... pnpm --filter @yo/agentd dev-client [--agents a1,a2] [--url ws://127.0.0.1:7801]
 * Does: unauthenticated rejection check, hello, computer.ensure, computer.status, pty (echo hi && ls),
 * fs.list, screenshot(s) to /tmp/yo-shot[-<agent>].png, and a VNC bridge banner check.
 */
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const args = process.argv.slice(2);
const flag = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const BASE = flag("url", process.env.AGENTD_URL ?? "ws://127.0.0.1:7801");
const HTTP = BASE.replace(/^ws/, "http");
const AGENTS = flag("agents", "a1").split(",").filter(Boolean);
const TOKEN = process.env.YO_AGENTD_TOKEN ?? "";
if (TOKEN.length < 32) {
  console.error("YO_AGENTD_TOKEN (>=32 chars) is required");
  process.exit(2);
}

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
const say = (...a: unknown[]) => console.log(ts(), ...a);

async function checkUnauthenticated(): Promise<void> {
  const code = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`${BASE}/control`);
    ws.on("open", () =>
      ws.send(JSON.stringify({ id: "h", type: "hello", token: "x".repeat(64), coreVersion: "dev" })),
    );
    ws.on("close", (c) => resolve(c));
    ws.on("error", () => resolve(-1));
  });
  say(`unauthenticated hello -> close code ${code}`, code === 4401 ? "OK" : "UNEXPECTED");
  const status = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`${BASE}/control`, { headers: { Authorization: "Bearer wrong-token" } });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => resolve(101));
    ws.on("error", () => resolve(-1));
  });
  say(`bad bearer upgrade -> HTTP ${status}`, status === 401 ? "OK" : "UNEXPECTED");
  const shot = await fetch(`${HTTP}/screenshot/${AGENTS[0]}`);
  say(`unauthenticated /screenshot -> HTTP ${shot.status}`, shot.status === 401 ? "OK" : "UNEXPECTED");
}

class Control {
  private ws!: WebSocket;
  private n = 0;
  private waiters = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ptyData = new Map<string, string>();
  pushes: any[] = [];

  async connect(): Promise<any> {
    this.ws = new WebSocket(`${BASE}/control`);
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ok" || msg.type === "err") {
        const w = this.waiters.get(msg.re);
        this.waiters.delete(msg.re);
        if (!w) return;
        if (msg.type === "ok") w.resolve(msg.data);
        else w.reject(new Error(msg.error));
        return;
      }
      if (msg.type === "pty.data") {
        this.ptyData.set(msg.ptyId, (this.ptyData.get(msg.ptyId) ?? "") + msg.data);
        return;
      }
      this.pushes.push(msg);
      if (msg.type !== "metrics") say("push", JSON.stringify(msg));
    });
    this.ws.on("close", (code, reason) => say(`control closed ${code} ${reason}`));
    return this.req("hello", { token: TOKEN, coreVersion: "dev-client", resume: [] });
  }

  req(type: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = `r${++this.n}`;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type, ...params }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function vncBanner(agentId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/vnc/${agentId}`, ["binary"], {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const timer = setTimeout(() => reject(new Error("no banner")), 15_000);
    ws.on("message", (d: Buffer) => {
      clearTimeout(timer);
      resolve(`${d.toString("latin1").trim()} (subprotocol=${ws.protocol || "none"})`);
      ws.close();
    });
    ws.on("error", reject);
  });
}

async function main() {
  await checkUnauthenticated();

  const c = new Control();
  const hello = await c.connect();
  say("hello ->", JSON.stringify(hello));

  for (const agentId of AGENTS) {
    const t = Date.now();
    const r = await c.req("computer.ensure", { agentId });
    say(`computer.ensure ${agentId} ->`, JSON.stringify(r), `(${Date.now() - t}ms)`);
  }
  say("computer.status ->", JSON.stringify(await c.req("computer.status")));

  const agent = AGENTS[0]!;
  await c.req("pty.open", { ptyId: "p1", agentId: agent, cols: 100, rows: 30 });
  await new Promise((r) => setTimeout(r, 500));
  await c.req("pty.input", {
    ptyId: "p1",
    data: "echo hi && ls && echo DISPLAY=$DISPLAY HOME=$HOME && whoami\n",
  });
  await new Promise((r) => setTimeout(r, 1500));
  await c.req("pty.close", { ptyId: "p1" });
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g");
  say(`pty output:\n${(c.ptyData.get("p1") ?? "").replace(ansi, "")}`);

  say("fs.list ->", JSON.stringify(await c.req("fs.list", { agentId: agent, path: "" })));
  try {
    await c.req("fs.list", { agentId: agent, path: "../../../etc" });
    say("fs.list traversal -> UNEXPECTED success");
  } catch (e) {
    say("fs.list traversal -> rejected OK:", (e as Error).message);
  }

  for (const agentId of AGENTS) {
    const res = await fetch(`${HTTP}/screenshot/${agentId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const file = agentId === AGENTS[0] ? "/tmp/yo-shot.png" : `/tmp/yo-shot-${agentId}.png`;
    writeFileSync(file, buf);
    say(`screenshot ${agentId} -> HTTP ${res.status} ${buf.length} bytes -> ${file}`);
  }

  for (const agentId of AGENTS) say(`vnc ${agentId} banner ->`, await vncBanner(agentId));

  c.close();
  say("done");
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  console.error("dev-client failed:", err);
  process.exit(1);
});
