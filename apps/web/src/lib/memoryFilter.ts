/**
 * Filters for the Memory page: by space (All · Work · Personal · Everywhere) and, for memories older teammates
 * keep to themselves, by agent. Pure, so it's tested without a browser.
 */
import { type Memory, resolveSpace, type Settings, type Space } from "@yo/contracts";

export type SpaceFilter = "all" | Space | "everywhere";
/** null = any agent; "shared" = memories no single agent owns; else an agent id. */
export type AgentFilter = string | null;

/** A memory's space, with older memories (no space at all) counting as Everywhere. */
export function memorySpace(m: Pick<Memory, "space">): Space | null {
  return m.space ?? null;
}

export function matchesSpace(m: Pick<Memory, "space">, f: SpaceFilter): boolean {
  if (f === "all") return true;
  const s = memorySpace(m);
  return f === "everywhere" ? s === null : s === f;
}

export function matchesAgent(m: Pick<Memory, "agentId">, f: AgentFilter): boolean {
  if (f === null) return true;
  return f === "shared" ? m.agentId === null : m.agentId === f;
}

export function filterMemories<M extends Pick<Memory, "space" | "agentId">>(
  memories: readonly M[],
  space: SpaceFilter,
  agent: AgentFilter = null,
): M[] {
  return memories.filter((m) => matchesSpace(m, space) && matchesAgent(m, agent));
}

/** How many memories each space filter shows (after the agent filter, so the numbers match the list). */
export function spaceCounts(
  memories: readonly Pick<Memory, "space" | "agentId">[],
  agent: AgentFilter = null,
): Record<SpaceFilter, number> {
  const c: Record<SpaceFilter, number> = { all: 0, work: 0, personal: 0, everywhere: 0 };
  for (const m of memories) {
    if (!matchesAgent(m, agent)) continue;
    c.all++;
    c[memorySpace(m) ?? "everywhere"]++;
  }
  return c;
}

/** Where a memory typed on the Memory page goes by default: the space you're in, or Everywhere with spaces off. */
export function defaultMemorySpace(
  settings: Partial<Pick<Settings, "spacesOn" | "workHours" | "spaceManual" | "timezone">>,
  now: number = Date.now(),
): Space | null {
  return settings.spacesOn ? resolveSpace(now, settings).space : null;
}

/** The move-to choices, in menu order (null = Everywhere). */
export const SPACE_CHOICES: { value: Space | null; key: Space | "everywhere"; label: string }[] = [
  { value: "work", key: "work", label: "Work" },
  { value: "personal", key: "personal", label: "Personal" },
  { value: null, key: "everywhere", label: "Everywhere" },
];
