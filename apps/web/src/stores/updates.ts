/**
 * Update state for the update button, its notice, the update window and Settings (see lib/updates.ts).
 * The web check runs at startup, every 4 minutes, when the window comes back into focus and right after the
 * socket reconnects (a deploy restarts core, so that is usually the first sign of one).
 *
 * One flow: an offer (restart, reload, or a public build's download) shows a small notice; the update window
 * (`dialog: "update"`) says what's new and what will happen; Restart now turns that window into the steps; and
 * after the reload or relaunch a short "Updated to Yo 2.0.N" says it worked. Nothing applies by itself.
 */
import { create } from "zustand";
import { api } from "../lib/api";
import { friendlyError } from "../lib/connection";
import {
  type ApplyPhase,
  CHECK_INTERVAL_MS,
  type DesktopUpdateState,
  MOCK_BUILD,
  MOCK_VERSION,
  needsRefresh,
  type Offer,
  pendingServerUpdate,
  pickNotice,
  pickOffer,
  type ServerVersion,
  updatesBridge,
  WEB_BUILD,
  WEB_VERSION,
} from "../lib/updates";

/** Restarting Yo.app shows "Closing Yo" at least this long, so the window doesn't just blink away. */
export const APP_CLOSE_MS = 1200;
/** "Done" stays on screen this long before the page reloads into the new version. */
export const DONE_HOLD_MS = 700;
/** Past this a server update counts as stuck: the window says so and how to get Yo back. */
export const SERVER_APPLY_CAP_MS = 6 * 60_000;
/** How often the page asks core about a server update being applied (core is down for part of it)... */
export const SERVER_POLL_MS = 3000;
/** ...and, once it's stuck, how often it keeps asking. */
export const STUCK_POLL_MS = 15_000;
/** A check started by a click spins at least this long, so "Yo is up to date" visibly follows a real check. */
export const CHECK_MIN_MS = 1200;
/** "Updated to Yo 2.0.N" goes away by itself after this long. */
export const DONE_NOTICE_MS = 9000;

export interface Applying {
  /** server: the host applies a server update. app: Yo.app installs a downloaded build. web: a reload. */
  kind: "server" | "app" | "web";
  phase: ApplyPhase;
  startedAt: number;
  /** The Yo.app version being installed (app, or server with `alsoApp`). */
  version: string | null;
  /** server: the release being applied, and the last result's time when it started (to spot the new one). */
  rev?: string;
  prevFinishedAt?: number | null;
  restartsComputer?: boolean;
  /** The "What's new" of what's being installed (kept for "Updated to…": core forgets it once applied). */
  notes: string | null;
  /** server: a downloaded Yo.app installs right after it. */
  alsoApp?: boolean;
  /** server: started on another device or before this page loaded, so this page doesn't reload by itself. */
  adopted?: boolean;
}

/** Saved right before a reload or relaunch, so the new page can say "Updated to Yo 2.0.N" and show what's new. */
export interface UpdatedRecord {
  kind: "server" | "app" | "web";
  /** server: the release applied. app: the Yo.app version installed. */
  rev?: string;
  version?: string | null;
  notes: string | null;
  at: number;
}

interface UpdatesState {
  /** Build id this page was loaded from; null turns the web check off. */
  ownBuild: string | null;
  /** This page's release number ("2.0.N"), when the build has one. */
  ownVersion: string | null;
  server: ServerVersion | null;
  /** The server now serves a different web build. */
  refresh: boolean;
  webCheckedAt: number | null;
  /** Yo.app's updater (desktop builds only). */
  desktop: DesktopUpdateState | null;
  /** Put off with Later, per build/version/release, so a newer one asks again. */
  laterBuild: string | null;
  laterVersion: string | null;
  laterServerRev: string | null;
  laterDownload: string | null;
  /** The update window: "update" decides and then shows the progress; "whatsnew" follows "Updated to…". */
  dialog: "update" | "whatsnew" | null;
  /** An update being applied right now. */
  applying: Applying | null;
  /** A server update ran past SERVER_APPLY_CAP_MS (still followed, in case it finishes). */
  stuck: boolean;
  /** Why the last server update couldn't start (core refused it). */
  serverError: string | null;
  /** github channel: Download was pressed in the update window. */
  downloadOpened: boolean;
  /** `finishedAt` of the server update report the user has acknowledged (persisted). */
  resultSeen: number | null;
  /** What was being installed when the page reloaded or Yo.app relaunched (persisted for a few minutes). */
  updated: UpdatedRecord | null;
}

const SEEN_KEY = "yo.serverUpdateSeen";
const UPDATED_KEY = "yo.updated";
/** A record older than this is no news anymore (a relaunch that never happened). */
const UPDATED_FRESH_MS = 15 * 60_000;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode / storage off: the "Updated" notice just doesn't show
  }
}

function readUpdated(now = Date.now()): UpdatedRecord | null {
  try {
    const r = JSON.parse(readStorage(UPDATED_KEY) ?? "null") as UpdatedRecord | null;
    return r && typeof r.at === "number" && now - r.at < UPDATED_FRESH_MS ? r : null;
  } catch {
    return null;
  }
}

function remember(r: Omit<UpdatedRecord, "at">) {
  writeStorage(UPDATED_KEY, JSON.stringify({ ...r, at: Date.now() }));
}

export const useUpdates = create<UpdatesState>(() => ({
  ownBuild: null,
  ownVersion: null,
  server: null,
  refresh: false,
  webCheckedAt: null,
  desktop: null,
  laterBuild: null,
  laterVersion: null,
  laterServerRev: null,
  laterDownload: null,
  dialog: null,
  applying: null,
  stuck: false,
  serverError: null,
  downloadOpened: false,
  resultSeen: null,
  updated: null,
}));

const get = () => useUpdates.getState();
const set = useUpdates.setState;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let started = false;
let lastCheck = 0;
let inFlight: Promise<void> | null = null;

/** Ask core which build it serves. Throttled to one check per 15s unless forced. */
export function checkWeb(force = false): Promise<void> {
  const { ownBuild } = get();
  if (!ownBuild) return Promise.resolve();
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastCheck < 15_000) return Promise.resolve();
  lastCheck = Date.now();
  inFlight = api()
    .version()
    .then((server) => {
      // No answer (offline, core restarting) keeps what we knew; during a server update it means the swap.
      if (!server) return coreReachable(false);
      set({ server, refresh: needsRefresh(ownBuild, server), webCheckedAt: Date.now() });
      coreReachable(true);
      followServerUpdate(server);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function setPhase(phase: ApplyPhase) {
  const a = get().applying;
  if (!a || a.phase === phase) return;
  set({ applying: { ...a, phase } });
  // It moved on after all (Yo came back): not stuck anymore, and quick to notice the end again.
  if (get().stuck) {
    set({ stuck: false });
    poll(SERVER_POLL_MS);
  }
}

/** Core went away or came back: during a server update, that's the swap starting or Yo starting again. */
function coreReachable(up: boolean) {
  const a = get().applying;
  if (a?.kind !== "server") return;
  if (!up && a.phase === "save") setPhase("install");
  if (up && a.phase === "install") setPhase("start");
}

let serverPoll: ReturnType<typeof setInterval> | null = null;
let serverCap: ReturnType<typeof setTimeout> | null = null;

function stopServerWatch() {
  if (serverPoll) clearInterval(serverPoll);
  if (serverCap) clearTimeout(serverCap);
  serverPoll = serverCap = null;
}

function poll(ms: number) {
  if (serverPoll) clearInterval(serverPoll);
  serverPoll = setInterval(() => void checkWeb(true), ms);
}

/**
 * While a server update runs: ask core every few seconds (it's down for part of it). Past the cap it's "stuck":
 * the window says so, and the page keeps asking, more slowly, in case it finishes after all.
 */
function watchServerUpdate(startedAt: number) {
  stopServerWatch();
  poll(SERVER_POLL_MS);
  serverCap = setTimeout(() => {
    if (get().applying?.startedAt !== startedAt) return;
    poll(STUCK_POLL_MS);
    set({ stuck: true });
  }, SERVER_APPLY_CAP_MS);
}

/**
 * Each answer from core while a server update is (or might be) applied: pick up one started elsewhere, and when
 * the updater's report for ours arrives, reload into the new version (or restart Yo.app too), or show why not.
 */
function followServerUpdate(v: ServerVersion) {
  const s = v.server;
  const a = get().applying;
  if (!s) return;
  if (s.applying && !a) {
    const startedAt = Date.now();
    set({
      applying: {
        kind: "server",
        phase: "save",
        startedAt,
        version: null,
        rev: s.pending?.rev,
        prevFinishedAt: s.lastResult?.finishedAt ?? null,
        restartsComputer: s.pending?.restartsComputer,
        notes: s.pending?.notes ?? null,
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
  if (!r.ok || a.adopted) {
    // A failure: the update window (or the notice) says why. Someone else's update: this page offers a reload
    // like after any deploy; it never reloads by itself.
    set({ applying: null, stuck: false });
    return;
  }
  void finishServer(a, r.rev);
}

async function finishServer(a: Applying, rev: string | null) {
  if (a.alsoApp) {
    setPhase("app");
    remember({ kind: "app", version: a.version, notes: a.notes });
    return installApp();
  }
  setPhase("done");
  remember({ kind: "server", rev: rev ?? a.rev, notes: a.notes });
  await wait(DONE_HOLD_MS);
  location.reload();
}

/** Quit, install the downloaded Yo.app and reopen. A failure comes back as the updater's "install" error. */
async function installApp() {
  try {
    await updatesBridge()?.install();
  } catch {
    set({ applying: null });
    writeStorage(UPDATED_KEY, null);
  }
}

/** The offer the user can act on now, and whether they put it off with Later. */
export function currentOffer(s: UpdatesState): Offer | null {
  return pickOffer({
    refresh: s.refresh,
    desktop: s.desktop,
    serverPending: !!pendingServerUpdate(s.server),
  });
}

export function offerDismissed(s: UpdatesState): boolean {
  const offer = currentOffer(s);
  if (offer === "refresh") return !!s.laterBuild && s.laterBuild === (s.server?.web ?? s.server?.build);
  if (offer === "download") return !!s.laterDownload && s.laterDownload === s.desktop?.availableVersion;
  if (offer !== "restart") return false;
  const ready = s.desktop?.status === "downloaded" ? s.desktop.downloadedVersion : null;
  const pending = pendingServerUpdate(s.server);
  return (!ready || s.laterVersion === ready) && (!pending || s.laterServerRev === pending.rev);
}

export const updates = {
  /** Look for both kinds of update now (Settings → Check for updates, the update button). */
  async checkNow() {
    const bridge = updatesBridge();
    await Promise.all([checkWeb(true), bridge?.check().then(setDesktop), wait(CHECK_MIN_MS)]);
  },
  /** Open the update window: what's new and Restart now, the download steps, the progress or what went wrong. */
  open() {
    set({ dialog: "update", serverError: null });
    void checkWeb(); // freshen the "What's new" (throttled)
  },
  /** "What's new" on "Updated to Yo 2.0.N". */
  openWhatsNew() {
    set({ dialog: "whatsnew" });
  },
  /**
   * Later, Escape, a click outside, OK or Close. Not updating now is Later: the notice goes and the dot on the
   * update button stays. An update this window started can't be closed while it runs (only hidden once it's slow).
   */
  close() {
    const s = get();
    const view = dialogView(s);
    if (view === "progress" && !s.applying?.adopted && !s.stuck) return;
    if (view === "decide" || view === "download") updates.later();
    if (view === "failed") updates.acknowledge();
    if (view === "whatsnew") updates.dismissDone();
    set({ dialog: null });
  },
  /** Hide a slow or stuck update's window: the notice next to the update button keeps showing it. */
  hide() {
    set({ dialog: null });
  },
  later() {
    const s = get();
    const offer = currentOffer(s);
    if (offer === "refresh") set({ laterBuild: s.server?.web ?? s.server?.build ?? null });
    else if (offer === "download") set({ laterDownload: s.desktop?.availableVersion ?? null });
    else if (offer === "restart")
      set({
        laterVersion: s.desktop?.status === "downloaded" ? s.desktop.downloadedVersion : null,
        laterServerRev: pendingServerUpdate(s.server)?.rev ?? null,
      });
  },
  /** Restart now / Reload now: one button for everything. A server update goes first (the app restarts after it). */
  async confirm() {
    const s = get();
    if (s.applying) return;
    const offer = currentOffer(s);
    if (offer === "restart" && pendingServerUpdate(s.server)) return updates.applyServer();
    if (offer === "restart") return updates.applyApp();
    if (offer === "refresh") return updates.reload();
  },
  /**
   * Restart to update, server side: the host's updater backs up, swaps and health-checks while core is down,
   * and this page follows along (followServerUpdate) until the report comes in.
   */
  async applyServer() {
    const s = get();
    const pending = pendingServerUpdate(s.server);
    if (!pending || s.applying) return;
    const startedAt = Date.now();
    const app = s.desktop?.status === "downloaded" ? s.desktop.downloadedVersion : null;
    set({
      serverError: null,
      stuck: false,
      applying: {
        kind: "server",
        phase: "save",
        startedAt,
        version: app,
        rev: pending.rev,
        prevFinishedAt: s.server?.server?.lastResult?.finishedAt ?? null,
        restartsComputer: pending.restartsComputer,
        notes: restartNotes(s),
        alsoApp: !!app,
      },
    });
    try {
      await api().call("update.applyServer", { rev: pending.rev });
    } catch (err) {
      set({ applying: null, serverError: friendlyError(err) });
      return;
    }
    watchServerUpdate(startedAt);
  },
  /** Install the downloaded Yo.app: "Closing Yo" for a moment, then Yo quits, installs and opens again. */
  async applyApp() {
    const s = get();
    if (s.applying || s.desktop?.status !== "downloaded") return;
    const version = s.desktop.downloadedVersion;
    const notes = restartNotes(s);
    set({ applying: { kind: "app", phase: "close", startedAt: Date.now(), version, notes } });
    remember({ kind: "app", version, notes });
    await wait(APP_CLOSE_MS);
    await installApp();
  },
  /** Load the new UI the server now serves. Agents keep working: only this window reloads. */
  async reload() {
    set({ applying: { kind: "web", phase: "reload", startedAt: Date.now(), version: null, notes: null } });
    remember({ kind: "web", notes: null });
    await wait(300);
    location.reload();
  },
  /** Public builds: open the newer release's download (the steps stay in the update window). */
  async download() {
    set({ downloadOpened: true });
    await updatesBridge()?.download?.();
  },
  /** Retry a failed download (or check). */
  async retry() {
    await updatesBridge()?.check().then(setDesktop);
  },
  /** "Check now" on a stuck server update. */
  async checkAgain() {
    await checkWeb(true);
  },
  /** OK on "The update didn't finish". */
  acknowledge() {
    const r = get().server?.server?.lastResult;
    if (r && !r.ok) {
      writeStorage(SEEN_KEY, String(r.finishedAt));
      set({ resultSeen: r.finishedAt });
    }
  },
  /** "Updated to Yo 2.0.N" closed, timed out, or its What's new was read. */
  dismissDone() {
    const r = get().server?.server?.lastResult;
    if (r && get().updated?.kind === "server") writeStorage(SEEN_KEY, String(r.finishedAt));
    writeStorage(UPDATED_KEY, null);
    set((s) => ({
      updated: null,
      resultSeen: s.updated?.kind === "server" && r ? r.finishedAt : s.resultSeen,
    }));
  },
};

function setDesktop(desktop: DesktopUpdateState | undefined) {
  if (!desktop) return;
  const a = get().applying;
  // Yo.app couldn't quit to install (or refused the build): the update window says what to do instead.
  if (a?.kind === "app" && desktop.status === "error") {
    writeStorage(UPDATED_KEY, null);
    set({ desktop, applying: null });
    return;
  }
  set({ desktop });
}

export function startUpdates() {
  if (started) return;
  started = true;
  const c = api();
  const seen = Number(readStorage(SEEN_KEY));
  set({
    ownBuild: c.mock ? MOCK_BUILD : WEB_BUILD,
    ownVersion: c.mock ? MOCK_VERSION : WEB_VERSION,
    resultSeen: Number.isFinite(seen) && seen > 0 ? seen : null,
    updated: readUpdated(),
  });

  void checkWeb(true);
  window.setInterval(() => void checkWeb(true), CHECK_INTERVAL_MS);
  window.addEventListener("focus", () => void checkWeb());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkWeb();
  });
  c.onStatus((status, reconnected) => {
    coreReachable(status === "open");
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
  if (r.ok) return s.updated?.kind === "server" && s.updated.rev === (r.rev ?? undefined) ? "ok" : null;
  return now - r.finishedAt < RESULT_FRESH_MS ? "failed" : null;
}

/** What went wrong, for the update window: a server update that didn't finish, or Yo.app couldn't restart. */
export type Failure = { kind: "server" | "app"; message: string };

export function failure(s: UpdatesState, now = Date.now()): Failure | null {
  if (serverResult(s, now) === "failed")
    return { kind: "server", message: s.server?.server?.lastResult?.message ?? "" };
  if (s.desktop?.status === "error" && s.desktop.errorContext === "install")
    return { kind: "app", message: s.desktop.message ?? "" };
  return null;
}

/** "Updated to Yo 2.0.N": the version now running, once the update this page started is confirmed. */
export function justUpdated(s: UpdatesState): { version: string | null; notes: string | null } | null {
  const r = s.updated;
  if (!r) return null;
  if (r.kind === "server" && serverResult(s) === "ok") return { version: s.ownVersion, notes: r.notes };
  if (r.kind === "app" && r.version && s.desktop?.currentVersion === r.version)
    return { version: r.version, notes: r.notes };
  // The page reloaded and now runs what the server serves.
  if (r.kind === "web" && s.webCheckedAt && !s.refresh) return { version: s.ownVersion, notes: r.notes };
  return null;
}

/**
 * What the update window shows: the steps of an update being applied (slow and stuck included), what went
 * wrong, the decision (restart or reload), a public build's download steps, or what's new after an update.
 * Null when there's nothing left to show (say the update finished on another device): the window closes.
 */
export type DialogView = "progress" | "failed" | "decide" | "download" | "whatsnew";

export function dialogView(s: UpdatesState): DialogView | null {
  if (s.dialog === "whatsnew") return "whatsnew";
  if (s.dialog !== "update") return null;
  if (s.applying) return "progress";
  if (failure(s)) return "failed";
  const offer = currentOffer(s);
  return offer === "download" ? "download" : offer ? "decide" : null;
}

/** The notice to show next to the update button (lib/updates.ts pickNotice). */
export function noticeKind(s: UpdatesState) {
  return pickNotice({
    dialogOpen: dialogView(s) !== null,
    applying: !!s.applying,
    failed: failure(s)?.kind === "server",
    done: !!justUpdated(s),
    offer: currentOffer(s),
    dismissed: offerDismissed(s),
  });
}
