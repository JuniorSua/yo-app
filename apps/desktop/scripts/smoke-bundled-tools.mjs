// Non-VM check for a clean-installed Yo.app: with Homebrew moved aside, the app must resolve the
// bundled Colima, Lima and Docker paths (hostTools.resolveTools probes /opt/homebrew/bin and
// /usr/local/bin by absolute path), those binaries must be the arm64 copies the release ships,
// and each must answer a version command. Does not start a VM.
//
//   node --import tsx apps/desktop/scripts/smoke-bundled-tools.mjs /Applications/Yo.app
//
// The release workflow runs this with tsx because hostTools.ts is TypeScript. `lima` is the shell
// wrapper from the Lima tarball. On `--version` it execs `$LIMACTL`, which defaults to `limactl`
// looked up on PATH (lima v2.2.1 cmd/lima line 33). limactl is the arm64 binary that carries the
// virtualization entitlement. Colima 0.10's command is `version`; `--version` is tried first.
//
// Version commands use hostTools.launchEnv, the same environment the app builds before it runs
// colima or docker (ComputerLifecycle.hostEnv / desktop stopComputerVm). That puts
// Contents/Resources/bin first on PATH, so the wrapper finds the bundled limactl on a Mac with no
// Homebrew. A runner PATH does not. The check still executes `lima --version`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultSupportDir, hostHome, launchEnv, resolveTools } from "../../core/src/computer/hostTools.ts";

/** Mach-O magics, big-endian as they appear on disk. */
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const MH_MAGIC = 0xfeedface;
const MH_CIGAM = 0xcefaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
/** CPU_TYPE_ARM | CPU_ARCH_ABI64. */
const CPU_TYPE_ARM64 = 0x0100000c;

const TOOL_BINS = ["colima", "lima", "limactl", "docker", "docker-compose"];
/** Mach-O binaries. `lima` is not in this list: it is a shell wrapper. */
const ARM64_BINS = ["colima", "limactl", "docker", "docker-compose"];

export function machOArm64(buf) {
  if (!buf || buf.length < 8) return false;
  const magic = buf.readUInt32BE(0);
  if (magic === FAT_MAGIC || magic === FAT_CIGAM) {
    const read = (off) => (magic === FAT_CIGAM ? buf.readUInt32LE(off) : buf.readUInt32BE(off));
    if (buf.length < 8) return false;
    const n = read(4);
    if (!Number.isInteger(n) || n < 1 || n > 32) return false;
    for (let i = 0; i < n; i++) {
      const off = 8 + i * 20;
      if (off + 4 > buf.length) return false;
      if (read(off) === CPU_TYPE_ARM64) return true;
    }
    return false;
  }
  const little = magic === MH_CIGAM_64 || magic === MH_CIGAM;
  const big = magic === MH_MAGIC_64 || magic === MH_MAGIC;
  if (!little && !big) return false;
  const cputype = little ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  return cputype === CPU_TYPE_ARM64;
}

export function looksLikeShellScript(buf) {
  if (!buf || buf.length < 2) return false;
  return buf.subarray(0, Math.min(buf.length, 128)).toString("utf8").startsWith("#!");
}

/** True when `file` is a path strictly inside `root`. */
export function isInside(root, file) {
  if (typeof root !== "string" || typeof file !== "string" || !root || !file) return false;
  const base = path.resolve(root);
  const target = path.resolve(file);
  const rel = path.relative(base, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The result of resolveTools for an installed app. Throws unless every tool path is the bundled one.
 * Callers must not pass homebrewBins: the real check probes /opt/homebrew/bin and /usr/local/bin.
 */
export function assertBundledResolution(app, tools) {
  const resources = path.join(path.resolve(app), "Contents", "Resources");
  const source = tools?.source;
  if (source !== "bundled") {
    throw new Error(
      `Yo resolved its tools as ${source ?? "unknown"}, not the bundled copies in ${resources} ` +
        `(colima=${tools?.colima ?? "none"}, docker=${tools?.docker ?? "none"})`,
    );
  }
  for (const key of ["binDir", "colima", "limactl", "docker", "compose"]) {
    const value = tools[key];
    if (typeof value !== "string" || !isInside(resources, value)) {
      throw new Error(`${key} is not inside ${resources}: ${value}`);
    }
  }
  return tools;
}

export function resolveInstalledApp(app, deps = {}) {
  const resolve = deps.resolveTools ?? resolveTools;
  const homeDir = deps.homeDir ?? os.homedir();
  const resources = path.join(path.resolve(app), "Contents", "Resources");
  const tools = resolve({ bundledRoot: resources, homeDir });
  return assertBundledResolution(app, tools);
}

function defaultReadHead(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Executable bundled tools, arm64 Mach-O where the release ships a binary, plus Lima's guest agent. */
export function assertBundleBinaries(resources, deps = {}) {
  const stat = deps.stat ?? fs.statSync;
  const readHead = deps.readHead ?? defaultReadHead;
  const bin = path.join(resources, "bin");
  const problems = [];
  for (const name of TOOL_BINS) {
    const file = path.join(bin, name);
    let st;
    try {
      st = stat(file);
    } catch {
      problems.push(`${name} is missing (${file})`);
      continue;
    }
    if (!st.isFile() || (st.mode & 0o111) === 0) problems.push(`${name} is not executable (${file})`);
  }
  for (const name of ARM64_BINS) {
    const file = path.join(bin, name);
    let head;
    try {
      head = readHead(file);
    } catch {
      continue;
    }
    if (!machOArm64(head)) problems.push(`${name} is not an arm64 Mach-O (${file})`);
  }
  const lima = path.join(bin, "lima");
  try {
    const head = readHead(lima);
    if (!machOArm64(head) && !looksLikeShellScript(head)) {
      problems.push(`lima is neither an arm64 binary nor the shell wrapper that execs limactl (${lima})`);
    }
  } catch {
    /* missing already reported */
  }
  const guest = path.join(resources, "share", "lima", "lima-guestagent.Linux-aarch64.gz");
  try {
    if (!stat(guest).isFile()) problems.push(`guest agent is not a file (${guest})`);
  } catch {
    problems.push(`guest agent is missing (${guest})`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
}

/** Colima answers `version` when it has no `--version` flag. Everything else is `--version` only. */
export function versionAttempts(name) {
  if (name === "colima") return [["--version"], ["version"]];
  return [["--version"]];
}

export function runBundledVersions(binDir, run, env) {
  const lines = [];
  for (const name of TOOL_BINS) {
    const file = path.join(binDir, name);
    let last = "no attempt";
    let answered = false;
    for (const args of versionAttempts(name)) {
      try {
        const out = run(file, args, env);
        const first = String(out ?? "")
          .split("\n")
          .map((line) => line.trim())
          .find(Boolean);
        lines.push(`${name} ${args.join(" ")}: ${first || "(no output)"}`);
        answered = true;
        break;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
    }
    if (!answered) throw new Error(`${name} did not answer --version: ${last}`);
  }
  return lines;
}

/**
 * Environment a packaged app uses for bundled colima, lima and docker. `bundledRoot` is this
 * app's Contents/Resources, which is what the desktop process passes as YO_BUNDLED_ROOT.
 * launchEnv prepends Resources/bin to PATH.
 */
export function installedAppEnv(app, deps = {}) {
  const resources = path.join(path.resolve(app), "Contents", "Resources");
  const baseEnv = deps.baseEnv ?? process.env;
  const homeDir = deps.homeDir ?? hostHome(baseEnv);
  const dataDir = deps.dataDir || baseEnv.YO_DATA_DIR?.trim() || defaultSupportDir(homeDir);
  const profile = deps.profile || baseEnv.YO_COLIMA_PROFILE?.trim() || "yo";
  return launchEnv({
    dataDir,
    homeDir,
    profile,
    bundledRoot: resources,
    baseEnv,
  });
}

/** Run one bundled tool. `env` must be installedAppEnv (or the same PATH) or `lima` cannot exec limactl. */
export function execVersion(file, args, env) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr).trim() : "";
    const stdout = err && typeof err === "object" && "stdout" in err ? String(err.stdout).trim() : "";
    const message = err instanceof Error ? err.message : String(err);
    throw new Error([stderr, stdout, message].filter(Boolean).join("\n"));
  }
}

/** Resolve, check the binaries, and run their version commands with the app's launch environment. */
export function checkInstalledApp(app, deps = {}) {
  const tools = resolveInstalledApp(app, deps);
  const resources = path.join(path.resolve(app), "Contents", "Resources");
  assertBundleBinaries(resources, deps);
  const env = deps.env ?? installedAppEnv(app, deps);
  const lines = runBundledVersions(tools.binDir, deps.run ?? execVersion, env);
  return { tools, lines, env };
}

function invokedDirectly(metaUrl = import.meta.url, argv = process.argv) {
  const entry = argv[1];
  if (!entry) return false;
  return metaUrl === pathToFileURL(path.resolve(entry)).href;
}

function main() {
  const app = process.argv[2];
  if (!app || app.startsWith("--")) {
    console.error("usage: smoke-bundled-tools.mjs <Yo.app>");
    process.exit(2);
  }
  const { tools, lines, env } = checkInstalledApp(path.resolve(app));
  console.log(`source: ${tools.source}`);
  for (const key of ["binDir", "colima", "limactl", "docker", "compose"])
    console.log(`${key}: ${tools[key]}`);
  console.log(`tool PATH: ${String(env.PATH).split(":")[0]}`);
  for (const line of lines) console.log(line);
  console.log("BUNDLED TOOLS: PASS");
}

if (invokedDirectly()) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
