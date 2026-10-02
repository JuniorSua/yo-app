/**
 * Fake Macs for the first agent's computer setup (`&mockMac=…`):
 *   strong    M3 Pro, 36 GB, plenty of disk, macOS 15, everything installed (all pass) — the default
 *   intel16   Intel Core i7 (6 cores), 16 GB, macOS 14 (warnings, still allowed)
 *   small     M1, 8 GB, 9 GB free (blocked)
 *   nocolima  like "strong", with Homebrew but without Colima, Docker or Compose
 *   nobrew    like "strong", with nothing installed (not even Homebrew)
 * The UI re-checks while tools are missing; `__yoMock.installTools()` "installs" them.
 */
import type { MachineFacts, ToolFact, ToolId } from "@yo/contracts";

export type MockMac = "strong" | "intel16" | "small" | "nocolima" | "nobrew";

const GB = 1024 ** 3;
const yes = (version: string): ToolFact => ({ installed: true, version });
const no: ToolFact = { installed: false, version: null };

export function installedTools(): Record<ToolId, ToolFact> {
  return {
    homebrew: yes("Homebrew 4.6.12"),
    colima: yes("colima version 0.10.3"),
    docker: yes("Docker version 28.4.0, build d8eb465"),
    compose: yes("Docker Compose version 2.39.4"),
  };
}

export function mockMacFromQuery(q: URLSearchParams): MockMac {
  const v = q.get("mockMac");
  return v === "intel16" || v === "small" || v === "nocolima" || v === "nobrew" ? v : "strong";
}

export function mockMachine(kind: MockMac): MachineFacts {
  const tools = installedTools();
  if (kind === "nocolima" || kind === "nobrew") {
    tools.colima = no;
    tools.docker = no;
    tools.compose = no;
    if (kind === "nobrew") tools.homebrew = no;
  }
  if (kind === "intel16")
    return {
      platform: "darwin",
      totalMemBytes: 16 * GB,
      cpu: {
        model: "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz",
        appleSilicon: false,
        physicalCores: 6,
        logicalCores: 12,
      },
      diskFreeBytes: 64 * GB,
      macosVersion: "14.7.2",
      tools,
    };
  if (kind === "small")
    return {
      platform: "darwin",
      totalMemBytes: 8 * GB,
      cpu: { model: "Apple M1", appleSilicon: true, physicalCores: 8, logicalCores: 8 },
      diskFreeBytes: 9 * GB,
      macosVersion: "15.6",
      tools,
    };
  return {
    platform: "darwin",
    totalMemBytes: 36 * GB,
    cpu: { model: "Apple M3 Pro", appleSilicon: true, physicalCores: 12, logicalCores: 12 },
    diskFreeBytes: 412 * GB,
    macosVersion: "15.6",
    tools,
  };
}
