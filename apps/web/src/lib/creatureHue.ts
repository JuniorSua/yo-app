/**
 * Light-mode hue from Yo's character (round 2, milestone 3).
 *
 * When the primary agent ("Yo") is one of the creatures (Sprout, Pebble, Mimi), the whole UI takes that
 * character's colors, in light mode only. This module is the single source of truth:
 * - the per-character workspace palettes (also used by the `?creature-lab=1` workshop),
 * - how they map onto the app's light tokens in styles.css (`hueTokens`; a unit test checks styles.css matches),
 * - the contrast pairs the tests hold to WCAG AA (`contrastPairs`),
 * - which hue applies (`resolveHue`), and the device-local "Match Yo's character colors" preference.
 */
import { CREATURE_KINDS, type CreatureKind } from "@yo/contracts";
import { create } from "zustand";

/* -------------------------------- Palettes -------------------------------- */

export interface WorkspacePalette {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  line: string;
  bubble: string;
  active: string;
  accent: string;
}

/** Semantic colors for the entire workspace, not just the avatar or selected row. */
export const WORKSPACE_PALETTES: Record<CreatureKind, WorkspacePalette> = {
  sprout: {
    bg: "#fafbf5",
    surface: "#f1f4e7",
    text: "#35432d",
    muted: "#5d684f",
    line: "#dde4ce",
    bubble: "#edf2e2",
    active: "#e1eacf",
    accent: "#779554",
  },
  pebble: {
    bg: "#fffaf7",
    surface: "#faf0e8",
    text: "#543e34",
    muted: "#785b4c",
    line: "#ecdcd0",
    bubble: "#f7e8df",
    active: "#efd8c8",
    accent: "#b2785d",
  },
  mimi: {
    bg: "#fcfaff",
    surface: "#f2eef8",
    text: "#4b405f",
    muted: "#685777",
    line: "#e5dced",
    bubble: "#eee6f6",
    active: "#e1d5ef",
    accent: "#9680b1",
  },
};

/** The workshop's dark preview palette. The app's dark mode never uses a hue (it keeps styles.css `.dark`). */
export const DARK_WORKSPACE_PALETTE: WorkspacePalette = {
  bg: "#252923",
  surface: "#21251f",
  text: "#e4e8d9",
  muted: "#abb59f",
  line: "#363d30",
  bubble: "#333b2d",
  active: "#394331",
  accent: "#94a480",
};

export function workspacePalette(id: CreatureKind, dark: boolean): WorkspacePalette {
  return dark ? DARK_WORKSPACE_PALETTE : WORKSPACE_PALETTES[id];
}

/** `--ws-*` variables for the workshop's preview. */
export function workspaceVariables(id: CreatureKind, dark: boolean): Record<string, string> {
  return Object.fromEntries(
    Object.entries(workspacePalette(id, dark)).map(([key, value]) => [`--ws-${key}`, value]),
  );
}

/* ------------------------------ Color helpers ----------------------------- */

type RGB = [number, number, number];

function parseHex(hex: string): RGB {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as RGB;
}

function toHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** `amount` of `b` mixed into `a` (0 = a, 1 = b), in sRGB like CSS color-mix. */
export function mix(a: string, b: string, amount: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex(x.map((c, i) => c + (y[i]! - c) * amount) as RGB);
}

/** `fg` at `alpha` painted over the opaque `bg` (what a translucent token looks like on screen). */
export function over(fg: string, alpha: number, bg: string): string {
  return mix(bg, fg, alpha);
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/** WCAG 2 contrast ratio. */
export function contrast(a: string, b: string): number {
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix `from` toward `toward` in 2% steps until it reaches `ratio` against every background. */
function deepen(from: string, toward: string, backgrounds: string[], ratio: number): string {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = mix(from, toward, t);
    if (backgrounds.every((bg) => contrast(c, bg) >= ratio)) return c;
  }
  return toward;
}

function rgbTriplet(hex: string): string {
  return parseHex(hex).join(" ");
}

/* ------------------------------- App tokens ------------------------------- */

/** Alphas of the translucent row states (the base light theme uses 0.045 / 0.075 of --fg). */
export const HOVER_ALPHA = 0.09;
export const ACTIVE_ALPHA = 0.15;

/**
 * Opaque colors behind text in the app (for contrast checks and the derivations below): page, sidebar,
 * cards/dialogs, chat bubbles, and the hover/selected rows on each.
 */
function backgrounds(p: WorkspacePalette) {
  const card = mix(p.bg, "#ffffff", 0.6);
  return {
    bg: p.bg,
    sidebar: p.surface,
    card,
    bubble: p.bubble,
    "hover row on sidebar": over(p.accent, HOVER_ALPHA, p.surface),
    "selected row on sidebar": over(p.accent, ACTIVE_ALPHA, p.surface),
    "selected row on card": over(p.accent, ACTIVE_ALPHA, card),
    "brand chip (brand/15) on card": over(p.accent, 0.15, card),
  };
}

/**
 * The light-mode tokens for one character. styles.css holds the same values literally under
 * `html.light[data-hue="…"]` (a unit test keeps them in sync), so dark mode can't be affected.
 */
export function hueTokens(kind: CreatureKind): Record<string, string> {
  const p = WORKSPACE_PALETTES[kind];
  const bgs = backgrounds(p);
  const textBgs = Object.values(bgs);
  const card = bgs.card;
  // Accent as text/links/focus ring: the accent deepened toward the text color until it reads (AA) everywhere.
  const ink = deepen(p.accent, p.text, textBgs, 4.5);
  // Text/icons on an accent fill (send button, brand buttons): a deep tone of the hue (like the base theme's
  // dark ink on yellow), deepened toward black until it reaches AA on the accent.
  const accentFg = deepen(mix(p.text, "#000000", 0.35), "#000000", [p.accent], 4.5);
  // Muted/faint keep the base theme's hierarchy; faint (placeholders, timestamps) gets at least 3:1.
  const faint = deepen(mix(p.muted, p.bg, 0.45), p.muted, [p.bg, card, p.surface], 3);
  return {
    "--bg": p.bg,
    "--sidebar": p.surface,
    "--card": card,
    "--elevated": card,
    "--bubble": p.bubble,
    "--border": p.line,
    "--border-strong": mix(p.line, p.text, 0.08),
    "--fg": p.text,
    "--fg-2": mix(p.text, p.muted, 0.5),
    "--muted": p.muted,
    "--faint": faint,
    "--hover": `rgb(${rgbTriplet(p.accent)} / ${HOVER_ALPHA})`,
    "--active": `rgb(${rgbTriplet(p.accent)} / ${ACTIVE_ALPHA})`,
    "--brand": p.accent,
    "--brand-ink": ink,
    "--brand-fg": accentFg,
    "--link": ink,
    "--focus": ink,
    "--scrim": `rgb(${rgbTriplet(mix(p.text, "#000000", 0.5))} / 0.28)`,
    "--screen-bg": mix(p.surface, p.text, 0.06),
  };
}

export interface ContrastPair {
  label: string;
  fg: string;
  bg: string;
  /** 4.5 for normal text, 3 for large text / UI components. */
  min: number;
}

/** Every text/background pair the app uses with these tokens, with the WCAG AA minimum it must meet. */
export function contrastPairs(kind: CreatureKind): ContrastPair[] {
  const p = WORKSPACE_PALETTES[kind];
  const t = hueTokens(kind);
  const bgs = backgrounds(p);
  const pairs: ContrastPair[] = [];
  for (const [name, bg] of Object.entries(bgs)) {
    pairs.push({ label: `text on ${name}`, fg: t["--fg"]!, bg, min: 4.5 });
    pairs.push({ label: `secondary text on ${name}`, fg: t["--fg-2"]!, bg, min: 4.5 });
    pairs.push({ label: `muted on ${name}`, fg: t["--muted"]!, bg, min: 4.5 });
    pairs.push({ label: `accent text/link on ${name}`, fg: t["--link"]!, bg, min: 4.5 });
  }
  for (const name of ["bg", "card", "sidebar"] as const)
    pairs.push({ label: `faint (placeholders) on ${name}`, fg: t["--faint"]!, bg: bgs[name], min: 3 });
  pairs.push({ label: "accent foreground on accent", fg: t["--brand-fg"]!, bg: p.accent, min: 4.5 });
  pairs.push({ label: "page text on primary button (bg on fg)", fg: t["--bg"]!, bg: t["--fg"]!, min: 4.5 });
  pairs.push({ label: "accent fill against page (UI)", fg: p.accent, bg: p.bg, min: 3 });
  pairs.push({ label: "accent fill against card (UI)", fg: p.accent, bg: bgs.card, min: 3 });
  pairs.push({ label: "focus ring on page (UI)", fg: t["--focus"]!, bg: p.bg, min: 3 });
  pairs.push({ label: "focus ring on card (UI)", fg: t["--focus"]!, bg: bgs.card, min: 3 });
  return pairs;
}

/* ----------------------------- Which hue applies ----------------------------- */

export const CREATURE_NAMES: Record<CreatureKind, string> = {
  sprout: "Sprout",
  pebble: "Pebble",
  mimi: "Mimi",
};

export function isCreatureKind(v: unknown): v is CreatureKind {
  return typeof v === "string" && (CREATURE_KINDS as readonly string[]).includes(v);
}

/**
 * The hue to show: the primary agent's creature, only in light mode and only while the Appearance toggle is on.
 * Anything else (no creature, an unknown kind from a newer core, dark mode, toggle off) means no hue.
 */
export function resolveHue(opts: {
  creature: unknown;
  theme: "light" | "dark";
  enabled: boolean;
}): CreatureKind | null {
  if (!opts.enabled || opts.theme !== "light") return null;
  return isCreatureKind(opts.creature) ? opts.creature : null;
}

/** The light-mode page background with a hue (for the window's theme-color). */
export function hueBackground(kind: CreatureKind | null): string | null {
  return kind ? WORKSPACE_PALETTES[kind].bg : null;
}

/* ------------------------- Device-local preference ------------------------- */

/** "Match Yo's character colors in light mode" (default on). Device-local, like the cached theme. */
export const HUE_PREF_KEY = "yo.matchHue";
/** The hue last shown in light mode, so index.html can apply it before first paint (no flash). */
export const HUE_CACHE_KEY = "yo.hue";

export function readHuePref(): boolean {
  try {
    return localStorage.getItem(HUE_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeHuePref(on: boolean) {
  try {
    localStorage.setItem(HUE_PREF_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function cacheHue(kind: CreatureKind | null) {
  try {
    if (kind) localStorage.setItem(HUE_CACHE_KEY, kind);
    else localStorage.removeItem(HUE_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** The toggle's live value (Settings → Appearance), persisted with `writeHuePref`. */
export const useHuePref = create<{ on: boolean }>(() => ({ on: readHuePref() }));

export function setHuePref(on: boolean) {
  writeHuePref(on);
  useHuePref.setState({ on });
}
