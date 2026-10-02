/**
 * ACP (Agent Client Protocol) transport for the Grok Build CLI (`grok agent stdio`).
 * Uses @agentclientprotocol/sdk's ClientSideConnection over the child's stdio (NDJSON).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { type Client, ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

export interface AcpProcessOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  client: Client;
  log?: (msg: string) => void;
}

export class AcpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly conn: ClientSideConnection;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  private stderrTail = "";
  private _exited = false;

  constructor(opts: AcpProcessOptions) {
    this.child = spawn(opts.command, opts.args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    this.child.stdin.on("error", () => {});
    this.exited = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => {
        this._exited = true;
        resolve({ code, signal });
      });
      this.child.on("error", (err) => {
        this.stderrTail += `\n${err.message}`;
        this._exited = true;
        resolve({ code: null, signal: null });
      });
    });
    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    this.conn = new ClientSideConnection(() => opts.client, stream);
  }

  get isExited(): boolean {
    return this._exited;
  }

  get stderr(): string {
    return this.stderrTail;
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
}

/**
 * The npm `grok` launcher bootstraps the native binary into `$GROK_HOME/bin`; since Yo gives every
 * account its own GROK_HOME, prefer the real binary directly: explicit > YO_GROK_BIN >
 * ~/.grok/bin/grok (installer default for the container user) > `grok` on PATH.
 */
export function resolveGrokCommand(explicit?: string[]): string[] {
  if (explicit?.length) return explicit;
  const env = process.env.YO_GROK_BIN;
  if (env) return env.match(/"[^"]*"|'[^']*'|\S+/g)?.map((p) => p.replace(/^["']|["']$/g, "")) ?? [env];
  const home = process.env.HOME;
  if (home) {
    const p = join(home, ".grok", "bin", "grok");
    if (existsSync(p)) return [p];
  }
  return ["grok"];
}
