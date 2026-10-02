/**
 * Living characters: the three original concept renders (the "agent depth" design exploration), brought to life.
 * Body colours are hue/saturation/value shifts of the render's body (headset, eyes and highlights untouched);
 * headset colours remap the headset's shading onto a new dark→light ramp.
 */
import type { Avatar as AvatarData, LIVING_CHARACTERS } from "@yo/contracts";

export type LivingCharacterId = (typeof LIVING_CHARACTERS)[number];

export interface LivingBody {
  id: string;
  name: string;
  /** Hue shift in degrees, saturation and value multipliers. */
  shift: [number, number, number];
  /** Swatch gradient: shade, base, light. */
  swatch: [string, string, string];
}
export interface LivingHeadset {
  id: string;
  name: string;
  /** Dark and light ends of the new ramp; null keeps the render's own headset. */
  ramp: [string, string] | null;
  swatch: [string, string];
}
export interface LivingCharacter {
  id: LivingCharacterId;
  name: string;
  tagline: string;
  /** Hue (deg) of the render's body, used to find body pixels. */
  bodyHue: number;
  bodies: LivingBody[];
  headsets: LivingHeadset[];
  /** Drawn look used anywhere the living render can't be shown. */
  fallback: Pick<AvatarData, "shape" | "color">;
}

const body = (
  id: string,
  name: string,
  shift: [number, number, number],
  swatch: [string, string, string],
) => ({
  id,
  name,
  shift,
  swatch,
});

export const LIVING_CHARACTERS_INFO: Record<LivingCharacterId, LivingCharacter> = {
  violet: {
    id: "violet",
    name: "Violet Copilot",
    tagline: "Calm, curious, capable",
    bodyHue: 268,
    bodies: [
      body("violet", "Violet", [0, 1, 1], ["#3E1B86", "#8A52FA", "#CF9DFF"]),
      body("cobalt", "Cobalt", [-42, 1, 1.02], ["#172f8a", "#3d6cf9", "#9dbcff"]),
      body("orchid", "Orchid", [32, 1, 1.02], ["#6d1586", "#c552fa", "#ef9dff"]),
      body("graphite", "Graphite", [0, 0.12, 0.8], ["#3b3a40", "#6f6c78", "#a9a6b3"]),
    ],
    headsets: [
      { id: "midnight", name: "Midnight", ramp: null, swatch: ["#202338", "#494763"] },
      { id: "graphite", name: "Graphite", ramp: ["#1d1e22", "#8d8f98"], swatch: ["#1d1e22", "#8d8f98"] },
      { id: "plum", name: "Plum", ramp: ["#241030", "#9a74b8"], swatch: ["#241030", "#9a74b8"] },
    ],
    fallback: { shape: "squircle", color: "violet" },
  },
  lagoon: {
    id: "lagoon",
    name: "Lagoon Pebble",
    tagline: "Attentive and warm",
    bodyHue: 182,
    bodies: [
      body("lagoon", "Lagoon", [0, 1, 1], ["#064E73", "#0DB9BD", "#8BF3F2"]),
      body("sky", "Sky", [24, 1, 1], ["#062f73", "#0d7fbd", "#8bd2f3"]),
      body("mint", "Mint", [-30, 0.9, 1], ["#0b6a4e", "#1dbd86", "#9df3cf"]),
      body("lime", "Lime", [-80, 0.74, 0.92], ["#3a6a0b", "#7bbd1d", "#cdf39d"]),
    ],
    headsets: [
      { id: "navy", name: "Navy", ramp: null, swatch: ["#1b2336", "#3e4a66"] },
      { id: "black", name: "Black", ramp: ["#0c0d10", "#5a5d66"], swatch: ["#0c0d10", "#5a5d66"] },
      { id: "ocean", name: "Ocean", ramp: ["#081f2e", "#5aa0c4"], swatch: ["#081f2e", "#5aa0c4"] },
    ],
    fallback: { shape: "pebble", color: "cyan" },
  },
  coral: {
    id: "coral",
    name: "Coral Copilot",
    tagline: "Energetic and confident",
    bodyHue: 356,
    bodies: [
      body("coral", "Coral", [0, 1, 1], ["#A8193E", "#FE5463", "#FFB08C"]),
      body("tangerine", "Tangerine", [24, 1, 1.02], ["#a8410f", "#fe8a3c", "#ffd08c"]),
      body("rose", "Rose", [-22, 1, 1], ["#a8196f", "#fe54a6", "#ffa6cd"]),
      body("sunflower", "Sunflower", [44, 1, 1.05], ["#b36b10", "#ffc23d", "#fff09a"]),
    ],
    headsets: [
      { id: "navy", name: "Navy", ramp: null, swatch: ["#1b2336", "#3e4a66"] },
      { id: "rosegold", name: "Rose gold", ramp: ["#6b3d3a", "#ffd3c2"], swatch: ["#6b3d3a", "#ffd3c2"] },
      { id: "graphite", name: "Graphite", ramp: ["#18191d", "#7d7f88"], swatch: ["#18191d", "#7d7f88"] },
    ],
    fallback: { shape: "squircle", color: "red" },
  },
};

export const LIVING_ORDER: LivingCharacterId[] = ["violet", "lagoon", "coral"];

/** A complete avatar record for a living character (drawn fallback fields filled in). */
export function livingAvatar(character: LivingCharacterId, bodyId?: string, headsetId?: string): AvatarData {
  const c = LIVING_CHARACTERS_INFO[character];
  return {
    ...c.fallback,
    eyes: "capsule",
    accessory: "headset",
    finish: "dimensional",
    living: { character, body: bodyId ?? c.bodies[0]!.id, headset: headsetId ?? c.headsets[0]!.id },
  };
}

export function livingParts(living: NonNullable<AvatarData["living"]>) {
  const c = LIVING_CHARACTERS_INFO[living.character] ?? LIVING_CHARACTERS_INFO.violet;
  const b = c.bodies.find((x) => x.id === living.body) ?? c.bodies[0]!;
  const h = c.headsets.find((x) => x.id === living.headset) ?? c.headsets[0]!;
  return { character: c, body: b, headset: h };
}
