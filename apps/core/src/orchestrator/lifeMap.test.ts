import { DEFAULT_SETTINGS, type Memory, SUGGESTION_PREFIX } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { buildSystemAppend, LIFE_MAP_MAX_CHARS, lifeMapSection } from "./PromptBuilder";

const NOW = new Date("2026-10-05T15:00:00Z");
let n = 0;
const mem = (content: string, ageDays = 1): Memory => ({
  id: `mem_${++n}`,
  agentId: null,
  content,
  createdAt: NOW.getTime() - ageDays * 86_400_000,
  updatedAt: NOW.getTime() - ageDays * 86_400_000,
});

const ctx = (memories: Memory[], isPrimary = true) => ({
  agent: { id: "agt_yo", name: "Yo", role: "", instructions: "", isPrimary },
  team: [],
  settings: { ...DEFAULT_SETTINGS, userName: "Sam" },
  memories,
  scratchpad: "",
  routines: [],
  priorConversation: [],
  now: NOW,
});

describe("life map in the main assistant's prompt", () => {
  it("shows one line per tagged area, newest area first, and ignores untagged memories", () => {
    const text = lifeMapSection(
      [
        mem("[area:work] Quotes for Polestar go out by Friday", 5),
        mem("[area:work] Desk leads are in Activix", 6),
        mem("[area:personal] Gym on Tuesdays", 1),
        mem("Prefers window seats"),
      ],
      "Sam",
    )!;
    expect(text).toContain("# Your life map");
    expect(text).toContain("- work: Quotes for Polestar go out by Friday; Desk leads are in Activix");
    expect(text).toContain("- personal: Gym on Tuesdays");
    expect(text).not.toContain("window seats");
    expect(text.indexOf("- personal")).toBeLessThan(text.indexOf("- work"));
  });

  it("has no section until something is tagged", () => {
    expect(lifeMapSection([mem("Prefers window seats")], "Sam")).toBeNull();
    const prompt = buildSystemAppend(ctx([mem("Prefers window seats")]));
    expect(prompt).not.toContain("# Your life map");
    // The rules are still there, and they tell Yo to build the map.
    expect(prompt).toContain("# Areas, goals and new agents");
    expect(prompt).toContain("You don't have a life map yet");
  });

  it("is capped, however much is remembered", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      mem(`[area:area${i % 12}] ${"fact ".repeat(60)}${i}`, i),
    );
    const text = lifeMapSection(many, "Sam")!;
    expect(text.length).toBeLessThanOrEqual(LIFE_MAP_MAX_CHARS);
    expect(text.split("\n- ").length - 1).toBeLessThanOrEqual(8);
    expect(text).toContain("use recall");
  });

  it("is only in the main assistant's prompt", () => {
    const tagged = [mem("[area:work] Quotes go out Friday")];
    expect(buildSystemAppend(ctx(tagged, true))).toContain("# Your life map");
    const other = buildSystemAppend(ctx(tagged, false));
    expect(other).not.toContain("# Your life map");
    expect(other).not.toContain("# Areas, goals and new agents");
  });

  it("states the rules: the four conditions, once per area per month, reason and cost, ask first", () => {
    const prompt = buildSystemAppend(ctx([mem("[area:work] Quotes go out Friday")]));
    expect(prompt).toContain("work out which area it belongs to");
    expect(prompt).toContain("its own audience");
    expect(prompt).toContain("busy most of the day");
    expect(prompt).toContain("sign-ins or data must not mix");
    expect(prompt).toContain("different model or has different cost");
    expect(prompt).toContain("at most once per area per month");
    expect(prompt).toContain("about 450 MB");
    expect(prompt).toContain("Only add the teammate");
    expect(prompt).toContain("after Sam says yes");
  });

  it("remembers recent suggestions per area, and forgets them after a month", () => {
    const recent = mem(`[area:work] ${SUGGESTION_PREFIX}2026-09-25`);
    const old = mem(`[area:personal] ${SUGGESTION_PREFIX}2026-07-01`);
    const prompt = buildSystemAppend(ctx([recent, old, mem("[area:work] Quotes go out Friday")]));
    expect(prompt).toContain("You already suggested an agent for: work (on 2026-09-25)");
    expect(prompt).not.toContain("personal (on");
    // The suggestion note itself is bookkeeping, not part of the map.
    expect(lifeMapSection([recent], "Sam")).toBeNull();
  });
});

describe("text to copy", () => {
  it("tells Yo to put text to copy in a fenced code block (it gets a Copy button)", () => {
    const prompt = buildSystemAppend(ctx([]));
    expect(prompt).toContain("put exactly that text in its own fenced code block");
  });
});
