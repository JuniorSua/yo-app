/**
 * Per-agent environment + MCP server specs handed to provider adapters (via SessionStartInput).
 *
 *   yo      -> node <dist>/yo-mcp.js       (Yo tools, reverse-RPC to yo-core through agentd's unix socket)
 *   browser -> playwright-mcp --cdp-endpoint http://127.0.0.1:<9200+N>  (the agent's headed Chromium; on the
 *              shared computer, its seat's windows of the one shared Chromium, through cdpProxy.ts)
 *   desktop -> node <dist>/desktop-mcp.js  (xdotool/scrot on DISPLAY=:N, or on the shared :0 inside the seat)
 */
import path from "node:path";
import { config, paths } from "./config";
import { cdpPort } from "./displays/allocation";
import type { DisplayManager } from "./displays/DisplayManager";
import { seatFile } from "./displays/SharedDesktop";
import type { McpServerSpec } from "./providers/ProviderAdapter";

/**
 * Longest a single browser tool call may take (#114). playwright-mcp bounds clicks/typing (--timeout-action)
 * and page loads (--timeout-navigation), but browser_run_code_unsafe runs the model's own Playwright script
 * with no overall limit and has no flag for one, so a script stuck on e.g. page.mouse.wheel() never returned.
 * The provider enforces this one per call instead (Claude: per-server `timeout`; Codex: `tool_timeout_sec`;
 * Grok: `_meta.mcpConfig.<server>.toolTimeoutMs`).
 */
export const BROWSER_TOOL_TIMEOUT_MS = 120_000;
/**
 * Longest a single desktop tool call may take. Each xdotool/scrot step has its own 15 s limit, but a call
 * chains several (focusing the seat checks every window; typing goes 200 characters at a time), so a hung X
 * server could hold a call far longer. 5 minutes still types ~25,000 characters.
 */
export const DESKTOP_TOOL_TIMEOUT_MS = 300_000;

let manager: DisplayManager | null = null;

export function initComputer(dm: DisplayManager): void {
  manager = dm;
}

function displayOf(agentId: string): number {
  if (!manager) throw new Error("computer helpers not initialised (initComputer)");
  return manager.displayNumber(agentId);
}

export interface AgentEnv extends Record<string, string> {
  DISPLAY: string;
  HOME: string;
  YO_AGENT_ID: string;
  YO_CDP_URL: string;
}

/** The agent's X display: its own, or the shared computer's (its seat is a tile of it; see seatFile). */
function xDisplayOf(agentId: string): string {
  if (!manager) throw new Error("computer helpers not initialised (initComputer)");
  return `:${manager.place(agentId).display}`;
}

export function getAgentEnv(agentId: string): AgentEnv {
  const n = displayOf(agentId);
  return {
    DISPLAY: xDisplayOf(agentId),
    HOME: paths.agentHome(agentId),
    YO_AGENT_ID: agentId,
    // Its own browser, or on the shared computer its seat's view of the shared one (cdpProxy.ts).
    YO_CDP_URL: `http://127.0.0.1:${cdpPort(n)}`,
  };
}

export function getMcpServers(agentId: string, sessionKey: string, toolset?: string): McpServerSpec[] {
  const n = displayOf(agentId);
  const home = paths.agentHome(agentId);
  return [
    {
      name: "yo",
      command: process.execPath,
      args: [path.join(config.distDir, "yo-mcp.js")],
      env: {
        YO_AGENT_ID: agentId,
        YO_SESSION_KEY: sessionKey,
        YO_SOCKET: config.toolSocket,
        // Which Yo tools it offers (a helper gets fewer); absent: all of them.
        ...(toolset ? { YO_TOOLSET: toolset } : {}),
      },
    },
    {
      name: "browser",
      command: config.playwrightMcpBin,
      args: [
        "--cdp-endpoint",
        `http://127.0.0.1:${cdpPort(n)}`,
        "--output-dir",
        path.join(home, ".yo", "browser-output"),
        "--timeout-action",
        "5000",
        "--timeout-navigation",
        "60000",
      ],
      env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", HOME: home },
      toolTimeoutMs: BROWSER_TOOL_TIMEOUT_MS,
    },
    {
      name: "desktop",
      command: process.execPath,
      args: [path.join(config.distDir, "desktop-mcp.js")],
      env: {
        DISPLAY: xDisplayOf(agentId),
        YO_AGENT_ID: agentId,
        YO_CDP_URL: `http://127.0.0.1:${cdpPort(n)}`,
        HOME: home,
        ...(manager?.sharedComputer ? { YO_SEAT_FILE: seatFile(agentId) } : {}),
      },
      toolTimeoutMs: DESKTOP_TOOL_TIMEOUT_MS,
    },
  ];
}
