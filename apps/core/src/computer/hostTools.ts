/**
 * Where Yo finds Colima, Lima and Docker, and where it keeps their files.
 *
 * The downloaded app ships arm64 builds under Contents/Resources (bin/colima, bin/lima, bin/limactl,
 * bin/docker, bin/docker-compose, plus Lima's Linux guest agent and templates). Those win.
 * The bundled bin is first on PATH, so a Homebrew `lima` cannot stand in for a missing one.
 * A development build or an Intel Mac built from source has no bundle, so Yo falls back to
 * the Homebrew folders it already put on PATH.
 *
 * Data lives under Yo's own folder (~/Library/Application Support/Yo, the same folder as
 * core's data), not in ~/.colima or ~/.docker:
 *   colima/   COLIMA_HOME. Colima only honors this when the directory already exists, so Yo
 *             creates it before the first `colima start`.
 *   lima/     LIMA_HOME. A sibling of colima/, not colima/_lima: Lima's ssh socket path must
 *             stay under 104 bytes (unix(4)), and the nested path gets there first. Lima
 *             evaluates symlinks in LIMA_HOME, so a too-long path is a real shorter directory
 *             (~/.yo/lima), not a symlink back into Application Support.
 *   docker/   DOCKER_CONFIG. The Compose plugin is linked into docker/cli-plugins so
 *             `docker compose` works without the old Homebrew symlink step.
 *
 * Someone who already has a VM in ~/.colima is asked, in the setup chat, to keep using it
 * or to move it. An update, where that chat is already finished, keeps the VM where it is
 * and records that choice so Start is not locked. Move stays available in Settings.
 * Yo never deletes that data. Colima 0.10 keeps Docker's containers, images
 * and volumes on a Lima disk at `<LIMA_HOME>/_disks/<instance>` (datadisk), separate from the
 * instance directory. Move takes that disk with the instance. If any part cannot move, the
 * parts already moved are put back, so the VM is never left split across the two homes.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../log";

export type ToolSource = "bundled" | "homebrew" | "missing";
export type VmHomeChoice = "reuse" | "move";

/**
 * Last resort if a choice still cannot be recorded. Start itself keeps an existing VM instead of
 * showing this, so an update does not lock the computer.
 */
export const VM_CHOICE_NEEDED =
  "Yo found an existing computer in ~/.colima. Choose Keep or Move in the setup chat. Nothing is deleted. Then press Try again.";

const HOMEBREW_BINS = ["/opt/homebrew/bin", "/usr/local/bin"];
const COMPOSE_CANDIDATES = [
  "/opt/homebrew/opt/docker-compose/bin/docker-compose",
  "/opt/homebrew/lib/docker/cli-plugins/docker-compose",
  "/usr/local/opt/docker-compose/bin/docker-compose",
  "/usr/local/lib/docker/cli-plugins/docker-compose",
];

/**
 * Files that make a bundled tree usable. Lima's vz driver is inside limactl (Lima 2.2).
 * Colima 0.10 looks up `lima` on PATH (`dependency check failed for VM: lima not found`).
 * That file is the shell wrapper from the Lima tarball; it execs limactl.
 */
export const BUNDLE_FILES = [
  "bin/colima",
  "bin/lima",
  "bin/limactl",
  "bin/docker",
  "bin/docker-compose",
  "share/lima/lima-guestagent.Linux-aarch64.gz",
];

export interface ResolvedTools {
  source: ToolSource;
  /** Prepended to PATH. Null when the bundle isn't complete. */
  binDir: string | null;
  colima: string | null;
  limactl: string | null;
  docker: string | null;
  /** Absolute path of the Compose plugin binary, when one was found. */
  compose: string | null;
}

export interface VmLayout {
  state: "ready" | "choose";
  choice: VmHomeChoice | null;
  colimaHome: string;
  limaHome: string;
  dockerConfig: string;
  /** ~/.colima */
  legacyDir: string;
  /**
   * The Application Support lima folder would make `ssh.sock.<16>` 104 characters or more,
   * so limaHome is a shorter real directory (Lima expands symlinks, so this is not a link).
   */
  limaShortened: boolean;
  detail: string;
  /** The old copy is still in ~/.colima. Yo has not deleted it. */
  legacyKept: boolean;
  profileShort: string;
  profileId: string;
  /** Unix socket Colima publishes for this profile. */
  socketPath: string;
}

export interface ProfileNames {
  /** Directory under COLIMA_HOME (`yo`, or `default`). */
  short: string;
  /** Lima instance and Docker context (`colima-yo`, or `colima` for the default profile). */
  id: string;
}

/** Same folder core uses for its data (config.ts `defaultDataDir`). */
export function defaultSupportDir(home = os.homedir(), platform = process.platform): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Yo");
  return path.join(home, ".yo");
}

/**
 * The home core and the desktop app both use for ~/.colima. `YO_HOME` wins, so a test can point
 * both at the same folder. Electron's `app.getPath("home")` is not this and must not be used instead.
 */
export function hostHome(env: NodeJS.ProcessEnv = process.env, fallback = os.homedir()): string {
  const fromEnv = env.YO_HOME?.trim();
  return fromEnv || fallback;
}

/** Colima's profile naming: `yo` -> instance `colima-yo`, `default` -> instance `colima`. */
export function profileNames(profile: string): ProfileNames {
  const name = profile.trim() || "yo";
  if (name === "default" || name === "colima") return { short: "default", id: "colima" };
  const short = name.startsWith("colima-") ? name.slice("colima-".length) : name;
  return { short, id: `colima-${short}` };
}

function blank(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function resolveTools(o: {
  bundledRoot: string | null;
  homeDir: string;
  exists?: (p: string) => boolean;
  homebrewBins?: string[];
  /** Homebrew Compose locations. Tests pass [] so a real /opt/homebrew install is not consulted. */
  composeCandidates?: string[];
}): ResolvedTools {
  const exists = o.exists ?? fs.existsSync;
  const root = o.bundledRoot;
  if (root && BUNDLE_FILES.every((f) => exists(path.join(root, f)))) {
    const bin = path.join(root, "bin");
    return {
      source: "bundled",
      binDir: bin,
      colima: path.join(bin, "colima"),
      limactl: path.join(bin, "limactl"),
      docker: path.join(bin, "docker"),
      compose: path.join(bin, "docker-compose"),
    };
  }
  const bins = o.homebrewBins ?? HOMEBREW_BINS;
  const find = (name: string) => bins.map((b) => path.join(b, name)).find((p) => exists(p)) ?? null;
  const colima = find("colima");
  const docker = find("docker");
  const compose =
    [
      ...(o.composeCandidates ?? COMPOSE_CANDIDATES),
      path.join(o.homeDir, ".docker", "cli-plugins", "docker-compose"),
    ].find((p) => exists(p)) ?? null;
  if (!colima || !docker) {
    return { source: "missing", binDir: null, colima, limactl: find("limactl"), docker, compose };
  }
  return { source: "homebrew", binDir: null, colima, limactl: find("limactl"), docker, compose };
}

interface ChoiceFile {
  choice: VmHomeChoice;
  originalKept: boolean;
  at: number;
}

function choicePath(dataDir: string): string {
  return path.join(dataDir, "vm-home.json");
}

function readChoice(dataDir: string): ChoiceFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(choicePath(dataDir), "utf8")) as Partial<ChoiceFile>;
    if (raw.choice !== "reuse" && raw.choice !== "move") return null;
    return { choice: raw.choice, originalKept: raw.originalKept === true, at: Number(raw.at) || 0 };
  } catch {
    return null;
  }
}

function writeChoice(dataDir: string, choice: VmHomeChoice, originalKept: boolean) {
  fs.mkdirSync(dataDir, { recursive: true });
  const body: ChoiceFile = { choice, originalKept, at: Date.now() };
  fs.writeFileSync(choicePath(dataDir), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Lima refuses to create an instance when `ssh.sock` plus OpenSSH's 16-character suffix is
 * 104 bytes or more (`instance name too long`, unix(4)). This is that suffix, from Lima's
 * `filenames.LongestSock`.
 */
export const LIMA_UNIX_PATH_MAX = 104;
export const LIMA_LONGEST_SOCK = "ssh.sock.1234567890123456";

const log = logger("computer");

export function limaSocketPath(limaHome: string, instanceId: string): string {
  return path.join(limaHome, instanceId, LIMA_LONGEST_SOCK);
}

export function limaSocketLength(limaHome: string, instanceId: string): number {
  return Buffer.byteLength(limaSocketPath(limaHome, instanceId));
}

/** True when Lima will accept this home. The path must be shorter than 104 bytes. */
export function limaSocketFits(limaHome: string, instanceId: string): boolean {
  return limaSocketLength(limaHome, instanceId) < LIMA_UNIX_PATH_MAX;
}

function shortLimaLeaf(dataDir: string): string {
  const base =
    path
      .basename(dataDir)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "yo";
  return base === "yo" ? "lima" : `lima-${base}`;
}

/**
 * Where Yo keeps Lima. Application Support when the socket fits. Otherwise a real directory
 * under ~/.yo (`lima`, or `lima-<folder>` so Yo Test does not share the installed app's files).
 * Not a symlink: Lima's LimaDir() evaluates symlinks before it measures the socket.
 */
export function managedLimaHome(
  dataDir: string,
  homeDir: string,
  instanceId: string,
): { dir: string; shortened: boolean } {
  const preferred = path.join(dataDir, "lima");
  if (limaSocketFits(preferred, instanceId)) return { dir: preferred, shortened: false };
  const named = path.join(homeDir, ".yo", shortLimaLeaf(dataDir));
  if (limaSocketFits(named, instanceId)) return { dir: named, shortened: true };
  const hashed = path.join(
    homeDir,
    ".yo",
    "l",
    createHash("sha256").update(preferred).digest("hex").slice(0, 8),
  );
  if (limaSocketFits(hashed, instanceId)) return { dir: hashed, shortened: true };
  throw new Error(
    `Lima's ssh socket would be ${limaSocketLength(preferred, instanceId)} characters under ${preferred}, and ${hashed} is still too long. The limit is ${LIMA_UNIX_PATH_MAX}.`,
  );
}

function yoHomes(dataDir: string, homeDir: string, instanceId: string) {
  const lima = managedLimaHome(dataDir, homeDir, instanceId);
  return {
    colimaHome: path.join(dataDir, "colima"),
    limaHome: lima.dir,
    limaShortened: lima.shortened,
    dockerConfig: path.join(dataDir, "docker"),
  };
}

function legacyHomes(homeDir: string) {
  const legacyDir = path.join(homeDir, ".colima");
  return { legacyDir, colimaHome: legacyDir, limaHome: path.join(legacyDir, "_lima") };
}

/** Colima 0.10's Docker data disk. Lima resolves `additionalDisks[].name` under `_disks/<name>`. */
export function vmDataDiskDir(limaHome: string, instanceId: string): string {
  return path.join(limaHome, "_disks", instanceId);
}

function hasVm(colimaHome: string, limaHome: string, names: ProfileNames, exists: (p: string) => boolean) {
  const instance = path.join(limaHome, names.id);
  return (
    exists(path.join(colimaHome, names.short, "colima.yaml")) ||
    exists(path.join(instance, "lima.yaml")) ||
    exists(path.join(instance, "disk")) ||
    exists(path.join(instance, "diffdisk")) ||
    exists(path.join(vmDataDiskDir(limaHome, names.id), "datadisk"))
  );
}

function layout(o: {
  state: VmLayout["state"];
  choice: VmHomeChoice | null;
  colimaHome: string;
  limaHome: string;
  dockerConfig: string;
  legacyDir: string;
  detail: string;
  legacyKept: boolean;
  limaShortened: boolean;
  names: ProfileNames;
}): VmLayout {
  return {
    ...o,
    profileShort: o.names.short,
    profileId: o.names.id,
    socketPath: path.join(o.colimaHome, o.names.short, "docker.sock"),
  };
}

/**
 * Decide which folders to use. Reads the choice file and looks for an existing VM.
 * Does not create or delete anything.
 */
export function resolveVmHome(o: {
  dataDir: string;
  homeDir: string;
  profile: string;
  exists?: (p: string) => boolean;
}): VmLayout {
  const exists = o.exists ?? fs.existsSync;
  const names = profileNames(o.profile);
  const yo = yoHomes(o.dataDir, o.homeDir, names.id);
  const legacy = legacyHomes(o.homeDir);
  const legacyHas = hasVm(legacy.colimaHome, legacy.limaHome, names, exists);
  const yoHas = hasVm(yo.colimaHome, yo.limaHome, names, exists);
  const saved = readChoice(o.dataDir);
  const base = { dockerConfig: yo.dockerConfig, legacyDir: legacy.legacyDir, names };

  if (saved?.choice === "reuse") {
    return layout({
      ...base,
      state: "ready",
      choice: "reuse",
      colimaHome: legacy.colimaHome,
      limaHome: legacy.limaHome,
      limaShortened: false,
      legacyKept: true,
      detail: "Using your existing computer in ~/.colima. Yo didn't move or delete it.",
    });
  }
  if (saved?.choice === "move") {
    const kept = saved.originalKept || legacyHas;
    return layout({
      ...base,
      state: "ready",
      choice: "move",
      colimaHome: yo.colimaHome,
      limaHome: yo.limaHome,
      limaShortened: yo.limaShortened,
      legacyKept: kept,
      detail: kept
        ? "Yo copied your computer into its own folder. The original is still in ~/.colima and was not deleted. You can remove that old copy later if you want."
        : "Your existing computer now lives in Yo's folder. It was renamed, not deleted. Other Colima profiles are still in ~/.colima.",
    });
  }
  if (legacyHas && yoHas) {
    return layout({
      ...base,
      state: "ready",
      choice: null,
      colimaHome: yo.colimaHome,
      limaHome: yo.limaHome,
      limaShortened: yo.limaShortened,
      legacyKept: true,
      detail:
        "Yo is using the computer in its own folder. An older copy is still in ~/.colima. Yo will not delete it.",
    });
  }
  if (legacyHas) {
    return layout({
      ...base,
      state: "choose",
      choice: null,
      colimaHome: legacy.colimaHome,
      limaHome: legacy.limaHome,
      limaShortened: false,
      legacyKept: true,
      detail: chooseDetail(names.short),
    });
  }
  return layout({
    ...base,
    state: "ready",
    choice: null,
    colimaHome: yo.colimaHome,
    limaHome: yo.limaHome,
    limaShortened: yo.limaShortened,
    legacyKept: false,
    detail: "",
  });
}

function chooseDetail(profile: string): string {
  return (
    `Yo found an existing computer in ~/.colima (Colima profile "${profile}"). ` +
    "You can keep using it there, or move it into Yo's folder. Yo will not delete it either way. Other Colima profiles stay put. " +
    "Keep it where it is: Yo uses ~/.colima, and nothing is moved. " +
    "Move it into Yo: Yo renames that profile into its own folder. If a rename isn't possible, Yo copies it and leaves the original in ~/.colima for you to remove later."
  );
}

interface VmPiece {
  src: string;
  dest: string;
}

/** Instance, Colima profile, store file, and Colima 0.10's Docker data disk. */
function vmPieces(
  legacy: { colimaHome: string; limaHome: string },
  yo: { colimaHome: string; limaHome: string },
  names: ProfileNames,
): VmPiece[] {
  return [
    { src: path.join(legacy.limaHome, names.id), dest: path.join(yo.limaHome, names.id) },
    { src: path.join(legacy.colimaHome, names.short), dest: path.join(yo.colimaHome, names.short) },
    {
      src: path.join(legacy.colimaHome, "_store", `${names.id}.json`),
      dest: path.join(yo.colimaHome, "_store", `${names.id}.json`),
    },
    { src: vmDataDiskDir(legacy.limaHome, names.id), dest: vmDataDiskDir(yo.limaHome, names.id) },
  ];
}

/** True when a Move already started and a piece (usually the Docker disk) is still only in ~/.colima. */
export function legacyVmSplit(o: { dataDir: string; homeDir: string; profile: string }): boolean {
  const names = profileNames(o.profile);
  const pieces = vmPieces(legacyHomes(o.homeDir), yoHomes(o.dataDir, o.homeDir, names.id), names);
  return pieces.some((p) => fs.existsSync(p.src) && !fs.existsSync(p.dest));
}

function moveOne(src: string, dest: string): "renamed" | "copied" | "absent" {
  if (!fs.existsSync(src)) return "absent";
  if (fs.existsSync(dest)) {
    throw new Error(
      `Yo already has ${dest}, and ${src} is still there. Yo won't overwrite either, and nothing was deleted.`,
    );
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `Couldn't move ${src} (${code ?? "error"}). It was left in place. If that computer is running, stop it and try again. Nothing was deleted.`,
    );
  }
  try {
    fs.renameSync(src, dest);
    return "renamed";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") {
      throw new Error(
        `Couldn't move ${src} (${code ?? "error"}). It was left in place. If that computer is running, stop it and try again. Nothing was deleted.`,
      );
    }
    try {
      fs.cpSync(src, dest, { recursive: true, errorOnExist: true });
    } catch (cpErr) {
      fs.rmSync(dest, { recursive: true, force: true });
      const cpCode = (cpErr as NodeJS.ErrnoException).code;
      throw new Error(
        `Couldn't copy ${src} (${cpCode ?? "error"}). The original was left in place and nothing was deleted.`,
      );
    }
    return "copied";
  }
}

type MoveStep =
  | { kind: "move"; src: string; dest: string; how: "renamed" | "copied" }
  | { kind: "symlink"; link: string; previous: string };

function restoreMove(step: { src: string; dest: string; how: "renamed" | "copied" }) {
  if (step.how === "copied") {
    if (!fs.existsSync(step.src)) {
      throw new Error(`The original ${step.src} is missing, so the copy at ${step.dest} was left in place.`);
    }
    fs.rmSync(step.dest, { recursive: true, force: true });
    if (fs.existsSync(step.dest)) throw new Error(`Couldn't remove the copy at ${step.dest}.`);
    return;
  }
  if (!fs.existsSync(step.dest)) return;
  if (fs.existsSync(step.src)) {
    throw new Error(`Both ${step.src} and ${step.dest} exist, so Yo left them rather than overwrite either.`);
  }
  try {
    fs.renameSync(step.dest, step.src);
  } catch {
    fs.cpSync(step.dest, step.src, { recursive: true, errorOnExist: true });
    if (!fs.existsSync(step.src)) throw new Error(`Couldn't restore ${step.src}.`);
    fs.rmSync(step.dest, { recursive: true, force: true });
  }
  if (fs.existsSync(step.dest) || !fs.existsSync(step.src)) {
    throw new Error(`Couldn't put ${step.dest} back at ${step.src}.`);
  }
}

function rollbackMove(done: MoveStep[]) {
  const problems: string[] = [];
  for (const step of [...done].reverse()) {
    try {
      if (step.kind === "symlink") {
        fs.unlinkSync(step.link);
        fs.symlinkSync(step.previous, step.link);
      } else restoreMove(step);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  return problems;
}

/**
 * Lima's `in_use_by` is an absolute symlink to the instance directory. After the instance and the
 * disk have both moved, point it at the new directory so `additionalDisks` can lock the same disk
 * (Colima reuses it with format: false instead of creating an empty one).
 */
function retargetDiskLock(diskDir: string, oldInstance: string, newInstance: string): MoveStep | null {
  const link = path.join(diskDir, "in_use_by");
  let previous: string;
  try {
    previous = fs.readlinkSync(link);
  } catch {
    return null;
  }
  if (path.resolve(path.dirname(link), previous) !== path.resolve(oldInstance)) return null;
  fs.unlinkSync(link);
  fs.symlinkSync(newInstance, link);
  return { kind: "symlink", link, previous };
}

/**
 * Record the setup chat's choice. `move` renames the profile into Yo's folder, including Colima
 * 0.10's Docker data disk (copy + leave the original only when the two folders are on different
 * disks). A piece already moved by an earlier attempt is left where it is. If any part cannot
 * move, everything this call moved is put back. Never deletes the source.
 */
export function chooseVmHome(o: {
  dataDir: string;
  homeDir: string;
  profile: string;
  choice: VmHomeChoice;
}): VmLayout {
  if (o.choice !== "reuse" && o.choice !== "move") {
    throw new Error("Choose whether to keep the existing computer or move it.");
  }
  const names = profileNames(o.profile);
  const yo = yoHomes(o.dataDir, o.homeDir, names.id);
  const legacy = legacyHomes(o.homeDir);
  if (o.choice === "reuse") {
    writeChoice(o.dataDir, "reuse", true);
    return resolveVmHome(o);
  }
  const pieces = vmPieces(legacy, yo, names);
  const conflicts = pieces.filter((p) => fs.existsSync(p.src) && fs.existsSync(p.dest));
  if (conflicts.length) {
    throw new Error(
      "Yo already has a computer in its own folder, and one is still in ~/.colima. Yo won't overwrite either, and nothing was deleted.",
    );
  }
  const pending = pieces.filter((p) => fs.existsSync(p.src));
  if (!pending.length) {
    writeChoice(o.dataDir, "move", false);
    return resolveVmHome(o);
  }
  const done: MoveStep[] = [];
  try {
    for (const pair of pending) {
      const how = moveOne(pair.src, pair.dest);
      if (how !== "absent") done.push({ kind: "move", ...pair, how });
    }
    const oldInstance = path.join(legacy.limaHome, names.id);
    const newInstance = path.join(yo.limaHome, names.id);
    const lock = retargetDiskLock(vmDataDiskDir(yo.limaHome, names.id), oldInstance, newInstance);
    if (lock) done.push(lock);
  } catch (err) {
    const original = err instanceof Error ? err : new Error(String(err));
    const problems = rollbackMove(done);
    if (problems.length) {
      throw new Error(
        `${original.message} Rolling that back failed, so the computer may be in both folders. Nothing was deleted. ${problems.join(" ")}`,
      );
    }
    throw original;
  }
  const originalKept = done.some((s) => s.kind === "move" && s.how === "copied");
  writeChoice(o.dataDir, "move", originalKept);
  return resolveVmHome(o);
}

/**
 * An existing ~/.colima VM with no saved choice. The setup chat is the place to ask, but that chat
 * is already gone for someone who updated. Keep the VM where it is, record that, and log it.
 * Nothing is moved or deleted. Move stays available afterwards.
 */
export function keepUnsetLegacyVm(o: { dataDir: string; homeDir: string; profile: string }): VmLayout {
  const vm = resolveVmHome(o);
  if (vm.state !== "choose") return vm;
  log.info(
    `Keeping the existing computer in ~/.colima (profile ${vm.profileShort}). No Keep or Move choice was saved, so Yo is leaving it there. Nothing was moved or deleted.`,
  );
  return chooseVmHome({ ...o, choice: "reuse" });
}

/**
 * Lima 2.2.1's vz driver, before it will use the usernet SSH forwarder, waits twice for a
 * user-v2 DHCP lease (`ResolveIPAddress`, 2 minutes each: once inside `WaitOpeningSSHPort` to
 * probe SSH-over-vsock, then again in `ConfigureDriver`). Colima 0.10's guest is Ubuntu 24.04
 * (systemd 255). SSH-over-vsock needs systemd 256, so that probe cannot succeed, and the host
 * sits there while the guest is already up. `ssh.overVsock: false` skips the probe. The second
 * lookup stays, and returns as soon as the lease exists.
 *
 * `internal_netplanOptional` is the flag Lima's own Ubuntu templates set so
 * systemd-networkd-wait-online does not hold boot for 120s per NIC (the 26.04 rename bug, and
 * any Lima NIC that is not online yet). Colima does not set it.
 *
 * Written only under Yo's LIMA_HOME. A kept VM in ~/.colima/_lima is not touched.
 */
export const LIMA_BOOT_OVERRIDE = `# yo-lima-override
ssh:
  overVsock: false
param:
  internal_netplanOptional: "true"
`;

function ensureLimaOverride(limaHome: string) {
  const file = path.join(limaHome, "_config", "override.yaml");
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, "utf8");
    if (!current.startsWith("# yo-lima-override")) return;
    if (current === LIMA_BOOT_OVERRIDE) return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, LIMA_BOOT_OVERRIDE, { mode: 0o644 });
}

/** Move a Lima home that is already on disk when its socket path is past the limit. */
function relocateLimaHome(from: string, to: string) {
  if (!fs.existsSync(from) || path.resolve(from) === path.resolve(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to) && fs.readdirSync(to).length > 0) {
    log.warn(
      `Lima's ssh socket is too long for ${from}, and ${to} already has files. Using ${to}. Nothing was deleted.`,
    );
    return;
  }
  if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** Create the homes Colima will accept. Does nothing while the setup chat is still asking. */
export function ensureVmDirs(vm: VmLayout) {
  if (vm.state !== "ready") return;
  if (vm.limaShortened) {
    const preferred = path.join(path.dirname(vm.colimaHome), "lima");
    const length = limaSocketLength(preferred, vm.profileId);
    relocateLimaHome(preferred, vm.limaHome);
    log.info(
      `Lima's ssh socket under Yo's folder would be ${length} characters and must be under ${LIMA_UNIX_PATH_MAX}, so LIMA_HOME is ${vm.limaHome}.`,
    );
  }
  fs.mkdirSync(vm.colimaHome, { recursive: true });
  fs.mkdirSync(vm.limaHome, { recursive: true });
  fs.mkdirSync(vm.dockerConfig, { recursive: true });
  if (vm.limaHome !== path.join(vm.legacyDir, "_lima")) ensureLimaOverride(vm.limaHome);
}

/** Point Docker at Yo's Compose plugin (or Homebrew's) inside DOCKER_CONFIG. */
export function ensureComposeLink(dockerConfig: string, plugin: string | null): string | null {
  if (!plugin || !fs.existsSync(plugin)) return null;
  const dir = path.join(dockerConfig, "cli-plugins");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "docker-compose");
  let current: string | null = null;
  try {
    current = fs.readlinkSync(dest);
  } catch {
    current = null;
  }
  if (current === plugin) return dest;
  // existsSync is false for a dangling symlink, and symlinkSync then throws EEXIST ("file already exists").
  fs.rmSync(dest, { force: true });
  fs.symlinkSync(plugin, dest);
  return dest;
}

/** Make sure Docker's `colima-<profile>` context points at this Colima socket. */
export async function ensureDockerContext(o: {
  run: (args: string[]) => Promise<unknown>;
  context: string;
  socketPath: string;
}) {
  try {
    await o.run(["context", "inspect", o.context]);
  } catch {
    await o.run([
      "context",
      "create",
      o.context,
      "--description",
      "Yo",
      "--docker",
      `host=unix://${o.socketPath}`,
    ]);
  }
}

export function launchEnv(o: {
  dataDir: string;
  homeDir: string;
  profile: string;
  bundledRoot?: string | null;
  baseEnv?: NodeJS.ProcessEnv;
  extra?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const base = o.baseEnv ?? process.env;
  const tools = resolveTools({ bundledRoot: o.bundledRoot ?? null, homeDir: o.homeDir });
  const vm = resolveVmHome({ dataDir: o.dataDir, homeDir: o.homeDir, profile: o.profile });
  // Bundled bin first, so Homebrew's lima cannot hide a bundle that forgot bin/lima.
  const pathValue = [
    tools.binDir,
    ...HOMEBREW_BINS,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    base.PATH ?? "",
  ]
    .filter((p): p is string => !!p)
    .join(":");
  return {
    ...base,
    PATH: pathValue,
    COLIMA_HOME: vm.colimaHome,
    LIMA_HOME: vm.limaHome,
    DOCKER_CONFIG: vm.dockerConfig,
    ...o.extra,
  };
}

export function bundledRootFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return blank(env.YO_BUNDLED_ROOT);
}
