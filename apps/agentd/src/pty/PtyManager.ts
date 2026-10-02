/** Interactive terminals: bash login shells in the agent's home, attached to its display. */
import type { IPty } from "node-pty";
import * as nodePty from "node-pty";
import { scrubEnv } from "../auth";
import { ensureAgentHome } from "../fs";
import { errMsg, type Logger } from "../log";

export interface PtySink {
  data(ptyId: string, data: string): void;
  exit(ptyId: string, code: number | null): void;
}

const clampDim = (n: number, max: number) => Math.max(1, Math.min(max, Math.floor(n) || 1));

export class PtyManager {
  private ptys = new Map<string, { pty: IPty; agentId: string }>();

  constructor(
    private readonly log: Logger,
    private readonly sink: PtySink,
    private readonly envFor: (agentId: string) => Record<string, string>,
  ) {}

  async open(ptyId: string, agentId: string, cols: number, rows: number): Promise<void> {
    if (this.ptys.has(ptyId)) throw new Error(`pty ${ptyId} already open`);
    const home = await ensureAgentHome(agentId);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(scrubEnv(process.env))) if (typeof v === "string") env[k] = v;
    Object.assign(env, this.envFor(agentId), {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG ?? "C.UTF-8",
      SHELL: "/bin/bash",
    });
    const pty = nodePty.spawn("/bin/bash", ["-l"], {
      name: "xterm-256color",
      cols: clampDim(cols, 1000),
      rows: clampDim(rows, 500),
      cwd: home,
      env,
    });
    this.ptys.set(ptyId, { pty, agentId });
    pty.onData((d) => this.sink.data(ptyId, d));
    pty.onExit(({ exitCode }) => {
      this.ptys.delete(ptyId);
      this.sink.exit(ptyId, exitCode ?? null);
    });
    this.log.info("pty opened", { ptyId, agentId, pid: pty.pid });
  }

  input(ptyId: string, data: string): void {
    this.req(ptyId).pty.write(data);
  }

  resize(ptyId: string, cols: number, rows: number): void {
    this.req(ptyId).pty.resize(clampDim(cols, 1000), clampDim(rows, 500));
  }

  close(ptyId: string): void {
    const p = this.ptys.get(ptyId);
    if (!p) return;
    try {
      p.pty.kill("SIGHUP");
    } catch (err) {
      this.log.warn("pty kill failed", { ptyId, err: errMsg(err) });
    }
  }

  closeAll(): void {
    for (const id of [...this.ptys.keys()]) this.close(id);
  }

  private req(ptyId: string) {
    const p = this.ptys.get(ptyId);
    if (!p) throw new Error(`unknown pty ${ptyId}`);
    return p;
  }
}
