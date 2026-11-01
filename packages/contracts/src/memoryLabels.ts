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
 * The lead: the primary agent (Yo), the only one the user talks to (docs/one-yo.md). It gets the front-door tools
 * (helpers, adding specialists, phone links, suggested tasks, the brief). A memory focus (Pip: personal) doesn't
 * make an agent a lead: specialists and helpers never are.
 */
export function isLead(a: { kind?: string | null; isPrimary?: boolean; space?: string | null }): boolean {
  return a.kind !== "helper" && !!a.isPrimary;
}

/** A specialist: a long-lived agent with a job that works for Yo (`kind` "agent" or absent, not the primary). */
export function isSpecialist(a: {
  kind?: string | null;
  isPrimary?: boolean;
  space?: string | null;
}): boolean {
  return a.kind !== "helper" && !a.isPrimary;
}

/** What the apps call each label. */
export const MEMORY_LABEL_NAMES: Record<MemoryLabel, string> = { work: "Work", personal: "Personal" };

/** A life-map area that names a label ("work", "Personal"), or null for any other area. */
export function labelOfArea(area: string | null | undefined): MemoryLabel | null {
  const a = area ? normalizeArea(area) : "";
  return a === "work" || a === "personal" ? a : null;
}
