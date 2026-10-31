import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateState, ServerUpdate, ServerVersion } from "../lib/updates";

const fake = {
  mock: true,
  call: vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({ ok: true })),
  version: vi.fn(async (): Promise<ServerVersion | null> => null),
  onStatus: vi.fn(() => () => {}),
};
vi.mock("../lib/api", () => ({ api: () => fake }));

const { checkWeb, noticeInput, restartNotes, SERVER_APPLY_CAP_MS, serverResult, updates, useUpdates } =
  await import("./updates");

const REV = "5c04cba5e647";
const pending = { rev: REV, notes: "- Faster", restartsComputer: false };
const version = (server: ServerUpdate, build = "mock-1"): ServerVersion => ({
  build,
  web: build,
  desktop: null,
  server,
});
const ready = { status: "downloaded", downloadedVersion: "0.1.313" } as DesktopUpdateState;
const reload = vi.fn();

beforeEach(() => {
  vi.stubGlobal("location", { reload });
  reload.mockReset();
  fake.call.mockClear();
  useUpdates.setState({
    ownBuild: "mock-1",
    server: version({ pending, applying: false }),
    desktop: null,
    applying: null,
    confirmingRestart: false,
    serverError: null,
    laterVersion: null,
    laterServerRev: null,
    resultSeen: null,
    updatedRev: null,
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

describe("server update notice", () => {
  it("asks to restart for a published update, and Later turns it into a pill", () => {
    expect(noticeInput(useUpdates.getState())).toMatchObject({
      serverPending: true,
      dismissedRestart: false,
    });
    updates.later("restart");
    expect(noticeInput(useUpdates.getState()).dismissedRestart).toBe(true);
    // A newer release asks again.
    useUpdates.setState({
      server: version({ pending: { ...pending, rev: "aaaaaaaaaaaa" }, applying: false }),
    });
    expect(noticeInput(useUpdates.getState()).dismissedRestart).toBe(false);
  });

  it("with a Yo.app ready too, Later covers both", () => {
    useUpdates.setState({ desktop: ready });
    updates.later("restart");
    expect(noticeInput(useUpdates.getState()).dismissedRestart).toBe(true);
    useUpdates.setState({ laterVersion: null });
    expect(noticeInput(useUpdates.getState()).dismissedRestart).toBe(false);
  });

  it("shows both What's new lists when one Restart installs both", () => {
    useUpdates.setState({
      desktop: ready,
      server: { ...version({ pending, applying: false }), desktop: { version: "0.1.313", notes: "- App" } },
    });
    expect(restartNotes(useUpdates.getState())).toBe("- Faster\n- App");
  });

  it("reports a failure to anyone until OK, and success only on the page that asked", () => {
    const failed = { rev: REV, ok: false, message: "The update didn't finish.", finishedAt: 100 };
    useUpdates.setState({ server: version({ pending: null, applying: false, lastResult: failed }) });
    expect(serverResult(useUpdates.getState(), 200)).toBe("failed");
    expect(serverResult(useUpdates.getState(), 100 + 25 * 3600_000)).toBeNull(); // old news
    updates.dismissResult();
    expect(serverResult(useUpdates.getState(), 200)).toBeNull();

    const ok = { ...failed, ok: true, finishedAt: 300 };
    useUpdates.setState({ server: version({ pending: null, applying: false, lastResult: ok }) });
    expect(serverResult(useUpdates.getState(), 400)).toBeNull();
    useUpdates.setState({ updatedRev: REV });
    expect(serverResult(useUpdates.getState(), 400)).toBe("ok");
  });
});

describe("Restart to update (server)", () => {
  it("asks core to apply exactly the pending rev, then reloads once the updater reports success", async () => {
    updates.askRestart();
    await updates.confirmRestart();
    expect(fake.call).toHaveBeenCalledWith("update.applyServer", { rev: REV });
    expect(useUpdates.getState().applying).toMatchObject({ kind: "server", rev: REV });

    await answer(version({ pending, applying: true })); // the updater is on it
    await answer(null); // core is down for the swap
    expect(reload).not.toHaveBeenCalled();
    expect(useUpdates.getState().applying?.kind).toBe("server");

    await answer(
      version(
        { pending: null, applying: false, lastResult: { rev: REV, ok: true, message: "", finishedAt: 9 } },
        "mock-2",
      ),
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("installs the downloaded Yo.app after the server update instead of reloading", async () => {
    const install = vi.fn(async () => {});
    vi.stubGlobal("window", { yoDesktop: { updates: { install } } });
    useUpdates.setState({ desktop: ready });
    await updates.confirmRestart();
    vi.useFakeTimers();
    await answer(
      version({
        pending: null,
        applying: false,
        lastResult: { rev: REV, ok: true, message: "", finishedAt: 9 },
      }),
    );
    expect(useUpdates.getState().applying).toMatchObject({ kind: "restart", version: "0.1.313" });
    await vi.runAllTimersAsync();
    expect(install).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it("a failed update closes the confirmation and leaves the failure to the notice", async () => {
    updates.askRestart();
    await updates.confirmRestart();
    const failed = {
      rev: REV,
      ok: false,
      message: "Yo is back on the previous version.",
      finishedAt: Date.now(),
    };
    await answer(version({ pending: null, applying: false, lastResult: failed }));
    expect(useUpdates.getState()).toMatchObject({ applying: null, confirmingRestart: false });
    expect(noticeInput(useUpdates.getState()).serverResult).toBe("failed");
    expect(reload).not.toHaveBeenCalled();
  });

  it("an older result for the same rev isn't mistaken for this one", async () => {
    const old = { rev: REV, ok: false, message: "earlier", finishedAt: 5 };
    useUpdates.setState({ server: version({ pending, applying: false, lastResult: old }) });
    await updates.confirmRestart();
    await answer(version({ pending, applying: false, lastResult: old }));
    expect(useUpdates.getState().applying?.kind).toBe("server");
  });

  it("when core refuses, the confirmation says why and nothing is applying", async () => {
    fake.call.mockRejectedValueOnce(
      new Error("That update isn't available anymore. Check for updates again."),
    );
    updates.askRestart();
    await updates.confirmRestart();
    expect(useUpdates.getState()).toMatchObject({
      applying: null,
      confirmingRestart: true,
      serverError: "That update isn't available anymore. Check for updates again.",
    });
  });

  it("stops waiting after the cap and says it's taking longer than usual", async () => {
    vi.useFakeTimers();
    fake.version.mockResolvedValue(null);
    await updates.confirmRestart();
    await vi.advanceTimersByTimeAsync(SERVER_APPLY_CAP_MS + 1);
    expect(useUpdates.getState().applying).toBeNull();
    expect(useUpdates.getState().serverError).toMatch(/longer than usual/);
    fake.version.mockReset();
    fake.version.mockResolvedValue(null);
  });

  it("picks up an update someone else started, and offers Refresh instead of reloading", async () => {
    await answer(version({ pending, applying: true }));
    expect(useUpdates.getState().applying).toMatchObject({ kind: "server", adopted: true });
    await answer(
      version(
        { pending: null, applying: false, lastResult: { rev: REV, ok: true, message: "", finishedAt: 9 } },
        "mock-2",
      ),
    );
    expect(useUpdates.getState().applying).toBeNull();
    expect(useUpdates.getState().refresh).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });
});
