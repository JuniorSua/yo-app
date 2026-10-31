import {
  AVATAR_COLORS,
  Avatar as AvatarSchema,
  type Item,
  SOFTIE_KINDS,
  type TimelineEntry,
} from "@yo/contracts";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { contrast } from "./color-math";
import {
  AGENT_TEMPLATES,
  Avatar,
  HELPER_ACCENTS,
  helperAvatar,
  SOFTIE_ACCENTS,
  SOFTIE_STATES,
  Softie,
  softieAvatar,
  softieOf,
  softiePalette,
  softieState,
  turnInfo,
  YO_AVATAR,
  YoLogo,
} from "./index";

const SIZES = [16, 24, 40, 64, 120];

describe("Softie", () => {
  it("draws every Softie in every state at every size, without NaN", () => {
    for (const kind of SOFTIE_KINDS)
      for (const state of SOFTIE_STATES)
        for (const size of SIZES) {
          const html = renderToStaticMarkup(createElement(Softie, { kind, state, size }));
          expect(html).toContain("<svg");
          expect(html).toContain(`data-softie="${kind}"`);
          expect(html).not.toContain("NaN");
          expect(html).not.toContain("undefined");
        }
  });

  it("small sizes show the state as a badge; bigger ones use overlays", () => {
    const at = (size: number, state: (typeof SOFTIE_STATES)[number]) =>
      renderToStaticMarkup(createElement(Softie, { kind: "dew", state, size }));
    expect(at(24, "thinking")).toContain("sf-badge-thinking");
    expect(at(24, "thinking")).not.toContain("sf-thought");
    expect(at(64, "thinking")).toContain("sf-thought");
    expect(at(64, "thinking")).not.toContain("sf-badge");
    expect(at(24, "working")).toContain("sf-badge-working");
    expect(at(40, "working")).toContain("sf-orbit");
    for (const size of SIZES) {
      expect(at(size, "needs")).toContain("sf-badge-needs");
      expect(at(size, "done")).toContain("sf-badge-done");
      expect(at(size, "error")).toContain("sf-badge-error");
      expect(at(size, "idle")).not.toContain("sf-badge");
      expect(at(size, "sleeping")).not.toContain("sf-badge");
    }
    // 30px and below crop to the figure so it fills the slot.
    expect(at(24, "idle")).toContain('viewBox="5 5 90 90"');
    expect(at(40, "idle")).toContain('viewBox="0 0 100 100"');
  });

  it("gives every gradient, clip and mask a unique id, and every reference resolves in its own svg", () => {
    // Many avatars on one page, all states: the designer's bug was "a1" + "b" meeting "a1b".
    const list = [];
    for (let i = 0; i < 4; i++)
      for (const kind of SOFTIE_KINDS)
        for (const state of SOFTIE_STATES)
          list.push(createElement(Softie, { key: `${i}${kind}${state}`, kind, state, size: SIZES[i % 5]! }));
    list.push(
      createElement(Avatar, { key: "photo", avatar: { ...YO_AVATAR, image: "data:," }, state: "done" }),
    );
    const html = renderToStaticMarkup(createElement(Fragment, null, list));
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(list.length * 5);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of html.split("</svg>").filter((s) => s.includes("<svg"))) {
      const own = [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
      for (const ref of svg.matchAll(/url\(#([^)]+)\)/g)) expect(own).toContain(ref[1]);
    }
  });

  it("wears another colour when asked", () => {
    const html = renderToStaticMarkup(createElement(Softie, { kind: "dew", color: "#DD6ADC", size: 64 }));
    expect(html).toContain(softiePalette("#DD6ADC").shade);
    expect(html).not.toContain(softiePalette("#4C86FF").shade);
  });

  it("stays still when animated is off", () => {
    expect(renderToStaticMarkup(createElement(Softie, { kind: "yo", state: "done" }))).toContain("sf--anim");
    expect(
      renderToStaticMarkup(createElement(Softie, { kind: "yo", state: "done", animated: false })),
    ).not.toContain("sf--anim");
  });
});

describe("palettes", () => {
  it("every accent's text tones read (AA) on light and dark pages", () => {
    for (const a of SOFTIE_ACCENTS) {
      const p = softiePalette(a.hex);
      expect(p.base).toBe(a.hex);
      for (const bg of ["#ffffff", "#f6f6f8"]) expect(contrast(p.ink, bg)).toBeGreaterThanOrEqual(4.5);
      for (const bg of ["#111113", "#1c1c1f"]) expect(contrast(p.inkDark, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("derives a readable ramp for any other colour", () => {
    for (const hex of ["#10B981", "#EF4444", "#64748B", "#FACC15"]) {
      const p = softiePalette(hex);
      expect(contrast(p.ink, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.inkDark, "#111113")).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("older avatars become Softies (no migration)", () => {
  const drawn = (color: string): AvatarSchema => ({
    shape: "squircle",
    color,
    eyes: "capsule",
    accessory: "headset",
  });

  it("the main agent and anything Yo-yellow is Yo", () => {
    expect(softieOf({ shape: "bubble", color: "yo" })).toEqual({ kind: "yo", color: "#FFD43B" });
    expect(softieOf(drawn("violet"), { primary: true })).toEqual({ kind: "yo", color: "#FFD43B" });
    expect(softieOf({ ...drawn("orange"), creature: { kind: "pebble" } }, { primary: true }).kind).toBe("yo");
    expect(softieOf(drawn("#F2C14E")).kind).toBe("yo");
  });

  it("others go by their nearest colour, and keep it", () => {
    const want: Record<string, [string, string]> = {
      violet: ["clove", "#9165F7"],
      emerald: ["mochi", "#2DC892"],
      orange: ["pico", "#FF7E36"],
      cyan: ["dew", "#00B1FF"],
      cobalt: ["dew", "#4C86FF"],
      pink: ["kiki", "#F4579F"],
      red: ["pico", "#FF7E36"],
      lime: ["mochi", "#B6D80B"],
      bronze: ["pico", "#FF7E36"],
      slate: ["dew", "#7C9CC3"],
      white: ["dew", "#7C9CC3"],
    };
    for (const c of AVATAR_COLORS.filter((c) => c.id !== "yo")) {
      const [kind, color] = want[c.id]!;
      expect(softieOf(drawn(c.id)), c.id).toEqual({ kind, color });
      // Same answer for the raw hex, every time.
      expect(softieOf(drawn(c.hex))).toEqual(softieOf(drawn(c.id)));
    }
  });

  it("creatures, living characters and CupCats keep their character's feel", () => {
    const creature = (kind: "sprout" | "pebble" | "mimi", tint?: string) => ({
      ...drawn("lime"),
      creature: { kind, tint },
    });
    expect(softieOf(creature("sprout"))).toEqual({ kind: "mochi", color: "#2DC892" });
    expect(softieOf(creature("pebble"))).toEqual({ kind: "pico", color: "#FF7E36" });
    expect(softieOf(creature("mimi"))).toEqual({ kind: "clove", color: "#9165F7" });
    // A tinted helper creature keeps (the nearest accent to) its tint.
    expect(softieOf(creature("mimi", "#3a7ff1"))).toEqual({ kind: "clove", color: "#4C86FF" });
    const living = (character: "violet" | "lagoon" | "coral") => ({
      ...drawn("cyan"),
      living: { character, body: "x", headset: "y" },
    });
    expect(softieOf(living("violet")).kind).toBe("clove");
    expect(softieOf(living("lagoon")).kind).toBe("dew");
    expect(softieOf(living("coral")).kind).toBe("pico");
    expect(softieOf({ shape: "cupcat", color: "yo", variant: "matcha" }).kind).toBe("mochi");
    expect(softieOf({ shape: "cupcat", color: "yo", variant: "sakura" }).kind).toBe("kiki");
    expect(softieOf({ shape: "cupcat", color: "yo" }).kind).toBe("pico");
  });

  it("a saved Softie wins, with its own colour or the default", () => {
    expect(softieOf({ ...drawn("violet"), softie: { kind: "kiki" } })).toEqual({
      kind: "kiki",
      color: "#F4579F",
    });
    expect(softieOf({ ...drawn("violet"), softie: { kind: "dew", color: "#B6D80B" } })).toEqual({
      kind: "dew",
      color: "#B6D80B",
    });
    expect(softieOf({ ...drawn("violet"), softie: { kind: "dew" } }, { primary: true }).kind).toBe("dew");
  });

  it("an uploaded photo still wins over the Softie", () => {
    const html = renderToStaticMarkup(
      createElement(Avatar, { avatar: { ...softieAvatar("dew"), image: "data:image/png;base64,AA" } }),
    );
    expect(html).toContain("<image");
    expect(html).not.toContain("data-softie");
    expect(renderToStaticMarkup(createElement(Avatar, { avatar: drawn("violet") }))).toContain(
      'data-softie="clove"',
    );
  });
});

describe("avatar records", () => {
  it("Softie avatars are valid, with a close fallback for older apps", () => {
    for (const kind of SOFTIE_KINDS) {
      const a = softieAvatar(kind);
      expect(AvatarSchema.parse(a)).toEqual(a);
      expect(softieOf(a).kind).toBe(kind);
    }
    expect(YO_AVATAR.color).toBe("yo");
    expect(softieAvatar("pico", "#00B1FF")).toMatchObject({
      color: "#00B1FF",
      softie: { kind: "pico", color: "#00B1FF" },
    });
    expect(AGENT_TEMPLATES.find((t) => t.primary)?.avatar.softie?.kind).toBe("yo");
    expect(AGENT_TEMPLATES.map((t) => t.id)).toEqual([...SOFTIE_KINDS]);
  });

  it("helpers are stable, never Yo or their parent's Softie, and wear a helper accent", () => {
    const helperHexes = HELPER_ACCENTS.map((id) => SOFTIE_ACCENTS.find((a) => a.id === id)!.hex);
    const kinds = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const seed = `agt_${i.toString(36)}x${i * 7}`;
      const a = helperAvatar(seed, softieAvatar("dew"));
      expect(helperAvatar(seed, softieAvatar("dew"))).toEqual(a);
      expect(AvatarSchema.parse(a)).toEqual(a);
      expect(a.softie?.kind).not.toBe("yo");
      expect(a.softie?.kind).not.toBe("dew");
      expect(helperHexes).toContain(a.softie?.color);
      kinds.add(a.softie!.kind);
    }
    expect(kinds.size).toBe(4);
    expect(helperAvatar("agt_x").softie?.kind).not.toBe("yo");
  });

  it("the logo still renders", () => {
    expect(renderToStaticMarkup(createElement(YoLogo, { size: 24 }))).toContain('aria-label="Yo"');
  });
});

let seq = 0;
const entry = (kind: Item["kind"], status: Item["status"] = "completed"): TimelineEntry => ({
  id: `e${seq}`,
  agentId: "a",
  turnId: "t",
  seq: seq++,
  createdAt: 0,
  item: { id: `i${seq}`, kind, status },
});

describe("state", () => {
  it("maps every activity", () => {
    expect(softieState("idle")).toBe("idle");
    expect(softieState("working")).toBe("working");
    expect(softieState("waiting")).toBe("needs");
    expect(softieState("done")).toBe("done");
    expect(softieState("sleeping")).toBe("sleeping");
    expect(softieState("error")).toBe("error");
  });

  it("only looks at the current turn (after the last user message)", () => {
    expect(turnInfo(undefined)).toBeUndefined();
    const old = [entry("user_message"), entry("command", "running")];
    expect(turnInfo([...old, entry("user_message")])).toEqual({ toolRunning: false, lastKind: null });
    expect(turnInfo([entry("user_message"), entry("browser", "running"), entry("todo", "running")])).toEqual({
      toolRunning: true,
      lastKind: "browser",
    });
  });

  it("thinks while a turn reasons or writes, and works while a tool runs", () => {
    const think = (entries: TimelineEntry[]) => softieState("working", turnInfo(entries));
    expect(think([entry("user_message")])).toBe("thinking");
    expect(think([entry("user_message"), entry("reasoning", "running")])).toBe("thinking");
    expect(think([entry("user_message"), entry("assistant_message", "running")])).toBe("thinking");
    expect(think([entry("user_message"), entry("command", "running")])).toBe("working");
    // Between two tool steps it stays on working (no flicker).
    expect(think([entry("user_message"), entry("file_change")])).toBe("working");
    expect(think([entry("user_message"), entry("command"), entry("reasoning", "running")])).toBe("thinking");
  });
});
