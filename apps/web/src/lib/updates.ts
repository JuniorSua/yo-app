/**
 * "Yo was updated": the two kinds of update and which notice to show.
 *  - Server/web: core and the web UI are deployed together. When the build core serves differs from the build
 *    this page was loaded from, the page offers a Refresh. It never reloads by itself (a draft could be lost).
 *  - Server update (Home PC): a release published but not applied (`server.pending`). Nothing restarts until the
 *    user presses Restart; the host's updater then swaps core (and maybe the agent computer) and this page
 *    reloads into the new UI once core is back. See apps/core/src/http/updates.ts.
 *  - Yo.app: the desktop app downloads new builds in the background (electron-updater, feed served by core)
 *    and offers a Restart once one is ready. Public builds ("github" channel, ad-hoc signed) can't install
 *    updates themselves: they offer Download, which opens the new release's page on GitHub, with the steps.
 *
 * What the user sees (components/UpdateButton, UpdateNotice, UpdateDialog): one small notice next to the update
 * button, one window to decide (what's new, what happens, who is busy) that turns into the progress, and a short
 * "Updated to Yo 2.0.N" afterwards. Nothing updates by itself.
 */

declare const __YO_BUILD__: string | null | undefined;

/** This page's build id (baked in by `vite build`); null in the dev server, which turns the check off. */
export const WEB_BUILD: string | null = typeof __YO_BUILD__ === "string" ? __YO_BUILD__ : null;

declare const __YO_VERSION__: string | null | undefined;

/** This page's release number ("2.0.<commit count>", baked in by `vite build`); null in the dev server. */
export const WEB_VERSION: string | null = typeof __YO_VERSION__ === "string" ? __YO_VERSION__ : null;

/** Build id and release number the mock UI pretends to be (see lib/mock/updates.ts). */
export const MOCK_BUILD = "mock-1";
export const MOCK_VERSION = "2.0.791";

/** How often to look for either kind of update. */
export const CHECK_INTERVAL_MS = 4 * 60 * 1000;

/** Mirrors `ServerUpdate` in apps/core/src/http/updates.ts. */
export interface ServerUpdate {
  pending: { rev: string; notes: string | null; restartsComputer: boolean } | null;
  applying: boolean;
  lastResult?: { rev: string | null; ok: boolean; message: string; finishedAt: number };
}

/** Mirrors `ServerVersion` in apps/core/src/http/updates.ts (GET /api/version). */
export interface ServerVersion {
  build: string | null;
  web: string | null;
  /** `notes`: the short "What's new" published with it (absent from cores before it existed). */
  desktop: { version: string; notes?: string | null } | null;
  /** Absent from cores before server updates waited for the user. */
  server?: ServerUpdate;
  /**
   * The PC edition: a newer GitHub release than the one running (`yo-app update` installs it). Null when up to
   * date or not the PC edition; absent from older cores.
   */
  release?: { version: string; url: string } | null;
}

/** The published server update the user can apply now (not while one is being applied). */
export function pendingServerUpdate(v: ServerVersion | null | undefined) {
  return v?.server && !v.server.applying ? v.server.pending : null;
}

/** "Pepe is in the middle of a task; it will stop." for the agents a restart would interrupt. */
export function busyLine(names: string[]): string | null {
  if (!names.length) return null;
  if (names.length === 1) return `${names[0]} is in the middle of a task; it will stop.`;
  const list = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} are in the middle of tasks; they will stop.`;
}

/** True when the server now serves a different web build than the one this page runs. */
export function needsRefresh(own: string | null, server: ServerVersion | null): boolean {
  const theirs = server ? (server.web ?? server.build) : null;
  return !!own && !!theirs && own !== theirs;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

/** Mirrors `UpdateChannel` in apps/desktop/src/updateState.ts. */
export type UpdateChannel = "feed" | "github";

/** Mirrors `DesktopUpdateState` in apps/desktop/src/updateState.ts. */
export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  /** Absent from Yo.apps built before the github channel existed: those are "feed". */
  channel?: UpdateChannel;
  currentVersion: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  /** 0–100 while downloading. */
  percent: number | null;
  checkedAt: number | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
  /** github channel: the release page (Download opens its .dmg when it has one). */
  releaseUrl?: string | null;
}

/** A public build's "Yo 0.1.N is available: Download" (opens the release's .dmg download, or its page; nothing installs in the app). */
export function isGithubDownload(d: DesktopUpdateState | null | undefined): boolean {
  return d?.channel === "github" && d.status === "available" && !!d.availableVersion;
}

/** Preload `updates` (desktop builds with the updater). Every call is validated in the main process. */
export interface YoUpdatesBridge {
  getState(): Promise<DesktopUpdateState>;
  /** Look for a new build now (downloads it in the background when there is one). */
  check(): Promise<DesktopUpdateState>;
  /** Quit, install the downloaded build and reopen Yo. */
  install(): Promise<void>;
  /** github channel: open the newer release's page (the main process picks and checks the URL). */
  download?(): Promise<void>;
  onState(cb: (state: DesktopUpdateState) => void): () => void;
}

export function updatesBridge(): YoUpdatesBridge | undefined {
  return typeof window !== "undefined" ? window.yoDesktop?.updates : undefined;
}

/**
 * What's waiting for the user's decision, if anything. A restart wins (a downloaded Yo.app and/or a published
 * server update; restarting also loads the new UI), then a reload for a server deploy, then a public build's
 * manual download.
 */
export type Offer = "restart" | "refresh" | "download";

export function pickOffer(input: {
  refresh: boolean;
  desktop: DesktopUpdateState | null;
  serverPending: boolean;
}): Offer | null {
  if (input.desktop?.status === "downloaded" || input.serverPending) return "restart";
  if (input.refresh) return "refresh";
  if (isGithubDownload(input.desktop)) return "download";
  return null;
}

/**
 * The one small notice next to the update button (floating on phones). Only one shows at a time, and none while
 * the update window is open: the window says it all then.
 *   ready     an update the user hasn't put off with Later ("Update ready")
 *   updating  an update this window didn't start, or one whose window was hidden ("Updating Yo…")
 *   failed    a server update that didn't finish, until OK
 *   done      "Updated to Yo 2.0.N · What's new", right after an update
 */
export type NoticeKind = "ready" | "updating" | "failed" | "done";

export function pickNotice(input: {
  dialogOpen: boolean;
  applying: boolean;
  failed: boolean;
  done: boolean;
  offer: Offer | null;
  /** Later on the current offer. */
  dismissed: boolean;
}): NoticeKind | null {
  if (input.dialogOpen) return null;
  if (input.applying) return "updating";
  if (input.failed) return "failed";
  if (input.done) return "done";
  if (input.offer && !input.dismissed) return "ready";
  return null;
}

/**
 * Steps of an update being applied, as far as this window can see them:
 *   server  save (the updater backs up while core still answers) → install (core is down for the swap) →
 *           start (core answers again; the updater checks it's healthy, maybe restarts the browser) → done
 *   app     close: Yo.app quits, installs and opens again; this window only sees the start of it
 *   web     a reload
 * `app` also follows a server update when a Yo.app was downloaded too (one Restart does both).
 */
export type ApplyPhase = "save" | "install" | "start" | "app" | "close" | "reload" | "done";

export interface ApplyStep {
  id: string;
  label: string;
  /** A line under the step while it's the current one. */
  detail?: string;
  state: "done" | "active" | "todo";
}

export function applySteps(a: {
  kind: "server" | "app" | "web";
  phase: ApplyPhase;
  restartsComputer?: boolean;
  alsoApp?: boolean;
}): ApplyStep[] {
  const list: Omit<ApplyStep, "state">[] =
    a.kind === "server"
      ? [
          {
            id: "save",
            label: "Saving a backup",
            detail: "Your chats and settings, in case anything goes wrong.",
          },
          { id: "install", label: "Installing the update", detail: "Yo is offline for this part." },
          {
            id: "start",
            label: a.restartsComputer ? "Starting Yo and its browser" : "Starting Yo",
            detail: "Checking that everything works.",
          },
          ...(a.alsoApp ? [{ id: "app", label: "Restarting the Yo app" }] : []),
        ]
      : a.kind === "app"
        ? [
            { id: "close", label: "Closing Yo" },
            { id: "install", label: "Installing the update" },
            { id: "open", label: "Opening Yo again" },
          ]
        : [{ id: "reload", label: "Loading the new version" }];
  const at = a.phase === "done" ? list.length : list.findIndex((s) => s.id === a.phase);
  return list.map((s, i) => ({
    ...s,
    detail: i === at ? s.detail : undefined,
    state: i < at ? "done" : i === at ? "active" : "todo",
  }));
}

/** How long an update usually takes, in words, and when to say it's taking longer than usual. */
export function applyEstimate(a: { kind: "server" | "app" | "web"; restartsComputer?: boolean }) {
  if (a.kind === "server")
    return a.restartsComputer
      ? { text: "Usually 1–2 minutes", slowAfterMs: 3 * 60_000 }
      : { text: "Usually about a minute", slowAfterMs: 2 * 60_000 };
  if (a.kind === "app") return { text: "Usually about 10 seconds", slowAfterMs: 30_000 };
  return { text: "A second or two", slowAfterMs: 15_000 };
}

/** "0:42", "3:05". */
export function elapsedText(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * What to do after a server update didn't finish, from the updater's own words: only a failed rollback ("the PC
 * needs a look") leaves anything for the user to do.
 */
export function failureAdvice(message: string): string {
  return /needs a look/i.test(message)
    ? "Restart the PC that runs Yo, then open Yo again. Your chats are saved."
    : "Nothing to do now: Yo works as before.";
}

/** Status line for Settings → About. */
export function desktopStatusText(d: DesktopUpdateState, now = Date.now()): string {
  switch (d.status) {
    case "disabled":
      return "Updates are off in development builds.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return isGithubDownload(d)
        ? `Yo ${d.availableVersion} is out. Download it, quit Yo (⌘Q), then drag the new Yo into Applications.`
        : `Yo ${d.availableVersion} is available.`;
    case "downloading":
      return `Downloading Yo ${d.availableVersion}… ${Math.round(d.percent ?? 0)}%`;
    case "downloaded":
      return `Yo ${d.downloadedVersion} is ready. Restart to update.`;
    case "error":
      return d.message ?? "Couldn't check for updates.";
    case "up-to-date":
      return d.checkedAt ? `Up to date · checked ${ago(d.checkedAt, now)}` : "Up to date";
    default:
      return d.message ?? ""; // idle: a check that got no answer says so (github channel)
  }
}

function ago(t: number, now: number) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
