/**
 * Keep the agent's browser session across Chromium restarts (hibernate, container restart, Yo update).
 *
 * Chromium persists logins (cookies) in the profile already. Open tabs and session-only cookies survive
 * only when the profile's startup mode is "continue where you left off" (restore_on_startup = 1), so we
 * set that before every launch, and mark the last exit as clean so no "restore pages?" prompt appears.
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESTORE_LAST_SESSION = 1;

/** Returns true when the profile has a saved session to reopen. Never throws. */
export function prepareSessionRestore(profileDir: string): boolean {
  const defaultDir = path.join(profileDir, "Default");
  const prefsFile = path.join(defaultDir, "Preferences");
  try {
    if (existsSync(prefsFile)) {
      const prefs = JSON.parse(readFileSync(prefsFile, "utf8")) as Record<string, any>;
      prefs.session = { ...(prefs.session ?? {}), restore_on_startup: RESTORE_LAST_SESSION };
      prefs.profile = { ...(prefs.profile ?? {}), exit_type: "Normal", exited_cleanly: true };
      const tmp = `${prefsFile}.yo-tmp`;
      writeFileSync(tmp, JSON.stringify(prefs));
      renameSync(tmp, prefsFile);
    }
  } catch {
    // A corrupt Preferences file is Chromium's to repair; we just don't touch it.
  }
  return hasSavedSession(defaultDir);
}

function hasSavedSession(defaultDir: string): boolean {
  try {
    const sessions = path.join(defaultDir, "Sessions");
    return readdirSync(sessions).some((f) => f.startsWith("Session_") || f.startsWith("Tabs_"));
  } catch {
    return false;
  }
}

/**
 * One-shot carry-over prepared before an update (the deploy tooling's `save-browser` step writes it):
 * `<profile>/.yo-restore.json` = { cookies: CDP session cookies, tabs: urls }. Chromium older than the
 * RestoreOnStartup policy drops session-only cookies on exit, so we put them back, reload the restored
 * tabs so they pick the cookies up, and reopen any saved tab that didn't come back. The file holds login
 * cookies, so it lives next to Chromium's own cookie store and is deleted as soon as it's applied.
 */
export const RESTORE_FILE = ".yo-restore.json";

export interface PendingRestore {
  cookies: Record<string, unknown>[];
  tabs: string[];
}

export function readPendingRestore(profileDir: string): PendingRestore | null {
  const file = path.join(profileDir, RESTORE_FILE);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PendingRestore>;
    return {
      cookies: Array.isArray(raw.cookies)
        ? raw.cookies.filter((c) => c && typeof c === "object").slice(0, 5000)
        : [],
      tabs: Array.isArray(raw.tabs)
        ? raw.tabs.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 100)
        : [],
    };
  } catch {
    return null;
  }
}

/** Saved tabs that aren't open now (multiset difference, so duplicates are kept). */
export function missingTabs(saved: string[], open: string[]): string[] {
  const left = [...open];
  const out: string[] = [];
  for (const url of saved) {
    const i = left.indexOf(url);
    if (i >= 0) left.splice(i, 1);
    else out.push(url);
  }
  return out;
}

/** CDP cookie (from Storage.getCookies) -> CookieParam (for Storage.setCookies). */
export function toCookieParam(c: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof c.name !== "string" || typeof c.value !== "string" || typeof c.domain !== "string") return null;
  const p: Record<string, unknown> = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: typeof c.path === "string" ? c.path : "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  if (typeof c.sameSite === "string") p.sameSite = c.sameSite;
  if (typeof c.expires === "number" && c.expires > 0 && !c.session) p.expires = c.expires;
  if (typeof c.priority === "string") p.priority = c.priority;
  if (typeof c.sourceScheme === "string") p.sourceScheme = c.sourceScheme;
  if (c.partitionKey && typeof c.partitionKey === "object") p.partitionKey = c.partitionKey;
  return p;
}
