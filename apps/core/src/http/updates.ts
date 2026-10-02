/**
 * What changed since the UI loaded, and the private feed new Yo.app builds come from.
 *
 *  GET /api/version                  { build, web, desktop } — the UI compares `web` (falling back to `build`)
 *                                    with its own build id and offers a Refresh when they differ.
 *  GET /api/updates/desktop/<file>   electron-updater's generic feed: latest-mac.yml and the signed zips,
 *                                    from `<dataDir>/updates/desktop/` (written by `release.py publish-app`).
 *
 * Both sit under /api/, so they need a signed-in controller like everything else there; Yo.app's main
 * process sends its session as a bearer token.
 */
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";
import { CORE_BUILD } from "../config";

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
  /** Newest Yo.app in the feed, if one was published. */
  desktop: { version: string } | null;
}

function readWebBuild(webDist: string | null): string | null {
  if (!webDist) return null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(webDist, "build.json"), "utf8")) as { build?: unknown };
    return typeof v.build === "string" ? v.build : null;
  } catch {
    return null;
  }
}

function readFeedVersion(dataDir: string): string | null {
  try {
    const yml = fs.readFileSync(path.join(desktopFeedDir(dataDir), "latest-mac.yml"), "utf8");
    return /^version:\s*['"]?([0-9A-Za-z.+-]+)['"]?\s*$/m.exec(yml)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function serverVersion(cfg: { dataDir: string; webDist: string | null }): ServerVersion {
  const desktop = readFeedVersion(cfg.dataDir);
  return {
    build: CORE_BUILD,
    web: readWebBuild(cfg.webDist),
    desktop: desktop ? { version: desktop } : null,
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
