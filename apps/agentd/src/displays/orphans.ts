/**
 * Tabs no agent owns (issue #158). After a wake, Chromium's session restore can bring back dozens of old
 * windows, all at the parking spot (its --window-position), where no seat sees them and no tab trimming
 * reaches them: gigabytes of memory for pages nobody uses. These helpers decide, without a browser:
 *   - after a (re)start, which one parked window stays (the session keeper) and what happens to the others
 *     (their pages go to their agent's reopen list when we can tell whose they were, then they close);
 *   - which orphan tabs the keeper closes later (unused for a while, or too many of them);
 *   - when memory is short enough to sweep at once.
 */
import {
  type CloseReason,
  isWebUrl,
  keepReason,
  type SeatTab,
  samePage,
  type TabState,
  tabsToSave,
} from "./tabTrim";

export interface RestoredWindow {
  id: number;
  bounds: { left?: number; windowState?: string };
  pages: { id: string; url: string }[];
}

export interface ReconcilePlan {
  /** The parked window that stays (the session keeper); null: park a new one first. */
  keeper: number | null;
  /** Windows in a tile a seat holds now: they stay and belong to that tile. */
  remember: { windowId: number; tile: number }[];
  /**
   * Windows to close. `owner`: the agent whose reopen list gets the window's web pages (null: unknown, the
   * pages just close). `parked`: it was at the parking spot (restored there, or left behind).
   */
  close: { windowId: number; owner: string | null; parked: boolean; pages: { id: string; url: string }[] }[];
}

/** A parked window that can keep the session: nothing but blank/new-tab pages. about:blank-only first. */
function keeperRank(w: RestoredWindow): number {
  if (w.pages.some((p) => isWebUrl(p.url))) return -1;
  return w.pages.every((p) => p.url === "about:blank") ? (w.pages.length === 1 ? 3 : 2) : 1;
}

/**
 * The agent whose saved tabs match the most of these pages (null: none match, or two agents match equally,
 * so we can't tell whose they were).
 */
export function ownerByUrl(urls: string[], saved: Record<string, string[]>): string | null {
  const pages = urls.filter(isWebUrl).map(samePage);
  let best: string | null = null;
  let bestN = 0;
  let tie = false;
  for (const [agentId, tabs] of Object.entries(saved)) {
    const mine = new Set(tabs.map(samePage));
    const n = pages.filter((p) => mine.has(p)).length;
    if (n > bestN) {
      best = agentId;
      bestN = n;
      tie = false;
    } else if (n > 0 && n === bestN) tie = true;
  }
  return tie ? null : best;
}

/** An agent's reopen list with more pages added after its own (most recent first): each page once, at most `max`. */
export function mergeSavedTabs(saved: string[], urls: string[], max: number): string[] {
  return tabsToSave([...saved, ...urls], max);
}

/**
 * Sorts out a fresh Chromium's windows. Exactly one parked window stays: a blank one (the session keeper),
 * or none, and a new one is parked. Every other parked window closes, its pages saved to the agent they match.
 * A window in a tile stays when a seat holds that tile; otherwise it closes, its pages saved to the agent
 * that held the tile last (as before #158).
 */
export function planReconcile(o: {
  windows: RestoredWindow[];
  parkX: number;
  tileWidth: number;
  tiles: number;
  /** Tiles a seat holds right now. */
  held: Set<number>;
  /** Tile -> the agent that held it last. */
  tileOwner: Record<string, string>;
  /** Each agent's saved tabs (its reopen list). */
  saved: Record<string, string[]>;
}): ReconcilePlan {
  const plan: ReconcilePlan = { keeper: null, remember: [], close: [] };
  const parked = o.windows.filter((w) => (w.bounds.left ?? 0) >= o.parkX);
  let keeper: RestoredWindow | null = null;
  for (const w of parked) if (keeperRank(w) > (keeper ? keeperRank(keeper) : 0)) keeper = w;
  plan.keeper = keeper?.id ?? null;
  for (const w of o.windows) {
    if (w === keeper) continue;
    const left = w.bounds.left ?? 0;
    if (left >= o.parkX) {
      const owner = ownerByUrl(
        w.pages.map((p) => p.url),
        o.saved,
      );
      plan.close.push({ windowId: w.id, owner, parked: true, pages: w.pages });
      continue;
    }
    const tile = Math.max(0, Math.min(o.tiles - 1, Math.floor(left / o.tileWidth)));
    if (o.held.has(tile)) plan.remember.push({ windowId: w.id, tile });
    else plan.close.push({ windowId: w.id, owner: o.tileOwner[tile] ?? null, parked: false, pages: w.pages });
  }
  return plan;
}

/** "host×n, host×n" (most first): what closed, for the log, without full addresses. */
export function hostSummary(urls: string[]): string {
  const n = new Map<string, number>();
  for (const u of urls) {
    const host = /^https?:\/\/([^/]+)/.exec(u)?.[1] ?? u.split(":")[0] ?? "?";
    n.set(host, (n.get(host) ?? 0) + 1);
  }
  return [...n]
    .sort((a, b) => b[1] - a[1])
    .map(([h, c]) => (c > 1 ? `${h}×${c}` : h))
    .join(", ");
}

export interface OrphanTrimOptions {
  /** Web pages whose window belongs to no seat (not the parked session keeper). */
  tabs: SeatTab[];
  lastUse: (id: string) => number | undefined;
  typed?: (id: string) => boolean;
  now: number;
  /** Close orphans unused for this long (0: any, the memory guard). */
  idleMs: number;
  /** Close the least recently used orphans at once while there are more than this (0: no cap). */
  maxTabs: number;
  typedGraceMs?: number;
  state: (id: string) => Promise<TabState>;
  close: (tab: SeatTab, why: CloseReason) => Promise<boolean>;
  kept?: (tab: SeatTab, why: string) => void;
}

/**
 * Closes orphan tabs, least recently used first: those unused for `idleMs`, and any over `maxTabs`. Same
 * protections as a seat's tabs (unsaved typing within the grace time, playing media, unreadable), but no tab
 * is kept for being the newest: no agent is looking at any of them. Returns the closed tabs.
 */
export async function trimOrphans(o: OrphanTrimOptions): Promise<SeatTab[]> {
  const used = (t: SeatTab) => o.lastUse(t.id) ?? o.now;
  const oldestFirst = o.tabs.filter((t) => isWebUrl(t.url)).sort((a, b) => used(a) - used(b));
  let open = oldestFirst.length;
  const closed: SeatTab[] = [];
  for (const t of oldestFirst) {
    const idleFor = o.now - used(t);
    if (!(idleFor >= o.idleMs || (o.maxTabs > 0 && open > o.maxTabs))) continue;
    const state = await o.state(t.id);
    const keep = keepReason(state, o.typed?.(t.id) ?? true, idleFor, o.typedGraceMs);
    if (keep) {
      o.kept?.(t, keep);
      continue;
    }
    if (!(await o.close(t, state?.hung ? "frozen" : "orphan"))) continue;
    open--;
    closed.push(t);
  }
  return closed;
}

/** Memory guard: sweep at once below this share of memory available. */
export const LOW_MEMORY = 0.25;

/**
 * Why the memory guard should sweep now (null: no need): memory available under LOW_MEMORY, or more
 * browser processes/pages than the seats' tab caps allow (`limit`, 0: no limit).
 */
export function memoryPressure(o: {
  /** Share of memory available, 0..1 (null: unknown). */
  available: number | null;
  /** Browser renderer processes (or open pages, whichever is more). */
  processes: number;
  limit: number;
}): "low memory" | "too many pages" | null {
  if (o.available !== null && o.available < LOW_MEMORY) return "low memory";
  if (o.limit > 0 && o.processes > o.limit) return "too many pages";
  return null;
}
