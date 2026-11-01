import type { AgentView } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { rosterState } from "./roster";

const view = (id: string, extra: Partial<AgentView> = {}) =>
  ({
    id,
    name: id,
    role: "",
    isPrimary: false,
    pinned: false,
    createdAt: 1,
    lastActiveAt: null,
    archivedAt: null,
    activity: "idle",
    unread: 0,
    todos: [],
    computer: { state: "ready", lease: "agent" },
    ...extra,
  }) as AgentView;

describe("roster rows", () => {
  const line = (a: AgentView, agents: Record<string, AgentView> = { [a.id]: a }) => rosterState(a, agents);

  it("say what the agent is doing now, in the same few words everywhere", () => {
    expect(line(view("a"))).toEqual({ tone: "idle", line: "Idle" });
    expect(line(view("a", { activity: "working" }))).toEqual({ tone: "thinking", line: "Thinking…" });
    expect(line(view("a", { activity: "working", statusLine: "For Yo: checking flights" }))).toEqual({
      tone: "working",
      line: "For Yo: checking flights",
    });
    expect(
      line(
        view("a", { activity: "working", todos: [{ text: "Compare three stores", status: "in_progress" }] }),
      ),
    ).toEqual({ tone: "working", line: "Working on compare three stores" });
    expect(
      line(
        view("a", { activity: "working", todos: [{ text: "MacBook price check", status: "in_progress" }] }),
      ).line,
    ).toBe("Working on MacBook price check");
    expect(line(view("a", { activity: "waiting" }))).toEqual({ tone: "waiting", line: "Waiting for you" });
    expect(line(view("a", { computer: { state: "hibernated", lease: "agent" } }))).toEqual({
      tone: "asleep",
      line: "Asleep",
    });
    expect(line(view("a", { computer: { state: "ready", lease: "user" } })).line).toBe("You have control");
  });

  it("count the main agent's busy helpers without naming them", () => {
    const yo = view("agt_yo", { isPrimary: true });
    const helper = view("agt_h", { kind: "helper", parentId: "agt_yo", activity: "working", name: "Gift" });
    expect(line(yo, { agt_yo: yo, agt_h: helper })).toEqual({ tone: "working", line: "1 helper working" });
  });
});
