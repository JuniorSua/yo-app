import { describe, expect, it } from "vitest";
import {
  type DesktopUpdateState,
  desktopStatusText,
  isGithubDownload,
  needsRefresh,
  pickNotice,
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

const notice = (p: Partial<Parameters<typeof pickNotice>[0]>) =>
  pickNotice({ refresh: false, desktop: null, dismissedRefresh: false, dismissedRestart: false, ...p });

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

describe("which notice", () => {
  it("shows nothing when everything is current", () => {
    expect(notice({})).toBeNull();
    expect(notice({ desktop: desktop() })).toBeNull();
  });

  it("asks with a card, then keeps a pill after Later", () => {
    expect(notice({ refresh: true })).toEqual({ kind: "refresh", mode: "card" });
    expect(notice({ refresh: true, dismissedRefresh: true })).toEqual({ kind: "refresh", mode: "pill" });
    const ready = desktop({ status: "downloaded", downloadedVersion: "0.1.313" });
    expect(notice({ desktop: ready })).toEqual({ kind: "restart", mode: "card" });
    expect(notice({ desktop: ready, dismissedRestart: true })).toEqual({ kind: "restart", mode: "pill" });
  });

  it("prefers Restart over Refresh (a restart loads the new UI too)", () => {
    const ready = desktop({ status: "downloaded", downloadedVersion: "0.1.313" });
    expect(notice({ refresh: true, desktop: ready })?.kind).toBe("restart");
    expect(notice({ refresh: true, desktop: desktop({ status: "downloading", percent: 10 }) })?.kind).toBe(
      "refresh",
    );
  });

  it("shows progress and download errors quietly, never background check errors", () => {
    expect(notice({ desktop: desktop({ status: "downloading", percent: 42 }) })).toEqual({
      kind: "downloading",
      mode: "pill",
    });
    expect(
      notice({ desktop: desktop({ status: "error", errorContext: "download", canRetry: true }) }),
    ).toEqual({ kind: "error", mode: "pill" });
    expect(
      notice({ desktop: desktop({ status: "error", errorContext: "check", canRetry: true }) }),
    ).toBeNull();
    expect(
      notice({ desktop: desktop({ status: "available", availableVersion: "0.1.313", canRetry: true }) }),
    ).toEqual({ kind: "available", mode: "pill" });
    // Freshly found and about to download: no flash of a pill.
    expect(notice({ desktop: desktop({ status: "available", availableVersion: "0.1.313" }) })).toBeNull();
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
    expect(notice({ desktop: github() })).toEqual({ kind: "download", mode: "pill" });
    // A downloaded feed build still wins over a web refresh; a GitHub release doesn't.
    expect(notice({ refresh: true, desktop: github() })?.kind).toBe("refresh");
  });

  it("says where to get it, and says so when a check got no answer", () => {
    expect(desktopStatusText(github())).toBe("Yo 0.1.313 is available. Download it from GitHub.");
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
