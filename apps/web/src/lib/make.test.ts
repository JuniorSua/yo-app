import type { Artifact } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import {
  filterMade,
  KIND_LABEL,
  kindTint,
  MAKE_STARTERS,
  makeFilters,
  makeKindOf,
  starterDraft,
} from "./make";

const art = (id: string, kind?: Artifact["kind"], pageKind?: Artifact["pageKind"]): Artifact => ({
  id,
  agentId: "agt_yo",
  title: id,
  path: `${id}.md`,
  mime: "text/markdown",
  size: 1,
  createdAt: 0,
  ...(kind ? { kind } : {}),
  ...(pageKind ? { pageKind } : {}),
});

describe("Make kinds", () => {
  it("reads a page's own kind, and files and bug reports as theirs", () => {
    expect(makeKindOf(art("a", "page", "dashboard"))).toBe("dashboard");
    expect(makeKindOf(art("b", "page"))).toBe("page"); // an older core: no page kind
    expect(makeKindOf(art("c", "file"))).toBe("file");
    expect(makeKindOf(art("d"))).toBe("file");
    expect(makeKindOf(art("e", "bug"))).toBe("bug");
    expect(KIND_LABEL[makeKindOf(art("f", "page", "slides"))]).toBe("Slides");
  });

  it("shows All first, then a chip only for the kinds there are, in a fixed order", () => {
    const list = [
      art("a", "bug"),
      art("b", "page", "slides"),
      art("c"),
      art("d", "page", "dashboard"),
      art("e", "page"),
    ];
    expect(makeFilters(list)).toEqual([
      { id: "all", label: "All" },
      { id: "page", label: "Pages" },
      { id: "dashboard", label: "Dashboards" },
      { id: "slides", label: "Slides" },
      { id: "file", label: "Files" },
      { id: "bug", label: "Bug reports" },
    ]);
    expect(makeFilters([])).toEqual([{ id: "all", label: "All" }]);
  });

  it("filters to one kind and keeps the order", () => {
    const list = [art("a", "page", "doc"), art("b"), art("c", "page", "doc"), art("d", "page")];
    expect(filterMade(list, "doc").map((a) => a.id)).toEqual(["a", "c"]);
    expect(filterMade(list, "page").map((a) => a.id)).toEqual(["d"]);
    expect(filterMade(list, "all").map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("tints with 13% of the kind's colour on the card", () => {
    expect(kindTint("doc")).toBe("color-mix(in srgb, var(--kind-blue) 13%, var(--card))");
  });

  it("turns a starter into a draft to finish", () => {
    expect(starterDraft("Make a deck about …")).toBe("Make a deck about ");
    expect(MAKE_STARTERS.map((s) => starterDraft(s.starter))).toEqual([
      "Make a dashboard of ",
      "Make a deck about ",
      "Write a doc about ",
      "Make a web page about ",
      "Make a design for ",
    ]);
  });
});
