/**
 * Which Softie an avatar is. Yo 2 stores `avatar.softie`; every older avatar (drawn shapes, CupCats, living
 * characters, creatures) maps to one deterministically, so saved agents become Softies with no migration:
 * - the main agent, and anything Yo-yellow, is Yo;
 * - creatures and living characters keep their character's feel (Sprout → Mochi, Pebble → Pico, Mimi → Clove…);
 * - everything else goes by its colour: the nearest of the ten accents picks the Softie, and the colour stays.
 * No React here: the app's accent colours and core's helpers use it too.
 */
import type { Avatar, CreatureKind, SoftieKind } from "@yo/contracts";
import { colorById } from "../colors";
import { isSoftieKind, softieInfo } from "./characters";
import { accentHex, nearestAccent, type SoftieAccentId } from "./palette";

/** A Softie and the colour it wears (always a hex). */
export interface SoftieLook {
  kind: SoftieKind;
  color: string;
}

export type AvatarLike = Pick<Avatar, "color"> &
  Partial<Pick<Avatar, "shape" | "softie" | "creature" | "living" | "variant">>;

const ACCENT_KIND: Record<SoftieAccentId, SoftieKind> = {
  sun: "yo",
  cobalt: "dew",
  tangerine: "pico",
  mint: "mochi",
  grape: "clove",
  berry: "kiki",
  slate: "dew",
  sky: "dew",
  lime: "mochi",
  orchid: "kiki",
};

const CREATURE_KIND: Record<CreatureKind, SoftieKind> = { sprout: "mochi", pebble: "pico", mimi: "clove" };
const LIVING_KIND: Record<string, SoftieKind> = { violet: "clove", lagoon: "dew", coral: "pico" };
/** The 15 CupCats, by the colour of their fur and cup. */
const CUPCAT_KIND: Record<string, SoftieKind> = {
  sakura: "kiki",
  matcha: "mochi",
  ramen: "pico",
  dango: "mochi",
  melon: "dew",
  bento: "pico",
  kitsune: "clove",
  maid: "mochi",
  sailor: "dew",
  kero: "clove",
  hotcake: "mochi",
  majo: "dew",
  daruma: "kiki",
  maneki: "kiki",
  niji: "dew",
};

const HEX = /^#[0-9a-f]{6}$/i;

export function defaultColor(kind: SoftieKind): string {
  return accentHex(softieInfo(kind).accent);
}

/** A kind in its own colour, or in the accent nearest to `hex`. */
function wearing(kind: SoftieKind, hex?: string): SoftieLook {
  return { kind, color: hex && HEX.test(hex) ? accentHex(nearestAccent(hex)) : defaultColor(kind) };
}

export function softieOf(avatar: AvatarLike, opts: { primary?: boolean } = {}): SoftieLook {
  const s = avatar.softie;
  if (s && isSoftieKind(s.kind))
    return { kind: s.kind, color: s.color && HEX.test(s.color) ? s.color : defaultColor(s.kind) };
  if (opts.primary) return wearing("yo");
  if (avatar.creature) {
    const kind = CREATURE_KIND[avatar.creature.kind] ?? "mochi";
    return wearing(kind, avatar.creature.tint);
  }
  if (avatar.living) return wearing(LIVING_KIND[avatar.living.character] ?? "clove");
  if (avatar.shape === "cupcat") return wearing(CUPCAT_KIND[avatar.variant ?? ""] ?? "pico");
  const accent = nearestAccent(colorById(avatar.color).hex);
  return { kind: ACCENT_KIND[accent], color: accentHex(accent) };
}
