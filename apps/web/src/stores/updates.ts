/**
 * Update state for the notice and Settings (see lib/updates.ts).
 * The web check runs at startup, every 4 minutes, when the window comes back into focus and right after the
 * socket reconnects (a deploy restarts core, so that is usually the first sign of one).
 */
import { create } from "zustand";
import { api } from "../lib/api";
import {
  CHECK_INTERVAL_MS,
  type DesktopUpdateState,
  MOCK_BUILD,
  needsRefresh,
  type ServerVersion,
  updatesBridge,
  WEB_BUILD,
} from "../lib/updates";

/**
 * Applying an update (Restart or Refresh) stays on screen at least this long, with a progress bar, so it reads
 * as an update being installed rather than a blink: the download already happened in the background.
 */
export const APPLY_MIN_MS = 2400;
/** A check started by a click spins at least this long, so "Yo is up to date" visibly follows a real check. */
export const CHECK_MIN_MS = 1200;

export interface Applying {
  kind: "restart" | "refresh";
  /** The Yo.app version being installed (restart only). */
  version: string | null;
  startedAt: number;
}

interface UpdatesState {
  /** Build id this page was loaded from; null turns the web check off. */
  ownBuild: string | null;
  server: ServerVersion | null;
  /** The server now serves a different web build. */
  refresh: boolean;
  webCheckedAt: number | null;
  /** Yo.app's updater (desktop builds only). */
  desktop: DesktopUpdateState | null;
  /** Dismissed with Later, per build/version, so a newer one asks again. */
  laterBuild: string | null;
  laterVersion: string | null;
  /** An update being applied right now (the progress shown before Yo restarts or reloads). */
  applying: Applying | null;
}

export const useUpdates = create<UpdatesState>(() => ({
  ownBuild: null,
  server: null,
  refresh: false,
  webCheckedAt: null,
  desktop: null,
  laterBuild: null,
  laterVersion: null,
  applying: null,
}));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let started = false;
let lastCheck = 0;
let inFlight: Promise<void> | null = null;

/** Ask core which build it serves. Throttled to one check per 15s unless forced. */
export function checkWeb(force = false): Promise<void> {
  const { ownBuild } = useUpdates.getState();
  if (!ownBuild) return Promise.resolve();
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastCheck < 15_000) return Promise.resolve();
  lastCheck = Date.now();
  inFlight = api()
    .version()
    .then((server) => {
      // A failed check (offline, core restarting) keeps what we knew.
      if (server)
        useUpdates.setState({ server, refresh: needsRefresh(ownBuild, server), webCheckedAt: Date.now() });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export const updates = {
  /** Reload the page to pick up the new UI. */
  refresh() {
    location.reload();
  },
  /** Look for both kinds of update now (Settings → Check for updates). */
  async checkNow() {
    const bridge = updatesBridge();
    await Promise.all([checkWeb(true), bridge?.check().then(setDesktop), wait(CHECK_MIN_MS)]);
  },
  /**
   * Install the downloaded Yo.app (restart) or load the new UI (refresh), after showing progress for at least
   * APPLY_MIN_MS. One at a time; a failed install clears the progress so the user can try again.
   */
  async apply(kind: "restart" | "refresh") {
    if (useUpdates.getState().applying) return;
    const version = kind === "restart" ? (useUpdates.getState().desktop?.downloadedVersion ?? null) : null;
    useUpdates.setState({ applying: { kind, version, startedAt: Date.now() } });
    await wait(APPLY_MIN_MS);
    if (kind === "refresh") return updates.refresh();
    try {
      await updates.install();
    } catch (err) {
      useUpdates.setState({ applying: null });
      throw err;
    }
  },
  /** Quit, install the downloaded Yo.app and reopen. */
  async install() {
    await updatesBridge()?.install();
  },
  /** Public builds: open the newer release's page on GitHub. */
  async download() {
    await updatesBridge()?.download?.();
  },
  /** Retry a failed download (or check). */
  async retry() {
    await updatesBridge()?.check().then(setDesktop);
  },
  later(kind: "refresh" | "restart") {
    const s = useUpdates.getState();
    if (kind === "refresh") useUpdates.setState({ laterBuild: s.server?.web ?? s.server?.build ?? null });
    else useUpdates.setState({ laterVersion: s.desktop?.downloadedVersion ?? null });
  },
};

function setDesktop(desktop: DesktopUpdateState | undefined) {
  if (desktop) useUpdates.setState({ desktop });
}

export function startUpdates() {
  if (started) return;
  started = true;
  const c = api();
  useUpdates.setState({ ownBuild: c.mock ? MOCK_BUILD : WEB_BUILD });

  void checkWeb(true);
  window.setInterval(() => void checkWeb(true), CHECK_INTERVAL_MS);
  window.addEventListener("focus", () => void checkWeb());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkWeb();
  });
  c.onStatus((status, reconnected) => {
    if (status === "open" && reconnected) void checkWeb(true);
  });

  const bridge = updatesBridge();
  if (bridge) {
    bridge.onState(setDesktop);
    void bridge.getState().then(setDesktop, () => undefined);
  }
}

/** Notice inputs, derived (used by the notice and its tests). */
export function noticeInput(s: UpdatesState) {
  const serverBuild = s.server?.web ?? s.server?.build ?? null;
  return {
    refresh: s.refresh,
    desktop: s.desktop,
    dismissedRefresh: !!serverBuild && s.laterBuild === serverBuild,
    dismissedRestart: !!s.desktop?.downloadedVersion && s.laterVersion === s.desktop.downloadedVersion,
  };
}
