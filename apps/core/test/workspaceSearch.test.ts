import type { Item } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/db";
import { Store } from "../src/db/store";

let store: Store;
function agent(name: string) {
  return store.createAgent({
    name,
    role: "",
    instructions: "",
    avatar: { shape: "squircle", color: "yellow", eyes: "round", accessory: "none" },
    accountId: null,
    model: null,
    effort: null,
    runtimeMode: "approval-required",
    isPrimary: name === "Yo",
    pinned: false,
  });
}
function message(agentId: string, id: string, text: string, kind: Item["kind"] = "user_message") {
  return store.upsertEntry({ id, agentId, turnId: null, item: { id, kind, status: "completed", text } });
}
beforeEach(() => {
  store = new Store(openMemoryDb());
});
afterEach(() => store.db.close());
describe("workspace search", () => {
  it("finds saved messages outside the latest 500 and opens bounded context belonging to that conversation", () => {
    const yo = agent("Yo"),
      old = message(yo.id, "old", "A quiet weekend in Montréal");
    for (let i = 0; i < 650; i++) message(yo.id, `later-${i}`, `Later request ${i}`);
    expect(store.listTimeline(yo.id, undefined, 500).some((e) => e.id === old.id)).toBe(false);
    expect(store.searchWorkspace("Montréal")).toEqual([
      expect.objectContaining({ id: old.id, kind: "message", agentId: yo.id }),
    ]);
    const rows = store.timelineAround(yo.id, old.id);
    expect(rows).toHaveLength(70);
    expect(rows[0]!.id).toBe(old.id);
    expect(rows.every((e) => e.agentId === yo.id)).toBe(true);
    expect(() => store.timelineAround(agent("Other").id, old.id)).toThrow("Message not found");
  });
  it("searches memories, routine prompts and file titles without exposing tool payloads, paths or archived work", () => {
    const yo = agent("Yo"),
      legacy = agent("Old");
    const memory = store.addMemory("weekend: quiet places", null);
    const routine = store.createRoutine({
      agentId: yo.id,
      name: "Friday reminder",
      prompt: "Plan the weekend",
      cron: null,
      runAt: Date.now() + 60000,
      timezone: "UTC",
      enabled: true,
      nextRunAt: Date.now() + 60000,
    });
    const file = store.addArtifact({
      agentId: yo.id,
      title: "Weekend plan",
      path: "/secret-path.txt",
      storedPath: "/private-secret",
      mime: "text/plain",
      size: 1,
      kind: "file",
    });
    message(yo.id, "tool", "weekend tool-secret", "notice");
    store.upsertEntry({
      id: "peer",
      agentId: yo.id,
      turnId: null,
      item: {
        id: "peer",
        kind: "user_message",
        status: "completed",
        text: "weekend internal",
        from: { agentId: legacy.id, name: "Old" },
      },
    });
    message(legacy.id, "archived", "weekend archived");
    store.updateAgent(legacy.id, { archivedAt: Date.now() });
    expect(new Set(store.searchWorkspace("WEEKEND").map((r) => r.id))).toEqual(
      new Set([memory.id, routine.id, file.id]),
    );
    expect(store.searchWorkspace("secret")).toEqual([]);
  });
  it("treats wildcard/SQL text literally and bounds queries, results and snippets", () => {
    const yo = agent("Yo");
    message(yo.id, "literal", "Discount: 10%_off");
    message(yo.id, "other", "Discount 100off");
    expect(store.searchWorkspace("%_").map((r) => r.id)).toEqual(["literal"]);
    expect(store.searchWorkspace("' OR 1=1 --")).toEqual([]);
    expect(store.searchWorkspace("   ")).toEqual([]);
    expect(() => store.searchWorkspace("x".repeat(201))).toThrow();
    for (let i = 0; i < 75; i++) store.addMemory(`${"x".repeat(300)} needle ${i}`, null);
    expect(store.searchWorkspace("needle", 999)).toHaveLength(60);
    const result = store.searchWorkspace("needle", 1);
    expect(result).toHaveLength(1);
    expect(result[0]!.snippet).toContain("needle");
    expect(result[0]!.snippet.length).toBeLessThanOrEqual(240);
  });
});
