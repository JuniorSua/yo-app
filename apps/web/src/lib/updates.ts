/**
 * "Yo was updated": the two kinds of update and which notice to show.
 *  - Server/web: core and the web UI are deployed together. When the build core serves differs from the build
 *    this page was loaded from, the page offers a Refresh. It never reloads by itself (a draft could be lost).
 *  - Yo.app: the desktop app downloads new builds in the background (electron-updater, feed served by core)
 *    and offers a Restart once one is ready. Public builds ("github" channel, ad-hoc signed) can't install
 *    updates themselves: they offer Download, which opens the new release's page on GitHub.
 */

declare const __YO_BUILD__: string | null | undefined;

/** This page's build id (baked in by `vite build`); null in the dev server, which turns the check off. */
export const WEB_BUILD: string | null = typeof __YO_BUILD__ === "string" ? __YO_BUILD__ : null;

/** Build id the mock UI pretends to be (see lib/mock/updates.ts). */
export const MOCK_BUILD = "mock-1";

/** How often to look for either kind of update. */
export const CHECK_INTERVAL_MS = 4 * 60 * 1000;

/** Mirrors `ServerVersion` in apps/core/src/http/updates.ts (GET /api/version). */
export interface ServerVersion {
  build: string | null;
  web: string | null;
  desktop: { version: string } | null;
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

export type NoticeKind = "restart" | "refresh" | "downloading" | "available" | "download" | "error";

export interface Notice {
  kind: NoticeKind;
  /** "card" asks; "pill" is the quiet reminder after Later (and for background progress or errors). */
  mode: "card" | "pill";
}

/**
 * The one notice to show. A downloaded Yo.app wins (restarting also loads the new UI), then a web refresh,
 * then download progress. Errors only show for downloads and installs: a failed background check (offline,
 * core restarting) is not worth a reminder and is visible in Settings.
 */
export function pickNotice(input: {
  refresh: boolean;
  desktop: DesktopUpdateState | null;
  dismissedRefresh: boolean;
  dismissedRestart: boolean;
}): Notice | null {
  const d = input.desktop;
  if (d?.status === "downloaded") return { kind: "restart", mode: input.dismissedRestart ? "pill" : "card" };
  if (input.refresh) return { kind: "refresh", mode: input.dismissedRefresh ? "pill" : "card" };
  if (d?.status === "downloading") return { kind: "downloading", mode: "pill" };
  if (isGithubDownload(d)) return { kind: "download", mode: "pill" };
  if (d?.status === "available" && d.canRetry) return { kind: "available", mode: "pill" };
  if (d?.status === "error" && d.errorContext !== "check") return { kind: "error", mode: "pill" };
  return null;
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
        ? `Yo ${d.availableVersion} is available. Download it from GitHub.`
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
