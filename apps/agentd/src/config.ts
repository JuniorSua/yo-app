/** Static configuration for agentd (paths inside the yo-computer container). All overridable via env for dev. */
import path from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;

export const AGENTD_VERSION = "0.1.0";

export const config = {
  port: Number(env.AGENTD_PORT ?? 7801),
  /** TESTS ONLY: accept authenticated requests from inside the container. */
  allowLocal: env.YO_AGENTD_ALLOW_LOCAL === "1",
  host: env.AGENTD_HOST ?? "0.0.0.0",
  /** Persistent volume root. */
  dataDir: env.YO_DATA_DIR ?? "/data",
  /** Directory containing the bundled agentd.js / yo-mcp.js / desktop-mcp.js. */
  distDir: env.YO_AGENTD_DIR ?? path.dirname(fileURLToPath(import.meta.url)),
  /** Unix socket used by yo-mcp shims to reach agentd. */
  toolSocket: env.YO_SOCKET ?? "/tmp/yo/agentd.sock",
  /** Runtime scratch dir (screenshots, wallpapers). */
  runDir: env.YO_RUN_DIR ?? "/tmp/yo",
  /** Playwright MCP bin (installed globally in the image). */
  playwrightMcpBin: env.YO_PLAYWRIGHT_MCP_BIN ?? "playwright-mcp",
  chromiumBin: env.YO_CHROMIUM_BIN ?? "chromium",
  screen: { width: 1280, height: 800, depth: 24 },
  ringSize: Number(env.YO_RING_SIZE ?? 2000),
  metricsIntervalMs: 10_000,
};

export const paths = {
  homeRoot: () => path.join(config.dataDir, "home"),
  agentsRoot: () => path.join(config.dataDir, "home", "agents"),
  agentHome: (agentId: string) => path.join(config.dataDir, "home", "agents", agentId),
  sharedDir: () => path.join(config.dataDir, "home", "shared"),
  profileDir: (agentId: string) => path.join(config.dataDir, "profiles", agentId),
  accountDir: (provider: string, accountId: string) =>
    path.join(config.dataDir, "accounts", provider, accountId),
  displaysFile: () => path.join(config.dataDir, "displays.json"),
};

/** Agent/account ids become path segments: keep them boring. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export function assertSafeId(id: string, what = "id"): string {
  if (!SAFE_ID.test(id) || id.includes("..")) throw new Error(`invalid ${what}: ${JSON.stringify(id)}`);
  return id;
}
