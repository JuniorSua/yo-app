import { describe, expect, it } from "vitest";
import { colimaArch } from "../computer/ComputerLifecycle";
import {
  firstLine,
  macosFromDarwin,
  parseCount,
  parseSwVers,
  probeMachine,
  probeTools,
  type Runner,
} from "./probe";

const GB = 1024 ** 3;

/** A fake shell: `outputs["cmd arg…"]` is stdout; anything else fails like a missing binary. */
function fakeRunner(outputs: Record<string, string>): Runner & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (cmd: string, args: string[]) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    if (key in outputs) return outputs[key]!;
    const err = new Error(`spawn ${cmd} ENOENT`) as Error & { code: string };
    err.code = "ENOENT";
    throw err;
  }) as Runner & { calls: string[] };
  run.calls = calls;
  return run;
}

const APPLE_M2 = {
  "sysctl -n machdep.cpu.brand_string": "Apple M2 Pro\n",
  "sysctl -n hw.optional.arm64": "1\n",
  "sysctl -n hw.physicalcpu": "10\n",
  "sysctl -n hw.logicalcpu": "10\n",
  "sw_vers -productVersion": "15.6.1\n",
  "brew --version": "Homebrew 4.6.12\n",
  "colima version": "colima version 0.10.3\ngit commit: 1234\n",
  "docker --version": "Docker version 28.4.0, build d8eb465\n",
  "docker compose version": "Docker Compose version 2.39.4\n",
};

const base = {
  platform: "darwin" as const,
  totalmem: () => 32 * GB,
  cpus: () => Array.from({ length: 10 }, () => ({ model: "Apple M2 Pro" })),
  release: () => "24.6.0",
  freeBytes: async () => 120 * GB,
  home: () => "/tmp/fake-home",
};

describe("probe parsing", () => {
  it("reads sw_vers in both forms", () => {
    expect(parseSwVers("14.5\n")).toBe("14.5");
    expect(parseSwVers("ProductName:\tmacOS\nProductVersion:\t15.6.1\nBuildVersion:\t24G90\n")).toBe(
      "15.6.1",
    );
    expect(parseSwVers("")).toBeNull();
    expect(parseSwVers(null)).toBeNull();
    expect(parseSwVers("command not found")).toBeNull();
  });

  it("maps Darwin releases to macOS versions", () => {
    expect(macosFromDarwin("22.6.0")).toBe("13.0");
    expect(macosFromDarwin("24.6.0")).toBe("15.0");
    expect(macosFromDarwin("25.0.0")).toBe("26.0");
    expect(macosFromDarwin("19.6.0")).toBeNull();
    expect(macosFromDarwin("")).toBeNull();
  });

  it("parses counts and version lines", () => {
    expect(parseCount("8\n")).toBe(8);
    expect(parseCount("0")).toBeNull();
    expect(parseCount("abc")).toBeNull();
    expect(parseCount(null)).toBeNull();
    expect(firstLine("\n  colima version 0.10.3\nmore")).toBe("colima version 0.10.3");
    expect(firstLine("")).toBeNull();
  });
});

describe("probeMachine", () => {
  it("measures an Apple silicon Mac with everything installed", async () => {
    const f = await probeMachine({ ...base, run: fakeRunner(APPLE_M2) });
    expect(f).toEqual({
      platform: "darwin",
      totalMemBytes: 32 * GB,
      cpu: { model: "Apple M2 Pro", appleSilicon: true, physicalCores: 10, logicalCores: 10 },
      diskFreeBytes: 120 * GB,
      macosVersion: "15.6.1",
      tools: {
        homebrew: { installed: true, version: "Homebrew 4.6.12" },
        colima: { installed: true, version: "colima version 0.10.3" },
        docker: { installed: true, version: "Docker version 28.4.0, build d8eb465" },
        compose: { installed: true, version: "Docker Compose version 2.39.4" },
      },
    });
  });

  it("an Intel Mac: arm64 flag 0, hyperthreads counted separately", async () => {
    const f = await probeMachine({
      ...base,
      run: fakeRunner({
        "sysctl -n machdep.cpu.brand_string": "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz",
        "sysctl -n hw.optional.arm64": "0",
        "sysctl -n hw.physicalcpu": "6",
        "sysctl -n hw.logicalcpu": "12",
        "sw_vers -productVersion": "14.7.2",
      }),
    });
    expect(f.cpu).toEqual({
      model: "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz",
      appleSilicon: false,
      physicalCores: 6,
      logicalCores: 12,
    });
    expect(f.tools.colima).toEqual({ installed: false, version: null });
  });

  it("missing sw_vers, sysctl and colima give unknowns, not errors", async () => {
    const f = await probeMachine({
      ...base,
      cpus: () => [],
      release: () => "not-a-version",
      freeBytes: async () => {
        throw new Error("EACCES");
      },
      run: fakeRunner({}),
    });
    expect(f.macosVersion).toBeNull();
    expect(f.cpu).toEqual({ model: null, appleSilicon: null, physicalCores: null, logicalCores: null });
    expect(f.diskFreeBytes).toBeNull();
    expect(Object.values(f.tools).every((t) => !t.installed)).toBe(true);
  });

  it("falls back to the Darwin version when sw_vers is missing", async () => {
    const f = await probeMachine({ ...base, run: fakeRunner({}) });
    expect(f.macosVersion).toBe("15.0");
    // os.cpus() still says Apple: Apple silicon even without sysctl.
    expect(f.cpu.appleSilicon).toBe(true);
    expect(f.cpu.physicalCores).toBe(10);
  });

  it("survives os probes that throw", async () => {
    const f = await probeMachine({
      ...base,
      totalmem: () => {
        throw new Error("boom");
      },
      cpus: () => {
        throw new Error("boom");
      },
      run: fakeRunner(APPLE_M2),
    });
    expect(f.totalMemBytes).toBeNull();
    expect(f.cpu.physicalCores).toBe(10);
  });

  it("doesn't run Mac-only commands elsewhere", async () => {
    const run = fakeRunner({});
    const f = await probeMachine({ ...base, platform: "linux", arch: "x64", run });
    expect(f.macosVersion).toBeNull();
    expect(f.cpu.appleSilicon).toBe(false);
    expect(run.calls.some((c) => c.startsWith("sysctl") || c.startsWith("sw_vers"))).toBe(false);
  });

  it("probeTools: docker without the compose plugin", async () => {
    const t = await probeTools(fakeRunner({ "docker --version": "Docker version 28.4.0" }));
    expect(t.docker.installed).toBe(true);
    expect(t.compose.installed).toBe(false);
  });
});

describe("colimaArch", () => {
  it("matches the Mac, even under Rosetta", async () => {
    expect(await colimaArch(async () => "", "arm64")).toBe("aarch64");
    expect(await colimaArch(async () => "1\n", "x64")).toBe("aarch64");
    expect(await colimaArch(async () => "0\n", "x64")).toBe("x86_64");
    expect(
      await colimaArch(async () => {
        throw new Error("no sysctl");
      }, "x64"),
    ).toBe("x86_64");
  });
});
