/**
 * Filters for the Memory page: by label (All · Work · Personal · Everywhere) and, for memories a teammate keeps to
 * itself, by agent. Pure, so it's tested without a browser.
 */
import type { AgentView, Memory, MemoryLabel } from "@yo/contracts";

export type LabelFilter = "all" | MemoryLabel | "everywhere";
/** null = any agent; "shared" = memories no single agent owns; else an agent id. */
export type AgentFilter = string | null;

/** A memory's label, with older memories (no label at all) counting as Everywhere. */
export function memoryLabel(m: Pick<Memory, "space">): MemoryLabel | null {
  return m.space ?? null;
}

export function matchesLabel(m: Pick<Memory, "space">, f: LabelFilter): boolean {
  if (f === "all") return true;
  const l = memoryLabel(m);
  return f === "everywhere" ? l === null : l === f;
}

export function matchesAgent(m: Pick<Memory, "agentId">, f: AgentFilter): boolean {
  if (f === null) return true;
  return f === "shared" ? m.agentId === null : m.agentId === f;
}

export function filterMemories<M extends Pick<Memory, "space" | "agentId">>(
  memories: readonly M[],
  label: LabelFilter,
  agent: AgentFilter = null,
): M[] {
  return memories.filter((m) => matchesLabel(m, label) && matchesAgent(m, agent));
}

/** How many memories each label filter shows (after the agent filter, so the numbers match the list). */
export function labelCounts(
  memories: readonly Pick<Memory, "space" | "agentId">[],
  agent: AgentFilter = null,
): Record<LabelFilter, number> {
  const c: Record<LabelFilter, number> = { all: 0, work: 0, personal: 0, everywhere: 0 };
  for (const m of memories) {
    if (!matchesAgent(m, agent)) continue;
    c.all++;
    c[memoryLabel(m) ?? "everywhere"]++;
  }
  return c;
}

/** The labels a memory can have, in menu order (null = Everywhere). */
export const LABEL_CHOICES: { value: MemoryLabel | null; key: MemoryLabel | "everywhere"; label: string }[] =
  [
    { value: "work", key: "work", label: "Work" },
    { value: "personal", key: "personal", label: "Personal" },
    { value: null, key: "everywhere", label: "Everywhere" },
  ];

/**
 * Whose prompt shows a memory with this label: agents focused on it and agents with no focus ("Yo and Pepe see
 * it"), or "Every agent sees it". `recall` finds it either way.
 */
export function whoSees(
  label: MemoryLabel | null,
  agents: readonly Pick<AgentView, "name" | "space">[],
): string {
  const shown = label ? agents.filter((a) => !a.space || a.space === label) : agents;
  if (shown.length === agents.length) return "Every agent sees it";
  if (!shown.length) return "Found when an agent searches memory";
  const names = shown.map((a) => a.name);
  const list =
    names.length <= 3
      ? names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
      : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return `${list} ${shown.length === 1 ? "sees" : "see"} it`;
}
