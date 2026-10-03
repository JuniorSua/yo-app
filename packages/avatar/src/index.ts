export { Avatar, type AvatarProps, AvatarStyles } from "./Avatar";
export { type AccessoryId, HAT_ACCESSORIES } from "./accessories";
export { type AvatarColor, colorById, onColor, randomAvatar, YO_AVATAR, YO_YELLOW } from "./colors";
// Creatures: names, picking and the activity mapping only. The three.js renderer is loaded on demand by
// <Avatar> (and the workshop imports "@yo/avatar/creatures").
export {
  CREATURE_FALLBACK,
  CREATURE_ORDER,
  CREATURE_POSES,
  CREATURES,
  type CreatureId,
  type CreaturePose,
  creatureAvatar,
  creatureFallback,
  creatureInfo,
} from "./creatures/meta";
export {
  type CreatureView,
  creatureState,
  SNAPSHOT_BUCKETS,
  snapshotKey,
  snapshotPx,
  type TurnInfo,
  turnInfo,
} from "./creatures/state";
export { CupCatFigure } from "./cupcat";
export {
  CUPCAT_VARIANTS,
  type CupCatVariant,
  cupCatVariant,
  RARITY_COLOR,
  RARITY_LABEL,
  type Rarity,
  rollCupCat,
} from "./cupcat-variants";
export { type Detail, detailFor, type Material, materialFor } from "./dimensional";
export { BUBBLE_BODY, BUBBLE_TAIL } from "./geometry";
export {
  LOGO_EYE,
  type LogoFinish,
  SUNLIT_SATIN,
  YoLogo,
  type YoLogoProps,
  YoWordmark,
  type YoWordmarkProps,
} from "./Logo";
export {
  LIVING_CHARACTERS_INFO,
  LIVING_ORDER,
  type LivingBody,
  type LivingCharacter,
  type LivingCharacterId,
  type LivingHeadset,
  livingAvatar,
  livingParts,
} from "./living/characters";
export { type LivingMode, livingMode } from "./living/motion";
export { SHAPES, type ShapeGeometry, type ShapeId } from "./shapes";
export { AVATAR_CSS } from "./styles";
export {
  AGENT_TEMPLATES,
  type AgentTemplate,
  AVATAR_PRESETS,
  VIOLET_COPILOT,
} from "./templates";

/** Human labels for the Avatar Studio pickers. */
export const SHAPE_LABELS: Record<string, string> = {
  bubble: "Bubble",
  squircle: "Squircle",
  pebble: "Pebble",
  hex: "Hex",
  drop: "Drop",
  cloud: "Cloud",
  burst: "Burst",
  tablet: "Tablet",
};

export const EYE_LABELS: Record<string, string> = {
  capsule: "Capsule",
  round: "Round",
  sleepy: "Sleepy",
  happy: "Happy",
};
export const ACCESSORY_LABELS: Record<string, string> = {
  none: "None",
  headset: "Headset",
  glasses: "Glasses",
  beanie: "Beanie",
  crown: "Crown",
  antenna: "Antenna",
  bowtie: "Bow tie",
  earbuds: "Earbuds",
  chef: "Chef hat",
  cap: "Cap",
};
