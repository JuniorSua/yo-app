/**
 * Per-account Codex config (`$CODEX_HOME/config.toml`), rewritten by Yo before every app-server spawn.
 *
 * The container is the sandbox, so Codex runs with `danger-full-access`. Codex's own computer/browser
 * use, apps/plugins and memories are turned off: Yo supplies browser/desktop/memory via its MCP servers.
 * Feature names verified with `codex features list` (codex-cli 0.159.2).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerSpec } from "../ProviderAdapter";

export const CODEX_DISABLED_FEATURES = [
  "computer_use",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "in_app_local_automation",
  "apps",
  "plugins",
  "remote_plugin",
  "memories",
  "image_generation",
];

/** Yo's blocking tools (ask_user, request_approval, request_takeover) may wait on the human for hours. */
export const MCP_TOOL_TIMEOUT_SEC = 86_400;
export const MCP_STARTUP_TIMEOUT_SEC = 60;

/** TOML basic string with escapes. */
export function tomlString(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping control chars for TOML
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

export function tomlArray(items: string[]): string {
  return `[${items.map(tomlString).join(", ")}]`;
}

export function tomlInlineTable(obj: Record<string, string>): string {
  const parts = Object.entries(obj).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`);
  return `{ ${parts.join(", ")} }`;
}

export interface CodexConfigOptions {
  /** MCP servers to write as `[mcp_servers.<name>]` tables. */
  mcpServers?: McpServerSpec[];
}

export function buildCodexConfigToml(opts: CodexConfigOptions = {}): string {
  const lines: string[] = [
    "# Managed by Yo. Rewritten before each Codex session; local edits are overwritten.",
    'cli_auth_credentials_store = "file"',
    'sandbox_mode = "danger-full-access"',
    "check_for_update_on_startup = false",
    "",
    "[features]",
    ...CODEX_DISABLED_FEATURES.map((f) => `${f} = false`),
  ];
  for (const s of opts.mcpServers ?? []) {
    lines.push(
      "",
      `[mcp_servers.${tomlKey(s.name)}]`,
      `command = ${tomlString(s.command)}`,
      `args = ${tomlArray(s.args)}`,
    );
    if (s.env && Object.keys(s.env).length) lines.push(`env = ${tomlInlineTable(s.env)}`);
    lines.push(
      `startup_timeout_sec = ${MCP_STARTUP_TIMEOUT_SEC}`,
      `tool_timeout_sec = ${MCP_TOOL_TIMEOUT_SEC}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function writeCodexConfig(codexHome: string, opts: CodexConfigOptions = {}): string {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const path = join(codexHome, "config.toml");
  writeFileSync(path, buildCodexConfigToml(opts), { mode: 0o600 });
  return path;
}

/**
 * Per-session MCP servers as `-c` overrides for `codex app-server`. Several agents can share one
 * account (one CODEX_HOME), each with its own browser/display, so MCP servers are passed per process
 * rather than only through the shared config.toml.
 */
export function mcpConfigOverrides(specs: McpServerSpec[]): string[] {
  const args: string[] = [];
  for (const s of specs) {
    const k = `mcp_servers.${tomlKey(s.name)}`;
    args.push("-c", `${k}.command=${tomlString(s.command)}`);
    args.push("-c", `${k}.args=${tomlArray(s.args)}`);
    if (s.env && Object.keys(s.env).length) args.push("-c", `${k}.env=${tomlInlineTable(s.env)}`);
    args.push("-c", `${k}.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SEC}`);
    args.push("-c", `${k}.tool_timeout_sec=${MCP_TOOL_TIMEOUT_SEC}`);
  }
  return args;
}
