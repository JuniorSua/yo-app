/**
 * "Connect your model" walkthrough, host side: what core can see on the machine it runs on, before Yo's
 * computer exists.
 *
 * - Detection only checks that files exist. It never reads, copies or returns the user's own logins
 *   (`~/.codex/auth.json`, Claude's Keychain item), never runs a CLI (no Keychain prompts), and never
 *   returns paths (they contain the user's name).
 * - Claude: nothing to import. Claude Code signs in on Yo's computer with its own sign-in (Yo never handles a
 *   Claude token); detection only tells the walkthrough the person already uses Claude Code here.
 * - Codex: nothing to import either. ChatGPT signs in once more, on Yo's computer, so the person's own `~/.codex`
 *   login is never copied (ChatGPT refresh tokens rotate: two copies of one login log each other out, "refresh
 *   token already used"). Detection only tells the walkthrough the person already uses Codex here.
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConnectDetection } from "@yo/contracts";

export interface HostFs {
  /** True when the path exists (file or folder). Never throws. */
  exists(p: string): Promise<boolean>;
  /** True when the path is an executable file. Never throws. */
  isExecutable(p: string): Promise<boolean>;
  readFile(p: string): Promise<string>;
  /** Names in a folder ([] when it's missing). Never throws. */
  listDir?(p: string): Promise<string[]>;
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
  listDir: (p) => fsp.readdir(p).catch(() => []),
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

/** `npm install -g` under nvm lands in ~/.nvm/versions/node/<version>/bin, which a GUI app's PATH never has. */
async function nvmDirs(env: HostEnv, fs: HostFs): Promise<string[]> {
  const root = path.join(env.home, ".nvm", "versions", "node");
  const versions = (await fs.listDir?.(root).catch(() => [])) ?? [];
  return versions.filter((v) => /^v\d/.test(v)).map((v) => path.join(root, v, "bin"));
}

export async function findCli(name: string, env: HostEnv, fs: HostFs): Promise<boolean> {
  for (const dir of [...cliDirs(env), ...(await nvmDirs(env, fs))]) {
    if (await fs.isExecutable(path.join(dir, name))) return true;
  }
  return false;
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
  const [claudeInstalled, codexInstalled, claudeIn, codexIn] = await Promise.all([
    findCli("claude", env, fs),
    findCli("codex", env, fs),
    claudeSignedIn(env, fs),
    fs.exists(path.join(env.home, ".codex", "auth.json")),
  ]);
  return {
    host: { platform: env.platform, name: env.hostname.replace(/\.local$/, "") },
    claude: { installed: claudeInstalled, signedIn: claudeIn },
    codex: { installed: codexInstalled, signedIn: codexIn },
  };
}
