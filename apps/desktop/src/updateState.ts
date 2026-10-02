/**
 * Yo.app's update state machine, Electron-free so it can be unit tested. The main process feeds it
 * electron-updater / Squirrel.Mac events (feed channel) or GitHub Releases checks (github channel) and pushes the
 * result to the UI (mirrored in apps/web/src/lib/updates.ts).
 *
 *   disabled                       unpackaged builds (development)
 *   idle → checking → up-to-date   nothing newer in the feed (or nothing published yet)
 *            ↓
 *        available → downloading (%) → downloaded      "Restart to update"
 *            ↑            ↓
 *            └── error (canRetry) ←┘
 *
 * The github channel (public, ad-hoc signed builds) never downloads: "available" carries the release page
 * (`releaseUrl`) and the UI offers Download, which opens it. A check that can't reach GitHub (offline, rate
 * limited) is "quiet": it goes back to what was known, with a note, instead of an error.
 */

/** Built into the app (apps/desktop/scripts/channel.mjs). */
export type UpdateChannel = "feed" | "github";

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  channel: UpdateChannel;
  currentVersion: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  /** 0–100 while downloading. */
  percent: number | null;
  checkedAt: number | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
  /** github channel: the release page Download opens (validated in the main process before opening). */
  releaseUrl: string | null;
}

export type UpdateEvent =
  | { type: "check"; at: number }
  | { type: "none"; at: number }
  | { type: "available"; version: string; at: number; url?: string }
  /** The check couldn't get an answer, and that's nothing for the user to fix (github channel). */
  | { type: "quiet"; message: string }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; message: string }
  | { type: "install-failed"; message: string };

export function initialUpdateState(
  currentVersion: string,
  enabled: boolean,
  channel: UpdateChannel = "feed",
): DesktopUpdateState {
  return {
    status: enabled ? "idle" : "disabled",
    channel,
    currentVersion,
    availableVersion: null,
    downloadedVersion: null,
    percent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
    releaseUrl: null,
  };
}

export function reduceUpdate(s: DesktopUpdateState, e: UpdateEvent): DesktopUpdateState {
  if (s.status === "disabled") return s;
  // Once a build is downloaded it stays ready: later checks can't take the Restart away.
  const ready = s.downloadedVersion !== null;
  switch (e.type) {
    case "check":
      if (ready || s.status === "downloading") return { ...s, checkedAt: e.at };
      return {
        ...s,
        status: "checking",
        checkedAt: e.at,
        message: null,
        errorContext: null,
        canRetry: false,
      };
    case "none":
      if (ready) return { ...s, checkedAt: e.at };
      return {
        ...s,
        status: "up-to-date",
        availableVersion: null,
        releaseUrl: null,
        percent: null,
        checkedAt: e.at,
        message: null,
        errorContext: null,
        canRetry: false,
      };
    case "available":
      if (ready && s.downloadedVersion === e.version) return { ...s, checkedAt: e.at };
      if (s.status === "downloading" && s.availableVersion === e.version) return s;
      return {
        ...s,
        status: "available",
        availableVersion: e.version,
        releaseUrl: e.url ?? null,
        downloadedVersion: null,
        percent: null,
        checkedAt: e.at,
        message: null,
        errorContext: null,
        canRetry: false,
      };
    case "progress":
      if (ready) return s;
      return {
        ...s,
        status: "downloading",
        percent: Math.max(0, Math.min(100, e.percent)),
        message: null,
        errorContext: null,
        canRetry: false,
      };
    case "downloaded":
      return {
        ...s,
        status: "downloaded",
        availableVersion: e.version,
        downloadedVersion: e.version,
        percent: 100,
        message: null,
        errorContext: null,
        canRetry: true,
      };
    case "error": {
      if (ready) return s; // a failed re-check doesn't matter: the downloaded build is still installable
      const downloading = s.status === "downloading" || s.status === "available";
      if (downloading && s.availableVersion)
        return {
          ...s,
          status: "error",
          percent: null,
          message: e.message,
          errorContext: "download",
          canRetry: true,
        };
      return {
        ...s,
        status: "error",
        percent: null,
        message: e.message,
        errorContext: "check",
        canRetry: true,
      };
    }
    case "quiet":
      if (ready || s.status !== "checking") return s;
      // A release found earlier is still worth offering; otherwise say why there's no answer yet.
      if (s.availableVersion) return { ...s, status: "available", message: null };
      return { ...s, status: "idle", message: e.message, errorContext: null, canRetry: true };
    case "install-failed":
      return { ...s, status: "error", message: e.message, errorContext: "install", canRetry: true };
  }
}

/** Short, human error text: electron-updater errors carry stack traces and whole responses. */
export function friendlyUpdateError(err: unknown): string {
  const raw = String((err as { message?: string })?.message ?? err ?? "");
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|net::ERR_|socket hang up|ECONNRESET/i.test(raw))
    return "Couldn't reach Yo to check for updates.";
  if (/\b401\b|\b403\b/.test(raw)) return "Yo isn't signed in yet; it will try again shortly.";
  if (/sha512 checksum mismatch/i.test(raw)) return "The download was damaged. Try again.";
  if (/code signature|designated requirement|signature/i.test(raw))
    return "This update isn't signed like the installed Yo, so macOS refused it.";
  const first = raw.split("\n")[0]!.trim();
  return first.length > 160 ? `${first.slice(0, 157)}…` : first || "Update failed.";
}

/** True for "the feed has nothing yet" (no latest-mac.yml published): not an error for the user. */
export function isNothingPublished(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return (
    e?.code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" || /\b404\b.*latest-mac\.yml/s.test(String(e?.message))
  );
}
