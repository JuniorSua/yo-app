/**
 * The "Starting Yo…" page (static/starting.html) and its Keychain explanation (#74).
 *
 * Yo's saved login (controller keys, Mac pairing) is encrypted with Electron safeStorage, whose key is the
 * "Yo Safe Storage" item in the macOS Keychain. Public builds are ad-hoc signed, so every manual update has a
 * new signature and macOS asks again for the login password the first time the new build reads that item.
 * The read is synchronous on Electron's main thread, so main shows this page and lets it paint first.
 *
 *  - "now"   the explanation shows right away: a public build launched for the first time after an update,
 *            with a saved login to unlock (the case that prompts).
 *  - "later" a softer "If macOS asks…" line appears after a second, only if the page is still up.
 *  - "off"   just "Starting Yo…": not a Mac, or a signed build (stable signature, no prompt).
 */
import fs from "node:fs";
import path from "node:path";

export type KeychainHint = "now" | "later" | "off";

/** Files encrypted with the safeStorage key; any of them means the Keychain item exists. */
const SAVED_LOGIN_FILES = ["controller.bin", "device-pairing.bin", "device-state.bin"];
/** The app version that last signed in (plain text in the app's data folder). */
const LAST_VERSION_FILE = "last-signed-in-version";

export function keychainHint(o: {
  platform: string;
  channel: "feed" | "github";
  version: string;
  lastVersion: string | null;
  hasSavedLogin: boolean;
}): KeychainHint {
  if (o.platform !== "darwin" || o.channel !== "github") return "off";
  return o.hasSavedLogin && o.lastVersion !== o.version ? "now" : "later";
}

/** Reads what `keychainHint` needs from the app's data folder (no Keychain access). */
export function readKeychainState(userData: string) {
  let lastVersion: string | null = null;
  try {
    lastVersion = fs.readFileSync(path.join(userData, LAST_VERSION_FILE), "utf8").trim() || null;
  } catch {
    /* never signed in with this feature */
  }
  const hasSavedLogin = SAVED_LOGIN_FILES.some((f) => fs.existsSync(path.join(userData, f)));
  return { lastVersion, hasSavedLogin };
}

/** Call after a sign-in that read the saved login: this version's signature has been allowed. */
export function rememberSignedInVersion(userData: string, version: string) {
  try {
    fs.writeFileSync(path.join(userData, LAST_VERSION_FILE), `${version}\n`);
  } catch {
    /* only a hint */
  }
}
