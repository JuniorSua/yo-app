/**
 * Mock update scenarios for screenshots and E2E:
 * `?mockUpdate=web|available|downloading|ready|error|github|server|server-browser|server-ready|server-fail`.
 *   web          the server runs a newer build than the page → "Yo was updated — Refresh"
 *   available    Yo.app found a new build but the download stopped → "Update available" pill
 *   downloading  Yo.app is downloading one (42%)
 *   ready        a new Yo.app is downloaded → "Yo 0.1.313 is ready — Restart"
 *   error        the download failed → quiet "Update failed" pill; Retry downloads it and it becomes ready
 *   github       a public build (github channel) sees a newer GitHub Release → "Yo 0.1.313 is available —
 *                Download", which opens the release page (counted in `downloads`; nothing downloads in the app)
 *   server       a server update is published on the Home PC → "Update ready — Restart"; Restart makes the
 *                mock core go away for a moment and come back on the new build (`serverApplies` counts it).
 *                The page then reloads; the mock remembers (sessionStorage) and reports "Yo was updated".
 *   server-browser   the same, and the agent computer changes too (its browser reloads)
 *   server-ready     a server update and a downloaded Yo.app: one Restart does both, server first
 *   server-fail      the updater reports a failure and rolls back
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

export type MockUpdateScenario =
  | "web"
  | "available"
  | "downloading"
  | "ready"
  | "error"
  | "github"
  | "server"
  | "server-browser"
  | "server-ready"
  | "server-fail";
const SCENARIOS: MockUpdateScenario[] = [
  "web",
  "available",
  "downloading",
  "ready",
  "error",
  "github",
  "server",
  "server-browser",
  "server-ready",
  "server-fail",
];

const CURRENT = "0.1.312";
const NEXT = "0.1.313";
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
/** Survives the reload after a mock server update, like the new build on a real core. */
const APPLIED_KEY = "yo.mock.serverApplied";

function initialState(scenario: MockUpdateScenario | null): DesktopUpdateState {
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
  switch (scenario) {
    case "github":
      return { ...base, status: "available", availableVersion: NEXT, releaseUrl: MOCK_RELEASE_URL };
    case "available":
      return { ...base, status: "available", availableVersion: NEXT, canRetry: true };
    case "downloading":
      return { ...base, status: "downloading", availableVersion: NEXT, percent: 42 };
    case "ready":
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
  /** Test hook: how many times Restart was confirmed. */
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

  constructor(
    readonly scenario: MockUpdateScenario | null,
    private readonly scale: number,
  ) {
    this.deployed = scenario === "web";
    this.state = initialState(scenario);
    if (scenario?.startsWith("server")) {
      const applied = Number(sessionStorage.getItem(APPLIED_KEY));
      this.server = applied
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

  /**
   * update.applyServer: like the host's updater, core goes away for a moment (the swap) and comes back on the new
   * build, then reports how it went. `conn` drops and restores the mock connection.
   */
  applyServer(rev: string, conn: { drop(): void; back(): void }) {
    const pending = this.server.pending;
    if (!pending || pending.rev !== rev || this.server.applying)
      throw new Error("That update isn't available anymore. Check for updates again.");
    this.serverApplies++;
    this.server = { ...this.server, applying: true };
    const later = (ms: number) => new Promise((r) => setTimeout(r, ms * this.scale));
    void (async () => {
      await later(2500);
      conn.drop();
      await later(8000);
      const ok = this.scenario !== "server-fail";
      const finishedAt = Date.now();
      this.server = {
        pending: null,
        applying: false,
        lastResult: { rev, ok, message: ok ? "Yo was updated." : MOCK_SERVER_FAILURE, finishedAt },
      };
      if (ok) {
        this.deployed = true;
        sessionStorage.setItem(APPLIED_KEY, String(finishedAt));
      }
      conn.back();
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
    const later = (ms: number) => new Promise((r) => setTimeout(r, ms * this.scale));
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
        this.installs++;
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
