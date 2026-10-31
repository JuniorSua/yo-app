import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ fail: true }));
vi.mock("../lib/api", () => ({
  api: () => ({
    call: () => (fake.fail ? Promise.reject(new Error("timeline.list timed out")) : Promise.resolve([])),
  }),
}));
vi.stubGlobal("document", { visibilityState: "visible" });
vi.stubGlobal("requestAnimationFrame", () => 0);
vi.stubGlobal("cancelAnimationFrame", () => undefined);

const { useTimeline } = await import("./timeline");

describe("loading a conversation", () => {
  beforeEach(() => useTimeline.setState({ byAgent: {}, loaded: {}, errors: {} }));

  it("keeps why it failed instead of rejecting, and clears it once a retry works", async () => {
    fake.fail = true;
    await expect(useTimeline.getState().load("agt_1")).resolves.toBeUndefined();
    expect(useTimeline.getState().loaded.agt_1).toBeFalsy();
    expect(useTimeline.getState().errors.agt_1).toMatch(/didn't answer in time/);
    fake.fail = false;
    await useTimeline.getState().load("agt_1");
    expect(useTimeline.getState().loaded.agt_1).toBe(true);
    expect(useTimeline.getState().errors).toEqual({});
  });
});
