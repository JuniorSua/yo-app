import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { AGENTD_PORT, type ComputerOverview, LOCAL_COMPUTER, localTimeZone } from "@yo/contracts";
import type { CoreConfig } from "../config";
import { logger } from "../log";
import type { SecretStore } from "../secrets/SecretStore";
import {
  bundledRootFromEnv,
  chooseVmHome,
  defaultSupportDir,
  ensureComposeLink,
  ensureDockerContext,
  ensureVmDirs,
  hostHome,
  keepUnsetLegacyVm,
  launchEnv,
  legacyVmSplit,
  resolveTools,
  resolveVmHome,
  VM_CHOICE_NEEDED,
} from "./hostTools";

const execFileP = promisify(execFile);
const log = logger("computer");

/** Built from the source checkout (compose.yaml). */
export const LOCAL_IMAGE = "yo-computer:dev";
/** Published by .github/workflows/release.yml (multi-arch). Last resort without a checkout or a pinned tag. */
export const PUBLISHED_IMAGE = "ghcr.io/juniorsua/yo-computer:latest";
const COMPOSE_PROJECT = "yo";
/**
 * Downloading and unpacking the image (~0.75 GB, ~2.7 GB unpacked). Measured 23.5 min on a very busy Mac, so 30
 * minutes was too close: a slow line or a busy Mac would be cut off mid-way and start over.
 */
const PULL_TIMEOUT_MS = 60 * 60 * 1000;

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

/**
 * GUI-launched apps don't inherit the shell PATH. Bundled tools (when Yo.app shipped them) come
 * first, then Homebrew. COLIMA_HOME, LIMA_HOME and DOCKER_CONFIG point at Yo's own folder, or at
 * ~/.colima when the person chose to keep an existing VM there.
 */
export function hostEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return launchEnv({
    dataDir: process.env.YO_DATA_DIR || defaultSupportDir(),
    homeDir: hostHome(),
    profile: process.env.YO_COLIMA_PROFILE || "yo",
    bundledRoot: bundledRootFromEnv(),
    extra,
  });
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

/**
 * `--mount none` when this Colima understands it (0.10.0 and later), else nothing.
 *
 * With no `--mount`, Colima mounts the whole Mac home folder into the VM, writable (virtiofs on vz):
 * an empty `mounts` list means "~ writable" (colima v0.10.3 environment/vm/lima/yaml.go, and the
 * colima.yaml template's "Colima default behaviour: $HOME is mounted as writable"). Yo needs no host
 * path in the VM: it talks to Docker over the socket, the build context and image pulls go through
 * that API, and the agent's container only has its own `yo-data` volume. So the VM gets no mounts.
 * The flag is passed on every start, so it also wins over a saved colima.yaml, and Colima rewrites
 * the Lima config from it each time a stopped VM starts.
 *
 * Before 0.10.0 "none" was read as a folder called "none", so an older Colima (a Homebrew
 * development build) keeps its old behaviour rather than failing to start.
 */
export function colimaNoMountArgs(versionOutput: string): string[] {
  const m = /colima version v?(\d+)\.(\d+)\./i.exec(versionOutput);
  if (!m) return [];
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 0 || minor >= 10 ? ["--mount", "none"] : [];
}

/**
 * Host port core uses for agentd (`YO_AGENTD_URL`). compose.runtime.yaml publishes
 * `127.0.0.1:${YO_AGENTD_PORT:-7801}:7801`, so a configured port still reaches the container (it keeps
 * listening on 7801). A URL with no port, or one that isn't a URL, stays on 7801.
 */
export function agentdListenPort(agentdUrl: string): number {
  try {
    const n = Number(new URL(agentdUrl).port);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  } catch {
    /* fall through */
  }
  return AGENTD_PORT;
}

/**
 * Environment for `docker compose` on this Mac. compose.runtime.yaml runs ${YO_COMPUTER_IMAGE:-yo-computer:dev}
 * with TZ=${YO_TZ:-America/New_York}: give the computer the Mac's own time zone, so its clock, browser and
 * files agree with the user's. YO_AGENTD_PORT is the host port core connects to (7801 when unset).
 */
export function computerDockerEnv(o: {
  colimaProfile: string;
  token: string;
  image: string;
  timeZone?: string | null;
  dataDir?: string;
  homeDir?: string;
  bundledRoot?: string | null;
  /** Host port published for agentd. Defaults to 7801, matching compose when YO_AGENTD_PORT is unset. */
  agentdPort?: number;
}): NodeJS.ProcessEnv {
  const tz = process.env.YO_TZ || (o.timeZone === undefined ? localTimeZone() : o.timeZone);
  const port = o.agentdPort ?? AGENTD_PORT;
  return launchEnv({
    dataDir: o.dataDir || process.env.YO_DATA_DIR || defaultSupportDir(),
    homeDir: o.homeDir || hostHome(),
    profile: o.colimaProfile,
    bundledRoot: o.bundledRoot === undefined ? bundledRootFromEnv() : o.bundledRoot,
    extra: {
      DOCKER_CONTEXT: `colima-${o.colimaProfile}`,
      YO_AGENTD_TOKEN: o.token,
      YO_COMPUTER_IMAGE: o.image,
      YO_AGENTD_PORT: String(port >= 1 && port <= 65535 ? port : AGENTD_PORT),
      ...(tz ? { YO_TZ: tz } : {}),
    },
  });
}

export async function getAgentdToken(secrets: SecretStore): Promise<string> {
  let token = await secrets.get("agentd-token");
  if (!token) {
    token = randomBytes(32).toString("hex");
    await secrets.set("agentd-token", token);
  }
  return token;
}

async function defaultHasBinary(name: string): Promise<boolean> {
  try {
    await execFileP("/usr/bin/which", [name], { env: hostEnv() });
    return true;
  } catch {
    return false;
  }
}

/** Runs a host command (colima, docker) and resolves with its output; rejects like execFile does. */
export type HostExec = (cmd: string, args: string[], timeoutMs: number) => Promise<{ stdout: string }>;

const TOO_SLOW =
  "Starting my computer took too long. Your Mac may be busy: close a few apps, then press Try again.";

/** A sentence a person can act on, by what the raw error says. Checked in order: the first hit wins. */
const START_ERRORS: [RegExp, string][] = [
  [
    /no space left on device|not enough (?:disk )?space|disk quota exceeded/i,
    "Your Mac is out of disk space. Free up about 10 GB (empty the Trash, remove big downloads), then press Try again.",
  ],
  [
    /unknown command: docker compose|'compose' is not a docker command/i,
    'Docker Compose isn\'t turned on yet. Do the "Turn on Docker Compose" step in the setup chat, then press Try again.',
  ],
  [
    /colima is not installed|spawn colima ENOENT/i,
    "Colima isn't available. Reinstall Yo (it includes Colima), or for a development build run: brew install colima docker docker-compose. Then press Try again.",
  ],
  [
    /spawn docker ENOENT|docker: command not found|docker cli is not installed/i,
    "Docker isn't available. Reinstall Yo (it includes Docker), or for a development build run: brew install docker docker-compose. Then press Try again.",
  ],
  [/existing computer in ~\/\.colima/i, VM_CHOICE_NEEDED],
  [
    /manifest unknown|manifest for \S+ not found|repository does not exist|pull access denied/i,
    "I couldn't find my computer's download for this version of Yo. Check for a Yo update, then press Try again.",
  ],
  [
    /toomanyrequests|rate limit/i,
    "The download server is busy right now. Wait a few minutes, then press Try again.",
  ],
  [
    /no such host|dial tcp|i\/o timeout|tls handshake timeout|connection reset by peer.*(?:ghcr|registry|blob)|network is unreachable|unexpected eof|context deadline exceeded|temporary failure in name resolution|failed to download|error downloading/i,
    "I couldn't download my computer. Check that this Mac is online (and that a VPN or firewall isn't blocking it), then press Try again. What's already downloaded is kept.",
  ],
  [
    /port is already allocated|address already in use/i,
    "Another app is using the port my computer needs (7801). Quit other copies of Yo or anything else using it, then press Try again.",
  ],
  [
    /virtualization is not (?:available|supported)|vz is not supported|requires macos 13/i,
    "This Mac can't run the small virtual machine my computer needs (it needs macOS 13 or later).",
  ],
  [/timed out|took too long/i, TOO_SLOW],
];

/**
 * What the setup chat and Settings show when the computer didn't start: one plain sentence the user can act on,
 * never a wall of colima/docker log lines (those stay in core.log, which bug reports include).
 */
export function friendlyStartError(err: unknown): string {
  const e = (typeof err === "object" ? err : null) as {
    stderr?: unknown;
    message?: unknown;
    killed?: boolean;
  } | null;
  // execFile's own timeout kills the command.
  if (e?.killed) return TOO_SLOW;
  const raw = [e?.stderr, e?.message, typeof err === "string" ? err : ""]
    .filter((x): x is string => typeof x === "string")
    .join("\n");
  for (const [re, text] of START_ERRORS) if (re.test(raw)) return text;
  return "My computer didn't start. Press Try again. If it keeps happening, quit and reopen Yo, or send us a bug report so we can look at the details.";
}

const UNIT: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9 };

/**
 * Reads `docker compose pull`'s plain output ("<layer> Downloading 12.58MB", "<layer> Download complete",
 * "<layer> Extracting 3.1MB", "<layer> Pull complete") into how much has been downloaded so far.
 */
export class PullProgress {
  private layers = new Map<string, number>();
  /** Layers still to download. Docker unpacks the first layers while later ones are still downloading. */
  private pending = new Set<string>();
  private extracting = false;

  /** All downloads finished and Docker is unpacking. */
  get unpacking(): boolean {
    return this.extracting && this.pending.size === 0;
  }

  /** True when the line changed something worth showing. */
  add(line: string): boolean {
    const m = line
      .trim()
      .match(
        /^([0-9a-f]{12})\s+(Pulling fs layer|Waiting|Downloading|Download complete|Already exists|Extracting|Pull complete)\b\s*(?:([\d.]+)\s*([kKMG]?B)\b)?/,
      );
    if (!m) return false;
    const [, id, what, num, unit] = m as unknown as [string, string, string, string?, string?];
    const wasUnpacking = this.unpacking;
    if (what === "Pulling fs layer" || what === "Waiting") this.pending.add(id);
    else if (what === "Download complete" || what === "Already exists" || what === "Pull complete")
      this.pending.delete(id);
    else if (what === "Extracting") this.extracting = true;
    else if (what === "Downloading" && num) {
      this.pending.add(id);
      const bytes = Number(num) * (UNIT[unit ?? "B"] ?? 1);
      if (bytes > (this.layers.get(id) ?? 0)) {
        this.layers.set(id, bytes);
        return true;
      }
    }
    return this.unpacking !== wasUnpacking;
  }

  get bytes(): number {
    let sum = 0;
    for (const b of this.layers.values()) sum += b;
    return sum;
  }
}

type Runtime = ComputerOverview["runtime"];

/** The status line while the watchdog restarts a computer that stopped answering (ComputerWatchdog). */
export const RECONNECTING = "Reconnecting to Yo's computer…";

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
  /** A repair is running: its steps all show RECONNECTING. */
  private repairing = false;
  private dockerEnv: NodeJS.ProcessEnv;

  private readonly run: HostExec;
  private readonly which: (name: string) => Promise<boolean>;

  constructor(
    private cfg: CoreConfig,
    private token: string,
    /** Tests replace the host commands. */
    deps: { exec?: HostExec; hasBinary?: (name: string) => Promise<boolean> } = {},
  ) {
    super();
    this.run =
      deps.exec ??
      ((cmd, args, timeoutMs) =>
        execFileP(cmd, args, {
          env: this.dockerEnv,
          cwd: this.cfg.dataDir,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        }));
    this.which = deps.hasBinary ?? defaultHasBinary;
    this.plan = computerImagePlan({
      computerImage: cfg.computerImage,
      hasSourceCheckout: cfg.computerMode === "local" && hasSourceCheckout(cfg.repoRoot),
    });
    this.dockerEnv = this.toolEnv();
  }

  /** Re-read the bundled tools and the VM-folder choice. The setup chat can change the choice while core runs. */
  private toolEnv(): NodeJS.ProcessEnv {
    return computerDockerEnv({
      colimaProfile: this.cfg.colimaProfile,
      token: this.token,
      image: this.plan.image,
      dataDir: this.cfg.dataDir,
      homeDir: hostHome(),
      bundledRoot: bundledRootFromEnv(),
      agentdPort: agentdListenPort(this.cfg.agentdUrl),
    });
  }

  private prepareVm() {
    this.dockerEnv = this.toolEnv();
    const where = {
      dataDir: this.cfg.dataDir,
      homeDir: hostHome(),
      profile: this.cfg.colimaProfile,
    };
    // A Move that stopped before the Docker disk (Colima 0.10's _disks/<instance>) would boot an
    // empty Docker. The person already chose Move, so finish the pieces still in ~/.colima.
    let vm = resolveVmHome(where);
    if (vm.choice === "move" && legacyVmSplit(where)) vm = chooseVmHome({ ...where, choice: "move" });
    // No saved choice and a VM already in ~/.colima. Asking in the setup chat locks anyone whose
    // setup is already finished, so Keep is recorded here and Start continues. Move is in Settings.
    if (vm.state === "choose") vm = keepUnsetLegacyVm(where);
    if (vm.state === "choose") throw new Error(VM_CHOICE_NEEDED);
    ensureVmDirs(vm);
    const tools = resolveTools({
      bundledRoot: bundledRootFromEnv(),
      homeDir: hostHome(),
    });
    ensureComposeLink(vm.dockerConfig, tools.compose);
    return vm;
  }

  private set(runtime: Runtime, message: string | null = null) {
    this.runtime = runtime;
    this.message = this.repairing && runtime === "starting" ? RECONNECTING : message;
    this.emit("changed");
  }

  /** Starting, rebuilding or repairing right now. */
  get busy(): boolean {
    return !!this.starting;
  }

  private exec(cmd: string, args: string[], timeoutMs = 120000) {
    return this.run(cmd, args, timeoutMs);
  }

  /** `docker compose` args for runtime operations (up/ps/stop) — no source checkout needed. */
  private compose(...args: string[]) {
    return ["compose", "-p", COMPOSE_PROJECT, "-f", this.cfg.composeFile, ...args];
  }

  /** `docker compose` args for building the image — needs the source checkout. */
  private composeBuild(...args: string[]) {
    return ["compose", "-p", COMPOSE_PROJECT, "-f", path.join(this.cfg.repoRoot, "compose.yaml"), ...args];
  }

  hasBinary(name: string): Promise<boolean> {
    return this.which(name);
  }

  async refresh(): Promise<void> {
    if (this.cfg.computerMode === "remote") return;
    if (this.starting) return;
    this.dockerEnv = this.toolEnv();
    if (!(await this.hasBinary("colima")) || !(await this.hasBinary("docker"))) {
      this.set(
        "missing",
        "Colima and Docker aren't available. Reinstall Yo, or for a development build run: brew install colima docker docker-compose.",
      );
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

  /** See colimaNoMountArgs. A failed `colima version` leaves the args as they were. */
  private async noMountArgs(): Promise<string[]> {
    let out = "";
    try {
      out = String((await this.exec("colima", ["version"], 20000)).stdout ?? "");
    } catch (err: any) {
      // `colima version` can exit non-zero after printing the version (no running default VM).
      out = String(err?.stdout ?? "");
    }
    const args = colimaNoMountArgs(out);
    if (args.length === 0)
      log.warn(
        "Colima is older than 0.10 (or its version is unknown): the VM keeps Colima's default home-folder mount",
      );
    return args;
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
      // "Try again" after a failure: drop the old error right away (the checks below can take a while).
      if (this.runtime === "error") this.set("starting", "Starting Yo's computer…");
      const vm = this.prepareVm();
      if (!(await this.hasBinary("colima"))) throw new Error("Colima is not installed");
      if (!(await this.hasBinary("docker"))) throw new Error("The Docker CLI is not installed");
      if (!(await this.vmRunning())) await this.startVm();
      await ensureDockerContext({
        run: (args) => this.exec("docker", args, 20_000),
        context: vm.profileId,
        socketPath: vm.socketPath,
      });
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
      this.set("error", friendlyStartError(err));
      throw err;
    }
  }

  /**
   * `colima start`, then make sure the VM really is up. A first boot on a busy Mac can end "degraded" (Lima's
   * guest agent answers late): colima exits 1 with the VM running but Docker never set up, and every later
   * `colima start` says "already running" without fixing it, so "Try again" could never recover. A crash, a force
   * quit or quitting Yo mid-start can leave the same half-started VM. So when the first try fails, force-stop the
   * VM and start it once more.
   */
  private async startVm() {
    this.set("starting", "Starting Yo's computer (virtual machine)…");
    const args = [
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
      // Yo reaches the VM through the Docker socket. Colima's default writes
      // `Include <COLIMA_HOME>/ssh_config` into ~/.ssh/config with no quotes, and a space in
      // "Application Support" makes sshd ignore the rest of the file. Passing the flag marks it
      // set, so a saved colima.yaml cannot turn it back on. Yo does not edit ~/.ssh/config itself.
      "--ssh-config=false",
      // No Mac folders inside the VM: Colima's default mounts the whole home folder, writable.
      ...(await this.noMountArgs()),
    ];
    const attempt = async () => {
      // The very first start downloads the VM's disk image (a few hundred MB): give slow connections time.
      await this.exec("colima", args, 20 * 60 * 1000);
      if (!(await this.vmRunning())) throw new Error("colima start finished but colima status still fails");
    };
    try {
      await attempt();
    } catch (err: any) {
      // Timed out after 20 minutes: a second try would only double the wait.
      if (err?.killed) throw err;
      log.warn("colima start failed; force-stopping the VM and trying once more", err);
      this.set("starting", "Restarting Yo's computer (the first try didn't finish)…");
      await this.exec("colima", ["stop", "--force", "--profile", this.cfg.colimaProfile], 120000).catch((e) =>
        log.warn("colima stop --force failed", e),
      );
      await attempt();
    }
  }

  /**
   * The computer is up as far as Colima knows, but Yo can't reach it (typically after the Mac slept and woke and
   * the VM's network didn't come back). Same as Settings → Computer → Stop, then Start: force-stop the VM, then
   * the normal start (which itself retries a half-started VM once). The status line says "Reconnecting…" all along.
   */
  repair(): Promise<void> {
    if (this.cfg.computerMode === "remote") return Promise.resolve();
    if (this.starting) return this.starting;
    this.repairing = true;
    this.starting = (async () => {
      this.dockerEnv = this.toolEnv();
      this.set("starting", RECONNECTING);
      await this.exec("colima", ["stop", "--force", "--profile", this.cfg.colimaProfile], 120000).catch((e) =>
        log.warn("colima stop --force failed", e),
      );
      await this.doStart();
    })().finally(() => {
      this.starting = null;
      this.repairing = false;
    });
    return this.starting;
  }

  /** Build or download the image, per the plan. */
  private async getImage() {
    if (this.plan.source === "pull") {
      this.set("starting", "Downloading Yo's computer (first run takes a few minutes)…");
      await this.pullWithProgress();
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
      await this.streamed("docker", this.compose("pull", "yo-computer"), PULL_TIMEOUT_MS);
    else await this.streamed("docker", this.composeBuild("build", "yo-computer"), 1800000);
    await this.exec("docker", this.compose("up", "-d", "--force-recreate", "yo-computer"), 180000);
    this.set("running");
  }

  async stop(opts: { vm?: boolean } = { vm: true }) {
    if (this.cfg.computerMode === "remote") return;
    this.dockerEnv = this.toolEnv();
    try {
      await this.exec("docker", this.compose("stop", "yo-computer"), 60000).catch(() => {});
      if (opts.vm) await this.exec("colima", ["stop", "--profile", this.cfg.colimaProfile], 120000);
      this.set("stopped");
    } catch (err: any) {
      this.set("error", String(err?.message ?? err));
    }
  }

  private streamed(
    cmd: string,
    args: string[],
    timeoutMs: number,
    onLine?: (line: string) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { env: this.dockerEnv, cwd: this.cfg.dataDir });
      let tail = "";
      let timedOut = false;
      const onData = (d: Buffer) => {
        const text = d.toString();
        tail = (tail + text).slice(-4000);
        const lines = text.trim().split("\n");
        const last = lines[lines.length - 1];
        if (last) log.debug(last);
        if (onLine) for (const l of lines) onLine(l);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const t = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      child.on("exit", (code) => {
        clearTimeout(t);
        if (code === 0) return resolve();
        const err = new Error(`${cmd} ${args.join(" ")} failed (${code}): ${tail.slice(-800)}`);
        reject(timedOut ? Object.assign(err, { killed: true }) : err);
      });
      child.on("error", reject);
    });
  }

  /** `docker compose pull` with the amount downloaded so far in the setup chat's status line. */
  private pullWithProgress(): Promise<void> {
    const progress = new PullProgress();
    let shown = -1;
    let unpacking = false;
    const show = () => {
      if (progress.unpacking) {
        if (!unpacking) this.set("starting", "Unpacking Yo's computer (almost there)…");
        unpacking = true;
        return;
      }
      const mb = Math.floor(progress.bytes / 1e6);
      // Every 10 MB is plenty for the eye, and keeps the UI from re-rendering on every line.
      if (mb - shown < 10) return;
      shown = mb;
      this.set("starting", `Downloading Yo's computer: ${mb} MB so far…`);
    };
    return this.streamed("docker", this.compose("pull", "yo-computer"), PULL_TIMEOUT_MS, (line) => {
      if (progress.add(line)) show();
    });
  }
}
