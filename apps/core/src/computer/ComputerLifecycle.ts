import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { type ComputerOverview, LOCAL_COMPUTER } from "@yo/contracts";
import type { CoreConfig } from "../config";
import { logger } from "../log";
import type { SecretStore } from "../secrets/SecretStore";

const execFileP = promisify(execFile);
const log = logger("computer");

/** Built from the source checkout (compose.yaml). */
export const LOCAL_IMAGE = "yo-computer:dev";
/** Published by .github/workflows/release.yml (multi-arch). Last resort without a checkout or a pinned tag. */
export const PUBLISHED_IMAGE = "ghcr.io/juniorsua/yo-computer:latest";
const COMPOSE_PROJECT = "yo";

export interface ImagePlan {
  image: string;
  /** "build": docker compose build from the checkout. "pull": docker compose pull the published image. */
  source: "build" | "pull";
}

/**
 * Where the agent's computer image comes from. A pinned image (Yo.app public builds set
 * YO_COMPUTER_IMAGE=ghcr.io/…/yo-computer:<app version>) is pulled; otherwise a source checkout builds
 * yo-computer:dev as before (the owner's Mac, `pnpm dev`); a downloaded app without either pulls :latest.
 */
export function computerImagePlan(o: {
  computerImage: string | null;
  hasSourceCheckout: boolean;
}): ImagePlan {
  if (o.computerImage) return { image: o.computerImage, source: "pull" };
  if (o.hasSourceCheckout) return { image: LOCAL_IMAGE, source: "build" };
  return { image: PUBLISHED_IMAGE, source: "pull" };
}

/** True when `repoRoot` holds what `docker compose build` needs. */
export function hasSourceCheckout(repoRoot: string): boolean {
  return (
    fs.existsSync(path.join(repoRoot, "compose.yaml")) &&
    fs.existsSync(path.join(repoRoot, "computer", "Dockerfile"))
  );
}

/** Tags of `repo` to delete after switching to `keepTag` (older app versions' images). */
export function staleImageTags(repo: string, keepTag: string, tags: string[]): string[] {
  return tags
    .filter((t) => t && t !== keepTag && t !== "latest" && t !== "<none>")
    .map((t) => `${repo}:${t}`);
}

/** GUI-launched apps don't inherit the shell PATH; make sure Homebrew binaries are reachable. */
export function hostEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const path = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    process.env.PATH ?? "",
  ]
    .filter(Boolean)
    .join(":");
  return { ...process.env, PATH: path, ...extra };
}

/**
 * The VM's architecture: the Mac's own (vz can't emulate another one). Apple silicon reports
 * hw.optional.arm64=1 even when core itself runs under Rosetta; Intel Macs need an x86_64 VM.
 */
export async function colimaArch(
  readArm64: () => Promise<string> = async () =>
    (await execFileP("sysctl", ["-n", "hw.optional.arm64"], { env: hostEnv(), timeout: 5000 })).stdout,
  arch: string = process.arch,
): Promise<"aarch64" | "x86_64"> {
  if (arch === "arm64") return "aarch64";
  try {
    return (await readArm64()).trim() === "1" ? "aarch64" : "x86_64";
  } catch {
    return "x86_64";
  }
}

export async function getAgentdToken(secrets: SecretStore): Promise<string> {
  let token = await secrets.get("agentd-token");
  if (!token) {
    token = randomBytes(32).toString("hex");
    await secrets.set("agentd-token", token);
  }
  return token;
}

type Runtime = ComputerOverview["runtime"];

/**
 * Manages the local container runtime (Colima VM + docker compose) that hosts `yo-computer`.
 * In remote mode it does nothing but report connectivity.
 */
export class ComputerLifecycle extends EventEmitter<{ changed: [] }> {
  runtime: Runtime = "stopped";
  message: string | null = null;
  imageReady = false;
  readonly plan: ImagePlan;
  private starting: Promise<void> | null = null;
  private dockerEnv: NodeJS.ProcessEnv;

  constructor(
    private cfg: CoreConfig,
    private token: string,
  ) {
    super();
    this.plan = computerImagePlan({
      computerImage: cfg.computerImage,
      hasSourceCheckout: cfg.computerMode === "local" && hasSourceCheckout(cfg.repoRoot),
    });
    // compose.runtime.yaml runs ${YO_COMPUTER_IMAGE:-yo-computer:dev}.
    this.dockerEnv = hostEnv({
      DOCKER_CONTEXT: `colima-${cfg.colimaProfile}`,
      YO_AGENTD_TOKEN: token,
      YO_COMPUTER_IMAGE: this.plan.image,
    });
  }

  private set(runtime: Runtime, message: string | null = null) {
    this.runtime = runtime;
    this.message = message;
    this.emit("changed");
  }

  private async exec(cmd: string, args: string[], timeoutMs = 120000) {
    return execFileP(cmd, args, {
      env: this.dockerEnv,
      cwd: this.cfg.dataDir,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  /** `docker compose` args for runtime operations (up/ps/stop) — no source checkout needed. */
  private compose(...args: string[]) {
    return ["compose", "-p", COMPOSE_PROJECT, "-f", this.cfg.composeFile, ...args];
  }

  /** `docker compose` args for building the image — needs the source checkout. */
  private composeBuild(...args: string[]) {
    return ["compose", "-p", COMPOSE_PROJECT, "-f", path.join(this.cfg.repoRoot, "compose.yaml"), ...args];
  }

  async hasBinary(name: string): Promise<boolean> {
    try {
      await execFileP("/usr/bin/which", [name], { env: hostEnv() });
      return true;
    } catch {
      return false;
    }
  }

  async refresh(): Promise<void> {
    if (this.cfg.computerMode === "remote") return;
    if (this.starting) return;
    if (!(await this.hasBinary("colima")) || !(await this.hasBinary("docker"))) {
      this.set("missing", "Colima/Docker CLI not installed (brew install colima docker docker-compose)");
      return;
    }
    const vmRunning = await this.vmRunning();
    if (!vmRunning) {
      this.set("stopped");
      return;
    }
    this.imageReady = await this.imageExists();
    const up = await this.containerRunning();
    this.set(up ? "running" : "stopped");
  }

  private async vmRunning(): Promise<boolean> {
    try {
      await this.exec("colima", ["status", "--profile", this.cfg.colimaProfile], 20000);
      return true;
    } catch {
      return false;
    }
  }

  private async imageExists(): Promise<boolean> {
    try {
      await this.exec("docker", ["image", "inspect", this.plan.image], 20000);
      return true;
    } catch {
      return false;
    }
  }

  private async containerRunning(): Promise<boolean> {
    try {
      const { stdout } = await this.exec(
        "docker",
        this.compose("ps", "--status", "running", "-q", "yo-computer"),
        20000,
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Start VM (if needed), build image (if needed), and bring up the computer container. Idempotent. */
  start(): Promise<void> {
    if (this.cfg.computerMode === "remote") return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart() {
    try {
      if (!(await this.hasBinary("colima")))
        throw new Error("Colima is not installed. Run: brew install colima docker docker-compose");
      if (!(await this.vmRunning())) {
        this.set("starting", "Starting Yo's computer (virtual machine)…");
        await this.exec(
          "colima",
          [
            "start",
            "--profile",
            this.cfg.colimaProfile,
            "--cpu",
            String(LOCAL_COMPUTER.vmCpus),
            "--memory",
            String(LOCAL_COMPUTER.vmMemoryGB),
            "--disk",
            String(LOCAL_COMPUTER.vmDiskGB),
            "--vm-type",
            "vz",
            "--arch",
            await colimaArch(),
          ],
          300000,
        );
      }
      this.imageReady = await this.imageExists();
      if (!this.imageReady) {
        await this.getImage();
        this.imageReady = true;
      }
      this.set("starting", "Booting Yo's computer…");
      await this.exec("docker", this.compose("up", "-d", "yo-computer"), 180000);
      this.set("running");
      if (this.plan.source === "pull") void this.pruneOldImages();
    } catch (err: any) {
      log.error("start failed", err);
      this.set("error", String(err?.stderr || err?.message || err).slice(0, 400));
      throw err;
    }
  }

  /** Build or download the image, per the plan. */
  private async getImage() {
    if (this.plan.source === "pull") {
      this.set("starting", "Downloading Yo's computer (first run takes a few minutes)…");
      await this.streamed("docker", this.compose("pull", "yo-computer"), 1800000);
    } else {
      this.set("starting", "Building Yo's computer (first run takes a few minutes)…");
      await this.streamed("docker", this.composeBuild("build", "yo-computer"), 1800000);
    }
  }

  /** After an app update the computer runs a new tag: drop the old versions' images (best effort). */
  private async pruneOldImages() {
    const i = this.plan.image.lastIndexOf(":");
    if (i <= this.plan.image.lastIndexOf("/")) return;
    const repo = this.plan.image.slice(0, i);
    try {
      const { stdout } = await this.exec("docker", ["image", "ls", repo, "--format", "{{.Tag}}"], 20000);
      const stale = staleImageTags(
        repo,
        this.plan.image.slice(i + 1),
        stdout.split("\n").map((t) => t.trim()),
      );
      if (stale.length) await this.exec("docker", ["image", "rm", ...stale], 120000);
    } catch (err) {
      log.debug("old image cleanup skipped", err);
    }
  }

  /** Rebuild (or re-download) the image, e.g. after an update, and recreate the container. */
  async rebuild() {
    this.set("starting", "Rebuilding Yo's computer…");
    if (this.plan.source === "pull")
      await this.streamed("docker", this.compose("pull", "yo-computer"), 1800000);
    else await this.streamed("docker", this.composeBuild("build", "yo-computer"), 1800000);
    await this.exec("docker", this.compose("up", "-d", "--force-recreate", "yo-computer"), 180000);
    this.set("running");
  }

  async stop(opts: { vm?: boolean } = { vm: true }) {
    if (this.cfg.computerMode === "remote") return;
    try {
      await this.exec("docker", this.compose("stop", "yo-computer"), 60000).catch(() => {});
      if (opts.vm) await this.exec("colima", ["stop", "--profile", this.cfg.colimaProfile], 120000);
      this.set("stopped");
    } catch (err: any) {
      this.set("error", String(err?.message ?? err));
    }
  }

  private streamed(cmd: string, args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { env: this.dockerEnv, cwd: this.cfg.dataDir });
      let tail = "";
      const onData = (d: Buffer) => {
        tail = (tail + d.toString()).slice(-4000);
        const line = d.toString().trim().split("\n").pop();
        if (line) log.debug(line);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const t = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.on("exit", (code) => {
        clearTimeout(t);
        if (code === 0) resolve();
        else reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${tail.slice(-800)}`));
      });
      child.on("error", reject);
    });
  }
}
