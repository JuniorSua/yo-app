import type { Memory } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { filterMemories, labelCounts, memoryLabel, whoSees } from "./memoryFilter";

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
  // From a core that predates labels: no `space` at all.
  { id: "old", agentId: null, content: "old", createdAt: 0, updatedAt: 0 } as Memory,
];
const ids = (ms: Memory[]) => ms.map((m) => m.id);

describe("memory filters", () => {
  it("counts a memory with no label as Everywhere", () => {
    expect(memoryLabel(list[5] as Memory)).toBeNull();
  });

  it("filters by label", () => {
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

  it("counts each label", () => {
    expect(labelCounts(list)).toEqual({ all: 6, work: 2, personal: 1, everywhere: 3 });
    expect(labelCounts(list, "shared")).toEqual({ all: 4, work: 1, personal: 1, everywhere: 2 });
  });
});

describe("who sees a memory", () => {
  // The owner's team: Yo (Work focus), Pip (Personal focus), Pepe (no focus).
  const team = [
    { name: "Yo", space: "work" as const },
    { name: "Pip", space: "personal" as const },
    { name: "Pepe", space: null },
  ];

  it("names the agents whose prompt shows it", () => {
    expect(whoSees("work", team)).toBe("Yo and Pepe see it");
    expect(whoSees("personal", team)).toBe("Pip and Pepe see it");
    expect(whoSees(null, team)).toBe("Every agent sees it");
    expect(whoSees("personal", [team[0]!, team[1]!])).toBe("Pip sees it");
  });

  it("with no focused agents, everyone sees every label", () => {
    const plain = [{ name: "Yo", space: null }, { name: "Pepe" }];
    expect(whoSees("work", plain)).toBe("Every agent sees it");
    expect(whoSees("work", [team[1]!])).toBe("Found when an agent searches memory");
    const many = ["A", "B", "C", "D"].map((name) => ({ name, space: null }));
    expect(whoSees("work", [...many, team[1]!])).toBe("A, B and 2 more see it");
  });
});
