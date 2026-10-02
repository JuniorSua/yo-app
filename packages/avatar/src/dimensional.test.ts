import { AVATAR_ACCESSORIES, AVATAR_EYES, AVATAR_SHAPES } from "@yo/contracts";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar, VIOLET_COPILOT, YoLogo } from "./index";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
/** The rendered <svg> class list (the markup also contains the shared stylesheet text). */
const svgClass = (html: string) => html.match(/<svg class="([^"]*)"/)?.[1] ?? "";

describe("dimensional finish (Violet Copilot)", () => {
  it("is opt-in: saved avatars without `finish` render exactly as before", () => {
    const legacy = { shape: "squircle", color: "violet", eyes: "capsule", accessory: "headset" } as const;
    const html = render(createElement(Avatar, { avatar: legacy, size: 40 }));
    expect(svgClass(html)).not.toContain("yo-av--dim");
    expect(html).not.toContain('data-finish="dimensional"');
    const flatExplicit = render(createElement(Avatar, { avatar: { ...legacy, finish: "flat" }, size: 40 }));
    expect(svgClass(flatExplicit)).not.toContain("yo-av--dim");
    expect(svgClass(render(createElement(Avatar, { avatar: VIOLET_COPILOT, size: 40 })))).toContain(
      "yo-av--dim",
    );
  });

  it("renders every shape × eyes × accessory × size without NaN", () => {
    for (const size of [20, 34, 128])
      for (const shape of AVATAR_SHAPES.filter((x) => x !== "cupcat"))
        for (const eyes of AVATAR_EYES)
          for (const accessory of AVATAR_ACCESSORIES) {
            const html = render(
              createElement(Avatar, {
                avatar: { shape, eyes, accessory, color: "violet", finish: "dimensional" },
                size,
              }),
            );
            expect(html).toContain('data-finish="dimensional"');
            expect(html).not.toContain("NaN");
          }
  });

  it("uses the tuned Violet Copilot material and headset", () => {
    const html = render(createElement(Avatar, { avatar: VIOLET_COPILOT, size: 128 }));
    expect(html).toContain("#8854FF");
    expect(html).toContain("#C9A4FF");
    expect(html).toContain("#45208C");
    expect(html).toContain("#202338"); // headset midnight
    expect(html).toContain("#0B0C0E"); // shared eye ink
  });

  it("keeps an attentive face on error (no x-eyes) while legacy keeps x-eyes", () => {
    const dim = render(createElement(Avatar, { avatar: VIOLET_COPILOT, size: 64, state: "error" }));
    const legacy = render(
      createElement(Avatar, { avatar: { ...VIOLET_COPILOT, finish: undefined }, size: 64, state: "error" }),
    );
    const xPath = /M[\d.]+ [\d.]+L[\d.]+ [\d.]+M/;
    expect(xPath.test(dim)).toBe(false);
    expect(xPath.test(legacy)).toBe(true);
  });

  it("drops fine detail (catch-lights, occlusion) at compact sizes", () => {
    const small = render(createElement(Avatar, { avatar: VIOLET_COPILOT, size: 20 }));
    const hero = render(createElement(Avatar, { avatar: VIOLET_COPILOT, size: 128 }));
    expect(small.length).toBeLessThan(hero.length);
    expect(small).not.toContain('opacity="0.3"');
    expect(hero).toContain('opacity="0.3"');
  });

  it("namespaces SVG ids so many avatars + logos can share a page", () => {
    const html = render(
      createElement(
        Fragment,
        null,
        createElement(Avatar, { avatar: VIOLET_COPILOT, size: 48 }),
        createElement(Avatar, { avatar: VIOLET_COPILOT, size: 48 }),
        createElement(YoLogo, { size: 48 }),
        createElement(YoLogo, { size: 48 }),
      ),
    );
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Sunlit Satin logo", () => {
  it("is the default finish, with the exact original eye geometry", () => {
    const html = render(createElement(YoLogo, { size: 48 }));
    expect(html).toContain("#FFF19A");
    expect(html).toContain("#CF8615");
    expect(html).toContain('x="35.2" y="37.6" width="9.2" height="17" rx="4.6"');
    expect(html).toContain('x="57.6" y="37.6" width="9.2" height="17" rx="4.6"');
  });

  it("falls back to the flat mark at tiny sizes and when asked", () => {
    expect(render(createElement(YoLogo, { size: 14 }))).not.toContain("#FFF19A");
    expect(render(createElement(YoLogo, { size: 64, finish: "flat" }))).not.toContain("#FFF19A");
  });
});

describe("CupCats (rolled, 15 collectibles) + headset-for-all", () => {
  it("renders all 15 CupCats in every state and size without NaN, with a headset + mic", async () => {
    const { CUPCAT_VARIANTS } = await import("./index");
    for (const v of CUPCAT_VARIANTS)
      for (const size of [20, 48, 128])
        for (const state of ["idle", "working", "waiting", "done", "error", "sleeping"] as const) {
          const html = render(
            createElement(Avatar, {
              avatar: { shape: "cupcat", color: "yo", eyes: "capsule", accessory: "headset", variant: v.id },
              size,
              state,
            }),
          );
          expect(html).not.toContain("NaN");
          expect(html).toContain(`data-variant="${v.id}"`);
          expect(html).toContain("yo-av-mic");
        }
  });

  it("has 15 variants whose odds sum to exactly 100, with a 1% legendary rainbow", async () => {
    const { CUPCAT_VARIANTS } = await import("./index");
    expect(CUPCAT_VARIANTS).toHaveLength(15);
    expect(CUPCAT_VARIANTS.reduce((a, v) => a + v.odds, 0)).toBe(100);
    expect(new Set(CUPCAT_VARIANTS.map((v) => v.id)).size).toBe(15);
    const legendary = CUPCAT_VARIANTS.filter((v) => v.rarity === "legendary");
    expect(legendary.map((v) => [v.id, v.odds])).toEqual([["niji", 1]]);
  });

  it("rolls with the published odds (seeded, 100k draws)", async () => {
    const { CUPCAT_VARIANTS, rollCupCat } = await import("./index");
    let seed = 42;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const counts = new Map<string, number>();
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const v = rollCupCat(rng);
      counts.set(v.id, (counts.get(v.id) ?? 0) + 1);
    }
    for (const v of CUPCAT_VARIANTS) {
      const pct = ((counts.get(v.id) ?? 0) / N) * 100;
      expect(Math.abs(pct - v.odds)).toBeLessThan(0.6);
    }
    expect(rollCupCat(() => 0).id).toBe(CUPCAT_VARIANTS[0]!.id);
    expect(rollCupCat(() => 0.99999).id).toBe("niji");
  });

  it("only Violet Copilot is a customizable preset; templates and randoms are headset-wearing Copilots", async () => {
    const { AVATAR_PRESETS, AGENT_TEMPLATES, randomAvatar } = await import("./index");
    expect(AVATAR_PRESETS.map((p) => p.id)).toEqual(["violet-copilot"]);
    for (const t of AGENT_TEMPLATES) {
      expect(t.avatar.accessory).toBe("headset");
      expect(t.avatar.shape).not.toBe("cupcat");
    }
    for (let i = 0; i < 200; i++) {
      const a = randomAvatar();
      expect(a.accessory).toBe("headset");
      expect(a.shape).not.toBe("cupcat");
    }
  });

  it("unknown/legacy CupCats fall back to Sakura Mochi", () => {
    const html = render(
      createElement(Avatar, {
        avatar: { shape: "cupcat", color: "pink", eyes: "capsule", accessory: "headset" },
        size: 48,
      }),
    );
    expect(html).toContain('data-variant="sakura"');
  });

  it("marks the boom mic so it can bob while working", () => {
    const html = render(createElement(Avatar, { avatar: VIOLET_COPILOT, size: 64, state: "working" }));
    expect(html).toMatch(/class="yo-av-mic"/);
    expect(html).toContain("transform-origin");
  });
});
