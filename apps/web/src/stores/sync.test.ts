import { beforeEach, describe, expect, it, vi } from "vitest";

type Status = "connecting" | "open" | "closed";
const fake = vi.hoisted(() => ({
  statusCb: null as null | ((s: Status, reconnected: boolean) => void),
  bootstrapCalls: 0,
  failFirst: true,
}));

vi.mock("../lib/api", () => ({
  api: () => ({
    onStatus: (cb: (s: Status, r: boolean) => void) => {
      fake.statusCb = cb;
    },
    on: () => () => undefined,
    call: (method: string) => {
      if (method !== "bootstrap") return Promise.resolve([]);
      fake.bootstrapCalls++;
      if (fake.failFirst && fake.bootstrapCalls === 1)
        return Promise.reject(new Error("bootstrap timed out"));
      return Promise.resolve({ agents: [], accounts: [], settings: {}, version: "test", computer: null });
    },
  }),
}));
vi.mock("./device", () => ({ startDeviceSync: () => undefined }));
vi.mock("../lib/desktop", () => ({ nativeNotify: () => undefined, desktop: undefined }));

import { useApp } from "./app";
import { startSync } from "./sync";

describe("first connection", () => {
  beforeEach(() => {
    fake.bootstrapCalls = 0;
  });

  it("loads once the socket finally opens, even after the first load timed out", async () => {
    await expect(startSync()).rejects.toThrow("timed out");
    expect(useApp.getState().booted).toBe(false);
    // The socket opens for the first time (not a reconnect): the app must load now, not wait forever.
    fake.statusCb!("open", false);
    await vi.waitFor(() => expect(useApp.getState().booted).toBe(true));
    expect(fake.bootstrapCalls).toBe(2);
    // Later opens of an already loaded app don't load twice.
    fake.statusCb!("open", false);
    expect(fake.bootstrapCalls).toBe(2);
  });
});
