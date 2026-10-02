/**
 * The "github" update channel (public, ad-hoc signed builds): is the newest GitHub Release of the public repo
 * newer than this app? Electron-free so it can be unit tested; src/updates.ts does the request and feeds the
 * result to the state machine (updateState.ts).
 *
 * GitHub allows 60 unauthenticated API requests an hour per IP, so the app checks at startup and every few
 * hours, and failures (offline, rate limit, no release yet) are quiet: nothing for the user to fix.
 */
import { compareVersions } from "../scripts/feed.mjs";

/** Checks in the background this often (plus at startup and when the user asks). */
export const GITHUB_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A click on "Check for updates" within this long of the last request reuses its answer. */
export const GITHUB_MIN_CHECK_GAP_MS = 60 * 1000;

export function latestReleaseApiUrl(repo: string) {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

export type GithubCheck =
  /** A newer release: offer "Download" (opens `url`, the release page). */
  | { kind: "newer"; version: string; url: string }
  /** Nothing newer (or no release published yet). */
  | { kind: "none" }
  /** Couldn't tell (offline, rate limited, odd answer): keep what we knew and try again later. */
  | { kind: "quiet"; reason: string };

/** "v0.1.313" or "0.1.313" -> "0.1.313"; anything else -> null. */
export function releaseVersion(tag: unknown): string | null {
  return typeof tag === "string" ? (/^v?(\d+\.\d+\.\d+)$/.exec(tag.trim())?.[1] ?? null) : null;
}

/** True only for an https://github.com/<repo>/releases/... page (what Download may open). */
export function isReleasePageUrl(url: unknown, repo: string): url is string {
  if (typeof url !== "string") return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.port || u.username || u.password)
    return false;
  const prefix = `/${repo}/releases/`.toLowerCase();
  return u.pathname.toLowerCase().startsWith(prefix) && !u.pathname.includes("..");
}

/** Interprets GET /repos/<repo>/releases/latest (`status` 0 = the request itself failed). */
export function readLatestRelease(
  status: number,
  body: unknown,
  currentVersion: string,
  repo: string,
): GithubCheck {
  if (status === 404) return { kind: "none" }; // no published release yet (drafts and pre-releases don't count)
  if (status === 403 || status === 429) return { kind: "quiet", reason: `rate limited (${status})` };
  if (status !== 200) return { kind: "quiet", reason: status ? `HTTP ${status}` : "offline" };
  const r = (body ?? {}) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (r.draft === true || r.prerelease === true) return { kind: "none" };
  const version = releaseVersion(r.tag_name);
  if (!version) return { kind: "quiet", reason: `unexpected tag ${JSON.stringify(r.tag_name)}` };
  if (compareVersions(version, currentVersion) <= 0) return { kind: "none" };
  if (!isReleasePageUrl(r.html_url, repo)) return { kind: "quiet", reason: "unexpected release URL" };
  return { kind: "newer", version, url: r.html_url };
}
