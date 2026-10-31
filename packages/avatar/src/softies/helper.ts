/**
 * Softie avatar records, for the app and for core (exported as "@yo/avatar/tint"; no React here).
 * - `softieAvatar(kind, color?)`: a complete avatar for a Softie. The older fields hold a close drawn fallback
 *   (shape + colour), so an app that doesn't know Softies still draws something like it.
 * - `helperAvatar(seed, parent?)`: a one-off helper's look, random but stable for its id: a teammate Softie that
 *   isn't its parent's, in one of the four extra accents, so helpers never pass for the named teammates.
 */
import type { Avatar, SoftieKind } from "@yo/contracts";
import { TEAMMATE_KINDS } from "./characters";
import { defaultColor, type SoftieLook, softieOf } from "./legacy";
import { accentHex, type SoftieAccentId } from "./palette";

const FALLBACK_SHAPE: Record<SoftieKind, Avatar["shape"]> = {
  yo: "bubble",
  dew: "drop",
  pico: "pebble",
  mochi: "cloud",
  clove: "burst",
  kiki: "tablet",
};

export function softieAvatar(kind: SoftieKind, color?: string): Avatar {
  const hex = color ?? defaultColor(kind);
  return {
    shape: FALLBACK_SHAPE[kind],
    color: kind === "yo" && !color ? "yo" : hex,
    eyes: "capsule",
    accessory: "none",
    softie: color ? { kind, color } : { kind },
  };
}

/** The main agent's look: Yo, the logo bubble in Yo yellow. */
export const YO_AVATAR: Avatar = softieAvatar("yo");

/** The accents helpers wear (the team's six belong to Yo and the named teammates). */
export const HELPER_ACCENTS: readonly SoftieAccentId[] = ["sky", "slate", "lime", "orchid"];

function hash(seed: string): number {
  let h = 7;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return h >>> 0;
}

export function helperAvatar(seed: string, parent?: Pick<Avatar, "color" | "softie">): Avatar {
  const h = hash(seed);
  const parentKind: SoftieLook["kind"] | undefined = parent ? softieOf(parent).kind : undefined;
  const kinds = TEAMMATE_KINDS.filter((k) => k !== parentKind);
  const kind = kinds[h % kinds.length]!;
  return softieAvatar(kind, accentHex(HELPER_ACCENTS[(h >>> 3) % HELPER_ACCENTS.length]!));
}
