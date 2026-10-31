/**
 * The team: the main agent (Yo, the front door) plus named, long-lived teammates, each with one job and its own
 * memory, computer seat and subscription. One-off helpers (start_helper) are the task layer below them.
 */
import type { Agent, Avatar } from "./domain";

/** The Softies a new teammate gets, in the order they're handed out. Yo's own Softie is the logo bubble. */
export const TEAMMATE_SOFTIES = [
  { kind: "dew", color: "#4C86FF" },
  { kind: "pico", color: "#FF7E36" },
  { kind: "mochi", color: "#2DC892" },
  { kind: "clove", color: "#9165F7" },
  { kind: "kiki", color: "#F4579F" },
] as const;
export type TeammateSoftie = (typeof TEAMMATE_SOFTIES)[number];

/** The first Softie no active agent wears yet; once all five are taken, the one worn least. */
export function nextTeammateSoftie(
  team: readonly Pick<Agent, "avatar" | "archivedAt" | "kind">[],
): TeammateSoftie {
  const worn = new Map<string, number>();
  for (const a of team) {
    const kind = a.avatar.softie?.kind;
    if (kind && !a.archivedAt && a.kind !== "helper") worn.set(kind, (worn.get(kind) ?? 0) + 1);
  }
  let pick: TeammateSoftie = TEAMMATE_SOFTIES[0];
  for (const s of TEAMMATE_SOFTIES) if ((worn.get(s.kind) ?? 0) < (worn.get(pick.kind) ?? 0)) pick = s;
  return pick;
}

/**
 * A new teammate's avatar: the next Softie. `color` is the Softie's colour too, so an app that doesn't know
 * Softies yet still draws the teammate in it.
 */
export function teammateAvatar(team: readonly Pick<Agent, "avatar" | "archivedAt" | "kind">[]): Avatar {
  const s = nextTeammateSoftie(team);
  return { shape: "bubble", color: s.color, eyes: "capsule", accessory: "none", softie: { kind: s.kind } };
}

/**
 * The exchange a message_agent result names: core ends its answer with "(exchange xch_…)", and the reply that
 * comes back later carries the same id in `item.from.exchangeId`. Null when there's none (an older core).
 */
export function exchangeIdIn(text: string | null | undefined): string | null {
  return text ? (/\(exchange (xch_[a-z0-9]+)\)/.exec(text)?.[1] ?? null) : null;
}
