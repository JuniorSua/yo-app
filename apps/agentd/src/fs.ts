/** File browsing confined to an agent's home (and the shared folder). */
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { FsEntry } from "@yo/contracts";
import { assertSafeId, paths } from "./config";

export class PathError extends Error {
  code = "EACCES_CONFINED";
}

export function allowedRoots(agentId: string): string[] {
  assertSafeId(agentId, "agentId");
  return [paths.agentHome(agentId), paths.sharedDir()];
}

export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve a user-supplied path lexically. Relative paths (and "", ".", "~") are relative to the agent
 * home; "~/x" too. Absolute paths must be inside an allowed root. Throws PathError otherwise.
 */
export function resolveConfined(agentId: string, input: string): string {
  const roots = allowedRoots(agentId);
  const home = roots[0]!;
  if (input.includes("\0")) throw new PathError("invalid path");
  let p = input.trim();
  if (p === "" || p === "~") p = ".";
  if (p.startsWith("~/")) p = p.slice(2);
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(home, p);
  if (!roots.some((r) => isWithin(r, abs))) throw new PathError(`path outside agent home: ${input}`);
  return abs;
}

/** Lexical check + symlink-safe check via realpath (target must exist). */
export async function resolveConfinedReal(agentId: string, input: string): Promise<string> {
  const abs = resolveConfined(agentId, input);
  const real = await fsp.realpath(abs);
  const realRoots = await Promise.all(allowedRoots(agentId).map((r) => fsp.realpath(r).catch(() => r)));
  if (!realRoots.some((r) => isWithin(r, real))) throw new PathError(`path escapes agent home: ${input}`);
  return real;
}

export async function ensureAgentHome(agentId: string): Promise<string> {
  const home = paths.agentHome(assertSafeId(agentId, "agentId"));
  await fsp.mkdir(home, { recursive: true, mode: 0o755 });
  await fsp.mkdir(paths.sharedDir(), { recursive: true, mode: 0o755 });
  // ~/Shared: the folder every agent on this computer sees (files for teammates, the browser's downloads).
  await fsp.symlink(paths.sharedDir(), path.join(home, "Shared")).catch(() => undefined);
  return home;
}

export async function listDir(agentId: string, input: string): Promise<FsEntry[]> {
  await ensureAgentHome(agentId);
  const dir = await resolveConfinedReal(agentId, input);
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const out: FsEntry[] = [];
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    try {
      const st = await fsp.stat(full);
      out.push({
        name: d.name,
        path: full,
        type: st.isDirectory() ? "dir" : "file",
        size: st.isDirectory() ? 0 : st.size,
        mtime: st.mtimeMs,
      });
    } catch {
      // dangling symlink etc.
    }
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return out;
}

/** Largest file accepted from the user's Mac or the chat (core enforces the same limit). */
export const MAX_INCOMING_BYTES = 20 * 1024 * 1024;

/**
 * Save a file the user shared from their Mac (~/from-mac) or attached in the chat (~/uploads) into the agent's
 * home under ~/<dir>/ without overwriting:
 * "report.xlsx", then "report (2).xlsx", ... Returns the home-relative path ("~/from-mac/report.xlsx").
 */
export async function saveIncoming(
  agentId: string,
  dir: "from-mac" | "uploads",
  name: string,
  data: Buffer,
): Promise<string> {
  if (data.length > MAX_INCOMING_BYTES) throw new PathError("file too large");
  const home = await ensureAgentHome(agentId);
  const target = path.join(home, dir);
  await fsp.mkdir(target, { recursive: true, mode: 0o755 });
  const realTarget = await fsp.realpath(target);
  if (!isWithin(await fsp.realpath(home), realTarget))
    throw new PathError("incoming folder escapes agent home");
  const clean =
    path
      .basename(name)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 200) || "file";
  const ext = path.extname(clean);
  const stem = ext ? clean.slice(0, -ext.length) : clean;
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? clean : `${stem} (${i})${ext}`;
    try {
      // wx = O_CREAT|O_EXCL: never replaces or follows an existing entry.
      await fsp.writeFile(path.join(realTarget, candidate), data, { flag: "wx", mode: 0o644 });
      return `~/${dir}/${candidate}`;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
  throw new PathError("too many files with that name");
}

/* ------------------------- folding an agent into another ------------------------- */

/** Folders that are caches or rebuildable, wherever they are in the home. */
const CACHE_DIRS = new Set(["node_modules", "__pycache__", ".cache", ".npm", ".pnpm-store", ".venv", "venv"]);
/** One file over this is reported, not copied; the whole copy stops at MAX_COPY_BYTES. */
export const MAX_COPY_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_COPY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_COPY_FILES = 20_000;

export interface CopyHomeStats {
  dir: string;
  copied: number;
  skipped: number;
  failed: number;
  bytes: number;
}

/** "from-Pepe": a folder name that stays inside the shared folder whatever the agent was called. */
export function safeCopyDir(name: string): string {
  const clean = path
    .basename(name)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  if (!clean) throw new PathError("invalid folder name");
  return clean.slice(0, 120);
}

/**
 * Copy an agent's home into `<shared>/<toDir>/`, for when the agent is folded into the main one. Left out:
 * screenshots at the top level (`*.png`), anything hidden at the top level (app state, logins, caches),
 * cache folders anywhere, and symlinks (so `~/Shared` is never followed). A file already there with the same
 * size is skipped, a different one is replaced, so running it again finishes the job.
 */
export async function copyHomeToShared(fromAgentId: string, toDir: string): Promise<CopyHomeStats> {
  const src = paths.agentHome(assertSafeId(fromAgentId, "agentId"));
  const dir = safeCopyDir(toDir);
  const stats: CopyHomeStats = { dir, copied: 0, skipped: 0, failed: 0, bytes: 0 };
  const srcStat = await fsp.lstat(src).catch(() => null);
  if (!srcStat?.isDirectory()) return stats; // the agent never had a computer: nothing to copy
  const dest = path.join(paths.sharedDir(), dir);
  await fsp.mkdir(dest, { recursive: true, mode: 0o755 });
  if (!isWithin(await fsp.realpath(paths.sharedDir()), await fsp.realpath(dest)))
    throw new PathError("shared folder entry escapes the shared folder");
  let files = 0;

  const walk = async (from: string, to: string, top: boolean): Promise<void> => {
    const entries = await fsp.readdir(from, { withFileTypes: true });
    for (const e of entries) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isSymbolicLink()) {
        stats.skipped++;
        continue;
      }
      if (top && e.name.startsWith(".")) {
        stats.skipped++;
        continue;
      }
      if (e.isDirectory()) {
        if (CACHE_DIRS.has(e.name)) {
          stats.skipped++;
          continue;
        }
        await fsp.mkdir(b, { recursive: true, mode: 0o755 });
        await walk(a, b, false);
        continue;
      }
      if (!e.isFile()) continue;
      if (top && /\.png$/i.test(e.name)) {
        stats.skipped++;
        continue;
      }
      if (++files > MAX_COPY_FILES || stats.bytes > MAX_COPY_BYTES) {
        stats.failed++;
        continue;
      }
      try {
        const st = await fsp.stat(a);
        if (st.size > MAX_COPY_FILE_BYTES) {
          stats.failed++;
          continue;
        }
        const have = await fsp.lstat(b).catch(() => null);
        if (have?.isFile() && have.size === st.size) {
          stats.skipped++;
          continue;
        }
        if (have && !have.isFile()) {
          stats.failed++; // never write through a link or into a folder
          continue;
        }
        await fsp.copyFile(a, b);
        stats.copied++;
        stats.bytes += st.size;
      } catch {
        stats.failed++;
      }
    }
  };
  await walk(src, dest, true);
  return stats;
}
