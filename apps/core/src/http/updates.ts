/**
 * What changed since the UI loaded, and the private feed new Yo.app builds come from.
 *
 *  GET /api/version                  { build, web, desktop, server } — the UI compares `web` (falling back to
 *                                    `build`) with its own build id and offers a Refresh when they differ.
 *                                    `desktop` carries the feed's "What's new", shown before Restart. `server`
 *                                    is a published server update waiting for the user's Restart (below).
 *                                    `release` is a newer GitHub release for the PC edition (./releaseCheck).
 *  GET /api/updates/desktop/<file>   electron-updater's generic feed: latest-mac.yml and the signed zips,
 *                                    from `<dataDir>/updates/desktop/` (written by `release.py publish-app`).
 *
 * Both sit under /api/, so they need a signed-in controller like everything else there; Yo.app's main
 * process sends its session as a bearer token.
 *
 * Server updates (Home PC): `release.py publish-server` writes `<dataDir>/updates/server/pending.json` and restarts
 * nothing. The user's "Restart to update" calls `update.applyServer`, which writes apply.json; the updater on the
 * host (its updater script) swaps the images, restarting this core, then writes result.json and removes the
 * other two. Core only reads pending/result and writes apply.json.
 */
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";
import { CORE_BUILD } from "../config";
import { logger } from "../log";

const log = logger("updates");

/** Only these names are ever served: no slashes, no dot-dot, nothing hidden. */
export const DESKTOP_UPDATE_FILE = /^(?:latest-mac\.yml|[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:zip|blockmap))$/;

const TYPES: Record<string, string> = {
  ".yml": "text/yaml; charset=utf-8",
  ".zip": "application/zip",
  ".blockmap": "application/octet-stream",
};

export function desktopFeedDir(dataDir: string) {
  return path.join(dataDir, "updates", "desktop");
}

export interface ServerVersion {
  /** Core's build id. */
  build: string | null;
  /** Build id of the web UI core serves (its dist/build.json), when it has one. */
  web: string | null;
  /** Newest Yo.app in the feed, if one was published, with its short "What's new" (null without one). */
  desktop: { version: string; notes: string | null } | null;
  /** A server update waiting for the user's Restart, one being applied, and how the last one went. */
  server: ServerUpdate;
  /** PC edition: the newest Yo release when it's newer than this core (`yo-app update` installs it), else null. */
  release: { version: string; url: string } | null;
}

export interface ServerUpdate {
  /** Published and not applied yet (null when there is none, or it's the build core already runs). */
  pending: { rev: string; notes: string | null; restartsComputer: boolean } | null;
  /** Someone pressed Restart and the updater hasn't finished yet. */
  applying: boolean;
  /** The updater's report on the last update it applied (absent before the first). */
  lastResult?: { rev: string | null; ok: boolean; message: string; finishedAt: number };
}

export function serverUpdateDir(dataDir: string) {
  return path.join(dataDir, "updates", "server");
}

const REV = /^[0-9a-f]{7,40}$/;
const IMAGE = /^yo-(core|computer):pc-([0-9a-f]{7,40})$/;
/** An apply request nobody picked up in this long (no updater installed) stops counting as "applying". */
export const APPLY_STALE_MS = 15 * 60_000;

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The published update as release.py writes it, or null when missing or malformed. */
function readPending(dataDir: string) {
  const p = readJson(path.join(serverUpdateDir(dataDir), "pending.json"));
  if (!p || typeof p.rev !== "string" || !REV.test(p.rev)) return null;
  const core = typeof p.coreImage === "string" ? IMAGE.exec(p.coreImage) : null;
  if (core?.[1] !== "core") return null;
  const computer = typeof p.computerImage === "string" ? IMAGE.exec(p.computerImage) : null;
  if (p.computerImage != null && computer?.[1] !== "computer") return null;
  const notes =
    typeof p.notes === "string" && p.notes.trim() ? p.notes.trim().slice(0, MAX_RELEASE_NOTES) : null;
  return { rev: p.rev, coreRev: core[2]!, notes, restartsComputer: !!computer };
}

/** Core's build id is "<count>-<sha7>": the same commit when that sha starts the release's. */
function isRunning(coreRev: string, build: string | null) {
  const sha = build?.split("-").pop();
  return !!sha && sha.length >= 7 && coreRev.startsWith(sha);
}

export function readServerUpdate(
  dataDir: string,
  build: string | null = CORE_BUILD,
  now = Date.now(),
): ServerUpdate {
  const dir = serverUpdateDir(dataDir);
  const p = readPending(dataDir);
  // Already running it (swapped by hand, say): nothing to offer. A computer-only update still is one.
  const pending =
    p && !(isRunning(p.coreRev, build) && !p.restartsComputer)
      ? { rev: p.rev, notes: p.notes, restartsComputer: p.restartsComputer }
      : null;
  const apply = readJson(path.join(dir, "apply.json"));
  const requestedAt = typeof apply?.requestedAt === "number" ? apply.requestedAt : 0;
  const r = readJson(path.join(dir, "result.json"));
  const lastResult =
    r && typeof r.ok === "boolean" && typeof r.finishedAt === "number"
      ? {
          rev: typeof r.rev === "string" ? r.rev : null,
          ok: r.ok,
          message: typeof r.message === "string" ? r.message.slice(0, 300) : "",
          finishedAt: r.finishedAt,
        }
      : undefined;
  return {
    pending,
    applying: !!apply && now - requestedAt < APPLY_STALE_MS,
    ...(lastResult ? { lastResult } : {}),
  };
}

/**
 * update.applyServer: ask the host's updater to apply the published update now. Refuses anything but the pending
 * rev. Written atomically (tmp + rename) so the updater never reads half a request.
 */
export function requestServerUpdate(dataDir: string, rev: unknown, build: string | null = CORE_BUILD) {
  if (typeof rev !== "string" || !REV.test(rev)) throw new Error("That isn't an update Yo knows about.");
  const s = readServerUpdate(dataDir, build);
  if (!s.pending || s.pending.rev !== rev)
    throw new Error("That update isn't available anymore. Check for updates again.");
  if (s.applying) return;
  const dir = serverUpdateDir(dataDir);
  const tmp = path.join(dir, `.apply-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify({ rev, requestedAt: Date.now() })}\n`, { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, "apply.json"));
  log.info(`server update ${rev} requested: the updater applies it and restarts core`);
}

/** Same limit publish-app writes with (apps/desktop/scripts/feed.mjs). */
const MAX_RELEASE_NOTES = 600;

function readWebBuild(webDist: string | null): string | null {
  if (!webDist) return null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(webDist, "build.json"), "utf8")) as { build?: unknown };
    return typeof v.build === "string" ? v.build : null;
  } catch {
    return null;
  }
}

function readFeed(dataDir: string): ServerVersion["desktop"] {
  let yml: string;
  try {
    yml = fs.readFileSync(path.join(desktopFeedDir(dataDir), "latest-mac.yml"), "utf8");
  } catch {
    return null;
  }
  const version = /^version:\s*['"]?([0-9A-Za-z.+-]+)['"]?\s*$/m.exec(yml)?.[1];
  return version ? { version, notes: readNotes(yml) } : null;
}

/** publish-app writes `releaseNotes: "<JSON string>"` on one line; anything else reads as no notes. */
function readNotes(yml: string): string | null {
  const raw = /^releaseNotes:\s*(".*")\s*$/m.exec(yml)?.[1];
  if (!raw) return null;
  try {
    const notes = JSON.parse(raw) as unknown;
    return typeof notes === "string" && notes.trim() ? notes.trim().slice(0, MAX_RELEASE_NOTES) : null;
  } catch {
    return null;
  }
}

export function serverVersion(
  cfg: { dataDir: string; webDist: string | null },
  release: ServerVersion["release"] = null,
): ServerVersion {
  return {
    build: CORE_BUILD,
    web: readWebBuild(cfg.webDist),
    desktop: readFeed(cfg.dataDir),
    server: readServerUpdate(cfg.dataDir),
    release,
  };
}

/** Stream one feed file, or 404. `name` is the already-decoded last path segment. */
export function serveDesktopUpdate(dataDir: string, name: string, res: http.ServerResponse) {
  if (!DESKTOP_UPDATE_FILE.test(name) || name.includes("..")) {
    res.writeHead(404).end("not found");
    return;
  }
  const file = path.join(desktopFeedDir(dataDir), name);
  let size: number;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[path.extname(name)] ?? "application/octet-stream",
    "content-length": String(size),
    // The feed file changes in place; the zips are versioned by name.
    "cache-control": name.endsWith(".yml") ? "no-store" : "private, max-age=86400",
    "x-content-type-options": "nosniff",
  });
  // pipeline closes the file when the download is aborted, and a read error (the file pruned by a publish
  // mid-download) just ends this response instead of crashing core.
  pipeline(fs.createReadStream(file), res, () => {});
}
