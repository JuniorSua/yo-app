import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLE_FILES,
  chooseVmHome,
  ensureComposeLink,
  ensureVmDirs,
  hostHome,
  LIMA_BOOT_OVERRIDE,
  LIMA_UNIX_PATH_MAX,
  launchEnv,
  limaSocketFits,
  limaSocketLength,
  managedLimaHome,
  profileNames,
  resolveTools,
  resolveVmHome,
  VM_CHOICE_NEEDED,
} from "./hostTools";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function tmp(): string {
  // macOS os.tmpdir() is /var/folders/..., already long enough that Lima's 104-byte socket check
  // throws, including the hashed ~/.yo/l fallback. /tmp stays short (it is a symlink, and the tests
  // measure the path they build, not the realpath).
  const base = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, "yo-vm-"));
  temps.push(dir);
  return dir;
}

/** A complete fake bundle: the files exist, they don't have to run. */
function fakeBundle(root: string) {
  for (const rel of [
    "bin/colima",
    "bin/lima",
    "bin/limactl",
    "bin/docker",
    "bin/docker-compose",
    "share/lima/lima-guestagent.Linux-aarch64.gz",
  ]) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "bin");
  }
}

function legacyVm(home: string) {
  const config = path.join(home, ".colima", "yo");
  const instance = path.join(home, ".colima", "_lima", "colima-yo");
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(instance, { recursive: true });
  fs.writeFileSync(path.join(config, "colima.yaml"), "runtime: docker\n");
  fs.writeFileSync(path.join(instance, "lima.yaml"), "vmType: vz\n");
  fs.writeFileSync(path.join(instance, "disk"), "vm-disk");
  fs.mkdirSync(path.join(home, ".colima", "default"), { recursive: true });
  fs.writeFileSync(path.join(home, ".colima", "default", "colima.yaml"), "other: true\n");
}

/** Bytes that stand in for Docker's on-disk containers, images and volumes inside the ext4 datadisk. */
const DOCKER_DATA = Buffer.from(
  [
    "containers/abc123/config.v2.json",
    "image/overlay2/imagedb/content/sha256/layer",
    "volumes/yo-data/_data/hello",
  ].join("\n"),
);

/**
 * Colima 0.10: the instance dir is not the Docker disk. Containers, images and volumes live in
 * `_lima/_disks/<instance>/datadisk`, and `in_use_by` is an absolute symlink to the instance.
 */
function colima010(home: string) {
  legacyVm(home);
  const instance = path.join(home, ".colima", "_lima", "colima-yo");
  fs.writeFileSync(
    path.join(instance, "lima.yaml"),
    "vmType: vz\nadditionalDisks:\n  - name: colima-yo\n    format: false\n    fsType: ext4\n",
  );
  const diskDir = path.join(home, ".colima", "_lima", "_disks", "colima-yo");
  fs.mkdirSync(diskDir, { recursive: true });
  fs.writeFileSync(path.join(diskDir, "datadisk"), DOCKER_DATA);
  fs.symlinkSync(instance, path.join(diskDir, "in_use_by"));
  const store = path.join(home, ".colima", "_store");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(
    path.join(store, "colima-yo.json"),
    `${JSON.stringify({ disk_formatted: true, disk_runtime: "docker" })}\n`,
  );
  // A different profile's disk must stay in ~/.colima.
  const other = path.join(home, ".colima", "_lima", "_disks", "colima");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "datadisk"), "other-profile-disk");
}

describe("host home", () => {
  it("uses YO_HOME, and the fallback only when that is unset", () => {
    expect(hostHome({ YO_HOME: "  /tmp/yo-home  " }, "/fallback")).toBe("/tmp/yo-home");
    expect(hostHome({ YO_HOME: "  " }, "/fallback")).toBe("/fallback");
    expect(hostHome({}, "/fallback")).toBe("/fallback");
  });
});

describe("profile names", () => {
  it("matches Colima: yo is colima-yo, default is colima", () => {
    expect(profileNames("yo")).toEqual({ short: "yo", id: "colima-yo" });
    expect(profileNames("default")).toEqual({ short: "default", id: "colima" });
  });
});

describe("tool discovery", () => {
  it("uses the bundled binaries when the bundle is complete, even if Homebrew has them too", () => {
    const root = tmp();
    const brew = path.join(root, "brew");
    fakeBundle(path.join(root, "Resources"));
    fs.mkdirSync(path.join(brew, "bin"), { recursive: true });
    fs.writeFileSync(path.join(brew, "bin", "colima"), "brew-colima");
    fs.writeFileSync(path.join(brew, "bin", "docker"), "brew-docker");
    const tools = resolveTools({
      bundledRoot: path.join(root, "Resources"),
      homeDir: root,
      homebrewBins: [path.join(brew, "bin")],
    });
    expect(tools.source).toBe("bundled");
    expect(tools.binDir).toBe(path.join(root, "Resources", "bin"));
    expect(tools.colima).toBe(path.join(root, "Resources", "bin", "colima"));
    expect(tools.limactl).toBe(path.join(root, "Resources", "bin", "limactl"));
    expect(tools.docker).toBe(path.join(root, "Resources", "bin", "docker"));
    expect(tools.compose).toBe(path.join(root, "Resources", "bin", "docker-compose"));
  });

  it("falls back to Homebrew when the bundle is missing a file (dev builds, Intel)", () => {
    const root = tmp();
    const bundled = path.join(root, "Resources");
    fakeBundle(bundled);
    fs.rmSync(path.join(bundled, "share", "lima", "lima-guestagent.Linux-aarch64.gz"));
    const brew = path.join(root, "opt", "homebrew", "bin");
    fs.mkdirSync(brew, { recursive: true });
    fs.writeFileSync(path.join(brew, "colima"), "c");
    fs.writeFileSync(path.join(brew, "limactl"), "l");
    fs.writeFileSync(path.join(brew, "docker"), "d");
    const tools = resolveTools({
      bundledRoot: bundled,
      homeDir: root,
      homebrewBins: [brew],
    });
    expect(tools.source).toBe("homebrew");
    expect(tools.binDir).toBeNull();
    expect(tools.colima).toBe(path.join(brew, "colima"));
    expect(tools.docker).toBe(path.join(brew, "docker"));
  });

  it("requires bin/lima before the bundled tools are used, so Homebrew's lima cannot hide a missing one", () => {
    expect(BUNDLE_FILES).toContain("bin/lima");
    const root = tmp();
    const bundled = path.join(root, "Resources");
    fakeBundle(bundled);
    fs.rmSync(path.join(bundled, "bin", "lima"));
    const brew = path.join(root, "brew", "bin");
    fs.mkdirSync(brew, { recursive: true });
    for (const name of ["colima", "docker", "lima", "limactl"]) fs.writeFileSync(path.join(brew, name), name);
    const tools = resolveTools({ bundledRoot: bundled, homeDir: root, homebrewBins: [brew] });
    expect(tools.source).toBe("homebrew");
    expect(tools.binDir).toBeNull();
  });

  it("reports missing when neither the bundle nor Homebrew has Colima and Docker", () => {
    const root = tmp();
    const tools = resolveTools({ bundledRoot: path.join(root, "nope"), homeDir: root, homebrewBins: [] });
    expect(tools.source).toBe("missing");
    expect(tools.colima).toBeNull();
    expect(tools.docker).toBeNull();
    expect(tools.binDir).toBeNull();
  });

  it("finds Homebrew's Compose plugin and links it into Yo's docker config", () => {
    const root = tmp();
    const plugin = path.join(root, ".docker", "cli-plugins", "docker-compose");
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    fs.writeFileSync(plugin, "#!/bin/sh\n");
    const tools = resolveTools({ bundledRoot: null, homeDir: root, homebrewBins: [], composeCandidates: [] });
    expect(tools.compose).toBe(plugin);
    const dockerConfig = path.join(root, "Yo", "docker");
    const linked = ensureComposeLink(dockerConfig, tools.compose);
    expect(linked).toBe(path.join(dockerConfig, "cli-plugins", "docker-compose"));
    expect(fs.readlinkSync(linked!)).toBe(plugin);
    // A second call leaves the same link.
    expect(ensureComposeLink(dockerConfig, tools.compose)).toBe(linked);
  });

  it("replaces a dangling Compose shortcut instead of failing with 'file already exists'", () => {
    const root = tmp();
    const plugin = path.join(root, "bin", "docker-compose");
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    fs.writeFileSync(plugin, "#!/bin/sh\n");
    const dockerConfig = path.join(root, "docker");
    const dest = path.join(dockerConfig, "cli-plugins", "docker-compose");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(path.join(root, "gone"), dest);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
    const linked = ensureComposeLink(dockerConfig, plugin);
    expect(linked).toBe(dest);
    expect(fs.readlinkSync(dest)).toBe(plugin);
  });
});

describe("environment passed to Colima and Docker", () => {
  it("puts the bundled bin first and points the homes at Yo's folder", () => {
    const root = tmp();
    const data = path.join(root, "data");
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    fakeBundle(path.join(root, "Resources"));
    const env = launchEnv({
      dataDir: data,
      homeDir: home,
      profile: "yo",
      bundledRoot: path.join(root, "Resources"),
      baseEnv: { PATH: "/usr/bin:/bin", HOME: home },
    });
    expect(env.COLIMA_HOME).toBe(path.join(data, "colima"));
    expect(env.LIMA_HOME).toBe(path.join(data, "lima"));
    expect(env.DOCKER_CONFIG).toBe(path.join(data, "docker"));
    expect(String(env.PATH).startsWith(`${path.join(root, "Resources", "bin")}:`)).toBe(true);
    const parts = String(env.PATH).split(":");
    expect(parts[0]).toBe(path.join(root, "Resources", "bin"));
    expect(parts.indexOf("/opt/homebrew/bin")).toBeGreaterThan(0);
  });

  it("keeps the Homebrew PATH when there is no bundle", () => {
    const root = tmp();
    const env = launchEnv({
      dataDir: path.join(root, "data"),
      homeDir: path.join(root, "home"),
      profile: "yo",
      bundledRoot: null,
      baseEnv: { PATH: "/usr/bin" },
    });
    expect(String(env.PATH).startsWith("/opt/homebrew/bin:/usr/local/bin:")).toBe(true);
    expect(env.COLIMA_HOME).toBe(path.join(root, "data", "colima"));
    expect(env.LIMA_HOME).toBe(path.join(root, "data", "lima"));
    expect(env.DOCKER_CONFIG).toBe(path.join(root, "data", "docker"));
  });
});

describe("an existing ~/.colima VM", () => {
  it("asks, and explains both choices, without touching the files", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    legacyVm(home);
    const before = fs.readFileSync(path.join(home, ".colima", "_lima", "colima-yo", "disk"), "utf8");
    const vm = resolveVmHome({ dataDir: data, homeDir: home, profile: "yo" });
    expect(vm.state).toBe("choose");
    expect(vm.colimaHome).toBe(path.join(home, ".colima"));
    expect(vm.limaHome).toBe(path.join(home, ".colima", "_lima"));
    expect(vm.dockerConfig).toBe(path.join(data, "docker"));
    expect(vm.legacyKept).toBe(true);
    expect(vm.detail).toMatch(/will not delete/i);
    expect(vm.detail).toMatch(/Keep it where it is/);
    expect(vm.detail).toMatch(/Move it into Yo/);
    expect(vm.detail).toMatch(/profile "yo"/);
    expect(fs.readFileSync(path.join(home, ".colima", "_lima", "colima-yo", "disk"), "utf8")).toBe(before);
    expect(VM_CHOICE_NEEDED).toMatch(/Nothing is deleted/);
  });

  it("reuse keeps the VM in ~/.colima", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    legacyVm(home);
    const vm = chooseVmHome({ dataDir: data, homeDir: home, profile: "yo", choice: "reuse" });
    expect(vm.state).toBe("ready");
    expect(vm.choice).toBe("reuse");
    expect(vm.colimaHome).toBe(path.join(home, ".colima"));
    expect(vm.limaHome).toBe(path.join(home, ".colima", "_lima"));
    expect(vm.legacyKept).toBe(true);
    expect(fs.readFileSync(path.join(home, ".colima", "_lima", "colima-yo", "disk"), "utf8")).toBe("vm-disk");
    expect(fs.existsSync(path.join(data, "lima", "colima-yo"))).toBe(false);
    // Asking again is a no-op: the recorded choice wins, still nothing deleted.
    const again = chooseVmHome({ dataDir: data, homeDir: home, profile: "yo", choice: "reuse" });
    expect(again.colimaHome).toBe(vm.colimaHome);
    expect(fs.readFileSync(path.join(home, ".colima", "yo", "colima.yaml"), "utf8")).toContain("docker");
  });

  it("move renames only the yo profile into Yo's folder and leaves other profiles", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    legacyVm(home);
    const vm = chooseVmHome({ dataDir: data, homeDir: home, profile: "yo", choice: "move" });
    expect(vm.state).toBe("ready");
    expect(vm.choice).toBe("move");
    expect(vm.colimaHome).toBe(path.join(data, "colima"));
    expect(vm.limaHome).toBe(path.join(data, "lima"));
    expect(vm.legacyKept).toBe(false);
    expect(fs.readFileSync(path.join(data, "lima", "colima-yo", "disk"), "utf8")).toBe("vm-disk");
    expect(fs.readFileSync(path.join(data, "colima", "yo", "colima.yaml"), "utf8")).toContain("docker");
    expect(fs.existsSync(path.join(home, ".colima", "yo"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".colima", "_lima", "colima-yo"))).toBe(false);
    // The other profile is untouched.
    expect(fs.readFileSync(path.join(home, ".colima", "default", "colima.yaml"), "utf8")).toContain("other");
    expect(vm.detail).toMatch(/renamed, not deleted/);
  });

  it("refuses to move over a computer Yo already has, and deletes nothing", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    legacyVm(home);
    const dest = path.join(data, "colima", "yo");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "colima.yaml"), "already: here\n");
    fs.mkdirSync(path.join(data, "lima", "colima-yo"), { recursive: true });
    fs.writeFileSync(path.join(data, "lima", "colima-yo", "lima.yaml"), "vmType: vz\n");
    expect(() => chooseVmHome({ dataDir: data, homeDir: home, profile: "yo", choice: "move" })).toThrow(
      /nothing was deleted/i,
    );
    expect(fs.readFileSync(path.join(home, ".colima", "_lima", "colima-yo", "disk"), "utf8")).toBe("vm-disk");
    expect(fs.readFileSync(path.join(dest, "colima.yaml"), "utf8")).toContain("already");
  });

  it("with both copies already on disk, uses Yo's folder and leaves ~/.colima alone", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    legacyVm(home);
    fs.mkdirSync(path.join(data, "colima", "yo"), { recursive: true });
    fs.writeFileSync(path.join(data, "colima", "yo", "colima.yaml"), "yo: true\n");
    const vm = resolveVmHome({ dataDir: data, homeDir: home, profile: "yo" });
    expect(vm.state).toBe("ready");
    expect(vm.colimaHome).toBe(path.join(data, "colima"));
    expect(vm.legacyKept).toBe(true);
    expect(vm.detail).toMatch(/will not delete/i);
    expect(fs.existsSync(path.join(home, ".colima", "yo", "colima.yaml"))).toBe(true);
  });

  it("moves the Colima 0.10 disk so containers, images and volumes survive, and leaves none of that disk behind", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    colima010(home);
    const vm = chooseVmHome({ dataDir: data, homeDir: home, profile: "yo", choice: "move" });
    const moved = path.join(data, "lima", "_disks", "colima-yo", "datadisk");
    const bytes = fs.readFileSync(moved);
    expect(bytes.equals(DOCKER_DATA)).toBe(true);
    expect(bytes.includes("containers/abc123/config.v2.json")).toBe(true);
    expect(bytes.includes("image/overlay2/imagedb/content/sha256/layer")).toBe(true);
    expect(bytes.includes("volumes/yo-data/_data/hello")).toBe(true);
    expect(fs.existsSync(path.join(home, ".colima", "_lima", "_disks", "colima-yo"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".colima", "_lima", "colima-yo"))).toBe(false);
    expect(fs.readdirSync(path.join(home, ".colima", "_lima", "_disks"))).toEqual(["colima"]);
    expect(fs.readFileSync(path.join(home, ".colima", "_lima", "_disks", "colima", "datadisk"), "utf8")).toBe(
      "other-profile-disk",
    );
    expect(fs.existsSync(path.join(data, "lima", "_disks", "colima"))).toBe(false);
    const lima = fs.readFileSync(path.join(data, "lima", "colima-yo", "lima.yaml"), "utf8");
    expect(lima).toMatch(/name: colima-yo/);
    expect(lima).toMatch(/format: false/);
    expect(fs.readlinkSync(path.join(data, "lima", "_disks", "colima-yo", "in_use_by"))).toBe(
      path.join(data, "lima", "colima-yo"),
    );
    const store = JSON.parse(fs.readFileSync(path.join(data, "colima", "_store", "colima-yo.json"), "utf8"));
    expect(store.disk_formatted).toBe(true);
    expect(store.disk_runtime).toBe("docker");
    expect(vm.legacyKept).toBe(false);
    expect(vm.limaHome).toBe(path.join(data, "lima"));
  });

  it("finishes a Move that already took the instance and left the Docker disk in ~/.colima", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    colima010(home);
    const instance = path.join(home, ".colima", "_lima", "colima-yo");
    const movedInstance = path.join(data, "lima", "colima-yo");
    fs.mkdirSync(path.dirname(movedInstance), { recursive: true });
    fs.renameSync(instance, movedInstance);
    fs.mkdirSync(path.join(data, "colima"), { recursive: true });
    fs.renameSync(path.join(home, ".colima", "yo"), path.join(data, "colima", "yo"));
    fs.mkdirSync(path.join(data, "colima", "_store"), { recursive: true });
    fs.renameSync(
      path.join(home, ".colima", "_store", "colima-yo.json"),
      path.join(data, "colima", "_store", "colima-yo.json"),
    );
    chooseVmHome({ dataDir: data, homeDir: home, profile: "yo", choice: "move" });
    const moved = path.join(data, "lima", "_disks", "colima-yo", "datadisk");
    expect(fs.readFileSync(moved).equals(DOCKER_DATA)).toBe(true);
    expect(fs.existsSync(path.join(home, ".colima", "_lima", "_disks", "colima-yo"))).toBe(false);
    expect(fs.readlinkSync(path.join(data, "lima", "_disks", "colima-yo", "in_use_by"))).toBe(movedInstance);
    expect(fs.readFileSync(path.join(home, ".colima", "_lima", "_disks", "colima", "datadisk"), "utf8")).toBe(
      "other-profile-disk",
    );
  });

  it("puts a half-moved computer back when a later piece cannot move, and deletes nothing", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    colima010(home);
    // The disk's parent is a file, so the disk cannot be moved after the instance, profile and store have.
    fs.mkdirSync(path.join(data, "lima"), { recursive: true });
    fs.writeFileSync(path.join(data, "lima", "_disks"), "not-a-directory");
    expect(() => chooseVmHome({ dataDir: data, homeDir: home, profile: "yo", choice: "move" })).toThrow(
      /nothing was deleted/i,
    );
    expect(fs.readFileSync(path.join(home, ".colima", "_lima", "colima-yo", "disk"), "utf8")).toBe("vm-disk");
    expect(fs.readFileSync(path.join(home, ".colima", "yo", "colima.yaml"), "utf8")).toContain("docker");
    expect(
      fs
        .readFileSync(path.join(home, ".colima", "_lima", "_disks", "colima-yo", "datadisk"))
        .equals(DOCKER_DATA),
    ).toBe(true);
    expect(fs.existsSync(path.join(data, "lima", "colima-yo"))).toBe(false);
    expect(fs.existsSync(path.join(data, "colima", "yo"))).toBe(false);
    expect(fs.existsSync(path.join(data, "colima", "_store", "colima-yo.json"))).toBe(false);
    expect(fs.readFileSync(path.join(data, "lima", "_disks"), "utf8")).toBe("not-a-directory");
  });

  it("refuses before moving anything when the Docker disk is already in both homes", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    colima010(home);
    const destDisk = path.join(data, "lima", "_disks", "colima-yo");
    fs.mkdirSync(destDisk, { recursive: true });
    fs.writeFileSync(path.join(destDisk, "datadisk"), "already-here");
    expect(() => chooseVmHome({ dataDir: data, homeDir: home, profile: "yo", choice: "move" })).toThrow(
      /nothing was deleted/i,
    );
    expect(
      fs
        .readFileSync(path.join(home, ".colima", "_lima", "_disks", "colima-yo", "datadisk"))
        .equals(DOCKER_DATA),
    ).toBe(true);
    expect(fs.existsSync(path.join(home, ".colima", "_lima", "colima-yo", "disk"))).toBe(true);
    expect(fs.existsSync(path.join(data, "lima", "colima-yo"))).toBe(false);
    expect(fs.readFileSync(path.join(destDisk, "datadisk"), "utf8")).toBe("already-here");
  });

  it("a Mac with no existing VM is ready to use Yo's folder", () => {
    const root = tmp();
    const vm = resolveVmHome({
      dataDir: path.join(root, "data"),
      homeDir: path.join(root, "home"),
      profile: "yo",
    });
    expect(vm.state).toBe("ready");
    expect(vm.choice).toBeNull();
    expect(vm.legacyKept).toBe(false);
    expect(vm.colimaHome).toBe(path.join(root, "data", "colima"));
    expect(vm.limaHome).toBe(path.join(root, "data", "lima"));
    expect(vm.detail).toBe("");
  });
});

function dataDirThatOverflows(root: string, folderName: string): string {
  let pad = "p";
  let data = path.join(root, pad, "Library", "Application Support", folderName);
  while (limaSocketFits(path.join(data, "lima"), "colima-yo")) {
    pad += "p";
    data = path.join(root, pad, "Library", "Application Support", folderName);
    if (pad.length > 200) throw new Error("could not build a lima path of 104 characters or more");
  }
  return data;
}

describe("Lima socket length", () => {
  it("keeps LIMA_HOME next to colima when the socket is under 104 characters", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    const vm = resolveVmHome({ dataDir: data, homeDir: home, profile: "yo" });
    expect(vm.limaHome).toBe(path.join(data, "lima"));
    expect(vm.limaShortened).toBe(false);
    expect(limaSocketLength(vm.limaHome, "colima-yo")).toBeLessThan(LIMA_UNIX_PATH_MAX);
  });

  it("uses ~/.yo/lima when Application Support would make the socket 104 characters or more", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = dataDirThatOverflows(root, "Yo");
    expect(limaSocketLength(path.join(data, "lima"), "colima-yo")).toBeGreaterThanOrEqual(LIMA_UNIX_PATH_MAX);
    const vm = resolveVmHome({ dataDir: data, homeDir: home, profile: "yo" });
    expect(vm.limaShortened).toBe(true);
    expect(vm.limaHome).toBe(path.join(home, ".yo", "lima"));
    expect(vm.colimaHome).toBe(path.join(data, "colima"));
    expect(limaSocketFits(vm.limaHome, vm.profileId)).toBe(true);
  });

  it("gives Yo Test its own short directory, and Keep still uses ~/.colima", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = dataDirThatOverflows(root, "Yo Test");
    legacyVm(home);
    const kept = chooseVmHome({ dataDir: data, homeDir: home, profile: "yo", choice: "reuse" });
    expect(kept.limaShortened).toBe(false);
    expect(kept.limaHome).toBe(path.join(home, ".colima", "_lima"));
    expect(fs.readFileSync(path.join(home, ".colima", "_lima", "colima-yo", "disk"), "utf8")).toBe("vm-disk");
    expect(fs.existsSync(path.join(home, ".yo"))).toBe(false);
  });

  it("moves the Docker disk into the short directory and leaves none of it in the old home", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = dataDirThatOverflows(root, "Yo Test");
    colima010(home);
    const vm = chooseVmHome({ dataDir: data, homeDir: home, profile: "yo", choice: "move" });
    expect(vm.limaHome).toBe(path.join(home, ".yo", "lima-yo-test"));
    expect(
      fs.readFileSync(path.join(vm.limaHome, "_disks", "colima-yo", "datadisk")).equals(DOCKER_DATA),
    ).toBe(true);
    expect(fs.existsSync(path.join(home, ".colima", "_lima", "_disks", "colima-yo"))).toBe(false);
    expect(fs.existsSync(path.join(data, "lima"))).toBe(false);
    expect(fs.readFileSync(path.join(data, "colima", "yo", "colima.yaml"), "utf8")).toContain("docker");
    expect(fs.readFileSync(path.join(home, ".colima", "_lima", "_disks", "colima", "datadisk"), "utf8")).toBe(
      "other-profile-disk",
    );
  });

  it("moves a lima folder that is already under Application Support onto the short path", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = dataDirThatOverflows(root, "Yo");
    fs.mkdirSync(path.join(data, "lima", "colima-yo"), { recursive: true });
    fs.writeFileSync(path.join(data, "lima", "colima-yo", "disk"), "vm-disk");
    const vm = resolveVmHome({ dataDir: data, homeDir: home, profile: "yo" });
    ensureVmDirs(vm);
    expect(fs.readFileSync(path.join(home, ".yo", "lima", "colima-yo", "disk"), "utf8")).toBe("vm-disk");
    expect(fs.existsSync(path.join(data, "lima"))).toBe(false);
    expect(fs.readFileSync(path.join(home, ".yo", "lima", "_config", "override.yaml"), "utf8")).toBe(
      LIMA_BOOT_OVERRIDE,
    );
  });

  it("uses a hashed directory when the folder name makes ~/.yo/lima-... too long", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = path.join(root, `${"n".repeat(80)} name`);
    const picked = managedLimaHome(data, home, "colima-yo");
    expect(picked.shortened).toBe(true);
    expect(path.dirname(picked.dir)).toBe(path.join(home, ".yo", "l"));
    expect(path.basename(picked.dir)).toMatch(/^[0-9a-f]{8}$/);
    expect(limaSocketFits(picked.dir, "colima-yo")).toBe(true);
  });
});

describe("Lima boot override", () => {
  it("writes ssh.overVsock false only under Yo's LIMA_HOME, not into a VM kept in ~/.colima", () => {
    const root = tmp();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    colima010(home);
    const kept = chooseVmHome({ dataDir: data, homeDir: home, profile: "yo", choice: "reuse" });
    ensureVmDirs(kept);
    expect(fs.existsSync(path.join(home, ".colima", "_lima", "_config", "override.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(data, "lima", "_config", "override.yaml"))).toBe(false);

    const fresh = resolveVmHome({
      dataDir: path.join(root, "fresh"),
      homeDir: path.join(root, "empty"),
      profile: "yo",
    });
    ensureVmDirs(fresh);
    const file = path.join(root, "fresh", "lima", "_config", "override.yaml");
    expect(fs.readFileSync(file, "utf8")).toBe(LIMA_BOOT_OVERRIDE);
    expect(LIMA_BOOT_OVERRIDE).toMatch(/overVsock: false/);
    expect(LIMA_BOOT_OVERRIDE).toMatch(/internal_netplanOptional: "true"/);

    fs.writeFileSync(file, "# someone else's lima override\nssh:\n  overVsock: true\n");
    ensureVmDirs(fresh);
    expect(fs.readFileSync(file, "utf8")).toContain("someone else's");

    fs.writeFileSync(file, "# yo-lima-override\nssh:\n  overVsock: true\n");
    ensureVmDirs(fresh);
    expect(fs.readFileSync(file, "utf8")).toBe(LIMA_BOOT_OVERRIDE);
  });
});
