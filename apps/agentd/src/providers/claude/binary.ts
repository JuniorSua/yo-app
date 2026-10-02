/**
 * Locate the native Claude Code binary bundled with @anthropic-ai/claude-agent-sdk.
 * The SDK ships it in a per-platform optional dependency (…-linux-arm64, …-darwin-arm64, …-linux-x64-musl).
 * We resolve relative to the SDK itself so it works under pnpm's isolated layout.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    if (report?.header?.glibcVersionRuntime) return false;
  } catch {
    // fall through
  }
  try {
    return readFileSync("/usr/bin/ldd", "utf8").includes("musl");
  } catch {
    return existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1");
  }
}

let cached: string | null | undefined;

/** Path to the bundled `claude` binary, or null if the platform package is missing. */
export function resolveBundledClaude(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const req = createRequire(import.meta.url);
    const sdkEntry = req.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkReq = createRequire(sdkEntry);
    const exe = process.platform === "win32" ? "claude.exe" : "claude";
    const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const candidates = isMusl() ? [`${base}-musl`, base] : [base, `${base}-musl`];
    for (const pkg of candidates) {
      try {
        const dir = dirname(sdkReq.resolve(`${pkg}/package.json`));
        const p = join(dir, exe);
        if (existsSync(p)) {
          cached = p;
          break;
        }
      } catch {
        // try next
      }
    }
  } catch {
    // SDK not installed
  }
  return cached;
}

/**
 * Executable used for sessions / probe / setup-token:
 * explicit option > YO_CLAUDE_BIN > bundled SDK binary > `claude` on PATH.
 */
export function resolveClaudeExecutable(explicit?: string): string {
  return explicit || process.env.YO_CLAUDE_BIN || resolveBundledClaude() || "claude";
}
