import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTD_PORT, CORE_PORT, type CoreEdition } from "@yo/contracts";

export const CORE_VERSION = "0.1.0";

declare const __YO_BUILD__: string | null | undefined;
/** "<commit count>-<sha>" baked in by build.mjs; null when running from source (tests, `pnpm dev`). */
export const CORE_BUILD: string | null = typeof __YO_BUILD__ === "string" ? __YO_BUILD__ : null;

declare const __YO_VERSION__: string | null | undefined;
/**
 * The Yo release this core belongs to ("0.1.312", the same number Yo.app and the GitHub Release carry), baked in by
 * build.mjs; null when running from source. Bug reports say it, so a report can be matched to the release that fixes it.
 */
export const CORE_RELEASE: string | null = typeof __YO_VERSION__ === "string" ? __YO_VERSION__ : null;

function defaultDataDir(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Yo");
  return path.join(os.homedir(), ".yo");
}

/** Repo root (for docker compose build context). Overridable for packaged builds. */
function defaultRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/ or dist/ -> apps/core -> apps -> root
  return path.resolve(here, "..", "..", "..");
}

export interface CoreConfig {
  host: string;
  port: number;
  dataDir: string;
  repoRoot: string;
  /** Runtime compose file (no build section). Bundled in Yo.app so the app never touches the source checkout. */
  composeFile: string;
  /**
   * Image to pull for the agent's computer (public builds: ghcr.io/…/yo-computer:<app version>, set by Yo.app).
   * Null: build yo-computer:dev from the source checkout at repoRoot (see computer/ComputerLifecycle.ts).
   */
  computerImage: string | null;
  webDist: string | null;
  agentdUrl: string;
  /** "local": core manages Colima + compose on this machine. "remote": agentd lives elsewhere. */
  computerMode: "local" | "remote";
  /** Secrets backend. */
  secrets: "keychain" | "file";
  colimaProfile: string;
  dev: boolean;
  /** Extra allowed WebSocket origins. */
  allowedOrigins: string[];
  /** GitHub REST base for filing bug reports (overridable to test against a fake). */
  githubApi: string;
  /** Yo Phone's relay (docs/phone/PROTOCOL.md); the owner can change it with `channels.phone.configure`. It also holds
   * the bug mailbox every Yo sends bug reports to (docs/phone/PROTOCOL.md, "Bug mailbox"). */
  phoneRelayUrl: string;
  /** Which Yo this is (YO_EDITION): the Mac app's core, the PC edition in Docker, or a home server. Sets wording. */
  edition: CoreEdition;
  /** The command that manages Yo on its machine (YO_HELPER_COMMAND, "yo-app" in the PC edition), shown in the UI. */
  helperCommand: string | null;
  /**
   * Hostnames whose connections core drops on sight (YO_DENY_PEERS, comma-separated). The PC edition lists the
   * agent's computer, which shares core's Docker network but must never reach core.
   */
  denyPeers: string[];
  /** Mark the session cookie Secure (YO_COOKIE_SECURE=1), for cores behind HTTPS. */
  cookieSecure: boolean;
  /** Where the PC edition looks for the newest release (YO_RELEASES_URL; tests point it at a fake). */
  releasesUrl: string;
}

const EDITIONS: readonly CoreEdition[] = ["mac", "pc", "home-server"];

export function loadConfig(env = process.env): CoreConfig {
  const repoRoot = env.YO_REPO_ROOT ?? defaultRepoRoot();
  const port = Number(env.YO_PORT ?? CORE_PORT);
  const webDist = env.YO_WEB_DIST ?? path.join(repoRoot, "apps", "web", "dist");
  const computerMode = (env.YO_COMPUTER_MODE as "local" | "remote") ?? "local";
  const edition = EDITIONS.find((e) => e === env.YO_EDITION?.trim());
  return {
    host: env.YO_HOST ?? "127.0.0.1",
    port,
    dataDir: env.YO_DATA_DIR ?? defaultDataDir(),
    repoRoot,
    composeFile: env.YO_COMPOSE_FILE ?? path.join(repoRoot, "computer", "compose.runtime.yaml"),
    computerImage: env.YO_COMPUTER_IMAGE?.trim() || null,
    webDist,
    agentdUrl: env.YO_AGENTD_URL ?? `http://127.0.0.1:${AGENTD_PORT}`,
    computerMode,
    secrets: (env.YO_SECRETS as "keychain" | "file") ?? (process.platform === "darwin" ? "keychain" : "file"),
    colimaProfile: env.YO_COLIMA_PROFILE ?? "yo",
    dev: env.YO_DEV === "1",
    allowedOrigins: (env.YO_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
    githubApi: env.YO_GITHUB_API ?? "https://api.github.com",
    phoneRelayUrl: env.YO_PHONE_RELAY_URL?.trim() || "https://yo-phone.vercel.app",
    edition: edition ?? (computerMode === "local" ? "mac" : "home-server"),
    helperCommand: env.YO_HELPER_COMMAND?.trim() || null,
    denyPeers: (env.YO_DENY_PEERS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
    cookieSecure: env.YO_COOKIE_SECURE === "1",
    releasesUrl:
      env.YO_RELEASES_URL?.trim() || "https://api.github.com/repos/JuniorSua/yo-app/releases/latest",
  };
}
