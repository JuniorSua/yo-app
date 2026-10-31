/**
 * Softie colours. Ten accents: the six team hues (spread round the wheel so they never collide at 24px) plus four
 * extras, so two teammates can share a shape. Each accent has a hand-tuned ramp for the vinyl shading and two
 * text tones (`ink` on light pages, `inkDark` on dark ones; both AA, held to it by softies.test.ts).
 * No React or DOM here: core imports it (through ./helper) too.
 */
import { contrast, mix } from "../color-math";

export interface SoftiePalette {
  light: string;
  base: string;
  shade: string;
  deep: string;
  /** The colour as text on a light page (AA). */
  ink: string;
  /** The colour as text on a dark page (AA). */
  inkDark: string;
  /** A light page wash. */
  tint: string;
}

export const SOFTIE_ACCENTS = [
  { id: "sun", name: "Sun", hex: "#FFD43B" },
  { id: "cobalt", name: "Cobalt", hex: "#4C86FF" },
  { id: "tangerine", name: "Tangerine", hex: "#FF7E36" },
  { id: "mint", name: "Mint", hex: "#2DC892" },
  { id: "grape", name: "Grape", hex: "#9165F7" },
  { id: "berry", name: "Berry", hex: "#F4579F" },
  { id: "slate", name: "Slate", hex: "#7C9CC3" },
  { id: "sky", name: "Sky", hex: "#00B1FF" },
  { id: "lime", name: "Lime", hex: "#B6D80B" },
  { id: "orchid", name: "Orchid", hex: "#DD6ADC" },
] as const;
export type SoftieAccentId = (typeof SOFTIE_ACCENTS)[number]["id"];

const PALETTES: Record<SoftieAccentId, SoftiePalette> = {
  sun: {
    light: "#FFF2A8",
    base: "#FFD43B",
    shade: "#F6AE1F",
    deep: "#B8700C",
    ink: "#8A5A00",
    inkDark: "#FFD43B",
    tint: "#FFF8DC",
  },
  cobalt: {
    light: "#A9C8FF",
    base: "#4C86FF",
    shade: "#2D5FE6",
    deep: "#1A3796",
    ink: "#2350C8",
    inkDark: "#8DB4FF",
    tint: "#EEF3FF",
  },
  tangerine: {
    light: "#FFCBA0",
    base: "#FF7E36",
    shade: "#EA5A1C",
    deep: "#A3390E",
    ink: "#B2470F",
    inkDark: "#FFA266",
    tint: "#FFF1E7",
  },
  mint: {
    light: "#AEF3D3",
    base: "#2DC892",
    shade: "#13A170",
    deep: "#085E44",
    ink: "#0B7A57",
    inkDark: "#5EDDAA",
    tint: "#E8FAF1",
  },
  grape: {
    light: "#D3C0FF",
    base: "#9165F7",
    shade: "#6E40DE",
    deep: "#3F1F95",
    ink: "#6A3CDB",
    inkDark: "#B79CFF",
    tint: "#F3EEFF",
  },
  berry: {
    light: "#FFB6D6",
    base: "#F4579F",
    shade: "#D63682",
    deep: "#8E1854",
    ink: "#C02A72",
    inkDark: "#FF8DC0",
    tint: "#FFEEF6",
  },
  slate: {
    light: "#C3D3E8",
    base: "#7C9CC3",
    shade: "#5E80AD",
    deep: "#34496A",
    ink: "#4A6890",
    inkDark: "#A9C0DD",
    tint: "#F1F5FA",
  },
  sky: {
    light: "#9BE0FF",
    base: "#00B1FF",
    shade: "#0090E0",
    deep: "#00508F",
    ink: "#0070A8",
    inkDark: "#5CCBFF",
    tint: "#E8F8FF",
  },
  lime: {
    light: "#E6F59A",
    base: "#B6D80B",
    shade: "#94B800",
    deep: "#4F6600",
    ink: "#5A6E00",
    inkDark: "#C9E64A",
    tint: "#F7FBE3",
  },
  orchid: {
    light: "#F6C2F5",
    base: "#DD6ADC",
    shade: "#C14CC4",
    deep: "#7A2280",
    ink: "#A2329F",
    inkDark: "#EB9BEA",
    tint: "#FDF0FD",
  },
};

const HEX = /^#[0-9a-f]{6}$/i;

/** Mix `from` toward `to` in 2% steps until it reaches `ratio` against `bg`. */
function deepen(from: string, to: string, bg: string, ratio: number): string {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = mix(from, to, t);
    if (contrast(c, bg) >= ratio) return c;
  }
  return to;
}

/** The accent (of the ten) a hex is, if any. */
export function accentOf(hex: string | undefined): SoftieAccentId | null {
  if (!hex) return null;
  const h = hex.toLowerCase();
  return SOFTIE_ACCENTS.find((a) => a.hex.toLowerCase() === h)?.id ?? null;
}

/** The ramp for a colour: hand-tuned for the ten accents, derived for any other hex. */
export function softiePalette(hex: string): SoftiePalette {
  const id = accentOf(hex);
  if (id) return PALETTES[id];
  if (!HEX.test(hex)) return PALETTES.sun;
  return {
    light: mix(hex, "#ffffff", 0.52),
    base: hex,
    shade: mix(hex, "#000000", 0.13),
    deep: mix(hex, "#000000", 0.52),
    ink: deepen(hex, "#000000", "#ffffff", 5.2),
    inkDark: deepen(hex, "#ffffff", "#111113", 6),
    tint: mix(hex, "#ffffff", 0.9),
  };
}

function hsl(hex: string): { h: number; s: number; chroma: number } {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s, chroma: d };
}

const ACCENT_HUES = SOFTIE_ACCENTS.filter((a) => a.id !== "slate").map((a) => ({
  id: a.id,
  h: hsl(a.hex).h,
}));

/**
 * The nearest of the ten accents to any colour: greys (and near-greys) are Slate; everything else goes by hue.
 * Used to turn an older avatar's colour into a Softie colour.
 */
export function nearestAccent(hex: string): SoftieAccentId {
  if (!HEX.test(hex)) return "sun";
  const c = hsl(hex);
  if (c.s < 0.18 || c.chroma < 40 / 255) return "slate";
  let best = ACCENT_HUES[0]!;
  let gap = 360;
  for (const a of ACCENT_HUES) {
    const d = Math.min(Math.abs(a.h - c.h), 360 - Math.abs(a.h - c.h));
    if (d < gap) {
      gap = d;
      best = a;
    }
  }
  return best.id;
}

export function accentHex(id: SoftieAccentId): string {
  return SOFTIE_ACCENTS.find((a) => a.id === id)!.hex;
}
