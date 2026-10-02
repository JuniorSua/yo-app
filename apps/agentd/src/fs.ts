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

/** Largest file accepted from the user's Mac (core enforces the same limit). */
export const MAX_INCOMING_BYTES = 20 * 1024 * 1024;

/**
 * Save a file the user shared from their Mac into the agent's home under ~/<dir>/ without overwriting:
 * "report.xlsx", then "report (2).xlsx", ... Returns the home-relative path ("~/from-mac/report.xlsx").
 */
export async function saveIncoming(
  agentId: string,
  dir: "from-mac",
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
