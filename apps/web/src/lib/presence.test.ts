import type { AgentView, TimelineEntry } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { activeHelpers, presenceLine, presenceTone, recentRequests, runningStep } from "./presence";

const agent = (patch: Partial<AgentView> = {}): AgentView =>
  ({
    id: "agt_yo",
    name: "Yo",
    role: "Your personal agent",
    isPrimary: true,
    activity: "idle",
    computer: { state: "ready", lease: "agent" },
    todos: [],
    preview: null,
    archivedAt: null,
    ...patch,
  }) as AgentView;

let seq = 0;
const entry = (item: Partial<TimelineEntry["item"]>): TimelineEntry =>
  ({
    id: `e${++seq}`,
    agentId: "agt_yo",
    turnId: null,
    seq,
    item: { id: `i${seq}`, kind: "assistant_message", status: "completed", ...item },
  }) as TimelineEntry;

describe("presence", () => {
  it("tone follows the computer lease and sleep", () => {
    expect(presenceTone(agent())).toBe("idle");
    expect(presenceTone(agent({ activity: "sleeping" }))).toBe("sleeping");
    expect(presenceTone(agent({ computer: { state: "hibernated", lease: "agent" } }))).toBe("sleeping");
    expect(presenceTone(agent({ activity: "working", computer: { state: "ready", lease: "user" } }))).toBe(
      "control",
    );
    expect(presenceTone(agent({ activity: "waiting" }))).toBe("waiting");
  });

  it("runningStep reads only the current turn", () => {
    const old = entry({ kind: "browser", status: "running", title: "Opened old.com" });
    const ask = entry({ kind: "user_message", text: "Find a desk" });
    const step = entry({ kind: "browser", status: "running", title: "Opened amazon.com" });
    expect(runningStep([old, ask])).toBe("");
    expect(runningStep([old, ask, step])).toBe("Opened amazon.com");
    expect(runningStep([ask, entry({ kind: "todo", status: "running", title: "Plan" })])).toBe("");
    expect(runningStep(undefined)).toBe("");
  });

  it("recentRequests: the user's own messages, newest first, never a teammate's", () => {
    const a = entry({ kind: "user_message", text: "First" });
    const b = entry({ kind: "user_message", text: "From a teammate", from: { agentId: "x", name: "X" } });
    const c = entry({ kind: "user_message", text: "Second" });
    expect(recentRequests([a, b, entry({}), c]).map((e) => e.item.text)).toEqual(["Second", "First"]);
    expect(recentRequests([a, c], 1).map((e) => e.item.text)).toEqual(["Second"]);
  });

  it("activeHelpers: only this agent's busy, unarchived helpers", () => {
    const h = (id: string, patch: Partial<AgentView>) =>
      agent({ id, kind: "helper", parentId: "agt_yo", isPrimary: false, activity: "working", ...patch });
    const agents = {
      a: h("a", {}),
      b: h("b", { activity: "done" }),
      c: h("c", { archivedAt: 1 }),
      d: h("d", { parentId: "other" }),
      agt_yo: agent(),
    };
    expect(activeHelpers(agents, "agt_yo").map((x) => x.id)).toEqual(["a"]);
  });

  it("line says what he's doing, most specific first", () => {
    const base = { step: "", helpers: [] as AgentView[] };
    const working = agent({
      activity: "working",
      todos: [{ text: "Comparing prices", status: "in_progress" }],
    });
    expect(presenceLine({ ...base, agent: working, tone: "working", step: "Opened amazon.com" })).toBe(
      "Opened amazon.com",
    );
    expect(presenceLine({ ...base, agent: working, tone: "working" })).toBe("Comparing prices");
    // A raw command never shows: the plan's words, or plain ones.
    expect(
      presenceLine({ ...base, agent: working, tone: "working", step: "Running `ls ~/Downloads`…" }),
    ).toBe("Comparing prices");
    expect(
      presenceLine({ ...base, agent: agent({ activity: "working" }), tone: "working", step: "Ran `ls`" }),
    ).toBe("Running a command");
    expect(presenceLine({ ...base, agent: agent(), tone: "working" })).toBe("Working on your request");
    expect(presenceLine({ ...base, agent: agent(), tone: "waiting", waitingOn: "Buy AirPods" })).toBe(
      "Waiting for your OK · Buy AirPods",
    );
    expect(
      presenceLine({ ...base, agent: agent(), tone: "waiting", waitingOn: "Which dates?", asking: true }),
    ).toBe("Waiting for your answer · Which dates?");
    const helper = agent({ id: "h", preview: "Checking times" });
    expect(presenceLine({ ...base, agent: agent(), tone: "idle", helpers: [helper] })).toBe(
      "1 helper working · Checking times",
    );
    expect(presenceLine({ ...base, agent: agent(), tone: "idle", helpers: [helper, helper] })).toBe(
      "2 helpers working · Checking times",
    );
    expect(presenceLine({ ...base, agent: agent(), tone: "idle" })).toBe("Ready when you are");
    expect(presenceLine({ ...base, agent: agent({ isPrimary: false }), tone: "idle" })).toBe(
      "Your personal agent",
    );
    expect(presenceLine({ ...base, agent: agent(), tone: "sleeping" })).toMatch(/^Resting/);
  });
});
