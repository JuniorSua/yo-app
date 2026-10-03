import { type CreatureId, creatureAvatar } from "@yo/avatar";
import type { Avatar as AvatarData } from "@yo/contracts";

/**
 * An edit to the drawn avatar (shape, colour, eyes, finish, image). Picking any drawn style leaves the
 * living character and the creature behind; every Yo worker keeps its headset on.
 */
export function editDrawn(value: AvatarData, patch: Partial<AvatarData>): AvatarData {
  return { ...value, living: undefined, creature: undefined, ...patch, accessory: "headset" };
}

/**
 * Picks Sprout, Pebble or Mimi. The drawn fields get the creature's close fallback (shape/colour), shown
 * wherever the 3D creature can't be. A rolled CupCat is remembered (variant), like for living characters.
 */
export function pickCreature(value: AvatarData, kind: CreatureId): AvatarData {
  return { ...creatureAvatar(kind), variant: value.variant };
}
