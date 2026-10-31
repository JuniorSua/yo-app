/**
 * Scratch files that nothing else removes. The shared browser saves every download into one staging folder
 * (cdpProxy.ts names each by its GUID and links it into the folder the agent's Playwright asked for, which
 * copies it out), so without this the folder only grows until the computer runs out of disk.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { config } from "./config";

/** Where the shared browser stages downloads (the dir SharedDesktop gives each seat's cdpProxy). */
export const downloadStagingDir = () => path.join(config.runDir, "downloads");
/** A staged download older than this has long been copied to where the agent wanted it. */
export const STAGED_DOWNLOAD_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Removes the files directly in `dir` last modified more than `maxAgeMs` ago (in-progress downloads keep
 * being written, so they stay). Returns how many went. A missing dir is fine.
 */
export async function pruneOldFiles(dir: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = await fsp.lstat(file);
      if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue;
      await fsp.rm(file, { force: true });
      removed++;
    } catch {
      // gone meanwhile
    }
  }
  return removed;
}
