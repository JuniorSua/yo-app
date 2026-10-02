import {
  AVATAR_COLORS,
  AVATAR_EYES,
  AVATAR_SHAPES,
  type Avatar,
  CUP_STYLES,
  CUP_TOPPINGS,
} from "@yo/contracts";

export type AvatarColor = { id: string; name: string; hex: string; eye: string };

export const YO_YELLOW = "#FFD43B";

function luminance(hex: string): number {
  const m = hex.replace("#", "");
  const full =
    m.length === 3
      ? m
          .split("")
          .map((c) => c + c)
          .join("")
      : m.slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (Number.isNaN(n)) return 0.5;
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/**
 * Look up a palette color by id (e.g. "violet"). Also accepts a raw hex string, in which case a
 * matching eye color is derived. Unknown values fall back to Yo Yellow.
 */
export function colorById(idOrHex: string | null | undefined): AvatarColor {
  const byId = AVATAR_COLORS.find((c) => c.id === idOrHex || c.hex.toLowerCase() === idOrHex?.toLowerCase());
  if (byId) return byId;
  if (idOrHex && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(idOrHex)) {
    return {
      id: idOrHex,
      name: idOrHex,
      hex: idOrHex,
      eye: luminance(idOrHex) > 0.18 ? "#111111" : "#F4F4F2",
    };
  }
  return AVATAR_COLORS[0];
}

/** Readable text color on top of an avatar color (for badges / initials). */
export function onColor(hex: string): string {
  return luminance(hex) > 0.35 ? "#111111" : "#FFFFFF";
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** A random, always-cute Copilot-style avatar (CupCats are rolled separately). Always wears the headset. */
export function randomAvatar(): Avatar {
  return {
    shape: pick(AVATAR_SHAPES.filter((s) => s !== "cupcat")),
    color: pick(AVATAR_COLORS.filter((c) => c.id !== "yo")).id,
    eyes: Math.random() < 0.55 ? "capsule" : pick(AVATAR_EYES),
    accessory: "headset",
  };
}

export const YO_AVATAR: Avatar = { shape: "bubble", color: "yo", eyes: "capsule", accessory: "headset" };
