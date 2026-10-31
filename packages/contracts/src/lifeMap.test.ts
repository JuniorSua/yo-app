import { describe, expect, it } from "vitest";
import { normalizeArea, parseArea, recentSuggestions, SUGGESTION_PREFIX, tagArea } from "./lifeMap";

describe("area tags", () => {
  it("tags, parses and re-tags", () => {
    expect(tagArea("Work Stuff!", "Quotes go out Friday")).toBe("[area:work-stuff] Quotes go out Friday");
    expect(parseArea("[area:work] Quotes")).toEqual({ area: "work", text: "Quotes" });
    expect(parseArea("[AREA: Work ] Quotes")).toEqual({ area: "work", text: "Quotes" });
    expect(tagArea("personal", "[area:work] Quotes")).toBe("[area:personal] Quotes");
    expect(tagArea("", "Quotes")).toBe("Quotes");
    expect(tagArea(undefined, "Quotes")).toBe("Quotes");
    expect(parseArea("Prefers window seats")).toEqual({ area: null, text: "Prefers window seats" });
    expect(normalizeArea("  Yo project ")).toBe("yo-project");
  });

  it("finds suggestions made in the last 30 days, newest per area", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    const found = recentSuggestions(
      [
        { content: `[area:work] ${SUGGESTION_PREFIX}2026-09-20` },
        { content: `[area:work] ${SUGGESTION_PREFIX}2026-09-30` },
        { content: `[area:personal] ${SUGGESTION_PREFIX}2026-08-01` },
        { content: `${SUGGESTION_PREFIX}2026-10-01` },
        { content: "[area:work] Quotes" },
      ],
      now,
    );
    expect(found).toEqual([{ area: "work", date: "2026-09-30" }]);
  });
});
