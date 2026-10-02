// Yo.app's update channel, chosen when the app is built (build.mjs bakes it in) and never at runtime.
//
//   YO_UPDATE_CHANNEL=feed    the owner's signed builds: electron-updater + Squirrel.Mac from the feed core
//                             serves (/api/updates/desktop). "Restart to update". `pnpm app:build`,
//                             `pnpm app:package`, `pnpm app:publish` and `release.py publish-app` set this.
//   YO_UPDATE_CHANNEL=github  public, ad-hoc signed builds: look at the newest GitHub Release of
//                             YO_UPDATE_REPO (default JuniorSua/yo-app) and offer "Download" (opens the
//                             release page). Squirrel can't install ad-hoc signed builds, so nothing downloads.
//
// Unset: "github" in a public snapshot (it has a VERSION file, see scripts/build-info.mjs), "feed" here. So a
// stranger's build from the public source follows the public releases, and the owner's builds from this repo
// stay on the feed even if a script forgets to say so.
//
// Public builds also run the agent's computer from a published image instead of building it from a source
// checkout the downloaded app doesn't have: ghcr.io/<repo owner>/yo-computer:<app version>.
// YO_COMPUTER_IMAGE_REPO overrides that repository; set it empty to keep building locally.

export const DEFAULT_UPDATE_REPO = "JuniorSua/yo-app";

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** registry/path/name, lowercase, no tag (the app adds its own version). */
const IMAGE_RE = /^[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ publicSnapshot: boolean }} where
 */
export function resolveUpdateChannel(env, { publicSnapshot }) {
  const raw = env.YO_UPDATE_CHANNEL?.trim() || (publicSnapshot ? "github" : "feed");
  if (raw !== "github" && raw !== "feed")
    throw new Error(`YO_UPDATE_CHANNEL must be "github" or "feed", not "${raw}"`);
  const repo = env.YO_UPDATE_REPO?.trim() || DEFAULT_UPDATE_REPO;
  if (!REPO_RE.test(repo)) throw new Error(`YO_UPDATE_REPO must look like owner/name, not "${repo}"`);

  let computerImageRepo = null;
  if (env.YO_COMPUTER_IMAGE_REPO !== undefined) computerImageRepo = env.YO_COMPUTER_IMAGE_REPO.trim() || null;
  else if (raw === "github") computerImageRepo = `ghcr.io/${repo.split("/")[0].toLowerCase()}/yo-computer`;
  if (computerImageRepo && !IMAGE_RE.test(computerImageRepo))
    throw new Error(`YO_COMPUTER_IMAGE_REPO must be an image name without a tag, not "${computerImageRepo}"`);

  return { channel: raw, repo, computerImageRepo };
}
