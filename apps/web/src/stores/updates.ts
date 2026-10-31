/**
 * Update state for the notice and Settings (see lib/updates.ts).
 * The web check runs at startup, every 4 minutes, when the window comes back into focus and right after the
 * socket reconnects (a deploy restarts core, so that is usually the first sign of one).
 */
import { create } from "zustand";
import { api } from "../lib/api";
import { friendlyError } from "../lib/connection";
import {
  CHECK_INTERVAL_MS,
  type DesktopUpdateState,
  MOCK_BUILD,
  needsRefresh,
  pendingServerUpdate,
  type ServerVersion,
  updatesBridge,
  WEB_BUILD,
} from "../lib/updates";

/**
 * Applying an update (Restart or Refresh) stays on screen at least this long, with a progress bar, so it reads
 * as an update being installed rather than a blink: the download already happened in the background.
 */
export const APPLY_MIN_MS = 2400;
/** A server update takes about this long (backup, swap, health check); its bar fills over this time. */
export const SERVER_APPLY_MS = 40_000;
/** Past this the page stops waiting for a server update and says it's taking longer than usual. */
export const SERVER_APPLY_CAP_MS = 6 * 60_000;
/** How often the page asks core about a server update being applied (core is down for part of it). */
export const SERVER_POLL_MS = 3000;
/** A check started by a click spins at least this long, so "Yo is up to date" visibly follows a real check. */
export const CHECK_MIN_MS = 1200;

export interface Applying {
  /** restart: install a downloaded Yo.app. refresh: reload the page. server: the host applies a server update. */
  kind: "restart" | "refresh" | "server";
  /** The Yo.app version being installed (restart only). */
  version: string | null;
  startedAt: number;
  /** server: the release being applied, and the last result's time when it started (to spot the new one). */
  rev?: string;
  prevFinishedAt?: number | null;
  /** server: started on another device or before this page loaded, so this page doesn't reload by itself. */
  adopted?: boolean;
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
  /** Dismissed with Later, per build/version/release, so a newer one asks again. */
  laterBuild: string | null;
  laterVersion: string | null;
  laterServerRev: string | null;
  /** An update being applied right now (the progress shown before Yo restarts or reloads). */
  applying: Applying | null;
  /** The restart confirmation is open (it stays open, showing progress, once Restart is confirmed). */
  confirmingRestart: boolean;
  /** Why the last server update couldn't start or wasn't confirmed (shown in the confirmation). */
  serverError: string | null;
  /** `finishedAt` of the server update report the user has acknowledged (persisted). */
  resultSeen: number | null;
  /** This page started the server update that just finished (it reloaded into the new version). */
  updatedRev: string | null;
}

const SEEN_KEY = "yo.serverUpdateSeen";
const UPDATED_KEY = "yo.serverUpdated";

function readStorage(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(store: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    // private mode / storage off: the notice just shows again next time
  }
}

export const useUpdates = create<UpdatesState>(() => ({
  ownBuild: null,
  server: null,
  refresh: false,
  webCheckedAt: null,
  desktop: null,
  laterBuild: null,
  laterVersion: null,
  laterServerRev: null,
  applying: null,
  confirmingRestart: false,
  serverError: null,
  resultSeen: null,
  updatedRev: null,
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
      if (!server) return;
      useUpdates.setState({ server, refresh: needsRefresh(ownBuild, server), webCheckedAt: Date.now() });
      followServerUpdate(server);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

let serverPoll: ReturnType<typeof setInterval> | null = null;
let serverCap: ReturnType<typeof setTimeout> | null = null;

function stopServerWatch() {
  if (serverPoll) clearInterval(serverPoll);
  if (serverCap) clearTimeout(serverCap);
  serverPoll = serverCap = null;
}

/** While a server update runs: ask core every few seconds (it's down for part of it), for at most the cap. */
function watchServerUpdate(startedAt: number) {
  stopServerWatch();
  serverPoll = setInterval(() => void checkWeb(true), SERVER_POLL_MS);
  serverCap = setTimeout(() => {
    stopServerWatch();
    const a = useUpdates.getState().applying;
    if (a?.kind !== "server" || a.startedAt !== startedAt) return;
    useUpdates.setState({
      applying: null,
      serverError:
        "Yo is taking longer than usual to update. It keeps going on its own; check again in a few minutes.",
    });
  }, SERVER_APPLY_CAP_MS);
}

/**
 * Each answer from core while a server update is (or might be) applied: pick up one started elsewhere, and when
 * the updater's report for ours arrives, reload into the new version (or restart Yo.app too), or show why not.
 */
function followServerUpdate(v: ServerVersion) {
  const s = v.server;
  const a = useUpdates.getState().applying;
  if (!s) return;
  if (s.applying && !a) {
    const startedAt = Date.now();
    useUpdates.setState({
      applying: {
        kind: "server",
        version: null,
        startedAt,
        rev: s.pending?.rev,
        prevFinishedAt: s.lastResult?.finishedAt ?? null,
        adopted: true,
      },
    });
    watchServerUpdate(startedAt);
    return;
  }
  if (a?.kind !== "server" || s.applying) return;
  const r = s.lastResult;
  const done = r && r.finishedAt !== a.prevFinishedAt && (!a.rev || r.rev === a.rev);
  if (!done) return;
  stopServerWatch();
  if (!r.ok) {
    useUpdates.setState({ applying: null, confirmingRestart: false });
    return;
  }
  if (a.adopted) {
    // Someone else's restart: this page offers Refresh like after any deploy, it never reloads by itself.
    useUpdates.setState({ applying: null });
    return;
  }
  writeStorage(() => sessionStorage, UPDATED_KEY, r.rev ?? "");
  if (useUpdates.getState().desktop?.status === "downloaded") void updates.apply("restart");
  else updates.refresh();
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
    const cur = useUpdates.getState().applying;
    if (cur && cur.kind !== "server") return;
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
  /**
   * Restart to update, server side: the host's updater backs up, swaps and health-checks while core is down,
   * and this page follows along (followServerUpdate) until the report comes in.
   */
  async applyServer() {
    const s = useUpdates.getState();
    const pending = pendingServerUpdate(s.server);
    if (!pending || s.applying) return;
    const startedAt = Date.now();
    useUpdates.setState({
      serverError: null,
      applying: {
        kind: "server",
        version: null,
        startedAt,
        rev: pending.rev,
        prevFinishedAt: s.server?.server?.lastResult?.finishedAt ?? null,
      },
    });
    try {
      await api().call("update.applyServer", { rev: pending.rev });
    } catch (err) {
      useUpdates.setState({ applying: null, serverError: friendlyError(err) });
      throw err;
    }
    watchServerUpdate(startedAt);
  },
  /**
   * Every Restart button asks first: a confirmation with what's new, in case of a misclick or a forgotten
   * update. Its Restart calls `confirmRestart`.
   */
  askRestart() {
    if (useUpdates.getState().applying) return;
    useUpdates.setState({ confirmingRestart: true, serverError: null });
    void checkWeb(); // freshen the "What's new" (throttled)
  },
  cancelRestart() {
    const a = useUpdates.getState().applying;
    if (a?.kind === "restart" || a?.kind === "server") return;
    useUpdates.setState({ confirmingRestart: false });
  },
  /** One Restart for everything: a server update first (the app restarts after it), else the Yo.app one. */
  async confirmRestart() {
    if (pendingServerUpdate(useUpdates.getState().server)) {
      await updates.applyServer().catch(() => {}); // the confirmation shows the error
      return;
    }
    try {
      await updates.apply("restart");
    } catch {
      useUpdates.setState({ confirmingRestart: false }); // the button shows the install error
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
    else
      useUpdates.setState({
        laterVersion: s.desktop?.downloadedVersion ?? null,
        laterServerRev: pendingServerUpdate(s.server)?.rev ?? null,
      });
  },
  /** OK on "Yo was updated" / "The update didn't finish". */
  dismissResult() {
    const r = useUpdates.getState().server?.server?.lastResult;
    if (r) writeStorage(() => localStorage, SEEN_KEY, String(r.finishedAt));
    writeStorage(() => sessionStorage, UPDATED_KEY, null);
    useUpdates.setState({ resultSeen: r?.finishedAt ?? null, updatedRev: null });
  },
};

function setDesktop(desktop: DesktopUpdateState | undefined) {
  if (desktop) useUpdates.setState({ desktop });
}

export function startUpdates() {
  if (started) return;
  started = true;
  const c = api();
  const seen = Number(readStorage(() => localStorage, SEEN_KEY));
  useUpdates.setState({
    ownBuild: c.mock ? MOCK_BUILD : WEB_BUILD,
    resultSeen: Number.isFinite(seen) && seen > 0 ? seen : null,
    updatedRev: readStorage(() => sessionStorage, UPDATED_KEY),
  });

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

/**
 * The "What's new" for what Restart installs: the published server update's notes and/or the downloaded Yo.app's
 * (when core's feed has notes for that same version).
 */
export function restartNotes(s: UpdatesState): string | null {
  const server = pendingServerUpdate(s.server)?.notes ?? null;
  const v = s.desktop?.status === "downloaded" ? s.desktop.downloadedVersion : null;
  const app = v && s.server?.desktop?.version === v ? (s.server.desktop.notes ?? null) : null;
  const all = [server, app].filter((n): n is string => !!n?.trim());
  return all.length ? all.join("\n") : null;
}

/** Results older than this aren't news anymore. */
const RESULT_FRESH_MS = 24 * 60 * 60_000;

/**
 * The server update report to show, if any: "ok" only on the page that asked for it (it reloaded into the new
 * version), "failed" to anyone until acknowledged.
 */
export function serverResult(s: UpdatesState, now = Date.now()): "ok" | "failed" | null {
  const r = s.server?.server?.lastResult;
  if (!r || s.applying || s.server?.server?.applying) return null;
  if (s.resultSeen !== null && r.finishedAt <= s.resultSeen) return null;
  if (r.ok) return s.updatedRev !== null && s.updatedRev === (r.rev ?? "") ? "ok" : null;
  return now - r.finishedAt < RESULT_FRESH_MS ? "failed" : null;
}

/** Notice inputs, derived (used by the notice and its tests). */
export function noticeInput(s: UpdatesState) {
  const serverBuild = s.server?.web ?? s.server?.build ?? null;
  const pending = pendingServerUpdate(s.server);
  const ready = s.desktop?.status === "downloaded" ? s.desktop.downloadedVersion : null;
  return {
    refresh: s.refresh,
    desktop: s.desktop,
    dismissedRefresh: !!serverBuild && s.laterBuild === serverBuild,
    dismissedRestart:
      (!!ready || !!pending) &&
      (!ready || s.laterVersion === ready) &&
      (!pending || s.laterServerRev === pending.rev),
    serverPending: !!pending,
    serverResult: serverResult(s),
  };
}
