import { describe, expect, it } from "vitest";
import {
  type ApplyStep,
  applyEstimate,
  applySteps,
  busyLine,
  type DesktopUpdateState,
  desktopStatusText,
  elapsedText,
  failureAdvice,
  isGithubDownload,
  needsRefresh,
  pendingServerUpdate,
  pickNotice,
  pickOffer,
  WEB_BUILD,
} from "./updates";

const server = (build: string | null, web: string | null = build) => ({ build, web, desktop: null });

const desktop = (patch: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  status: "up-to-date",
  currentVersion: "0.1.312",
  availableVersion: null,
  downloadedVersion: null,
  percent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  ...patch,
});

describe("web build mismatch", () => {
  it("is off without build ids (dev server, old core)", () => {
    expect(WEB_BUILD).toBeNull();
    expect(needsRefresh(null, server("312-abc"))).toBe(false);
    expect(needsRefresh("312-abc", server(null))).toBe(false);
    expect(needsRefresh("312-abc", null)).toBe(false);
  });

  it("compares with the web build core serves, falling back to core's own build", () => {
    expect(needsRefresh("312-abc", server("312-abc"))).toBe(false);
    expect(needsRefresh("312-abc", server("313-def"))).toBe(true);
    // Core rebuilt without a new UI: nothing to reload.
    expect(needsRefresh("312-abc", server("313-def", "312-abc"))).toBe(false);
    expect(needsRefresh("312-abc", server("312-abc", "313-def"))).toBe(true);
  });
});

describe("what to offer", () => {
  const offer = (p: Partial<Parameters<typeof pickOffer>[0]>) =>
    pickOffer({ refresh: false, desktop: null, serverPending: false, ...p });

  it("offers nothing when everything is current, or while a download is still running", () => {
    expect(offer({})).toBeNull();
    expect(offer({ desktop: desktop() })).toBeNull();
    expect(offer({ desktop: desktop({ status: "downloading", percent: 42 }) })).toBeNull();
    expect(
      offer({ desktop: desktop({ status: "error", errorContext: "download", canRetry: true }) }),
    ).toBeNull();
  });

  it("prefers Restart (a downloaded app or a server update) over Reload: a restart loads the new UI too", () => {
    const ready = desktop({ status: "downloaded", downloadedVersion: "2.0.791" });
    expect(offer({ desktop: ready })).toBe("restart");
    expect(offer({ serverPending: true, refresh: true })).toBe("restart");
    expect(offer({ refresh: true, desktop: ready })).toBe("restart");
    expect(offer({ refresh: true, desktop: desktop({ status: "downloading", percent: 10 }) })).toBe(
      "refresh",
    );
  });
});

describe("the one notice", () => {
  const notice = (p: Partial<Parameters<typeof pickNotice>[0]>) =>
    pickNotice({
      dialogOpen: false,
      applying: false,
      failed: false,
      done: false,
      offer: null,
      dismissed: false,
      ...p,
    });

  it("says Update ready until Later, then leaves it to the dot on the button", () => {
    expect(notice({})).toBeNull();
    expect(notice({ offer: "restart" })).toBe("ready");
    expect(notice({ offer: "download" })).toBe("ready");
    expect(notice({ offer: "refresh", dismissed: true })).toBeNull();
  });

  it("shows nothing while the update window is open: the window says it all", () => {
    expect(notice({ offer: "restart", dialogOpen: true })).toBeNull();
    expect(notice({ applying: true, dialogOpen: true })).toBeNull();
    expect(notice({ done: true, dialogOpen: true })).toBeNull();
  });

  it("shows one thing at a time: an update running, then a failure, then Updated, then a new offer", () => {
    expect(notice({ applying: true, failed: true, done: true, offer: "restart" })).toBe("updating");
    expect(notice({ failed: true, done: true, offer: "restart" })).toBe("failed");
    expect(notice({ done: true, offer: "restart" })).toBe("done");
  });
});

describe("applying an update", () => {
  const states = (steps: ApplyStep[]) => steps.map((s) => `${s.id}:${s.state}`);

  it("follows a server update through its real steps", () => {
    expect(states(applySteps({ kind: "server", phase: "save" }))).toEqual([
      "save:active",
      "install:todo",
      "start:todo",
    ]);
    expect(states(applySteps({ kind: "server", phase: "install" }))).toEqual([
      "save:done",
      "install:active",
      "start:todo",
    ]);
    expect(states(applySteps({ kind: "server", phase: "done" }))).toEqual([
      "save:done",
      "install:done",
      "start:done",
    ]);
    // Only the current step explains itself.
    const install = applySteps({ kind: "server", phase: "install" });
    expect(install[1]?.detail).toBe("Yo is offline for this part.");
    expect(install[0]?.detail).toBeUndefined();
  });

  it("names the browser when the agent computer restarts, and the app when it installs after", () => {
    const steps = applySteps({ kind: "server", phase: "app", restartsComputer: true, alsoApp: true });
    expect(steps.map((s) => s.label)).toEqual([
      "Saving a backup",
      "Installing the update",
      "Starting Yo and its browser",
      "Restarting the Yo app",
    ]);
    expect(steps[3]?.state).toBe("active");
    expect(states(applySteps({ kind: "app", phase: "close" }))).toEqual([
      "close:active",
      "install:todo",
      "open:todo",
    ]);
  });

  it("estimates honestly and knows when it's slow", () => {
    expect(applyEstimate({ kind: "server" })).toEqual({
      text: "Usually about a minute",
      slowAfterMs: 120_000,
    });
    expect(applyEstimate({ kind: "server", restartsComputer: true }).text).toBe("Usually 1–2 minutes");
    expect(applyEstimate({ kind: "app" }).text).toBe("Usually about 10 seconds");
    expect(elapsedText(0)).toBe("0:00");
    expect(elapsedText(42_900)).toBe("0:42");
    expect(elapsedText(185_000)).toBe("3:05");
  });

  it("only asks the user to act when going back failed too", () => {
    expect(failureAdvice("Yo's server didn't come back healthy; Yo is back on the previous version.")).toBe(
      "Nothing to do now: Yo works as before.",
    );
    expect(
      failureAdvice("Swap failed; going back to the previous version also failed, so the PC needs a look."),
    ).toMatch(/Restart the PC that runs Yo/);
  });
});

describe("public builds (github channel)", () => {
  const github = (patch: Partial<DesktopUpdateState> = {}) =>
    desktop({
      channel: "github",
      status: "available",
      availableVersion: "0.1.313",
      releaseUrl: "https://github.com/JuniorSua/yo-app/releases/tag/v0.1.313",
      ...patch,
    });

  it("offers Download for a newer release; feed builds (and old apps without a channel) don't", () => {
    expect(isGithubDownload(github())).toBe(true);
    expect(isGithubDownload(github({ status: "up-to-date", availableVersion: null }))).toBe(false);
    expect(isGithubDownload(desktop({ status: "available", availableVersion: "0.1.313" }))).toBe(false);
    const offer = (p: Partial<Parameters<typeof pickOffer>[0]>) =>
      pickOffer({ refresh: false, desktop: null, serverPending: false, ...p });
    expect(offer({ desktop: github() })).toBe("download");
    // A downloaded feed build still wins over a web refresh; a GitHub release doesn't.
    expect(offer({ refresh: true, desktop: github() })).toBe("refresh");
  });

  it("says where to get it, and says so when a check got no answer", () => {
    expect(desktopStatusText(github())).toBe(
      "Yo 0.1.313 is out. Download it, quit Yo (⌘Q), then drag the new Yo into Applications.",
    );
    expect(
      desktopStatusText(
        github({ status: "idle", availableVersion: null, message: "Couldn't check right now." }),
      ),
    ).toBe("Couldn't check right now.");
    expect(desktopStatusText(desktop({ status: "idle" }))).toBe("");
  });
});

describe("Settings status text", () => {
  it("says what is happening", () => {
    const now = 1_000_000;
    expect(desktopStatusText(desktop({ checkedAt: now - 5_000 }), now)).toBe("Up to date · checked just now");
    expect(desktopStatusText(desktop({ checkedAt: now - 5 * 60_000 }), now)).toBe(
      "Up to date · checked 5 min ago",
    );
    expect(
      desktopStatusText(desktop({ status: "downloading", availableVersion: "0.1.313", percent: 41.6 })),
    ).toBe("Downloading Yo 0.1.313… 42%");
    expect(desktopStatusText(desktop({ status: "downloaded", downloadedVersion: "0.1.313" }))).toBe(
      "Yo 0.1.313 is ready. Restart to update.",
    );
    expect(desktopStatusText(desktop({ status: "error", message: "Couldn't reach Yo." }))).toBe(
      "Couldn't reach Yo.",
    );
    expect(desktopStatusText(desktop({ status: "disabled" }))).toMatch(/development/);
  });
});

describe("server updates", () => {
  const pending = { rev: "5c04cba5e647", notes: null, restartsComputer: false };

  it("offers nothing while one is being applied, or from an older core", () => {
    expect(pendingServerUpdate({ ...server("1"), server: { pending, applying: false } })).toBe(pending);
    expect(pendingServerUpdate({ ...server("1"), server: { pending, applying: true } })).toBeNull();
    expect(pendingServerUpdate(server("1"))).toBeNull();
    expect(pendingServerUpdate(null)).toBeNull();
  });

  it("names the agents a restart would stop", () => {
    expect(busyLine([])).toBeNull();
    expect(busyLine(["Pepe"])).toBe("Pepe is in the middle of a task; it will stop.");
    expect(busyLine(["Yo", "Pepe"])).toBe("Yo and Pepe are in the middle of tasks; they will stop.");
    expect(busyLine(["Yo", "Pepe", "Mimi"])).toBe(
      "Yo, Pepe and Mimi are in the middle of tasks; they will stop.",
    );
  });
});
