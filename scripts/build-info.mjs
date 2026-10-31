// Build identity shared by the core, web and desktop builds (the update flow compares them).
//  - build id   "<commit count>-<short sha>", baked into core and web. When the server's differs from the
//               page's, the open UI offers a Refresh.
//  - app version "2.0.<commit count>" for Yo.app, so every build from main is newer than the last one
//               without version-bump commits. electron-updater compares these. Yo 2 moved the prefix from 0.1
//               to 2.0; every comparison is numeric, so 2.0.N is newer than any 0.1.N.
// YO_BUILD_ID / YO_APP_VERSION override them (tests, rebuilding an older commit on purpose).
//
// Public snapshots (the public repo, one commit per publish) can't use their commit count. They carry a
// VERSION file at the root instead ("2.0.<count>" of this repo), which wins over the count. Its presence
// also makes desktop builds default to the GitHub Releases update channel (apps/desktop/scripts/channel.mjs).
// This (private) repo never has a VERSION file.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Number of commits on HEAD, or null outside a git checkout. */
export function commitCount() {
  const n = Number(git("rev-list", "--count", "HEAD"));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** "<count>-<sha>", or null when unknown (then the refresh check stays off). */
export function buildId() {
  if (process.env.YO_BUILD_ID) return process.env.YO_BUILD_ID;
  const count = commitCount();
  const sha = git("rev-parse", "--short=7", "HEAD");
  return count && sha ? `${count}-${sha}` : null;
}

/** "2.0.<commit count>": the release number for a commit (Yo.app, the public snapshot and its GitHub Release). */
export function versionFor(count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`bad commit count ${count}`);
  return `2.0.${count}`;
}

/** The public snapshot's version from the root VERSION file ("2.0.950"), or null when there is none. */
export function snapshotVersion(root = repoRoot) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, "VERSION"), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  const v = raw.trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`VERSION must look like 2.0.950, not ${JSON.stringify(v)}`);
  return v;
}

/** Yo.app version: $YO_APP_VERSION, else the VERSION file, else "2.0.<count>", else `fallback` (package.json's). */
export function appVersion(fallback = "0.1.0") {
  if (process.env.YO_APP_VERSION) return process.env.YO_APP_VERSION;
  const snapshot = snapshotVersion();
  if (snapshot) return snapshot;
  const count = commitCount();
  return count ? versionFor(count) : fallback;
}
