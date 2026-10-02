/**
 * Seed an account's CODEX_HOME with the dedicated ChatGPT login the user made for Yo on their own machine
 * (the "Connect your model" walkthrough; core sends it as `codexAuthJson`).
 *
 * ChatGPT refresh tokens rotate: once Codex here refreshes the login, the copy core holds is spent. So the
 * seed is written ONCE, and never over a login Codex already has:
 *  - no `auth.json` yet                      -> write the seed
 *  - `auth.json` from this same seed         -> keep it (Codex may have refreshed it since)
 *  - `auth.json` from a sign-in made here    -> keep it (device-code sign-in inside Yo's computer)
 *  - `auth.json` from an OLDER seed, and core now sends a different one (the user connected again)
 *                                            -> replace it
 * A marker file remembers which seed (by hash) was written last.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SEED_MARKER = ".yo-seeded-auth";

export type SeedResult = "seeded" | "replaced" | "kept";

export interface SeedFs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: "utf8"): string;
  writeFileSync(p: string, data: string, opts: { mode: number }): void;
  renameSync(from: string, to: string): void;
  mkdirSync(p: string, opts: { recursive: true; mode: number }): unknown;
}

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");

export function seedCodexAuth(codexHome: string, authJson: string, fsImpl: SeedFs = fs): SeedResult {
  const auth = path.join(codexHome, "auth.json");
  const marker = path.join(codexHome, SEED_MARKER);
  const hash = hashOf(authJson);
  let result: SeedResult = "seeded";
  if (fsImpl.existsSync(auth)) {
    const last = fsImpl.existsSync(marker) ? fsImpl.readFileSync(marker, "utf8").trim() : null;
    // A login Codex made or refreshed here, or this same seed: never overwrite it.
    if (!last || last === hash) return "kept";
    result = "replaced";
  }
  fsImpl.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  // Atomic: Codex must never read a half-written file.
  const tmp = `${auth}.yo-tmp`;
  fsImpl.writeFileSync(tmp, authJson, { mode: 0o600 });
  fsImpl.renameSync(tmp, auth);
  fsImpl.writeFileSync(marker, `${hash}\n`, { mode: 0o600 });
  return result;
}
