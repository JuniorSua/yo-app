import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** The hex tokens of the first block whose selector list is exactly `selector`. */
function block(selector: string): Record<string, string> {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`^${esc}\\s*\\{([^}]*)\\}`, "m"));
  if (!m) throw new Error(`Missing ${selector}`);
  return Object.fromEntries(
    [...m[1]!.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((d) => [d[1]!, d[2]!]),
  );
}

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
/** `top` at `alpha` over `under`. */
const over = (top: string, alpha: number, under: string) =>
  hex(rgb(top).map((v, i) => v * alpha + rgb(under)[i]! * (1 - alpha)));

/** The Mac app's side columns let macOS's frost through: the mix declared for `--glass-sidebar` per theme. */
function frostMix(dark: boolean): number {
  const re = dark
    ? /\.dark\s*\{\s*--glass-sidebar: color-mix\(in srgb, var\(--sidebar\) (\d+)%, transparent\)/
    : /\(\[data-glass="off"\]\)\s*\{\s*--glass-sidebar: color-mix\(in srgb, var\(--sidebar\) (\d+)%, transparent\)/;
  const m = css.match(re);
  if (!m) throw new Error("Missing the Mac app's sidebar mix");
  return Number(m[1]) / 100;
}

const THEMES = [
  { name: "light", t: block(":root,\n.light"), frost: ["#ffffff", "#d9d9d9"], dark: false },
  { name: "dark", t: block(".dark"), frost: ["#000000", "#3a3a3a"], dark: true },
];

describe("Yo 2 tokens", () => {
  for (const { name, t, frost, dark } of THEMES) {
    it(`${name}: text meets WCAG AA on every surface (faint and icons 3:1)`, () => {
      const surfaces = ["--bg", "--sidebar", "--rail", "--card", "--elevated", "--bubble"].map((k) => t[k]!);
      for (const backdrop of frost) surfaces.push(over(t["--sidebar"]!, frostMix(dark), backdrop));
      for (const bg of surfaces) {
        for (const ink of ["--fg", "--fg-2", "--muted", "--link"])
          expect(contrast(t[ink]!, bg), `${ink} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--faint"]!, bg), `--faint on ${bg}`).toBeGreaterThanOrEqual(3);
      }
      for (const ink of ["--success", "--warning", "--danger"])
        expect(contrast(t[ink]!, t["--bg"]!), `${ink} on the canvas`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["--brand-fg"]!, t["--brand"]!)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: calm neutrals, as in Dots (no tint, no warm or hue layer)`, () => {
      for (const k of ["--bg", "--sidebar", "--card", "--bubble", "--fg", "--muted"]) {
        const [r, g, b] = rgb(t[k]!);
        expect(r === g && g === b, `${k} ${t[k]} is a grey`).toBe(true);
      }
    });
  }

  it("the canvas is white in light and #171717 in dark", () => {
    expect(THEMES[0]!.t["--bg"]).toBe("#ffffff");
    expect(THEMES[1]!.t["--bg"]).toBe("#171717");
  });

  it("nothing re-skins the app per character or per space any more", () => {
    expect(css).not.toMatch(/\[data-hue/);
    expect(css).not.toMatch(/\[data-space="personal"\]/);
  });
});
