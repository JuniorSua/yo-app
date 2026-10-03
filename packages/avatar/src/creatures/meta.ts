/**
 * Sprout, Pebble and Mimi: the procedural Three.js creatures (round 2). This file has no `three` import, so the
 * main bundle can name, pick and describe creatures; the renderer itself is loaded on demand (CreatureAvatar).
 */
import type { Avatar as AvatarData, CreatureKind } from "@yo/contracts";

export type CreatureId = CreatureKind;
/** What the 3D rig can show. AgentActivity maps onto these in state.ts (`creatureState`). */
export type CreaturePose = "idle" | "working" | "thinking" | "question" | "done" | "sleeping";
/** The workshop's name for a pose (kept for the ?creature-lab=1 page). */
export type CreatureState = CreaturePose;
export const CREATURE_POSES: readonly CreaturePose[] = [
  "idle",
  "working",
  "thinking",
  "question",
  "done",
  "sleeping",
];

export const CREATURES = [
  {
    id: "sprout",
    name: "Sprout",
    species: "The many-handed helper",
    color: "#92ad4b",
    background: "#e9eddf",
    ink: "#486237",
    tag: "A natural multitasker",
    description:
      "Four little hands. One very big heart. Sprout makes light work of the busywork, with a gentle bounce and a little extra help.",
    number: "01",
  },
  {
    id: "pebble",
    name: "Pebble",
    species: "The focused little builder",
    color: "#d68c6f",
    background: "#f2e5df",
    ink: "#935c46",
    tag: "Small but unstoppable",
    description:
      "A pocket-sized beetle with a can-do attitude. Pebble taps away at the details, then celebrates every little win.",
    number: "02",
  },
  {
    id: "mimi",
    name: "Mimi",
    species: "The bright-eyed explorer",
    color: "#aaa0cf",
    background: "#eae5f0",
    ink: "#70648d",
    tag: "A little flight of genius",
    description:
      "Curious by nature, thoughtful by design. Mimi brings a soft flutter, an inquisitive tilt, and a fresh perspective to your team.",
    number: "03",
  },
] as const satisfies readonly ({ id: CreatureId } & Record<string, string>)[];

export const CREATURE_ORDER: CreatureId[] = CREATURES.map((c) => c.id);

export function creatureInfo(kind: CreatureId) {
  return CREATURES.find((c) => c.id === kind) ?? CREATURES[0];
}

/** Drawn look used anywhere the 3D creature can't be shown (loading, no WebGL, render error, old clients). */
export const CREATURE_FALLBACK: Record<CreatureId, Pick<AvatarData, "shape" | "color">> = {
  sprout: { shape: "pebble", color: "lime" },
  pebble: { shape: "bubble", color: "orange" },
  mimi: { shape: "cloud", color: "violet" },
};

/** A complete avatar record for a creature (like `livingAvatar`: the drawn fallback fields are filled in). */
export function creatureAvatar(kind: CreatureId): AvatarData {
  return {
    ...CREATURE_FALLBACK[kind],
    eyes: "capsule",
    accessory: "headset",
    finish: "dimensional",
    creature: { kind },
  };
}

/** The avatar to draw instead of the creature: same record without the creature (or living) fields. */
export function creatureFallback(avatar: AvatarData): AvatarData {
  return { ...avatar, creature: undefined, living: undefined };
}
