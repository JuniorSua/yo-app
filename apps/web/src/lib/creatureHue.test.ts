import { readFileSync } from "node:fs";
import { CREATURE_KINDS } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import {
  contrast,
  contrastPairs,
  DARK_WORKSPACE_PALETTE,
  hueTokens,
  isCreatureKind,
  resolveHue,
  workspacePalette,
  workspaceVariables,
} from "./creatureHue";

const KINDS = CREATURE_KINDS;

describe("character workspace palettes (shared with the creature lab)", () => {
  it("uses a distinct complete light palette for each character", () => {
    const palettes = KINDS.map((id) => workspaceVariables(id, false));
    for (const token of [
      "--ws-bg",
      "--ws-surface",
      "--ws-line",
      "--ws-bubble",
      "--ws-active",
      "--ws-accent",
    ]) {
      expect(new Set(palettes.map((p) => p[token])).size).toBe(3);
    }
  });
  it("keeps every dark token identical across characters", () => {
    for (const id of KINDS) {
      expect(workspacePalette(id, true)).toBe(DARK_WORKSPACE_PALETTE);
      expect(workspaceVariables(id, true)).toEqual(workspaceVariables("sprout", true));
      expect(workspaceVariables(id, false)).not.toEqual(workspaceVariables(id, true));
    }
  });
  it("keeps text and secondary text legible on the workshop's tinted backgrounds", () => {
    for (const id of KINDS) {
      for (const dark of [false, true]) {
        const p = workspacePalette(id, dark);
        for (const bg of [p.bg, p.surface, p.bubble, p.active]) {
          expect(contrast(p.text, bg)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(p.muted, bg)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

describe("app tokens: WCAG AA contrast", () => {
  for (const kind of KINDS) {
    it(`${kind}: every text/background pair the app uses meets AA`, () => {
      const failures = contrastPairs(kind)
        .map((p) => ({ ...p, ratio: Math.round(contrast(p.fg, p.bg) * 100) / 100 }))
        .filter((p) => p.ratio < p.min);
      expect(failures).toEqual([]);
    });
  }
  it("covers the pairs the brief asks for", () => {
    const labels = contrastPairs("sprout").map((p) => p.label);
    for (const l of [
      "text on bg",
      "text on card",
      "muted on bg",
      "muted on card",
      "muted on bubble",
      "muted on selected row on sidebar",
      "accent foreground on accent",
      "accent text/link on bg",
    ])
      expect(labels).toContain(l);
  });
});

/** The `html.light[data-hue="kind"] { … }` block in styles.css, as a token map. */
function cssBlock(css: string, kind: string): Record<string, string> {
  const m = css.match(new RegExp(`html\\.light\\[data-hue="${kind}"\\]\\s*\\{([^}]*)\\}`));
  if (!m) return {};
  return Object.fromEntries(
    m[1]!
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d.startsWith("--"))
      .map((d) => {
        const i = d.indexOf(":");
        return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
      }),
  );
}

describe("styles.css", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  it("holds exactly the tokens hueTokens() derives, for each character", () => {
    for (const kind of KINDS) expect(cssBlock(css, kind)).toEqual(hueTokens(kind));
  });
  it("only applies a hue under the light theme (dark mode can't be affected)", () => {
    const selectors = [...css.matchAll(/^([^\n{}]*data-hue[^\n{}]*)\{/gm)].map((m) => m[1]!.trim());
    expect(selectors.length).toBe(KINDS.length);
    for (const s of selectors) expect(s).toMatch(/^html\.light\[data-hue="(sprout|pebble|mimi)"\]$/);
  });
});

describe("resolveHue: primary agent creature x theme x toggle", () => {
  for (const creature of [...KINDS, undefined, "dragon", 42, null]) {
    for (const theme of ["light", "dark"] as const) {
      for (const enabled of [true, false]) {
        const expected = enabled && theme === "light" && isCreatureKind(creature) ? creature : null;
        it(`${String(creature)} / ${theme} / toggle ${enabled ? "on" : "off"} -> ${expected ?? "no hue"}`, () => {
          expect(resolveHue({ creature, theme, enabled })).toBe(expected);
        });
      }
    }
  }
  it("applies the creature's hue only in light mode with the toggle on", () => {
    expect(resolveHue({ creature: "mimi", theme: "light", enabled: true })).toBe("mimi");
    expect(resolveHue({ creature: "mimi", theme: "dark", enabled: true })).toBeNull();
    expect(resolveHue({ creature: "mimi", theme: "light", enabled: false })).toBeNull();
    expect(resolveHue({ creature: undefined, theme: "light", enabled: true })).toBeNull();
  });
});
