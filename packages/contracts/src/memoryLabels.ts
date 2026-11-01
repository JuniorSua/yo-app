/**
 * Memory labels. A memory can be labelled Work or Personal (null: Everywhere, for core facts such as the user's
 * name and home), and an agent can have a memory focus (Yo: work, Pip: personal; most agents have none). An
 * agent's prompt shows the memories of its focus plus the Everywhere ones; an agent with no focus sees them all,
 * and `recall` searches every memory whatever its label. Both are stored as `space` on agents and memories.
 */
import { z } from "zod";
import { normalizeArea } from "./lifeMap";

export const MemoryLabel = z.enum(["work", "personal"]);
export type MemoryLabel = z.infer<typeof MemoryLabel>;

/**
 * A main agent: the primary (Yo) or one with its own memory focus (Pip). Main agents get the front-door tools
 * (helpers, phone links, suggested tasks, the brief); other teammates and helpers don't.
 */
export function isLead(a: { kind?: string | null; isPrimary?: boolean; space?: string | null }): boolean {
  return a.kind !== "helper" && (!!a.isPrimary || !!a.space);
}

/** What the apps call each label. */
export const MEMORY_LABEL_NAMES: Record<MemoryLabel, string> = { work: "Work", personal: "Personal" };

/** A life-map area that names a label ("work", "Personal"), or null for any other area. */
export function labelOfArea(area: string | null | undefined): MemoryLabel | null {
  const a = area ? normalizeArea(area) : "";
  return a === "work" || a === "personal" ? a : null;
}
