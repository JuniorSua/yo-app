// Downloads the pinned Apple silicon builds Yo.app ships, and checks each file's sha256 before
// anything is copied into apps/desktop/vendor/darwin-arm64. Those binaries stay out of git.
//
// What is included (and why):
//   colima, limactl, lima    Colima 0.10 looks up `lima` on PATH before it will start a VM. `lima` is the
//                            shell wrapper in the Lima tarball; it execs limactl. The vz driver is inside
//                            limactl, which is the binary that gets the virtualization entitlement.
//   Linux aarch64 guest agent  Lima looks for it next to the prefix that contains bin/limactl.
//   share/lima/templates     Small, and part of a normal Lima install.
//   docker                   The CLI only (the static tarball has no dockerd; the guest runs the daemon).
//   docker-compose           Linked into Yo's DOCKER_CONFIG at runtime.
// Left out on purpose: lima-driver-krunkit, limactl-mcp, and the Darwin guest agent. Yo starts VMs with
// `--vm-type vz`, which does not need krunkit.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
export const VENDOR_DIR = path.join(desktop, "vendor", "darwin-arm64");

export const PINS = {
  colima: {
    version: "0.10.3",
    url: "https://github.com/abiosoft/colima/releases/download/v0.10.3/colima-Darwin-arm64",
    sha256: "980ad8bf61a4ca370243f4cb41401a61276dcd2c2502bee7b9b86f9250169f34",
  },
  lima: {
    version: "2.2.1",
    url: "https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-arm64.tar.gz",
    sha256: "9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e",
  },
  docker: {
    version: "29.2.0",
    url: "https://download.docker.com/mac/static/stable/aarch64/docker-29.2.0.tgz",
    sha256: "dfdfe33aa3d8ae9f7ecce992de0acaeb1a5823e106a064d9d47373e91546baae",
  },
  compose: {
    version: "5.6.1",
    url: "https://github.com/docker/compose/releases/download/v5.6.1/docker-compose-darwin-aarch64",
    sha256: "fcce41226abd2b7b2936094e688bbd61284673dddafea542e08cb9a3b4423a8b",
  },
};

const REQUIRED = [
  "bin/colima",
  "bin/lima",
  "bin/limactl",
  "bin/docker",
  "bin/docker-compose",
  "share/lima/lima-guestagent.Linux-aarch64.gz",
];

export function stampBody() {
  return {
    colima: PINS.colima.version,
    lima: PINS.lima.version,
    docker: PINS.docker.version,
    compose: PINS.compose.version,
    sha256: {
      colima: PINS.colima.sha256,
      lima: PINS.lima.sha256,
      docker: PINS.docker.sha256,
      compose: PINS.compose.sha256,
    },
  };
}

export function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

function vendorReady() {
  const stampFile = path.join(VENDOR_DIR, ".pins.json");
  if (!fs.existsSync(stampFile)) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(stampFile, "utf8"));
    if (JSON.stringify(saved) !== JSON.stringify(stampBody())) return false;
  } catch {
    return false;
  }
  return REQUIRED.every((rel) => fs.existsSync(path.join(VENDOR_DIR, rel)));
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

function checkSha(file, expected, label) {
  const got = sha256File(file);
  if (got !== expected) {
    fs.rmSync(file, { force: true });
    throw new Error(`${label} checksum mismatch\n  expected ${expected}\n  got      ${got}`);
  }
}

function tarList(file) {
  const listed = spawnSync("tar", ["-tzf", file], { encoding: "utf8" });
  if (listed.status !== 0) throw new Error(listed.stderr || `Could not list ${file}`);
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function tarExtract(file, dest, members) {
  const extracted = spawnSync("tar", ["-xzf", file, "-C", dest, ...members], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(extracted.stderr || `Could not extract ${members.join(", ")}`);
}

function bare(name) {
  return name.replace(/^\.\//, "");
}

/**
 * The three archive members to extract. Naming every file under templates makes GNU tar
 * report those files as missing when the directory member is also listed. Naming the
 * directory extracts its contents on both GNU tar and bsdtar.
 */
export function limaMembersToExtract(names) {
  const wanted = new Set([
    "bin/lima",
    "bin/limactl",
    "share/lima/lima-guestagent.Linux-aarch64.gz",
    "share/lima/templates",
  ]);
  return names.filter((name) => wanted.has(bare(name).replace(/\/$/, "")));
}

function placeFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
}

function copyLicenses(stage) {
  const src = path.join(desktop, "licenses");
  const dest = path.join(stage, "licenses");
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(dest, name));
  }
}

function folderBytes(dir) {
  let total = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) total += folderBytes(full);
    else if (ent.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

async function fetchAll() {
  if (vendorReady()) {
    const bytes = folderBytes(VENDOR_DIR);
    console.log(`VM tools already match the pins (${(bytes / 1e6).toFixed(1)} MB) at ${VENDOR_DIR}`);
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "yo-vm-tools-"));
  const stage = path.join(work, "stage");
  const downloads = path.join(work, "downloads");
  fs.mkdirSync(path.join(stage, "bin"), { recursive: true });
  fs.mkdirSync(downloads, { recursive: true });
  try {
    const colimaFile = path.join(downloads, "colima");
    await download(PINS.colima.url, colimaFile);
    checkSha(colimaFile, PINS.colima.sha256, "colima");
    placeFile(colimaFile, path.join(stage, "bin", "colima"));

    const composeFile = path.join(downloads, "docker-compose");
    await download(PINS.compose.url, composeFile);
    checkSha(composeFile, PINS.compose.sha256, "docker-compose");
    placeFile(composeFile, path.join(stage, "bin", "docker-compose"));

    const dockerFile = path.join(downloads, "docker.tgz");
    await download(PINS.docker.url, dockerFile);
    checkSha(dockerFile, PINS.docker.sha256, "docker");
    const dockerMembers = tarList(dockerFile).filter((name) => bare(name) === "docker/docker");
    if (dockerMembers.length !== 1) throw new Error("Docker tarball does not contain docker/docker");
    tarExtract(dockerFile, stage, dockerMembers);
    const extractedDocker = path.join(stage, "docker", "docker");
    if (!fs.existsSync(extractedDocker)) throw new Error("Docker CLI was not extracted");
    placeFile(extractedDocker, path.join(stage, "bin", "docker"));
    fs.rmSync(path.join(stage, "docker"), { recursive: true, force: true });

    const limaFile = path.join(downloads, "lima.tgz");
    await download(PINS.lima.url, limaFile);
    checkSha(limaFile, PINS.lima.sha256, "lima");
    const limaMembers = limaMembersToExtract(tarList(limaFile));
    if (!limaMembers.some((name) => bare(name) === "bin/limactl")) {
      throw new Error("Lima tarball has no bin/limactl");
    }
    if (!limaMembers.some((name) => bare(name) === "bin/lima")) {
      throw new Error("Lima tarball has no bin/lima");
    }
    if (
      !limaMembers.some(
        (name) => bare(name).replace(/\/$/, "") === "share/lima/lima-guestagent.Linux-aarch64.gz",
      )
    ) {
      throw new Error("Lima tarball has no Linux aarch64 guest agent");
    }
    if (!limaMembers.some((name) => bare(name).replace(/\/$/, "") === "share/lima/templates")) {
      throw new Error("Lima tarball has no templates");
    }
    tarExtract(limaFile, stage, limaMembers);
    fs.chmodSync(path.join(stage, "bin", "limactl"), 0o755);
    fs.chmodSync(path.join(stage, "bin", "lima"), 0o755);

    for (const rel of REQUIRED) {
      if (!fs.existsSync(path.join(stage, rel))) throw new Error(`Staged bundle is missing ${rel}`);
    }
    copyLicenses(stage);
    fs.writeFileSync(path.join(stage, ".pins.json"), `${JSON.stringify(stampBody(), null, 2)}\n`);

    fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(VENDOR_DIR), { recursive: true });
    fs.cpSync(stage, VENDOR_DIR, { recursive: true });
    const bytes = folderBytes(VENDOR_DIR);
    console.log(`Staged VM tools at ${VENDOR_DIR} (${(bytes / 1e6).toFixed(1)} MB uncompressed)`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (invokedDirectly()) {
  fetchAll().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
