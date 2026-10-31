import { DEFAULT_WORK_HOURS, type Memory } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { defaultMemorySpace, filterMemories, memorySpace, spaceCounts } from "./memoryFilter";

const mem = (id: string, space: Memory["space"], agentId: string | null = null): Memory => ({
  id,
  agentId,
  content: id,
  space,
  createdAt: 0,
  updatedAt: 0,
});

const list = [
  mem("seats", null),
  mem("budget", "personal"),
  mem("quotes", "work"),
  mem("visa", null, "agt_shop"),
  mem("review", "work", "agt_cos"),
  // From a core that predates spaces: no `space` at all.
  { id: "old", agentId: null, content: "old", createdAt: 0, updatedAt: 0 } as Memory,
];
const ids = (ms: Memory[]) => ms.map((m) => m.id);

describe("memory filters", () => {
  it("counts a memory with no space as Everywhere", () => {
    expect(memorySpace(list[5] as Memory)).toBeNull();
  });

  it("filters by space", () => {
    expect(ids(filterMemories(list, "all"))).toEqual(ids(list));
    expect(ids(filterMemories(list, "work"))).toEqual(["quotes", "review"]);
    expect(ids(filterMemories(list, "personal"))).toEqual(["budget"]);
    expect(ids(filterMemories(list, "everywhere"))).toEqual(["seats", "visa", "old"]);
  });

  it("filters by agent too", () => {
    expect(ids(filterMemories(list, "all", "shared"))).toEqual(["seats", "budget", "quotes", "old"]);
    expect(ids(filterMemories(list, "all", "agt_shop"))).toEqual(["visa"]);
    expect(ids(filterMemories(list, "work", "agt_cos"))).toEqual(["review"]);
    expect(filterMemories(list, "personal", "agt_cos")).toEqual([]);
  });

  it("counts each space", () => {
    expect(spaceCounts(list)).toEqual({ all: 6, work: 2, personal: 1, everywhere: 3 });
    expect(spaceCounts(list, "shared")).toEqual({ all: 4, work: 1, personal: 1, everywhere: 2 });
  });

  it("adds new memories to the space you're in", () => {
    const s = { spacesOn: true, workHours: DEFAULT_WORK_HOURS, timezone: "America/New_York" };
    // Tue Oct 13 2026: 3 PM is Work, 9 PM is Personal (New York).
    expect(defaultMemorySpace({ ...s, spaceManual: null }, Date.UTC(2026, 9, 13, 19))).toBe("work");
    expect(defaultMemorySpace({ ...s, spaceManual: null }, Date.UTC(2026, 9, 14, 1))).toBe("personal");
    expect(defaultMemorySpace({ ...s, spaceManual: { space: "personal", until: null } })).toBe("personal");
    // Spaces off (or an older core): Everywhere.
    expect(defaultMemorySpace({ ...s, spacesOn: false })).toBeNull();
    expect(defaultMemorySpace({})).toBeNull();
  });
});
