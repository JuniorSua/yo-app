/**
 * "Connect your model" walkthrough, host side: what core can see on the machine it runs on, before Yo's
 * computer exists.
 *
 * - Detection only checks that files exist. It never reads, copies or returns the user's own logins
 *   (`~/.codex/auth.json`, Claude's Keychain item), never runs a CLI (no Keychain prompts), and never
 *   returns paths (they contain the user's name).
 * - Claude: the user pastes the long-lived token from `claude setup-token`; `parseClaudeToken` checks its
 *   shape and turns every mistake into a next step.
 * - Codex: the user signs in once more, into a folder only Yo uses (CODEX_YO_HOME). Copying their own
 *   `~/.codex` login would break it: ChatGPT refresh tokens rotate, so two copies of one login log each
 *   other out ("refresh token already used"). `readCodexLogin` picks that dedicated login up exactly once.
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_YO_HOME, type ConnectDetection, checkCodexAuthJson } from "@yo/contracts";

export { parseClaudeToken } from "@yo/contracts";

export interface HostFs {
  /** True when the path exists (file or folder). Never throws. */
  exists(p: string): Promise<boolean>;
  /** True when the path is an executable file. Never throws. */
  isExecutable(p: string): Promise<boolean>;
  readFile(p: string): Promise<string>;
  rm(p: string): Promise<void>;
}

export interface HostEnv {
  home: string;
  /** The PATH core was started with (often minimal for a GUI app on macOS). */
  path: string;
  platform: NodeJS.Platform;
  hostname: string;
}

export const nodeHostFs: HostFs = {
  async exists(p) {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
  async isExecutable(p) {
    try {
      const st = await fsp.stat(p);
      if (!st.isFile()) return false;
      await fsp.access(p, 1 /* X_OK */);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (p) => fsp.readFile(p, "utf8"),
  rm: (p) => fsp.rm(p, { force: true }),
};

export function nodeHostEnv(): HostEnv {
  return {
    home: os.homedir(),
    path: process.env.PATH ?? "",
    platform: process.platform,
    hostname: os.hostname(),
  };
}

/** Folders the official installers and package managers use, besides PATH. */
export function cliDirs(env: HostEnv): string[] {
  const fromPath = env.path.split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  const usual = [
    path.join(env.home, ".local", "bin"), // native installers (claude.ai/install.sh, chatgpt.com/codex/install.sh)
    path.join(env.home, ".claude", "local"), // older Claude Code "migrate-installer" location
    path.join(env.home, ".npm-global", "bin"),
    path.join(env.home, ".bun", "bin"),
    path.join(env.home, ".volta", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  return [...new Set([...fromPath, ...usual])];
}

export async function findCli(name: string, env: HostEnv, fs: HostFs): Promise<boolean> {
  for (const dir of cliDirs(env)) {
    if (await fs.isExecutable(path.join(dir, name))) return true;
  }
  return false;
}

/** Where the walkthrough's dedicated Codex login lands. */
export function codexYoHome(env: HostEnv): string {
  return path.join(env.home, ...CODEX_YO_HOME.split("/"));
}

/**
 * Claude Code keeps the account (no secrets) in `~/.claude.json` under `oauthAccount` once signed in; on
 * Linux the login itself is `~/.claude/.credentials.json`. On macOS the login is in the Keychain, which we
 * deliberately don't touch.
 */
async function claudeSignedIn(env: HostEnv, fs: HostFs): Promise<boolean | null> {
  if (await fs.exists(path.join(env.home, ".claude", ".credentials.json"))) return true;
  try {
    const raw = await fs.readFile(path.join(env.home, ".claude.json"));
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    return !!cfg.oauthAccount && typeof cfg.oauthAccount === "object";
  } catch {
    return null;
  }
}

export async function detectHost(
  env: HostEnv = nodeHostEnv(),
  fs: HostFs = nodeHostFs,
): Promise<ConnectDetection> {
  const [claudeInstalled, codexInstalled, claudeIn, codexIn, yoLogin] = await Promise.all([
    findCli("claude", env, fs),
    findCli("codex", env, fs),
    claudeSignedIn(env, fs),
    fs.exists(path.join(env.home, ".codex", "auth.json")),
    fs.exists(path.join(codexYoHome(env), "auth.json")),
  ]);
  return {
    host: { platform: env.platform, name: env.hostname.replace(/\.local$/, "") },
    claude: { installed: claudeInstalled, signedIn: claudeIn },
    codex: { installed: codexInstalled, signedIn: codexIn, yoLogin },
  };
}

/* ---------------------------------- Codex ---------------------------------- */

export type CodexLoginRead =
  | { state: "waiting" }
  | { state: "found"; authJson: string }
  | { state: "error"; error: string };

/** Look for the dedicated login. Read errors count as "not there yet"; nothing here throws. */
export async function readCodexLogin(
  env: HostEnv = nodeHostEnv(),
  fs: HostFs = nodeHostFs,
): Promise<CodexLoginRead> {
  const file = path.join(codexYoHome(env), "auth.json");
  if (!(await fs.exists(file))) return { state: "waiting" };
  let raw: string;
  try {
    raw = await fs.readFile(file);
  } catch {
    return { state: "waiting" };
  }
  const check = checkCodexAuthJson(raw);
  if (check === "partial") return { state: "waiting" };
  if (check === "invalid")
    return {
      state: "error",
      error:
        "Codex finished, but Yo can't use what it saved. Run the sign-in command again and finish signing in with ChatGPT in the browser.",
    };
  return { state: "found", authJson: raw };
}

/** After import, Yo's computer holds the only live copy: remove this one so two copies never compete. */
export async function removeCodexLogin(env: HostEnv = nodeHostEnv(), fs: HostFs = nodeHostFs): Promise<void> {
  await fs.rm(path.join(codexYoHome(env), "auth.json")).catch(() => {});
}
