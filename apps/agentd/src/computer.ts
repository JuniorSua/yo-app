/**
 * Per-agent environment + MCP server specs handed to provider adapters (via SessionStartInput).
 *
 *   yo      -> node <dist>/yo-mcp.js       (Yo tools, reverse-RPC to yo-core through agentd's unix socket)
 *   browser -> playwright-mcp --cdp-endpoint http://127.0.0.1:<9200+N>  (drives the agent's headed Chromium)
 *   desktop -> node <dist>/desktop-mcp.js  (xdotool/scrot on DISPLAY=:N)
 */
import path from "node:path";
import { config, paths } from "./config";
import { cdpPort } from "./displays/allocation";
import type { DisplayManager } from "./displays/DisplayManager";
import type { McpServerSpec } from "./providers/ProviderAdapter";

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

export function getAgentEnv(agentId: string): AgentEnv {
  const n = displayOf(agentId);
  return {
    DISPLAY: `:${n}`,
    HOME: paths.agentHome(agentId),
    YO_AGENT_ID: agentId,
    YO_CDP_URL: `http://127.0.0.1:${cdpPort(n)}`,
  };
}

export function getMcpServers(agentId: string, sessionKey: string): McpServerSpec[] {
  const n = displayOf(agentId);
  const home = paths.agentHome(agentId);
  return [
    {
      name: "yo",
      command: process.execPath,
      args: [path.join(config.distDir, "yo-mcp.js")],
      env: { YO_AGENT_ID: agentId, YO_SESSION_KEY: sessionKey, YO_SOCKET: config.toolSocket },
    },
    {
      name: "browser",
      command: config.playwrightMcpBin,
      args: [
        "--cdp-endpoint",
        `http://127.0.0.1:${cdpPort(n)}`,
        "--output-dir",
        path.join(home, ".yo", "browser-output"),
        "--timeout-navigation",
        "60000",
      ],
      env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", HOME: home },
    },
    {
      name: "desktop",
      command: process.execPath,
      args: [path.join(config.distDir, "desktop-mcp.js")],
      env: {
        DISPLAY: `:${n}`,
        YO_AGENT_ID: agentId,
        YO_CDP_URL: `http://127.0.0.1:${cdpPort(n)}`,
        HOME: home,
      },
    },
  ];
}
