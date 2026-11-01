/**
 * An agent's memory focus (see @yo/contracts memoryLabels.ts): Yo works on Work and Everywhere memories, Pip on
 * Personal and Everywhere, and an agent with no focus on every memory. It only decides what the prompt shows and
 * where `remember` saves by default; `recall` searches everything.
 */
import type { Agent, MemoryLabel } from "@yo/contracts";
import type { Store } from "../db/store";

/** The agent's own focus, or its parent's for a helper; undefined when it has none. */
export function memoryFocus(
  store: Pick<Store, "getAgent">,
  agent: Pick<Agent, "space" | "kind" | "parentId"> | null | undefined,
): MemoryLabel | undefined {
  if (!agent) return undefined;
  const own = agent.kind === "helper" && agent.parentId ? store.getAgent(agent.parentId) : agent;
  return own?.space ?? undefined;
}
