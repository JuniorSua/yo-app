/**
 * The agent's computer: what a machine needs to run it, and the first agent's "let's set up my computer" chat.
 *
 * The numbers live here ONCE. The app's requirement check (core, web, mock) uses them, and
 * docs/REQUIREMENTS.md explains each one with its sources. The website, README and SETUP_PROMPT.md
 * must quote these values, not their own.
 */

/** Requirement thresholds for running the agent's computer on this Mac. */
export const REQUIREMENTS = {
  /** The Mac's memory. Below the minimum, the VM and macOS fight for memory and both crawl. */
  ram: { minimumGB: 16, recommendedGB: 32 },
  /** Memory the agent's computer gets. Below 2 GB Chromium itself runs out; 4 GB keeps a few tabs open. */
  computerMemory: { minimumGB: 2, recommendedGB: 4 },
  /** What macOS, Yo and the user's own apps keep for themselves before the VM gets anything. */
  hostReserveGB: 8,
  /**
   * CPU. Yo gives the VM 4 CPUs, so fewer physical cores than that can't keep up. Apple silicon runs the
   * arm64 image natively through Apple's Virtualization framework; Intel Macs work but are slower and Homebrew
   * no longer ships ready-made packages for them.
   */
  cpu: { minimumCores: 4, recommendedCores: 8 },
  /** Free disk: the image (~0.9 GB download, ~3 GB unpacked) plus the VM disk, which can grow to 20 GB. */
  disk: { minimumFreeGB: 10, recommendedFreeGB: 20 },
  /**
   * macOS. Colima's `vz` VM type needs macOS 13 (Ventura). Homebrew only ships ready-made Colima and Docker
   * packages for macOS 15 and later (older versions build from source, which is slow and can fail).
   */
  macos: { minimumMajor: 13, recommendedMajor: 15 },
} as const;

/** What Yo gives its computer on this Mac (ComputerLifecycle's `colima start` and computer/compose*.yaml). */
export const LOCAL_COMPUTER = {
  vmCpus: 4,
  vmMemoryGB: 5,
  vmDiskGB: 20,
  /** `mem_limit` of the yo-computer container. */
  containerMemoryMB: 4500,
} as const;

/** Copy-paste commands the setup chat shows (and SETUP_PROMPT.md reuses). All free. */
export const SETUP_COMMANDS = {
  homebrew: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
  /** Apple silicon: Homebrew lives in /opt/homebrew, which a new Terminal doesn't have on its PATH yet. */
  homebrewPath: 'eval "$(/opt/homebrew/bin/brew shellenv)"',
  tools: "brew install colima docker docker-compose",
  /** Homebrew's docker-compose is a Docker CLI plugin: link it where `docker compose` looks. */
  composePlugin:
    'mkdir -p ~/.docker/cli-plugins && ln -sfn "$(brew --prefix)/opt/docker-compose/bin/docker-compose" ~/.docker/cli-plugins/docker-compose',
} as const;

export type CheckStatus = "pass" | "warn" | "block" | "unknown";
export type RequirementId = "ram" | "computerMemory" | "cpu" | "disk" | "macos";
export type ToolId = "homebrew" | "colima" | "docker" | "compose";

export interface ToolFact {
  installed: boolean;
  /** First line of the tool's version output, when it ran. */
  version: string | null;
}

/** What core measured on the machine it runs on. Null = couldn't tell. */
export interface MachineFacts {
  /** process.platform of core ("darwin" on a Mac). */
  platform: string;
  totalMemBytes: number | null;
  cpu: {
    /** e.g. "Apple M2 Pro" or "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz". */
    model: string | null;
    appleSilicon: boolean | null;
    physicalCores: number | null;
    logicalCores: number | null;
  };
  /** Free space for the user's home folder (where Colima keeps its VM disk). */
  diskFreeBytes: number | null;
  /** e.g. "14.5". */
  macosVersion: string | null;
  tools: Record<ToolId, ToolFact>;
}

export interface RequirementItem {
  id: RequirementId;
  label: string;
  status: CheckStatus;
  /** What was found, e.g. "16 GB". */
  value: string;
  /** One sentence in plain words: why it passes, what it means, or what to do. */
  detail: string;
}

export interface ToolItem {
  id: ToolId;
  label: string;
  installed: boolean;
  version: string | null;
}

export interface RequirementsReport {
  /** "local": the computer runs on the machine core runs on. "remote": it lives elsewhere (home server). */
  computerMode: "local" | "remote";
  facts: MachineFacts;
  items: RequirementItem[];
  tools: ToolItem[];
  /** Worst of the items: "block" means this machine can't run the computer. Unknown counts as "warn". */
  verdict: "pass" | "warn" | "block";
  /** Free tools still to install, in install order. */
  missingTools: ToolId[];
  checkedAt: number;
}

export interface SetupApiMethods {
  /** Measure this machine against REQUIREMENTS and look for Homebrew, Colima and the Docker CLI. */
  "setup.requirements": { params: Record<string, never>; result: RequirementsReport };
}

const GB = 1024 ** 3;

/** "16 GB", "7.5 GB" (one decimal below 10). */
export function formatGB(bytes: number): string {
  const gb = bytes / GB;
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

/** Major version from "14.5" / "26.0.1"; null if it isn't a version. */
export function macosMajor(version: string | null): number | null {
  const m = version?.trim().match(/^(\d+)(?:\.\d+)*$/);
  return m ? Number(m[1]) : null;
}

const MACOS_NAMES: Record<number, string> = {
  11: "Big Sur",
  12: "Monterey",
  13: "Ventura",
  14: "Sonoma",
  15: "Sequoia",
  26: "Tahoe",
};

function macosLabel(version: string): string {
  const name = MACOS_NAMES[macosMajor(version) ?? 0];
  return name ? `macOS ${version} (${name})` : `macOS ${version}`;
}

/** Memory the agent's computer gets on a Mac with this much RAM. */
export function computerMemoryGB(totalMemBytes: number): number {
  const spare = totalMemBytes / GB - REQUIREMENTS.hostReserveGB;
  return Math.max(0, Math.min(LOCAL_COMPUTER.containerMemoryMB / 1024, spare));
}

export function checkRam(totalMemBytes: number | null): RequirementItem {
  const base = { id: "ram" as const, label: "Memory" };
  const { minimumGB, recommendedGB } = REQUIREMENTS.ram;
  if (totalMemBytes == null)
    return { ...base, status: "unknown", value: "Unknown", detail: "I couldn't read this Mac's memory." };
  const gb = totalMemBytes / GB;
  const value = formatGB(totalMemBytes);
  // A "16 GB" Mac reports exactly 16 GiB; allow a little slack for machines that report a hair under.
  if (gb < minimumGB - 0.5)
    return {
      ...base,
      status: "block",
      value,
      detail: `I need at least ${minimumGB} GB. With ${value}, my computer and your apps would slow each other to a crawl.`,
    };
  if (gb < recommendedGB - 0.5)
    return {
      ...base,
      status: "warn",
      value,
      detail: `Enough to run me. ${recommendedGB} GB gives your own apps more room while I work.`,
    };
  return { ...base, status: "pass", value, detail: "Plenty of room for my computer and your apps." };
}

export function checkComputerMemory(totalMemBytes: number | null): RequirementItem {
  const base = { id: "computerMemory" as const, label: "Memory for my computer" };
  const { minimumGB, recommendedGB } = REQUIREMENTS.computerMemory;
  if (totalMemBytes == null)
    return {
      ...base,
      status: "unknown",
      value: "Unknown",
      detail: `I'd use up to ${recommendedGB} GB, but I couldn't read this Mac's memory.`,
    };
  const gb = computerMemoryGB(totalMemBytes);
  const value = gb > 0 ? `${Math.floor(gb * 10) / 10} GB` : "None to spare";
  if (gb < minimumGB)
    return {
      ...base,
      status: "block",
      value,
      detail: `My computer needs at least ${minimumGB} GB after macOS and your apps take theirs.`,
    };
  if (gb < recommendedGB)
    return {
      ...base,
      status: "warn",
      value,
      detail: `I can run with this, but pages with lots of tabs will be slow. ${recommendedGB} GB is better.`,
    };
  return {
    ...base,
    status: "pass",
    value,
    detail: "Enough for a full browser and a terminal. It's only used while my computer is on.",
  };
}

export function checkCpu(cpu: MachineFacts["cpu"]): RequirementItem {
  const base = { id: "cpu" as const, label: "Processor" };
  const { minimumCores, recommendedCores } = REQUIREMENTS.cpu;
  const cores = cpu.physicalCores ?? cpu.logicalCores;
  const kind = cpu.appleSilicon === true ? "Apple silicon" : cpu.appleSilicon === false ? "Intel" : null;
  const chip =
    cpu.model
      ?.replace(/\(R\)|\(TM\)|CPU|@.*$/g, "")
      .replace(/\s+/g, " ")
      .trim() || kind;
  const value = [chip, cores ? `${cores} cores` : null].filter(Boolean).join(", ") || "Unknown";
  if (cores == null || cpu.appleSilicon == null)
    return { ...base, status: "unknown", value, detail: "I couldn't tell which processor this Mac has." };
  if (cores < minimumCores)
    return {
      ...base,
      status: "block",
      value,
      detail: `I need at least ${minimumCores} cores. My computer alone uses ${LOCAL_COMPUTER.vmCpus}.`,
    };
  if (!cpu.appleSilicon)
    return {
      ...base,
      status: "warn",
      value,
      detail:
        "Intel Macs work, but more slowly, and installing Docker takes a while because Homebrew builds it from source.",
    };
  if (cores < recommendedCores)
    return {
      ...base,
      status: "warn",
      value,
      detail: `This works. ${recommendedCores} or more cores keeps your Mac snappy while I work.`,
    };
  return { ...base, status: "pass", value, detail: "Apple silicon runs my computer natively and quickly." };
}

export function checkDisk(diskFreeBytes: number | null): RequirementItem {
  const base = { id: "disk" as const, label: "Free disk space" };
  const { minimumFreeGB, recommendedFreeGB } = REQUIREMENTS.disk;
  if (diskFreeBytes == null)
    return {
      ...base,
      status: "unknown",
      value: "Unknown",
      detail: `I couldn't check. Make sure about ${recommendedFreeGB} GB is free.`,
    };
  const gb = diskFreeBytes / GB;
  const value = `${formatGB(diskFreeBytes)} free`;
  if (gb < minimumFreeGB)
    return {
      ...base,
      status: "block",
      value,
      detail: `I need at least ${minimumFreeGB} GB free to download and unpack my computer. Free up some space first.`,
    };
  if (gb < recommendedFreeGB)
    return {
      ...base,
      status: "warn",
      value,
      detail: `Enough to start. My computer's disk can grow to ${LOCAL_COMPUTER.vmDiskGB} GB, so about ${recommendedFreeGB} GB free is safer.`,
    };
  return { ...base, status: "pass", value, detail: "Room for my computer and the files I make." };
}

export function checkMacos(platform: string, version: string | null): RequirementItem {
  const base = { id: "macos" as const, label: "macOS version" };
  const { minimumMajor, recommendedMajor } = REQUIREMENTS.macos;
  if (platform !== "darwin")
    return {
      ...base,
      status: "warn",
      value: platform === "linux" ? "Linux" : platform,
      detail: "This isn't a Mac. Yo's app is made for macOS; running here is for development only.",
    };
  const major = macosMajor(version);
  if (!version || major == null)
    return { ...base, status: "unknown", value: "Unknown", detail: "I couldn't read the macOS version." };
  const value = macosLabel(version);
  if (major < minimumMajor)
    return {
      ...base,
      status: "block",
      value,
      detail: `My computer needs macOS ${minimumMajor} (Ventura) or later. Update in System Settings → General → Software Update.`,
    };
  if (major < recommendedMajor)
    return {
      ...base,
      status: "warn",
      value,
      detail: `This works, but Homebrew builds the tools from source on it, which is slow. macOS ${recommendedMajor} or later is smoother.`,
    };
  return { ...base, status: "pass", value, detail: "Up to date enough for my computer." };
}

const TOOL_LABEL: Record<ToolId, string> = {
  homebrew: "Homebrew",
  colima: "Colima",
  docker: "Docker CLI",
  compose: "Docker Compose",
};
const TOOL_ORDER: ToolId[] = ["homebrew", "colima", "docker", "compose"];

const RANK: Record<CheckStatus, number> = { pass: 0, unknown: 1, warn: 1, block: 2 };

/** The whole check, from what core measured. Pure: core, the web mock and tests all use it. */
export function evaluateRequirements(
  facts: MachineFacts,
  computerMode: "local" | "remote" = "local",
  now = Date.now(),
): RequirementsReport {
  const items = [
    checkRam(facts.totalMemBytes),
    checkComputerMemory(facts.totalMemBytes),
    checkCpu(facts.cpu),
    checkDisk(facts.diskFreeBytes),
    checkMacos(facts.platform, facts.macosVersion),
  ];
  const worst = Math.max(...items.map((i) => RANK[i.status]));
  const tools = TOOL_ORDER.map((id) => ({
    id,
    label: TOOL_LABEL[id],
    installed: facts.tools[id].installed,
    version: facts.tools[id].version,
  }));
  // Homebrew is only needed to install what's missing.
  const missing = tools.filter((t) => !t.installed && t.id !== "homebrew").map((t) => t.id);
  const missingTools: ToolId[] =
    missing.length && !facts.tools.homebrew.installed ? ["homebrew", ...missing] : missing;
  return {
    computerMode,
    facts,
    items,
    tools,
    verdict: worst === 2 ? "block" : worst === 1 ? "warn" : "pass",
    missingTools,
    checkedAt: now,
  };
}
