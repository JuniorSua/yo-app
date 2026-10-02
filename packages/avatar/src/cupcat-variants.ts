/**
 * The 15 collectible CupCats (inspired by the CupCats collection, themed around Japanese food & culture).
 * A CupCat can't be customized: you roll one with weighted odds, and that's your cat.
 * Odds are percentages and sum to exactly 100.
 */

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

export type CupKind = "liner" | "latte" | "bowl" | "box" | "bento" | "float" | "pot" | "masu";
export type HatKind = "none" | "sailor" | "witch" | "maid" | "frog";
export type MarkKind = "none" | "kitsune" | "daruma" | "calico";
export type ToppingKind =
  | "none"
  | "sakura"
  | "macarons"
  | "ramen"
  | "dango"
  | "float"
  | "flower"
  | "pancakes"
  | "koban"
  | "lollipops";

export interface CupCatVariant {
  id: string;
  name: string;
  /** Japanese name shown under the English one. */
  jp: string;
  rarity: Rarity;
  /** Percent chance (all variants sum to 100). */
  odds: number;
  fur: string;
  /** Lower-face (muzzle) color; omitted = single-color face. */
  muzzle?: string;
  /** Tint in the lower half of the glossy eyes. */
  eyeTint: string;
  cup: { kind: CupKind; color: string; accent?: string };
  topping: ToppingKind;
  hat: HatKind;
  mark: MarkKind;
  /** Legendary sparkle aura. */
  sparkle?: boolean;
}

export const CUPCAT_VARIANTS: readonly CupCatVariant[] = [
  // Common (55%)
  {
    id: "sakura",
    name: "Sakura Mochi",
    jp: "桜もち",
    rarity: "common",
    odds: 12,
    fur: "#FFC7D5",
    muzzle: "#FFFFFF",
    eyeTint: "#C2456D",
    cup: { kind: "liner", color: "#FFE1EA", accent: "#F59AB4" },
    topping: "sakura",
    hat: "none",
    mark: "none",
  },
  {
    id: "matcha",
    name: "Matcha Latte",
    jp: "抹茶ラテ",
    rarity: "common",
    odds: 12,
    fur: "#A8D88A",
    muzzle: "#F4FAEA",
    eyeTint: "#4E8A3A",
    cup: { kind: "latte", color: "#FFD3DF", accent: "#B98563" },
    topping: "macarons",
    hat: "none",
    mark: "none",
  },
  {
    id: "ramen",
    name: "Ramen",
    jp: "ラーメン",
    rarity: "common",
    odds: 11,
    fur: "#E2B07F",
    muzzle: "#FFF3E2",
    eyeTint: "#8A5A2B",
    cup: { kind: "bowl", color: "#E4533E", accent: "#FFFFFF" },
    topping: "ramen",
    hat: "none",
    mark: "none",
  },
  {
    id: "dango",
    name: "Hanami Dango",
    jp: "花見団子",
    rarity: "common",
    odds: 10,
    fur: "#FFF0C4",
    eyeTint: "#A26A1E",
    cup: { kind: "liner", color: "#C4E6B3", accent: "#8CC474" },
    topping: "dango",
    hat: "none",
    mark: "none",
  },
  {
    id: "melon",
    name: "Melon Soda",
    jp: "メロンソーダ",
    rarity: "common",
    odds: 10,
    fur: "#CFEBFF",
    muzzle: "#FFFFFF",
    eyeTint: "#2E7FB8",
    cup: { kind: "float", color: "#84DB6E", accent: "#FFFFFF" },
    topping: "float",
    hat: "none",
    mark: "none",
  },
  // Uncommon (25%)
  {
    id: "bento",
    name: "Bento",
    jp: "お弁当",
    rarity: "uncommon",
    odds: 7,
    fur: "#F4DDB6",
    muzzle: "#FFFFFF",
    eyeTint: "#9B4F2A",
    cup: { kind: "bento", color: "#EF6A5A", accent: "#FFFFFF" },
    topping: "flower",
    hat: "none",
    mark: "none",
  },
  {
    id: "kitsune",
    name: "Kitsune",
    jp: "狐",
    rarity: "uncommon",
    odds: 6,
    fur: "#FFFFFF",
    eyeTint: "#C8283A",
    cup: { kind: "liner", color: "#D6C6FF", accent: "#A98CF2" },
    topping: "none",
    hat: "none",
    mark: "kitsune",
  },
  {
    id: "maid",
    name: "Maid Café",
    jp: "メイド喫茶",
    rarity: "uncommon",
    odds: 6,
    fur: "#86E0CC",
    muzzle: "#FFFFFF",
    eyeTint: "#7B3FB8",
    cup: { kind: "box", color: "#E6D4FF", accent: "#FF9EB5" },
    topping: "none",
    hat: "maid",
    mark: "none",
  },
  {
    id: "sailor",
    name: "Sailor",
    jp: "セーラー",
    rarity: "uncommon",
    odds: 6,
    fur: "#F7E5CB",
    muzzle: "#FFFFFF",
    eyeTint: "#2F5DA8",
    cup: { kind: "liner", color: "#FFFFFF", accent: "#3D5AA8" },
    topping: "none",
    hat: "sailor",
    mark: "none",
  },
  // Rare (14%)
  {
    id: "kero",
    name: "Kero Frog",
    jp: "ケロ",
    rarity: "rare",
    odds: 5,
    fur: "#BBAEFF",
    muzzle: "#FFFFFF",
    eyeTint: "#3A9A6A",
    cup: { kind: "bowl", color: "#E4533E", accent: "#FFFFFF" },
    topping: "none",
    hat: "frog",
    mark: "none",
  },
  {
    id: "hotcake",
    name: "Hotcake",
    jp: "ホットケーキ",
    rarity: "rare",
    odds: 5,
    fur: "#98D17A",
    eyeTint: "#3F7A2B",
    cup: { kind: "bowl", color: "#5F6B7A", accent: "#FFFFFF" },
    topping: "pancakes",
    hat: "none",
    mark: "none",
  },
  {
    id: "majo",
    name: "Majo Witch",
    jp: "魔女",
    rarity: "rare",
    odds: 4,
    fur: "#DCF1FF",
    muzzle: "#FFFFFF",
    eyeTint: "#6A4FC2",
    cup: { kind: "liner", color: "#E5F1B4", accent: "#B9CD6A" },
    topping: "none",
    hat: "witch",
    mark: "none",
  },
  // Epic (5%)
  {
    id: "daruma",
    name: "Daruma",
    jp: "だるま",
    rarity: "epic",
    odds: 3,
    fur: "#E23B3B",
    muzzle: "#FFF4E6",
    eyeTint: "#7A1616",
    cup: { kind: "pot", color: "#F2C14E", accent: "#C98A12" },
    topping: "none",
    hat: "none",
    mark: "daruma",
  },
  {
    id: "maneki",
    name: "Maneki-neko",
    jp: "招き猫",
    rarity: "epic",
    odds: 2,
    fur: "#FFFFFF",
    eyeTint: "#B8860B",
    cup: { kind: "masu", color: "#C8102E", accent: "#F2C14E" },
    topping: "koban",
    hat: "none",
    mark: "calico",
  },
  // Legendary (1%)
  {
    id: "niji",
    name: "Niji Rainbow",
    jp: "虹",
    rarity: "legendary",
    odds: 1,
    fur: "#D3E9FF",
    muzzle: "#FFFFFF",
    eyeTint: "#8A5CF6",
    cup: { kind: "liner", color: "rainbow" },
    topping: "lollipops",
    hat: "none",
    mark: "none",
    sparkle: true,
  },
];

export const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

export const RARITY_COLOR: Record<Rarity, string> = {
  common: "#9AA0A6",
  uncommon: "#4ECB71",
  rare: "#3B82F6",
  epic: "#A855F7",
  legendary: "#F5B301",
};

const BY_ID = new Map(CUPCAT_VARIANTS.map((v) => [v.id, v]));

/** Look up a CupCat; unknown/absent ids fall back to Sakura Mochi. */
export function cupCatVariant(id: string | null | undefined): CupCatVariant {
  return BY_ID.get(id ?? "") ?? CUPCAT_VARIANTS[0]!;
}

/** Weighted roll. `rng` returns [0, 1). */
export function rollCupCat(rng: () => number = Math.random): CupCatVariant {
  let t = rng() * 100;
  for (const v of CUPCAT_VARIANTS) {
    t -= v.odds;
    if (t < 0) return v;
  }
  return CUPCAT_VARIANTS[CUPCAT_VARIANTS.length - 1]!;
}
