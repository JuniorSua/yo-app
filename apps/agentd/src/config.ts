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
  /**
   * One shared computer (default): one wide screen and one Chromium (one profile: the same logins and
   * downloads for every agent), with a seat (a screen-sized tile and its own windows) per awake agent.
   * YO_SHARED_COMPUTER=0 goes back to a separate screen and browser per agent.
   */
  sharedComputer: env.YO_SHARED_COMPUTER !== "0",
  /** Seats on the shared screen: the most agents that can be awake at once. */
  sharedTiles: Math.max(1, Math.min(12, Number(env.YO_SHARED_TILES ?? 6))),
  /**
   * The most agent computers (seats) awake at once (0: no cap beyond the screen's seats). Each awake seat
   * costs its tabs' memory. Waking one more is refused with NO_FREE_SEAT: core then puts the least recently
   * used idle agent's computer to sleep, or the new agent waits for a free screen.
   */
  maxAwakeSeats: Math.max(0, Number(env.YO_MAX_AWAKE_SEATS ?? 3)),
  /**
   * Shared computer: close a tab no agent has used for this long (minutes; 0 turns it off). Open tabs are
   * most of the computer's memory. Tabs with unsaved input or playing media, each agent's most recently used
   * tab and its last tab are kept; logins stay, so reopening a site is just navigating to it.
   */
  idleTabMinutes: Math.max(0, Number(env.YO_IDLE_TAB_MINUTES ?? 30)),
  /**
   * Shared computer: the most web tabs a seat keeps open (0 turns it off). Above it, the seat's least
   * recently used tabs close, with the same safety checks as idle tabs.
   */
  maxSeatTabs: Math.max(0, Number(env.YO_MAX_SEAT_TABS ?? 8)),
  ringSize: Number(env.YO_RING_SIZE ?? 2000),
  metricsIntervalMs: 10_000,
};

export const paths = {
  homeRoot: () => path.join(config.dataDir, "home"),
  agentsRoot: () => path.join(config.dataDir, "home", "agents"),
  agentHome: (agentId: string) => path.join(config.dataDir, "home", "agents", agentId),
  sharedDir: () => path.join(config.dataDir, "home", "shared"),
  profileDir: (agentId: string) => path.join(config.dataDir, "profiles", agentId),
  /** The shared computer's one Chromium profile. */
  sharedProfileDir: () => path.join(config.dataDir, "profiles", "shared"),
  /** Each agent's seat on the shared computer: its tile and its open tabs while asleep. */
  seatsFile: () => path.join(config.dataDir, "seats.json"),
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
