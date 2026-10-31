import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ fail: null as null | Error }));

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return {
    ...real,
    api: () => ({
      call: (method: string) => {
        if (method !== "tasks.list") return Promise.resolve([]);
        if (fake.fail) return Promise.reject(fake.fail);
        return Promise.resolve([{ id: "tsk_1", title: "Plan the trip", status: "in_progress" }]);
      },
    }),
  };
});
vi.mock("./device", () => ({ startDeviceSync: () => undefined }));
vi.mock("../lib/desktop", () => ({ nativeNotify: () => undefined, desktop: undefined }));

import { ApiError } from "../lib/api";
import { useApp } from "./app";
import { load } from "./sync";

describe("load.tasks", () => {
  beforeEach(() => {
    fake.fail = null;
    useApp.setState({ tasks: {}, tasksUnsupported: false });
  });

  it("an older core without tasks.list: an empty list and no +, not an error", async () => {
    fake.fail = new ApiError("Unknown method tasks.list");
    await expect(load.tasks("agt_yo")).resolves.toBeUndefined();
    expect(useApp.getState().tasks.agt_yo).toEqual([]);
    expect(useApp.getState().tasksUnsupported).toBe(true);
    // Once core is updated, the list loads and + comes back.
    fake.fail = null;
    await load.tasks("agt_yo");
    expect(useApp.getState().tasks.agt_yo).toHaveLength(1);
    expect(useApp.getState().tasksUnsupported).toBe(false);
  });

  it("any other failure is still an error", async () => {
    fake.fail = new ApiError("Request timed out");
    await expect(load.tasks("agt_yo")).rejects.toThrow("timed out");
    expect(useApp.getState().tasks.agt_yo).toBeUndefined();
    expect(useApp.getState().tasksUnsupported).toBe(false);
  });
});
