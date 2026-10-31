/**
 * Small sRGB helpers shared by the creature tints (here) and the light-mode hue (apps/web/src/lib/creatureHue.ts).
 * Colors are 6-digit hex strings ("#a8c962").
 */

type RGB = [number, number, number];

export function parseHex(hex: string): RGB {
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
