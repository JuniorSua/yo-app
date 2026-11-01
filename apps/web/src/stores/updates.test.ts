import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateState, ServerUpdate, ServerVersion } from "../lib/updates";

const fake = {
  mock: true,
  call: vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({ ok: true })),
  version: vi.fn(async (): Promise<ServerVersion | null> => null),
  onStatus: vi.fn(() => () => {}),
};
vi.mock("../lib/api", () => ({ api: () => fake }));

const {
  checkWeb,
  DONE_HOLD_MS,
  dialogView,
  justUpdated,
  noticeKind,
  offerDismissed,
  restartNotes,
  SERVER_APPLY_CAP_MS,
  serverResult,
  updates,
  useUpdates,
} = await import("./updates");

const REV = "5c04cba5e647";
const pending = { rev: REV, notes: "- Faster", restartsComputer: false };
const version = (server: ServerUpdate, build = "mock-1"): ServerVersion => ({
  build,
  web: build,
  desktop: null,
  server,
});
const ok = (finishedAt = 9) => ({ rev: REV, ok: true, message: "Yo was updated.", finishedAt });
const ready = {
  status: "downloaded",
  downloadedVersion: "2.0.791",
  currentVersion: "2.0.790",
} as DesktopUpdateState;
const reload = vi.fn();
const storage = new Map<string, string>();

beforeEach(() => {
  // Every timer the store starts (polls, the cap, the pauses before a reload) runs on a fake clock; Date stays real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("location", { reload });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  storage.clear();
  reload.mockReset();
  fake.call.mockClear();
  useUpdates.setState({
    ownBuild: "mock-1",
    ownVersion: "2.0.791",
    server: version({ pending, applying: false }),
    refresh: false,
    webCheckedAt: 1,
    desktop: null,
    dialog: null,
    applying: null,
    stuck: false,
    serverError: null,
    laterVersion: null,
    laterServerRev: null,
    laterBuild: null,
    laterDownload: null,
    resultSeen: null,
    updated: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The next answer from core, checked right away. */
async function answer(v: ServerVersion | null) {
  fake.version.mockResolvedValueOnce(v);
  await checkWeb(true);
}

const state = () => useUpdates.getState();

describe("one notice, one window", () => {
  it("says Update ready for a published update; Later leaves only the dot, until a newer release", () => {
    expect(noticeKind(state())).toBe("ready");
    updates.open();
    expect(dialogView(state())).toBe("decide");
    expect(noticeKind(state())).toBeNull(); // the window says it all
    updates.close(); // not now = Later
    expect(state().dialog).toBeNull();
    expect(offerDismissed(state())).toBe(true);
    expect(noticeKind(state())).toBeNull();
    useUpdates.setState({
      server: version({ pending: { ...pending, rev: "aaaaaaaaaaaa" }, applying: false }),
    });
    expect(noticeKind(state())).toBe("ready");
  });

  it("with a Yo.app ready too, Later covers both", () => {
    useUpdates.setState({ desktop: ready });
    updates.later();
    expect(offerDismissed(state())).toBe(true);
    useUpdates.setState({ laterVersion: null });
    expect(offerDismissed(state())).toBe(false);
  });

  it("shows both What's new lists when one Restart installs both", () => {
    useUpdates.setState({
      desktop: ready,
      server: { ...version({ pending, applying: false }), desktop: { version: "2.0.791", notes: "- App" } },
    });
    expect(restartNotes(state())).toBe("- Faster\n- App");
  });

  it("reports a failure to anyone until OK", () => {
    const failed = { rev: REV, ok: false, message: "Yo is back on the previous version.", finishedAt: 100 };
    useUpdates.setState({ server: version({ pending: null, applying: false, lastResult: failed }) });
    expect(serverResult(state(), 200)).toBe("failed");
    expect(serverResult(state(), 100 + 25 * 3600_000)).toBeNull(); // old news
    vi.spyOn(Date, "now").mockReturnValue(200);
    expect(noticeKind(state())).toBe("failed");
    updates.open();
    expect(dialogView(state())).toBe("failed");
    updates.close(); // OK
    expect(serverResult(state(), 200)).toBeNull();
    expect(noticeKind(state())).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("Restart now (server)", () => {
  it("applies exactly the pending rev, follows the real steps, says Done and reloads", async () => {
    updates.open();
    await updates.confirm();
    expect(fake.call).toHaveBeenCalledWith("update.applyServer", { rev: REV });
    expect(state().applying).toMatchObject({ kind: "server", phase: "save", rev: REV, notes: "- Faster" });
    expect(dialogView(state())).toBe("progress");

    await answer(version({ pending, applying: true })); // the updater backs up; core still answers
    expect(state().applying?.phase).toBe("save");
    await answer(null); // core is down for the swap
    expect(state().applying?.phase).toBe("install");
    await answer(version({ pending, applying: true }, "mock-2")); // core is back, the updater checks it
    expect(state().applying?.phase).toBe("start");
    expect(reload).not.toHaveBeenCalled();

    await answer(version({ pending: null, applying: false, lastResult: ok() }, "mock-2"));
    expect(state().applying?.phase).toBe("done");
    await vi.advanceTimersByTimeAsync(DONE_HOLD_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    // What the new page needs to say "Updated to Yo 2.0.N" with the notes core no longer has.
    expect(JSON.parse(storage.get("yo.updated")!)).toMatchObject({
      kind: "server",
      rev: REV,
      notes: "- Faster",
    });
  });

  it("says Updated after the reload, once, with the saved notes", () => {
    useUpdates.setState({
      server: version({ pending: null, applying: false, lastResult: ok(500) }),
      updated: { kind: "server", rev: REV, notes: "- Faster", at: Date.now() },
    });
    expect(justUpdated(state())).toEqual({ version: "2.0.791", notes: "- Faster" });
    expect(noticeKind(state())).toBe("done");
    updates.dismissDone();
    expect(justUpdated(state())).toBeNull();
    expect(state().resultSeen).toBe(500);
    expect(storage.has("yo.updated")).toBe(false);
  });

  it("installs the downloaded Yo.app after the server update instead of reloading", async () => {
    const install = vi.fn(async () => {});
    vi.stubGlobal("window", { yoDesktop: { updates: { install } } });
    useUpdates.setState({ desktop: ready });
    await updates.confirm();
    expect(state().applying).toMatchObject({ alsoApp: true, version: "2.0.791" });
    await answer(version({ pending: null, applying: false, lastResult: ok() }));
    expect(state().applying?.phase).toBe("app");
    expect(install).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get("yo.updated")!)).toMatchObject({ kind: "app", version: "2.0.791" });
  });

  it("a failed update turns the window into what happened, without reloading", async () => {
    updates.open();
    await updates.confirm();
    const failed = {
      rev: REV,
      ok: false,
      message: "Yo is back on the previous version.",
      finishedAt: Date.now(),
    };
    await answer(version({ pending: null, applying: false, lastResult: failed }));
    expect(state().applying).toBeNull();
    expect(dialogView(state())).toBe("failed");
    expect(reload).not.toHaveBeenCalled();
  });

  it("an older result for the same rev isn't mistaken for this one", async () => {
    const old = { rev: REV, ok: false, message: "earlier", finishedAt: 5 };
    useUpdates.setState({ server: version({ pending, applying: false, lastResult: old }) });
    await updates.confirm();
    await answer(version({ pending, applying: false, lastResult: old }));
    expect(state().applying?.kind).toBe("server");
  });

  it("when core refuses, the decision stays open and says why", async () => {
    fake.call.mockRejectedValueOnce(
      new Error("That update isn't available anymore. Check for updates again."),
    );
    updates.open();
    await updates.confirm();
    expect(state()).toMatchObject({
      applying: null,
      serverError: "That update isn't available anymore. Check for updates again.",
    });
    expect(dialogView(state())).toBe("decide");
  });

  it("can't be closed while it runs; past the cap it's stuck, can be hidden, and still finishes", async () => {
    fake.version.mockResolvedValue(null);
    updates.open();
    await updates.confirm();
    updates.close();
    expect(state().dialog).toBe("update");
    await vi.advanceTimersByTimeAsync(SERVER_APPLY_CAP_MS + 1);
    expect(state().stuck).toBe(true);
    expect(state().applying?.kind).toBe("server");
    updates.hide();
    expect(noticeKind(state())).toBe("updating");
    fake.version.mockReset();
    fake.version.mockResolvedValue(null);
    await answer(version({ pending: null, applying: false, lastResult: ok(Date.now()) }, "mock-2"));
    await vi.advanceTimersByTimeAsync(DONE_HOLD_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("picks up an update someone else started, and offers a reload instead of reloading", async () => {
    await answer(version({ pending, applying: true }));
    expect(state().applying).toMatchObject({ kind: "server", adopted: true });
    expect(noticeKind(state())).toBe("updating");
    await answer(version({ pending: null, applying: false, lastResult: ok() }, "mock-2"));
    expect(state().applying).toBeNull();
    expect(state().refresh).toBe(true);
    expect(noticeKind(state())).toBe("ready");
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("Restart now (Yo.app) and Reload now", () => {
  it("installs the downloaded app after showing Closing Yo, and says Updated once it runs", async () => {
    const install = vi.fn(async () => {});
    vi.stubGlobal("window", { yoDesktop: { updates: { install } } });
    useUpdates.setState({ server: version({ pending: null, applying: false }), desktop: ready });
    const done = updates.confirm();
    expect(state().applying).toMatchObject({ kind: "app", phase: "close", version: "2.0.791" });
    await vi.runAllTimersAsync();
    await done;
    expect(install).toHaveBeenCalledTimes(1);
    // Relaunched on the new version.
    useUpdates.setState({
      applying: null,
      desktop: { ...ready, status: "up-to-date", currentVersion: "2.0.791", downloadedVersion: null },
      updated: JSON.parse(storage.get("yo.updated")!),
    });
    expect(justUpdated(state())).toMatchObject({ version: "2.0.791" });
  });

  it("reloads for a server deploy and says Updated once the page runs it", async () => {
    useUpdates.setState({ server: version({ pending: null, applying: false }, "mock-2"), refresh: true });
    const done = updates.confirm();
    await vi.runAllTimersAsync();
    await done;
    expect(reload).toHaveBeenCalledTimes(1);
    useUpdates.setState({ refresh: false, updated: JSON.parse(storage.get("yo.updated")!) });
    expect(justUpdated(state())).toEqual({ version: "2.0.791", notes: null });
  });
});
