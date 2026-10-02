import { describe, expect, it } from "vitest";
import {
  checkComputerMemory,
  checkCpu,
  checkDisk,
  checkMacos,
  checkRam,
  computerMemoryGB,
  evaluateRequirements,
  formatGB,
  type MachineFacts,
  macosMajor,
  REQUIREMENTS,
} from "./setup";

const GB = 1024 ** 3;
const tools = (installed: boolean) => ({
  homebrew: { installed: true, version: "Homebrew 4.6.12" },
  colima: { installed, version: installed ? "colima version 0.10.3" : null },
  docker: { installed, version: installed ? "Docker version 28.4.0" : null },
  compose: { installed, version: installed ? "Docker Compose version 2.39.4" : null },
});

function mac(over: Partial<MachineFacts> = {}): MachineFacts {
  return {
    platform: "darwin",
    totalMemBytes: 32 * GB,
    cpu: { model: "Apple M2 Pro", appleSilicon: true, physicalCores: 10, logicalCores: 10 },
    diskFreeBytes: 200 * GB,
    macosVersion: "15.6",
    tools: tools(true),
    ...over,
  };
}

describe("requirement thresholds", () => {
  it("are the launch numbers", () => {
    expect(REQUIREMENTS.ram).toEqual({ minimumGB: 16, recommendedGB: 32 });
    expect(REQUIREMENTS.computerMemory).toEqual({ minimumGB: 2, recommendedGB: 4 });
    expect(REQUIREMENTS.disk.recommendedFreeGB).toBe(20);
    expect(REQUIREMENTS.macos.minimumMajor).toBe(13);
  });

  it("memory: 8 GB blocks, 16 GB warns, 32 GB passes", () => {
    expect(checkRam(8 * GB).status).toBe("block");
    expect(checkRam(15 * GB).status).toBe("block");
    expect(checkRam(16 * GB).status).toBe("warn");
    expect(checkRam(24 * GB).status).toBe("warn");
    expect(checkRam(32 * GB).status).toBe("pass");
    expect(checkRam(36 * GB).value).toBe("36 GB");
    expect(checkRam(null).status).toBe("unknown");
  });

  it("memory for the computer follows what macOS leaves over", () => {
    expect(computerMemoryGB(8 * GB)).toBe(0);
    expect(computerMemoryGB(11 * GB)).toBe(3);
    expect(computerMemoryGB(16 * GB)).toBeCloseTo(4500 / 1024);
    expect(checkComputerMemory(8 * GB).status).toBe("block");
    expect(checkComputerMemory(11 * GB).status).toBe("warn");
    expect(checkComputerMemory(16 * GB).status).toBe("pass");
    expect(checkComputerMemory(null).status).toBe("unknown");
  });

  it("processor: Apple silicon passes, Intel warns, under 4 cores blocks", () => {
    expect(
      checkCpu({ model: "Apple M1", appleSilicon: true, physicalCores: 8, logicalCores: 8 }).status,
    ).toBe("pass");
    const intel = checkCpu({
      model: "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz",
      appleSilicon: false,
      physicalCores: 6,
      logicalCores: 12,
    });
    expect(intel.status).toBe("warn");
    expect(intel.value).toBe("Intel Core i7-9750H, 6 cores");
    // Physical cores count, not hyperthreads.
    expect(checkCpu({ model: "Intel", appleSilicon: false, physicalCores: 2, logicalCores: 4 }).status).toBe(
      "block",
    );
    expect(
      checkCpu({ model: null, appleSilicon: null, physicalCores: null, logicalCores: null }).status,
    ).toBe("unknown");
  });

  it("disk: under 10 GB blocks, under 20 GB warns", () => {
    expect(checkDisk(9 * GB).status).toBe("block");
    expect(checkDisk(15 * GB).status).toBe("warn");
    expect(checkDisk(20 * GB).status).toBe("pass");
    expect(checkDisk(null).status).toBe("unknown");
  });

  it("macOS: 12 blocks, 13-14 warn, 15+ passes; not a Mac warns", () => {
    expect(checkMacos("darwin", "12.7.6").status).toBe("block");
    expect(checkMacos("darwin", "13.0").status).toBe("warn");
    expect(checkMacos("darwin", "14.7.2").value).toBe("macOS 14.7.2 (Sonoma)");
    expect(checkMacos("darwin", "15.6").status).toBe("pass");
    expect(checkMacos("darwin", "26.0.1").status).toBe("pass");
    expect(checkMacos("darwin", null).status).toBe("unknown");
    expect(checkMacos("linux", null).status).toBe("warn");
  });

  it("parses versions and formats sizes", () => {
    expect(macosMajor("14.5")).toBe(14);
    expect(macosMajor("26")).toBe(26);
    expect(macosMajor("garbage")).toBeNull();
    expect(formatGB(7.5 * GB)).toBe("7.5 GB");
    expect(formatGB(412 * GB)).toBe("412 GB");
  });
});

describe("evaluateRequirements", () => {
  it("a strong Mac with everything installed passes", () => {
    const r = evaluateRequirements(mac(), "local", 1);
    expect(r.verdict).toBe("pass");
    expect(r.missingTools).toEqual([]);
    expect(r.items.map((i) => i.id)).toEqual(["ram", "computerMemory", "cpu", "disk", "macos"]);
    expect(r.checkedAt).toBe(1);
  });

  it("a 16 GB Intel Mac warns but isn't blocked", () => {
    const r = evaluateRequirements(
      mac({
        totalMemBytes: 16 * GB,
        cpu: { model: "Intel Core i5", appleSilicon: false, physicalCores: 4, logicalCores: 8 },
      }),
    );
    expect(r.verdict).toBe("warn");
  });

  it("an 8 GB Mac is blocked", () => {
    expect(evaluateRequirements(mac({ totalMemBytes: 8 * GB })).verdict).toBe("block");
  });

  it("unknown counts as a warning, never a block", () => {
    expect(evaluateRequirements(mac({ diskFreeBytes: null, macosVersion: null })).verdict).toBe("warn");
  });

  it("lists missing tools in install order, with Homebrew only when something needs it", () => {
    expect(evaluateRequirements(mac({ tools: tools(false) })).missingTools).toEqual([
      "colima",
      "docker",
      "compose",
    ]);
    const noBrew = { ...tools(false), homebrew: { installed: false, version: null } };
    expect(evaluateRequirements(mac({ tools: noBrew })).missingTools).toEqual([
      "homebrew",
      "colima",
      "docker",
      "compose",
    ]);
    const onlyBrewMissing = { ...tools(true), homebrew: { installed: false, version: null } };
    expect(evaluateRequirements(mac({ tools: onlyBrewMissing })).missingTools).toEqual([]);
  });
});
