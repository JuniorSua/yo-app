/**
 * Mock update scenarios for screenshots and E2E (`?mockUpdate=…`):
 *   web          the server runs a newer build than the page → "Update ready" → Reload now; after the reload the
 *                page runs it → "Updated to Yo 2.0.791"
 *   available    Yo.app found a new build but the download stopped → the update button offers Download
 *   downloading  Yo.app is downloading one (42%): only the ring on the update button
 *   ready        a new Yo.app is downloaded → "Update ready" → "Yo 2.0.791 is ready" → Restart now: "Closing Yo",
 *                then the mock "relaunches" (a reload on the new version, `installs` counts it) → "Updated to…"
 *   ready-fail   the same, but Yo.app doesn't quit to install → "Yo couldn't restart to update"
 *   error        the download failed → error on the update button; Try again downloads it and it becomes ready
 *   github       a public build (github channel) sees a newer GitHub Release → "Update available" → the steps
 *                and Download, which opens the release page (counted in `downloads`; nothing downloads in the app)
 *   server       a server update is published on the Home PC → "Update ready" → Restart now: Saving a backup
 *                (core still up) → Installing (core down) → Starting Yo (core back, updater still busy) → Done,
 *                and the page reloads on the new build (`serverApplies` counts it) → "Updated to Yo 2.0.791"
 *   server-browser   the same, and the agent computer changes too (its browser reloads)
 *   server-ready     a server update and a downloaded Yo.app: one Restart does both, server first
 *   server-fail      the updater reports a failure and rolls back
 *   server-slow      the swap never finishes on its own (core stays down until `next()`): slow, then stuck
 *   server-other     another device started a server update: "Updating Yo…", then "Update ready" (reload)
 * `&mockHold=1` holds a server update at each step until `__yoMock.updates.next()` (screenshots of each step).
 * The desktop scenarios install a fake `window.yoDesktop.updates`. Test hooks on `__yoMock.updates`.
 */
import type { YoDesktopBridge } from "../desktop";
import {
  type DesktopUpdateState,
  MOCK_BUILD,
  type ServerUpdate,
  type ServerVersion,
  type YoUpdatesBridge,
} from "../updates";

const SCENARIOS = [
  "web",
  "available",
  "downloading",
  "ready",
  "ready-fail",
  "error",
  "github",
  "server",
  "server-browser",
  "server-ready",
  "server-fail",
  "server-slow",
  "server-other",
] as const;
export type MockUpdateScenario = (typeof SCENARIOS)[number];

const CURRENT = "2.0.790";
const NEXT = "2.0.791";
export const MOCK_RELEASE_URL = `https://github.com/JuniorSua/yo-app/releases/tag/v${NEXT}`;
/** The "What's new" the mock feed publishes with NEXT (shown in the restart confirmation). */
export const MOCK_NOTES =
  "- Restart now asks first and shows what's new\n- Download on the website starts the Mac app right away";
/** The published server update (`server*` scenarios). */
export const MOCK_SERVER_REV = "5c04cba5e647";
export const MOCK_SERVER_NOTES =
  "- Updates wait for you: restart when it suits you\n- Yo's browser keeps your open tabs across restarts";
export const MOCK_SERVER_FAILURE =
  "Yo's server didn't come back healthy within 3 min; Yo is back on the previous version.";
/** Survive a reload after a mock server update, like the new build (or the failure report) on a real core. */
const APPLIED_KEY = "yo.mock.serverApplied";
const FAILED_KEY = "yo.mock.serverFailed";
/** Survives the mock "relaunch" after Restart installs a Yo.app: the installs so far. */
const INSTALLS_KEY = "yo.mock.installs";

const LEFT_KEY = "yo.mock.leftAt";

/**
 * This page load is a reload (Reload now, Yo.app's "relaunch", the reload after a server update), not a fresh
 * visit: the page last left from this same URL. (Navigation timing would say so too, but tests that fake the
 * clock fake `performance` as well.)
 */
function reloaded() {
  const again = sessionStorage.getItem(LEFT_KEY) === location.href;
  sessionStorage.removeItem(LEFT_KEY);
  addEventListener("pagehide", () => sessionStorage.setItem(LEFT_KEY, location.href));
  return again;
}

function initialState(scenario: MockUpdateScenario | null, relaunched: boolean): DesktopUpdateState {
  const base: DesktopUpdateState = {
    status: "up-to-date",
    channel: scenario === "github" ? "github" : "feed",
    currentVersion: CURRENT,
    availableVersion: null,
    downloadedVersion: null,
    percent: null,
    checkedAt: Date.now() - 60_000,
    message: null,
    errorContext: null,
    canRetry: false,
    releaseUrl: null,
  };
  // Relaunched after Restart installed NEXT: that's the version running now.
  if (relaunched) return { ...base, currentVersion: NEXT, checkedAt: Date.now() };
  switch (scenario) {
    case "github":
      return { ...base, status: "available", availableVersion: NEXT, releaseUrl: MOCK_RELEASE_URL };
    case "available":
      return { ...base, status: "available", availableVersion: NEXT, canRetry: true };
    case "downloading":
      return { ...base, status: "downloading", availableVersion: NEXT, percent: 42 };
    case "ready":
    case "ready-fail":
    case "server-ready":
      return { ...base, status: "downloaded", availableVersion: NEXT, downloadedVersion: NEXT, percent: 100 };
    case "error":
      return {
        ...base,
        status: "error",
        availableVersion: NEXT,
        message: "The download was interrupted. Check your connection and try again.",
        errorContext: "download",
        canRetry: true,
      };
    default:
      return base;
  }
}

export class MockUpdates {
  /** Test hook: how many times Restart installed a Yo.app (kept across the mock relaunch). */
  installs = 0;
  /** Test hook: how many times Download opened the release page (github scenario). */
  downloads = 0;
  /** Test hook: how many times the page asked core for its version. */
  versionChecks = 0;
  /** Test hook: how many times a server update was applied (update.applyServer). */
  serverApplies = 0;
  private deployed: boolean;
  private server: ServerUpdate = { pending: null, applying: false };
  /** The PC edition's newer GitHub release (`&mockRelease=1`). */
  release: { version: string; url: string } | null = null;
  private state: DesktopUpdateState;
  private listeners = new Set<(s: DesktopUpdateState) => void>();
  /** `&mockHold=1`: a server update waits at each step for `next()`. */
  hold = false;
  private resume: (() => void) | null = null;

  constructor(
    readonly scenario: MockUpdateScenario | null,
    private readonly scale: number,
  ) {
    // What survives a reload (the new build after a server update, a relaunched Yo.app) belongs to that reload:
    // a fresh visit starts the scenario over.
    const again = reloaded();
    if (!again) {
      sessionStorage.removeItem(APPLIED_KEY);
      sessionStorage.removeItem(FAILED_KEY);
      sessionStorage.removeItem(INSTALLS_KEY);
    }
    this.installs = Number(sessionStorage.getItem(INSTALLS_KEY)) || 0;
    // After Reload now the page runs the build the server serves.
    this.deployed = scenario === "web" && !again;
    this.state = initialState(scenario, this.installs > 0);
    if (scenario === "server-other" && again) {
      // Reloaded after the other device's update: this page runs the new build.
      this.server = {
        pending: null,
        applying: false,
        lastResult: {
          rev: MOCK_SERVER_REV,
          ok: true,
          message: "Yo was updated.",
          finishedAt: Date.now() - 5000,
        },
      };
    } else if (scenario === "server-other") {
      // Someone pressed Restart on another device a moment ago.
      this.server = {
        pending: { rev: MOCK_SERVER_REV, notes: MOCK_SERVER_NOTES, restartsComputer: false },
        applying: true,
      };
      void this.later(4000).then(() => {
        this.server = {
          pending: null,
          applying: false,
          lastResult: { rev: MOCK_SERVER_REV, ok: true, message: "Yo was updated.", finishedAt: Date.now() },
        };
        this.deployed = true;
      });
    } else if (scenario?.startsWith("server")) {
      const applied = Number(sessionStorage.getItem(APPLIED_KEY));
      const failed = Number(sessionStorage.getItem(FAILED_KEY));
      this.server = failed
        ? {
            pending: null,
            applying: false,
            lastResult: { rev: MOCK_SERVER_REV, ok: false, message: MOCK_SERVER_FAILURE, finishedAt: failed },
          }
        : applied
          ? {
              pending: null,
              applying: false,
              lastResult: { rev: MOCK_SERVER_REV, ok: true, message: "Yo was updated.", finishedAt: applied },
            }
          : {
              pending: {
                rev: MOCK_SERVER_REV,
                notes: MOCK_SERVER_NOTES,
                restartsComputer: scenario === "server-browser",
              },
              applying: false,
            };
    }
  }

  /** What the mock core reports at /api/version. */
  version(): ServerVersion {
    this.versionChecks++;
    const build = this.deployed ? "mock-2" : MOCK_BUILD;
    const next = this.state.availableVersion;
    return {
      build,
      web: build,
      desktop: next ? { version: next, notes: MOCK_NOTES } : { version: CURRENT },
      server: structuredClone(this.server),
      ...(this.release ? { release: { ...this.release } } : {}),
    };
  }

  private later(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms * this.scale));
  }

  /** One step of a server update: its usual time, or until `next()` with `hold` (forever for server-slow). */
  private step(ms: number, forever = false) {
    if (!this.hold && !forever) return this.later(ms);
    return new Promise<void>((r) => {
      this.resume = r;
    });
  }

  /** Test hook: let a held server update go on to its next step. */
  next() {
    const r = this.resume;
    this.resume = null;
    r?.();
  }

  /**
   * update.applyServer: like the host's updater, it backs up while core still answers, core goes away for the
   * swap, comes back while the updater checks it's healthy, then the report says how it went. `conn` drops and
   * restores the mock connection.
   */
  applyServer(rev: string, conn: { drop(): void; back(): void }) {
    const pending = this.server.pending;
    if (!pending || pending.rev !== rev || this.server.applying)
      throw new Error("That update isn't available anymore. Check for updates again.");
    this.serverApplies++;
    this.server = { ...this.server, applying: true };
    void (async () => {
      await this.step(2500);
      conn.drop();
      await this.step(5000, this.scenario === "server-slow");
      conn.back();
      await this.step(2500);
      const ok = this.scenario !== "server-fail";
      const finishedAt = Date.now();
      this.server = {
        pending: null,
        applying: false,
        lastResult: { rev, ok, message: ok ? "Yo was updated." : MOCK_SERVER_FAILURE, finishedAt },
      };
      if (ok) this.deployed = true;
      sessionStorage.setItem(ok ? APPLIED_KEY : FAILED_KEY, String(finishedAt));
    })();
  }

  /** Test hook: a server deploy happened (the next version check sees a new build). */
  deploy() {
    this.deployed = true;
  }

  /** Test hook: Yo.app state changes, as if pushed by the main process. */
  set(patch: Partial<DesktopUpdateState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(structuredClone(this.state));
  }

  /** The desktop part, only for the desktop scenarios. */
  bridge(): YoUpdatesBridge | null {
    if (!this.scenario || this.scenario === "web") return null;
    // A server update alone: Yo in a browser (say a friend on the owner's PC), no Yo.app updater.
    if (this.scenario.startsWith("server") && this.scenario !== "server-ready") return null;
    const later = (ms: number) => this.later(ms);
    return {
      getState: async () => structuredClone(this.state),
      check: async () => {
        if (this.state.status === "downloaded") return structuredClone(this.state);
        this.set({ status: "checking", message: null, errorContext: null });
        await later(400);
        if (this.state.channel === "github") {
          // Public builds only look: the release is still there to download.
          this.set({
            status: this.state.availableVersion ? "available" : "up-to-date",
            checkedAt: Date.now(),
          });
        } else if (this.state.availableVersion) {
          for (const percent of [12, 48, 86, 100]) {
            this.set({ status: "downloading", percent, canRetry: false });
            await later(250);
          }
          this.set({ status: "downloaded", downloadedVersion: this.state.availableVersion, canRetry: true });
        } else this.set({ status: "up-to-date", checkedAt: Date.now() });
        return structuredClone(this.state);
      },
      install: async () => {
        if (this.state.status !== "downloaded") return;
        this.installs++;
        sessionStorage.setItem(INSTALLS_KEY, String(this.installs));
        if (this.scenario === "ready-fail") {
          // Like main's watchdog: Yo.app is still running a while after Restart.
          await later(1500);
          this.set({
            status: "error",
            message: "Yo didn't quit to install the update.",
            errorContext: "install",
          });
          return;
        }
        // Yo quits, installs and opens again: the page loads anew on NEXT.
        await later(800);
        location.reload();
      },
      download: async () => {
        if (this.state.channel === "github" && this.state.releaseUrl) this.downloads++;
      },
      onState: (cb) => {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
      },
    };
  }

  /** Add the fake updater to `window.yoDesktop`, creating a minimal desktop bridge if there is none. */
  install(win: Window) {
    const updates = this.bridge();
    if (!updates) return;
    const desktop: YoDesktopBridge = win.yoDesktop ?? {
      platform: "darwin",
      notify: () => {},
      openExternal: (url) => win.open(url, "_blank", "noopener,noreferrer"),
      onNavigate: () => () => {},
    };
    win.yoDesktop = { ...desktop, updates };
  }
}

export function mockUpdateScenario(q: URLSearchParams): MockUpdateScenario | null {
  const v = q.get("mockUpdate") as MockUpdateScenario | null;
  return v && SCENARIOS.includes(v) ? v : null;
}
