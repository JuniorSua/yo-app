// smoke-bundled-tools.mjs: a clean install resolves bundled tools when Homebrew's paths are absent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLE_FILES, resolveTools } from "../../core/src/computer/hostTools.ts";
import {
  assertBundleBinaries,
  assertBundledResolution,
  checkInstalledApp,
  execVersion,
  installedAppEnv,
  isInside,
  looksLikeShellScript,
  machOArm64,
  runBundledVersions,
  versionAttempts,
} from "./smoke-bundled-tools.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "yo-smoke-"));
  dirs.push(d);
  return d;
}

/** Little-endian 64-bit Mach-O header with the given cputype. */
function thinLe(cputype) {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(0xcffaedfe, 0);
  buf.writeUInt32LE(cputype, 4);
  return buf;
}

function arm64() {
  return thinLe(0x0100000c);
}

function fakeApp(root) {
  const resources = path.join(root, "Contents", "Resources");
  for (const rel of BUNDLE_FILES) {
    const file = path.join(resources, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = rel === "bin/lima" ? '#!/bin/sh\nexec limactl "$@"\n' : arm64();
    fs.writeFileSync(file, body, { mode: 0o755 });
  }
  return resources;
}

describe("Mach-O arm64", () => {
  it("recognizes thin and fat arm64, and not x86_64 or a shell script", () => {
    expect(machOArm64(arm64())).toBe(true);
    const big = Buffer.alloc(32);
    big.writeUInt32BE(0xfeedfacf, 0);
    big.writeUInt32BE(0x0100000c, 4);
    expect(machOArm64(big)).toBe(true);
    const fat = Buffer.alloc(28);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(1, 4);
    fat.writeUInt32BE(0x0100000c, 8);
    expect(machOArm64(fat)).toBe(true);
    expect(machOArm64(thinLe(0x01000007))).toBe(false);
    const script = Buffer.from('#!/bin/sh\nexec limactl "$@"\n');
    expect(machOArm64(script)).toBe(false);
    expect(looksLikeShellScript(script)).toBe(true);
    expect(machOArm64(Buffer.alloc(0))).toBe(false);
  });
});

describe("bundled resolution", () => {
  it("keeps a path only when it is inside the app", () => {
    const app = path.join(tmp(), "Yo.app");
    const resources = path.join(app, "Contents", "Resources");
    expect(isInside(resources, path.join(resources, "bin", "colima"))).toBe(true);
    expect(isInside(resources, "/opt/homebrew/bin/colima")).toBe(false);
    expect(isInside(resources, resources)).toBe(false);
  });

  it("rejects a Homebrew resolution", () => {
    const app = path.join(tmp(), "Yo.app");
    expect(() =>
      assertBundledResolution(app, {
        source: "homebrew",
        binDir: null,
        colima: "/opt/homebrew/bin/colima",
        limactl: "/opt/homebrew/bin/limactl",
        docker: "/usr/local/bin/docker",
        compose: "/opt/homebrew/bin/docker-compose",
      }),
    ).toThrow(/bundled/);
  });

  it("resolves the fake bundle when Homebrew's absolute paths are not used", () => {
    const app = path.join(tmp(), "Yo.app");
    const resources = fakeApp(app);
    const brew = path.join(tmp(), "brew", "bin");
    fs.mkdirSync(brew, { recursive: true });
    fs.writeFileSync(path.join(brew, "colima"), "brew");
    fs.writeFileSync(path.join(brew, "docker"), "brew");
    const tools = resolveTools({
      bundledRoot: resources,
      homeDir: tmp(),
      homebrewBins: [brew],
    });
    expect(assertBundledResolution(app, tools).colima).toBe(path.join(resources, "bin", "colima"));
    expect(tools.source).toBe("bundled");
    assertBundleBinaries(resources);
  });

  it("fails when a bundled binary is not arm64", () => {
    const app = path.join(tmp(), "Yo.app");
    const resources = fakeApp(app);
    fs.writeFileSync(path.join(resources, "bin", "docker"), thinLe(0x01000007), { mode: 0o755 });
    expect(() => assertBundleBinaries(resources)).toThrow(/docker is not an arm64/);
  });

  it("fails when lima is neither arm64 nor a shell wrapper", () => {
    const app = path.join(tmp(), "Yo.app");
    const resources = fakeApp(app);
    fs.writeFileSync(path.join(resources, "bin", "lima"), "not a binary", { mode: 0o755 });
    expect(() => assertBundleBinaries(resources)).toThrow(/shell wrapper/);
  });
});

describe("version commands", () => {
  it("tries colima --version before version, and --version only for the others", () => {
    expect(versionAttempts("colima")).toEqual([["--version"], ["version"]]);
    expect(versionAttempts("limactl")).toEqual([["--version"]]);
    expect(versionAttempts("docker")).toEqual([["--version"]]);
    const calls = [];
    const lines = runBundledVersions("/Yo.app/Contents/Resources/bin", (file, args) => {
      calls.push([path.basename(file), [...args]]);
      if (path.basename(file) === "colima" && args[0] === "--version") throw new Error("unknown flag");
      return `${path.basename(file)} 1.0\n`;
    });
    expect(calls[0]).toEqual(["colima", ["--version"]]);
    expect(calls[1]).toEqual(["colima", ["version"]]);
    expect(calls.map((c) => c[0])).toEqual([
      "colima",
      "colima",
      "lima",
      "limactl",
      "docker",
      "docker-compose",
    ]);
    expect(lines[0]).toBe("colima version: colima 1.0");
  });

  it("checks a complete app through resolveTools, probing the real Homebrew paths", () => {
    const home = tmp();
    const app = path.join(home, "Yo.app");
    fakeApp(app);
    // No homebrewBins override: resolveTools looks at /opt/homebrew/bin and /usr/local/bin.
    // A complete bundle still wins, which is what the clean-install smoke needs.
    const { tools, lines } = checkInstalledApp(app, {
      homeDir: home,
      run: (file) => `${path.basename(file)} ok`,
    });
    expect(tools.source).toBe("bundled");
    expect(tools.colima).toBe(path.join(app, "Contents", "Resources", "bin", "colima"));
    expect(lines).toHaveLength(5);
  });

  it("runs version commands with launchEnv so the bundled bin is first on PATH", () => {
    const home = tmp();
    const app = path.join(home, "Yo.app");
    fakeApp(app);
    const data = path.join(home, "data");
    const seen = [];
    const { env } = checkInstalledApp(app, {
      homeDir: home,
      dataDir: data,
      baseEnv: { PATH: "/usr/bin:/bin", HOME: home },
      run: (file, _args, childEnv) => {
        seen.push(childEnv);
        return `${path.basename(file)} ok`;
      },
    });
    const bin = path.join(app, "Contents", "Resources", "bin");
    expect(String(env.PATH).split(":")[0]).toBe(bin);
    expect(env.COLIMA_HOME).toBe(path.join(data, "colima"));
    expect(env.DOCKER_CONFIG).toBe(path.join(data, "docker"));
    expect(seen).toHaveLength(5);
    for (const childEnv of seen) expect(childEnv).toBe(env);
  });

  it("really runs lima --version when the wrapper execs limactl by name", () => {
    const home = tmp();
    const app = path.join(home, "Yo.app");
    const resources = fakeApp(app);
    const bin = path.join(resources, "bin");
    const data = path.join(home, "data");
    // Lima's wrapper execs `limactl` by name (LIMACTL defaults to that). It does not use a sibling path.
    fs.writeFileSync(path.join(bin, "lima"), '#!/bin/sh\nexec limactl "$@"\n', { mode: 0o755 });
    for (const name of ["colima", "limactl", "docker", "docker-compose"]) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} version-ok"\n`, { mode: 0o755 });
    }
    const bare = { PATH: "/usr/bin:/bin", HOME: home };
    expect(() => execVersion(path.join(bin, "lima"), ["--version"], bare)).toThrow(/limactl/);
    const env = installedAppEnv(app, { homeDir: home, dataDir: data, baseEnv: bare });
    const lines = runBundledVersions(bin, execVersion, env);
    expect(lines).toContain("lima --version: limactl version-ok");
    expect(lines).toContain("limactl --version: limactl version-ok");
  });
});
