/**
 * Launches the bundled YoDeviceBridge helper and talks to it over its private stdin/stdout pipes
 * (4-byte big-endian length + UTF-8 JSON). Main owns both pipes; nothing is exposed to the renderer.
 * The helper is started lazily on first use and stopped after a minute idle, so it costs nothing
 * while Yo isn't touching the Mac.
 */
import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { type HelperApi, HelperError } from "./DeviceAgent";

const MAX_FRAME = 32 * 1024 * 1024;
const IDLE_STOP_MS = 60_000;
const CALL_TIMEOUT_MS = 60_000;

export interface HelperInfo {
  version: string;
  macos: string;
  arch: string;
}

export class HelperClient implements HelperApi {
  private child: ChildProcess | null = null;
  private starting: Promise<HelperInfo> | null = null;
  private buf = Buffer.alloc(0);
  private seq = 0;
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private helloWaiter: ((frame: any) => void) | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  info: HelperInfo | null = null;

  constructor(private readonly binary: string) {}

  available(): boolean {
    try {
      fs.accessSync(this.binary, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async call(method: string, params: Record<string, unknown>): Promise<any> {
    await this.ensure();
    this.touch();
    const id = `c${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError("timeout", "helper did not answer"));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  ensure(): Promise<HelperInfo> {
    if (this.child && this.info) return Promise.resolve(this.info);
    if (!this.starting) this.starting = this.launch().finally(() => (this.starting = null));
    return this.starting;
  }

  private async launch(): Promise<HelperInfo> {
    if (!this.available()) throw new HelperError("unsupported", "Mac helper is not installed");
    // Fixed absolute path, no shell, minimal environment.
    const child = spawn(this.binary, [], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    });
    this.child = child;
    this.buf = Buffer.alloc(0);
    child.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    child.on("exit", () => this.onExit(child));
    child.stdin!.on("error", () => undefined);
    const nonce = crypto.randomBytes(16).toString("hex");
    const hello = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new HelperError("timeout", "helper did not start")), 10_000);
      this.helloWaiter = (f) => {
        clearTimeout(t);
        resolve(f);
      };
    });
    this.write({ type: "hello", nonce, protocol: 1 });
    const f = await hello;
    if (f?.type !== "hello" || f.nonce !== nonce || f.protocol !== 1) {
      child.kill();
      throw new HelperError("unsupported", "helper handshake failed");
    }
    this.info = { version: String(f.version), macos: String(f.macos), arch: String(f.arch) };
    this.touch();
    return this.info;
  }

  private write(obj: unknown) {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    if (body.length > MAX_FRAME) throw new HelperError("too_large", "request too large");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    this.child?.stdin?.write(Buffer.concat([head, body]));
  }

  private onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME) {
        this.child?.kill();
        return;
      }
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let f: any;
      try {
        f = JSON.parse(body.toString("utf8"));
      } catch {
        continue;
      }
      if (this.helloWaiter && f?.type === "hello") {
        const w = this.helloWaiter;
        this.helloWaiter = null;
        w(f);
        continue;
      }
      const p = typeof f?.id === "string" ? this.pending.get(f.id) : undefined;
      if (!p) continue;
      this.pending.delete(f.id);
      clearTimeout(p.timer);
      if (f.ok) p.resolve(f.result);
      else
        p.reject(new HelperError(String(f.error?.code ?? "io"), String(f.error?.message ?? "helper error")));
    }
  }

  private onExit(child: ChildProcess) {
    if (this.child !== child) return;
    this.child = null;
    this.info = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new HelperError("io", "helper stopped"));
    }
    this.pending.clear();
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.stop();
    }, IDLE_STOP_MS);
    this.idleTimer.unref();
  }

  stop() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const c = this.child;
    this.child = null;
    this.info = null;
    // Closing stdin makes the helper exit cleanly.
    c?.stdin?.end();
    setTimeout(() => c?.kill(), 2000).unref();
  }
}
