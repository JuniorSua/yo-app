/**
 * Mock update scenarios for screenshots and E2E: `?mockUpdate=web|available|downloading|ready|error|github`.
 *   web          the server runs a newer build than the page → "Yo was updated — Refresh"
 *   available    Yo.app found a new build but the download stopped → "Update available" pill
 *   downloading  Yo.app is downloading one (42%)
 *   ready        a new Yo.app is downloaded → "Yo 0.1.313 is ready — Restart"
 *   error        the download failed → quiet "Update failed" pill; Retry downloads it and it becomes ready
 *   github       a public build (github channel) sees a newer GitHub Release → "Yo 0.1.313 is available —
 *                Download", which opens the release page (counted in `downloads`; nothing downloads in the app)
 * The desktop scenarios install a fake `window.yoDesktop.updates`. Test hooks on `__yoMock.updates`.
 */
import type { YoDesktopBridge } from "../desktop";
import { type DesktopUpdateState, MOCK_BUILD, type ServerVersion, type YoUpdatesBridge } from "../updates";

export type MockUpdateScenario = "web" | "available" | "downloading" | "ready" | "error" | "github";
const SCENARIOS: MockUpdateScenario[] = ["web", "available", "downloading", "ready", "error", "github"];

const CURRENT = "0.1.312";
const NEXT = "0.1.313";
export const MOCK_RELEASE_URL = `https://github.com/JuniorSua/yo-app/releases/tag/v${NEXT}`;

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
  private deployed: boolean;
  private state: DesktopUpdateState;
  private listeners = new Set<(s: DesktopUpdateState) => void>();

  constructor(
    readonly scenario: MockUpdateScenario | null,
    private readonly scale: number,
  ) {
    this.deployed = scenario === "web";
    this.state = initialState(scenario);
  }

  /** What the mock core reports at /api/version. */
  version(): ServerVersion {
    this.versionChecks++;
    const build = this.deployed ? "mock-2" : MOCK_BUILD;
    return { build, web: build, desktop: { version: this.state.availableVersion ?? CURRENT } };
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
