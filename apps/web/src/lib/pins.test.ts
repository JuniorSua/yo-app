import type { Artifact } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { sortPinnedFirst } from "./pins";

const art = (id: string, pinnedAt?: number | null): Artifact => ({
  id,
  agentId: "agt_yo",
  title: id,
  path: `${id}.md`,
  mime: "text/markdown",
  size: 1,
  createdAt: 0,
  ...(pinnedAt !== undefined ? { pinnedAt } : {}),
});

describe("sortPinnedFirst", () => {
  it("puts pinned files first, newest pin on top, and keeps the rest in order", () => {
    const list = [art("a"), art("b", 10), art("c", null), art("d", 20), art("e")];
    expect(sortPinnedFirst(list).map((a) => a.id)).toEqual(["d", "b", "a", "c", "e"]);
  });

  it("leaves a list with no pins (or from an older core) as it is", () => {
    const list = [art("a"), art("b")];
    expect(sortPinnedFirst(list).map((a) => a.id)).toEqual(["a", "b"]);
  });
});
