/**
 * The shared computer: one wide screen (Xvfb :0) and one Chromium (one profile, so every agent has the same
 * logins and downloads), with a seat per awake agent. A seat is a screen-sized tile of the wide screen with
 * that agent's own Chrome windows, like a desktop you slide to. Each agent only sees its seat:
 *   - the browser through a filtering CDP proxy on the agent's usual port (cdpProxy.ts),
 *   - the desktop through offsets (desktop-mcp gets YO_SEAT_*),
 *   - the live view and screenshots clipped to the tile.
 * Sleeping saves the seat's tabs and closes its windows; the last seat to sleep stops Chromium (a parked
 * window off the screen keeps the session, so session-only logins survive). Waking reopens the tabs.
 * Session restore also brings back old windows into the parking spot: only one parked window stays, and tabs
 * no seat owns (orphans) close, as does anything a memory guard finds piling up (orphans.ts, issue #158).
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { ComputerState, LeaseHolder } from "@yo/contracts";
import { scrubEnv } from "../auth";
import { config, paths } from "../config";
import { errMsg, type Logger } from "../log";
import { availableMemory, countRenderers } from "../metrics";
import { cdpPort, noFreeSeat, vncPort } from "./allocation";
import { CdpClient } from "./cdpClient";
import { type Seat as SeatRect, startCdpProxy, tileBounds } from "./cdpProxy";
import { Display, type DisplaySpec, tcpReady, waitFor } from "./Display";
import {
  hostSummary,
  memoryPressure,
  mergeSavedTabs,
  planReconcile,
  type RestoredWindow,
  trimOrphans,
} from "./orphans";
import { missingTabs, RESTORE_FILE, readPendingRestore, toCookieParam } from "./sessionRestore";
import {
  type CloseReason,
  FreezeWatch,
  isWebUrl,
  type SeatTab,
  type TabState,
  tabsToSave,
  trimSeatTabs,
} from "./tabTrim";

/** The shared desktop's X display; its Chromium's real CDP port is cdpPort(0) (seats use 9200+N, N ≥ 1). */
export const SHARED_DISPLAY = 0;
const UPSTREAM = cdpPort(SHARED_DISPLAY);
const W = config.screen.width;
const H = config.screen.height;
const TILES = config.sharedTiles;
/**
 * The parking spot: one more tile at the right end of the screen, never given to a seat. The parked window
 * that keeps the session lives there (on the screen: the window manager pulls off-screen windows back on).
 */
const PARK_X = TILES * W;
const MAX_SAVED_TABS = 30;
const MAX_CLOSED_TABS = 30;
/** How often the keeper saves each seat's tab list (crash safety) and looks for idle tabs. */
const SNAPSHOT_MS = 30_000;
const SWEEP_MS = 60_000;
/** How often a seat over its tab cap may have tabs closed (each close first reads the page). */
const CAP_CHECK_MS = 10_000;
/** Another copy of a page the seat has open closes once the copy is unused this long. */
const DUPLICATE_MS = 2 * 60_000;
/** Typing keeps a tab open (unsaved input) only until the tab has been unused this long. */
const TYPED_GRACE_MS = 2 * 60 * 60_000;
/**
 * Orphans: web pages in a window no seat owns (restored by Chromium after a wake, or left behind), apart
 * from the parked session keeper. They close once unused this long, or at once above the seat tab cap.
 */
const ORPHAN_IDLE_MS = 2 * 60_000;
const ORPHAN_CHECK_MS = 10_000;
/** The memory guard looks this often, and sweeps at most once per GUARD_MS. */
const GUARD_CHECK_MS = 10_000;
const GUARD_MS = 60_000;
/**
 * Frozen tabs: every FREEZE_CHECK_MS each awake agent's tabs must answer a trivial script within
 * FREEZE_ANSWER_MS; a tab that misses FREEZE_STRIKES checks in a row is closed (a frozen page burns a CPU core
 * and makes the agent's browser tools time out one after another).
 */
const FREEZE_CHECK_MS = 60_000;
const FREEZE_ANSWER_MS = 5_000;
const FREEZE_STRIKES = 3;
/**
 * Commands that mean an agent really used a tab. Not reads like evaluating a script or a page's title:
 * listing tabs reads every tab, which would make them all look just used.
 */
const USE = /^(Input\.|Page\.(navigate|reload|bringToFront|captureScreenshot)|Target\.activateTarget$)/;
const TYPING = /^Input\.(insertText|dispatchKeyEvent|imeSetComposition)$/;
/**
 * Read in a tab before closing it (idle, or over its seat's tab cap): no unsaved input (a beforeunload
 * handler, or a form field changed from its default) and no playing audio/video (a call). (Which tab shows
 * in a window can't be read here: under automation every tab reports itself visible, so the most recently
 * used tab is kept instead.)
 */
const PAGE_STATE = `(() => {
  // Only text a person typed and would miss: visible, editable text fields (sites set search boxes,
  // checkboxes and menus themselves, so those don't count).
  const text = new Set(["text", "email", "number", "tel", "url", "date", "datetime-local", "time", "month", "week"]);
  const changed = (e) => !e.disabled && !e.readOnly && e.getClientRects().length > 0
    && (e.tagName === "TEXTAREA" || text.has(e.type)) && e.value !== e.defaultValue && e.value.trim() !== "";
  return JSON.stringify({
    dirty: !!window.onbeforeunload || [...document.querySelectorAll("input,textarea")].some(changed)
      || !!document.querySelector("[contenteditable=true]:focus, [contenteditable='']:focus"),
    media: [...document.querySelectorAll("audio,video")].some((m) => !m.paused && !m.ended),
  });
})()`;

const require = createRequire(import.meta.url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Where an agent's seat is right now, for its desktop tools (desktop-mcp reads it on every action: the tile
 * can change between wake-ups while the agent's session keeps running).
 */
export const seatFile = (agentId: string) => path.join(config.runDir, "seats", `${agentId}.json`);

interface ClosedTab {
  url: string;
  title: string;
  at: number;
}

interface SeatsFile {
  /**
   * Each agent's last tile, the tabs it had open when it went to sleep, and the idle tabs that were closed
   * to save memory (newest first).
   */
  seats: Record<string, { tile?: number; tabs?: string[]; closed?: ClosedTab[] }>;
  /** Tile -> the agent that held it last (whose windows a restart brings back there). */
  tiles: Record<string, string>;
}

/** A page as the window keeper sees it: its window, and the tile that window is in (null: no seat's). */
interface KeptPage extends SeatTab {
  tile: number | null;
  windowId: number;
}

export interface WindowBounds {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  windowState?: string;
}

export class SharedDesktop {
  readonly display: Display;
  private readonly seats = new Map<string, Seat>();
  /** Window id -> tile, learned when it was placed or first seen whole inside a tile. */
  private readonly windowTile = new Map<number, number>();
  private file: SeatsFile;
  private lockChain: Promise<unknown> = Promise.resolve();
  private cdp: CdpClient | null = null;
  private keeper: NodeJS.Timeout | null = null;
  private keeping = false;
  /** Settles once a fresh Chromium's windows are sorted out (afterChromium). */
  private reconciled: Promise<void> = Promise.resolve();
  /** Page targetId -> when an agent last used it (a command through its proxy) or its page changed. */
  private readonly lastUse = new Map<string, number>();
  private readonly lastUrl = new Map<string, string>();
  private lastSnapshot = 0;
  /** "targetId:reason" already logged as kept, so a tab kept for the same reason is logged once. */
  private readonly keptLogged = new Set<string>();
  private lastSweep = 0;
  private lastCapCheck = 0;
  /** Tabs an agent typed into: only there does a changed form field count as unsaved input. */
  private readonly typed = new Set<string>();
  private readonly freeze = new FreezeWatch(FREEZE_STRIKES);
  private lastFreezeCheck = 0;
  /** The one parked window that keeps the session (never an orphan); null until a reconcile finds or makes it. */
  private parkedWindow: number | null = null;
  private lastOrphanCheck = 0;
  private lastGuardCheck = 0;
  private lastGuard = 0;
  /** What the memory guard reads (replaceable in tests). */
  memoryProbe: { available: () => number | null; renderers: () => number | null } = {
    available: () => availableMemory(),
    renderers: () => countRenderers(),
  };

  constructor(private readonly log: Logger) {
    this.file = readSeatsFile();
    this.display = new Display(
      "shared",
      SHARED_DISPLAY,
      log.child("display:shared"),
      { onState: (state, _lease, message) => this.onDesktopState(state, message) },
      this.spec(),
    );
  }

  private spec(): DisplaySpec {
    return {
      width: (TILES + 1) * W,
      height: H,
      profileDir: paths.sharedProfileDir(),
      // Chromium's own HOME stays out of the folders agents can browse; what the user downloads by hand
      // during a takeover lands in the shared folder (every agent's ~/Shared/Downloads).
      home: path.join(config.dataDir, "home", "browser"),
      env: {
        ...scrubEnv(process.env),
        DISPLAY: `:${SHARED_DISPLAY}`,
        HOME: path.join(config.dataDir, "home", "browser"),
        XDG_DOWNLOAD_DIR: path.join(paths.sharedDir(), "Downloads"),
        LANG: process.env.LANG ?? "C.UTF-8",
      },
      vnc: false,
      // A fresh session opens its one window in the parking spot (it becomes the parked window).
      windowArgs: (restore) => [
        `--window-position=${PARK_X},0`,
        `--window-size=${W},${H}`,
        ...(restore ? ["--restore-last-session"] : ["about:blank"]),
      ],
      openboxArgs: ["--sm-disable", ...openboxConfigArgs(this.log)],
      beforeChromium: () => this.migrateProfile(),
      afterChromium: (port) => {
        this.reconciled = this.afterChromium(port);
        return this.reconciled;
      },
    };
  }

  /* --------------------------------- seats --------------------------------- */

  seat(agentId: string, n: number): Seat {
    let s = this.seats.get(agentId);
    if (!s) {
      s = new Seat(agentId, n, this, this.log.child(`seat:${n}`));
      this.seats.set(agentId, s);
    }
    return s;
  }

  /** Serializes window/tab creation across seats (Chromium puts a new tab in the last active window). */
  readonly lock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = this.lockChain.then(fn, fn);
    this.lockChain = run.catch(() => undefined);
    return run;
  };

  /** Starts the desktop and Chromium (once for every seat) and waits until restored windows are sorted. */
  async ensure(): Promise<void> {
    await this.display.ensure();
    await this.reconciled;
    await this.client();
    this.startKeeper();
  }

  /**
   * A seat gone for good (a helper that finished): its windows close without saving its tabs, and its tile
   * claim and saved tabs are forgotten, so the next agent gets a clean tile.
   */
  async discard(agentId: string): Promise<void> {
    const seat = this.seats.get(agentId);
    if (seat) await seat.discard();
    this.seats.delete(agentId);
    delete this.file.seats[agentId];
    for (const [tile, owner] of Object.entries(this.file.tiles))
      if (owner === agentId) delete this.file.tiles[tile];
    this.save();
    await this.released();
  }

  /** A seat went to sleep: stop the whole desktop once nobody is using it. */
  async released(): Promise<void> {
    if ([...this.seats.values()].some((s) => s.awake())) return;
    this.stopKeeper();
    this.cdp?.close();
    this.cdp = null;
    await this.display.hibernate();
  }

  /** Display.ts reports restarts as "<proc> exited; restarting in …" then "<proc> restarted". */
  private onDesktopState(state: ComputerState, message?: string) {
    if (state === "error") for (const s of this.seats.values()) s.desktopFailed(message);
    else if (message && (/restarting in/.test(message) || state === "booting"))
      for (const s of this.seats.values()) s.desktopRestarting(message);
    else if (state === "ready" && message && /restarted$/.test(message))
      for (const s of this.seats.values()) s.desktopRecovered();
  }

  async client(): Promise<CdpClient> {
    if (this.cdp && !this.cdp.closed) return this.cdp;
    this.cdp = await CdpClient.connect(UPSTREAM);
    return this.cdp;
  }

  /** Lowest free tile, preferring the agent's last one and tiles no other agent held last. */
  claimTile(agentId: string): number {
    const taken = new Set([...this.seats.values()].filter((s) => s.tile !== null).map((s) => s.tile!));
    const free = Array.from({ length: TILES }, (_, i) => i).filter((t) => !taken.has(t));
    if (!free.length) throw noFreeSeat(`All ${TILES} screens of the shared computer are in use.`);
    const last = this.file.seats[agentId]?.tile;
    const tile =
      (last !== undefined && free.includes(last) ? last : undefined) ??
      free.find((t) => !this.file.tiles[t] || this.file.tiles[t] === agentId) ??
      free[0]!;
    this.file.seats[agentId] = { ...this.file.seats[agentId], tile };
    this.file.tiles[tile] = agentId;
    this.save();
    return tile;
  }

  savedTabs(agentId: string): string[] {
    return this.file.seats[agentId]?.tabs ?? [];
  }

  /** Saves the tabs to reopen on wake: each page once, at most the seat's tab cap. */
  saveTabs(agentId: string, tabs: string[]) {
    this.file.seats[agentId] = { ...this.file.seats[agentId], tabs: tabsToSave(tabs, this.savedTabCap()) };
    this.save();
  }

  private savedTabCap(): number {
    return config.maxSeatTabs > 0 ? Math.min(config.maxSeatTabs, MAX_SAVED_TABS) : MAX_SAVED_TABS;
  }

  private save() {
    writeSeatsFile(this.file);
  }

  /** An agent sent this tab a command (method undefined: a raw page connection, which counts as use). */
  readonly touch = (targetId: string, method?: string) => {
    if (method !== undefined && !USE.test(method)) return;
    this.lastUse.set(targetId, Date.now());
    if (method !== undefined && TYPING.test(method)) this.typed.add(targetId);
  };

  /** When an agent last used the tab (most recent first sorts by this). */
  usedAt(targetId: string): number {
    return this.lastUse.get(targetId) ?? 0;
  }

  /** Window ownership for the proxies: the tile a window was placed in, or undefined when unknown. */
  windowTileOf(windowId: number): number | undefined {
    return this.windowTile.get(windowId);
  }

  rememberWindow(windowId: number, tile: number) {
    this.windowTile.set(windowId, tile);
  }

  /** Pages whose windows are in `tile` (uses remembered placement, else the window's left edge). */
  async pagesInTile(tile: number): Promise<{ id: string; url: string; windowId: number }[]> {
    const cdp = await this.client();
    const out: { id: string; url: string; windowId: number }[] = [];
    for (const p of await cdp.pages()) {
      try {
        const w = await cdp.call<{ windowId: number; bounds: WindowBounds }>("Browser.getWindowForTarget", {
          targetId: p.id,
        });
        if (this.tileOfWindow(w.windowId, w.bounds) === tile)
          out.push({ id: p.id, url: p.url, windowId: w.windowId });
      } catch {
        // closed meanwhile
      }
    }
    return out;
  }

  private tileOfWindow(windowId: number, b: WindowBounds): number | null {
    const known = this.windowTile.get(windowId);
    if (known !== undefined) return known;
    if (b.windowState && b.windowState !== "normal") return null;
    const left = b.left ?? 0;
    if (left < 0 || left >= PARK_X) return null;
    return Math.floor(left / W);
  }

  /**
   * Opens `urls` in the seat's tile: the first in a new window placed there, the rest as tabs of it (under
   * the lock, so another seat's new tab can't land in this window or vice versa).
   */
  async openInTile(tile: number, urls: string[]): Promise<void> {
    const list = urls.length ? urls : ["about:blank"];
    await this.lock(async () => {
      const cdp = await this.client();
      const first = await cdp.call<{ targetId: string }>("Target.createTarget", {
        url: list[0],
        newWindow: true,
      });
      const { windowId } = await cdp.call<{ windowId: number }>("Browser.getWindowForTarget", {
        targetId: first.targetId,
      });
      this.rememberWindow(windowId, tile);
      await cdp.call("Browser.setWindowBounds", { windowId, bounds: tileBounds(this.rect(tile)) });
      for (const url of list.slice(1)) {
        await cdp.call("Target.activateTarget", { targetId: first.targetId }).catch(() => undefined);
        const t = await cdp.call<{ targetId: string }>("Target.createTarget", { url, background: true });
        const w = await cdp.call<{ windowId: number }>("Browser.getWindowForTarget", {
          targetId: t.targetId,
        });
        if (w.windowId !== windowId) {
          // Landed elsewhere: give it its own window in the tile instead.
          await cdp.call("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
          const own = await cdp.call<{ targetId: string }>("Target.createTarget", { url, newWindow: true });
          const ow = await cdp.call<{ windowId: number }>("Browser.getWindowForTarget", {
            targetId: own.targetId,
          });
          this.rememberWindow(ow.windowId, tile);
          await cdp.call("Browser.setWindowBounds", {
            windowId: ow.windowId,
            bounds: tileBounds(this.rect(tile)),
          });
        }
      }
      await cdp.call("Target.activateTarget", { targetId: first.targetId }).catch(() => undefined);
    });
  }

  rect(tile: number): SeatRect {
    return { x: tile * W, width: W, height: H };
  }

  /* ------------------------------ maintenance ------------------------------ */

  /**
   * Keeps every window inside its tile: a page that goes fullscreen or a maximize would otherwise cover
   * the whole wide screen (every agent's seat). Runs every 2 s while any seat is awake.
   */
  private startKeeper() {
    if (this.keeper) return;
    this.keeper = setInterval(() => void this.keep(), 2000);
    this.keeper.unref();
  }

  private stopKeeper() {
    if (this.keeper) clearInterval(this.keeper);
    this.keeper = null;
  }

  private async keep() {
    if (this.keeping || this.display.state !== "ready") return;
    this.keeping = true;
    try {
      const cdp = await this.client();
      const seen = new Set<number>();
      const pages: KeptPage[] = [];
      for (const p of await cdp.pages()) {
        let w: { windowId: number; bounds: WindowBounds };
        try {
          w = await cdp.call("Browser.getWindowForTarget", { targetId: p.id });
        } catch {
          continue;
        }
        // A page first seen starts its idle clock now, unless its proxy already saw the agent use it (that
        // time is more precise). A page changing its own address (redirects, live pages) isn't use.
        if (!this.lastUrl.has(p.id) && !this.lastUse.has(p.id)) this.touch(p.id);
        this.lastUrl.set(p.id, p.url);
        pages.push({
          id: p.id,
          url: p.url,
          title: p.title ?? "",
          tile: this.tileOfWindow(w.windowId, w.bounds),
          windowId: w.windowId,
        });
        if (seen.has(w.windowId)) continue;
        seen.add(w.windowId);
        const tile = this.tileOfWindow(w.windowId, w.bounds);
        if (tile === null) continue; // parked, or a new fullscreen window we know nothing about
        this.rememberWindow(w.windowId, tile);
        const want = tileBounds(this.rect(tile));
        const b = w.bounds;
        if (
          b.windowState !== "normal" ||
          b.left !== want.left ||
          b.top !== want.top ||
          b.width !== want.width ||
          b.height !== want.height
        ) {
          if (b.windowState !== "normal")
            await cdp.call("Browser.setWindowBounds", {
              windowId: w.windowId,
              bounds: { windowState: "normal" },
            });
          await cdp.call("Browser.setWindowBounds", { windowId: w.windowId, bounds: want });
        }
      }
      for (const id of [...this.windowTile.keys()]) if (!seen.has(id)) this.windowTile.delete(id);
      const live = new Set(pages.map((p) => p.id));
      for (const id of [...this.lastUrl.keys()])
        if (!live.has(id)) {
          this.lastUrl.delete(id);
          this.lastUse.delete(id);
          this.typed.delete(id);
        }
      const now = Date.now();
      if (now - this.lastSnapshot > SNAPSHOT_MS) {
        this.lastSnapshot = now;
        // Crash safety: keep each awake seat's tab list fresh.
        for (const s of this.seats.values()) if (s.awake() && s.tile !== null) await s.snapshotTabs(false);
      }
      if (now - this.lastFreezeCheck > FREEZE_CHECK_MS) {
        this.lastFreezeCheck = now;
        await this.closeFrozenTabs(cdp, pages);
      }
      const sweep = now - this.lastSweep > SWEEP_MS;
      const overCap = now - this.lastCapCheck > CAP_CHECK_MS && this.overTabCap(pages);
      if (sweep || overCap) {
        if (sweep) this.lastSweep = now;
        this.lastCapCheck = now;
        await this.trimTabs(cdp, pages, sweep);
      }
      if (now - this.lastOrphanCheck > ORPHAN_CHECK_MS) {
        this.lastOrphanCheck = now;
        await this.closeOrphans(cdp, pages, ORPHAN_IDLE_MS);
      }
      if (now - this.lastGuardCheck > GUARD_CHECK_MS) {
        this.lastGuardCheck = now;
        await this.memoryGuard(cdp, pages, now);
      }
    } catch (err) {
      this.log.warn("window keeper failed", { err: errMsg(err) });
    } finally {
      this.keeping = false;
    }
  }

  /** True when some awake seat has more web tabs open than YO_MAX_SEAT_TABS. */
  private overTabCap(pages: { url: string; tile: number | null }[]): boolean {
    const cap = config.maxSeatTabs;
    if (cap <= 0) return false;
    const count = new Map<number, number>();
    for (const p of pages)
      if (p.tile !== null && isWebUrl(p.url)) count.set(p.tile, (count.get(p.tile) ?? 0) + 1);
    return [...count.values()].some((n) => n > cap);
  }

  /**
   * Closes tabs to save memory (open tabs are most of the computer's memory): with `sweep`, tabs no agent
   * has used for `idleTabMinutes` and older copies of a page the seat already has open; and always, a seat's
   * least recently used tabs above its tab cap. Keeps each seat's most recently used tab (normally the one
   * showing), tabs an agent typed into recently, tabs playing media, and every tab of a seat the user has
   * taken over (tabTrim.ts). Closed tabs are remembered (seats.json, the reopen list) and logged.
   */
  private async trimTabs(
    cdp: CdpClient,
    pages: { id: string; url: string; title: string; tile: number | null }[],
    sweep: boolean,
  ) {
    const now = Date.now();
    for (const seat of this.seats.values()) {
      if (seat.state !== "ready" || seat.lease !== "agent" || seat.tile === null) continue;
      const mine = pages.filter((p) => p.tile === seat.tile);
      if (process.env.YO_IDLE_TABS_DEBUG === "1")
        this.log.info("idle sweep", {
          agentId: seat.agentId,
          tabs: mine.map(
            (p) =>
              `${hostOf(p.url) ?? p.url.slice(0, 12)}:${Math.round((now - (this.lastUse.get(p.id) ?? now)) / 1000)}s`,
          ),
        });
      await trimSeatTabs({
        tabs: mine,
        lastUse: (id) => this.lastUse.get(id),
        now,
        idleMs: sweep ? config.idleTabMinutes * 60_000 : 0,
        duplicateMs: sweep ? DUPLICATE_MS : 0,
        typedGraceMs: TYPED_GRACE_MS,
        typed: (id) => this.typed.has(id),
        maxTabs: config.maxSeatTabs,
        state: (id) => this.pageState(cdp, id),
        kept: (p, why) => {
          if (this.keptLogged.has(`${p.id}:${why}`)) return;
          this.keptLogged.add(`${p.id}:${why}`);
          this.log.info("kept a tab", { agentId: seat.agentId, why, host: hostOf(p.url) });
        },
        close: (p, why) => this.closeTab(cdp, seat.agentId, p, why, now),
      });
    }
  }

  /**
   * Orphans: web pages in a window no seat owns (tile null), apart from the parked session keeper. Chromium
   * restores them after a wake, off the screen, and no seat's trimming sees them (#158).
   */
  private orphans(pages: KeptPage[]): KeptPage[] {
    return pages.filter(
      (p) => p.tile === null && p.windowId !== this.parkedWindow && isWebUrl(p.url) && this.lastUrl.has(p.id),
    );
  }

  /** Whether the user has taken over any seat: then nothing outside a seat closes (they may be using it). */
  private takenOver(): boolean {
    return [...this.seats.values()].some((s) => s.lease === "user");
  }

  /**
   * Closes orphan tabs unused for `idleMs` (0: any), and the least recently used at once while there are
   * more than a seat's tab cap of them. Same protections as a seat's tabs; nothing while the user has taken
   * over a seat. Returns how many closed.
   */
  private async closeOrphans(cdp: CdpClient, pages: KeptPage[], idleMs: number): Promise<number> {
    if (this.takenOver()) return 0;
    const tabs = this.orphans(pages);
    if (!tabs.length) return 0;
    const now = Date.now();
    const closed = await trimOrphans({
      tabs,
      lastUse: (id) => this.lastUse.get(id),
      now,
      idleMs,
      maxTabs: config.maxSeatTabs,
      typedGraceMs: TYPED_GRACE_MS,
      typed: (id) => this.typed.has(id),
      state: (id) => this.pageState(cdp, id),
      kept: (p, why) => {
        if (this.keptLogged.has(`${p.id}:${why}`)) return;
        this.keptLogged.add(`${p.id}:${why}`);
        this.log.info("kept a tab no agent owns", { why, host: hostOf(p.url) });
      },
      close: (p, why) => this.closeTab(cdp, null, p, why, now),
    });
    return closed.length;
  }

  /**
   * Memory guard: when memory available drops under LOW_MEMORY (orphans.ts), or there are more browser
   * processes than every seat's tab cap allows, sweep at once: orphans (any age), then other copies of a page
   * a seat has open, then each seat's least recently used tabs over its cap. Same protections as always
   * (unsaved typing, playing media, a taken-over seat, each seat's most recently used tab). At most once per
   * GUARD_MS.
   */
  private async memoryGuard(cdp: CdpClient, pages: KeptPage[], now: number) {
    if (now - this.lastGuard < GUARD_MS) return;
    const available = this.memoryProbe.available();
    const renderers = this.memoryProbe.renderers();
    const limit = config.maxSeatTabs > 0 ? TILES * config.maxSeatTabs + 4 : 0;
    const reason = memoryPressure({ available, processes: Math.max(renderers ?? 0, pages.length), limit });
    if (!reason) return;
    this.lastGuard = now;
    const closed = { orphans: 0, duplicates: 0, overCap: 0 };
    closed.orphans = await this.closeOrphans(cdp, pages, 0);
    for (const pass of ["duplicates", "overCap"] as const) {
      for (const seat of this.seats.values()) {
        if (seat.state !== "ready" || seat.lease !== "agent" || seat.tile === null) continue;
        const mine = pages.filter((p) => p.tile === seat.tile && this.lastUrl.has(p.id));
        const done = await trimSeatTabs({
          tabs: mine,
          lastUse: (id) => this.lastUse.get(id),
          now,
          idleMs: 0,
          // Any older copy (not only one unused for DUPLICATE_MS); then the cap, least recently used first.
          duplicateMs: pass === "duplicates" ? 1 : 0,
          maxTabs: pass === "overCap" ? config.maxSeatTabs : 0,
          typedGraceMs: TYPED_GRACE_MS,
          typed: (id) => this.typed.has(id),
          state: (id) => this.pageState(cdp, id),
          close: (p, why) => this.closeTab(cdp, seat.agentId, p, why, now),
        });
        closed[pass] += done.length;
      }
    }
    this.log.warn("memory guard swept tabs", {
      reason,
      availablePct: available === null ? undefined : Math.round(available * 100),
      renderers: renderers ?? undefined,
      pages: pages.length,
      closed,
    });
  }

  /**
   * Closes a tab and logs why. A seat's tab (agentId) is remembered in its reopen list; an orphan
   * (agentId null) has nobody to remember it for.
   */
  private async closeTab(
    cdp: CdpClient,
    agentId: string | null,
    p: { id: string; url: string; title: string },
    why: CloseReason,
    now = Date.now(),
  ): Promise<boolean> {
    try {
      await cdp.call("Target.closeTarget", { targetId: p.id });
    } catch {
      return false;
    }
    const idleMin = Math.round((now - (this.lastUse.get(p.id) ?? now)) / 60_000);
    this.lastUse.delete(p.id);
    this.lastUrl.delete(p.id);
    this.typed.delete(p.id);
    this.freeze.forget(p.id);
    if (agentId) {
      const entry = this.file.seats[agentId] ?? {};
      entry.closed = [{ url: p.url, title: p.title, at: now }, ...(entry.closed ?? [])].slice(
        0,
        MAX_CLOSED_TABS,
      );
      this.file.seats[agentId] = entry;
      this.save();
    }
    const what: Record<CloseReason, string> = {
      idle: "closed an idle tab",
      "tab cap": "closed a tab over the seat's tab cap",
      duplicate: "closed another copy of an open page",
      frozen: "closed a frozen tab",
      orphan: "closed a tab no agent owns",
    };
    const msg = agentId || why !== "frozen" ? what[why] : "closed a frozen tab no agent owns";
    this.log.info(msg, { ...(agentId ? { agentId } : {}), idleMin, host: hostOf(p.url) });
    return true;
  }

  /**
   * Closes tabs of awake agents that stopped answering (FREEZE_STRIKES checks in a row): a frozen page burns
   * a CPU core and makes every browser tool time out, including listing tabs. Not in a seat the user has
   * taken over: they may be waiting on it. Frozen orphans (no seat's) close too, unless the user has taken
   * over a seat.
   */
  private async closeFrozenTabs(cdp: CdpClient, pages: KeptPage[]) {
    const owner = new Map<number, string>();
    for (const seat of this.seats.values())
      if (seat.state === "ready" && seat.lease === "agent" && seat.tile !== null)
        owner.set(seat.tile, seat.agentId);
    const watched = [
      ...pages.filter((p) => p.tile !== null && owner.has(p.tile) && isWebUrl(p.url)),
      ...(this.takenOver() ? [] : this.orphans(pages)),
    ];
    const results = await Promise.all(
      watched.map(async (p) => ({ id: p.id, answered: await this.answers(cdp, p.id) })),
    );
    for (const id of this.freeze.record(results)) {
      const p = watched.find((w) => w.id === id)!;
      await this.closeTab(cdp, p.tile === null ? null : owner.get(p.tile)!, p, "frozen");
    }
  }

  /** Whether the page runs a trivial script in time (false: frozen; a page we can't attach to counts as fine). */
  private async answers(cdp: CdpClient, targetId: string): Promise<boolean> {
    let sessionId: string | undefined;
    try {
      ({ sessionId } = await cdp.call<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      }));
    } catch {
      return true;
    }
    try {
      await cdp.call(
        "Runtime.evaluate",
        { expression: "1", returnByValue: true },
        FREEZE_ANSWER_MS,
        sessionId,
      );
      return true;
    } catch (err) {
      return !/timed out/.test(errMsg(err));
    } finally {
      await cdp.call("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  private async pageState(cdp: CdpClient, targetId: string): Promise<TabState> {
    let sessionId: string | undefined;
    try {
      ({ sessionId } = await cdp.call<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      }));
      const r = await cdp.call<{ result?: { value?: string } }>(
        "Runtime.evaluate",
        { expression: PAGE_STATE, returnByValue: true },
        5000,
        sessionId,
      );
      return r.result?.value ? JSON.parse(r.result.value) : null;
    } catch (err) {
      // A page that doesn't answer is frozen: closing it is the useful thing. Otherwise we can't tell: keep it.
      return sessionId && /timed out/.test(errMsg(err)) ? { dirty: false, media: false, hung: true } : null;
    } finally {
      if (sessionId) await cdp.call("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  /**
   * First launch of the shared computer: start from the agent profile with the most logins (largest cookie
   * store), copied so the old per-agent profiles stay as they were (rolling back to one browser per agent
   * keeps working). Its old windows aren't restored: they belonged to a single screen.
   */
  private migrateProfile() {
    const shared = paths.sharedProfileDir();
    if (existsSync(path.join(shared, "Default"))) return;
    const root = path.dirname(shared);
    let best: { dir: string; size: number } | null = null;
    try {
      for (const name of readdirSync(root)) {
        if (!name.startsWith("agt_")) continue;
        // Chromium keeps them in Default/Network/Cookies (older versions: Default/Cookies).
        const size = Math.max(
          cookieCount(path.join(root, name, "Default", "Network", "Cookies")) ?? -1,
          cookieCount(path.join(root, name, "Default", "Cookies")) ?? -1,
        );
        if (size < 0) continue;
        if (!best || size > best.size) best = { dir: path.join(root, name), size };
      }
    } catch {
      return;
    }
    // The deploy tooling can name it (the main agent's), which beats guessing from cookie counts.
    const named = process.env.YO_SHARED_PROFILE_FROM;
    if (named && /^agt_[A-Za-z0-9]+$/.test(named) && existsSync(path.join(root, named, "Default")))
      best = { dir: path.join(root, named), size: Number.POSITIVE_INFINITY };
    if (!best) return;
    try {
      cpSync(best.dir, shared, {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          return (
            !base.startsWith("Singleton") && base !== RESTORE_FILE && !src.endsWith(`${path.sep}Sessions`)
          );
        },
      });
      this.log.info("shared browser profile created", { from: path.basename(best.dir) });
    } catch (err) {
      this.log.error("could not copy a browser profile for the shared computer", { err: errMsg(err) });
      rmSync(shared, { recursive: true, force: true });
    }
  }

  /**
   * After (re)launching Chromium: apply carry-overs saved before an update (session cookies + each agent's
   * tabs, written into the agents' old profiles by the deploy tooling), then sort out its windows.
   */
  private async afterChromium(port: number): Promise<void> {
    await sleep(2500); // let session restore open its windows
    const cdp = await this.client();
    await this.applyCarryOvers(cdp);
    const windows = await this.reconcileWindows(cdp);
    this.log.info("shared browser ready", { port, windows });
  }

  /**
   * Sorts out a fresh Chromium's windows (session restore brings back the last session, logins included, but
   * also every window it had, all in the parking spot): exactly one parked blank window stays (the session
   * keeper; a new one is parked when there's none); every other parked window closes, its pages added to the
   * reopen list of the agent they match; a window in a tile stays if a seat holds the tile, else closes, its
   * pages saved for the agent that held the tile last. Awake seats then reopen their saved tabs as usual.
   * Returns how many windows there were.
   */
  async reconcileWindows(cdp: CdpClient): Promise<number> {
    this.windowTile.clear();
    this.parkedWindow = null;
    const windows = new Map<number, RestoredWindow>();
    for (const p of await cdp.pages()) {
      try {
        const w = await cdp.call<{ windowId: number; bounds: WindowBounds }>("Browser.getWindowForTarget", {
          targetId: p.id,
        });
        const entry = windows.get(w.windowId) ?? { id: w.windowId, bounds: w.bounds, pages: [] };
        entry.pages.push({ id: p.id, url: p.url });
        windows.set(w.windowId, entry);
      } catch {
        // gone
      }
    }
    const saved: Record<string, string[]> = {};
    for (const [agentId, s] of Object.entries(this.file.seats)) if (s.tabs?.length) saved[agentId] = s.tabs;
    const plan = planReconcile({
      windows: [...windows.values()],
      parkX: PARK_X,
      tileWidth: W,
      tiles: TILES,
      held: new Set([...this.seats.values()].filter((s) => s.tile !== null).map((s) => s.tile!)),
      tileOwner: this.file.tiles,
      saved,
    });
    // Park first: closing Chromium's last window would quit it (and lose the session).
    this.parkedWindow = plan.keeper ?? (await this.park(cdp));
    for (const r of plan.remember) this.rememberWindow(r.windowId, r.tile);
    const parkedUrls: string[] = [];
    let parkedWindows = 0;
    let savedFor = 0;
    for (const c of plan.close) {
      const urls = c.pages.map((p) => p.url).filter(isWebUrl);
      if (c.owner && urls.length) {
        const before = this.savedTabs(c.owner).length;
        this.saveTabs(c.owner, mergeSavedTabs(this.savedTabs(c.owner), urls, this.savedTabCap()));
        if (c.parked && this.savedTabs(c.owner).length > before) savedFor++;
      }
      if (c.parked) {
        parkedWindows++;
        parkedUrls.push(...urls);
      }
      for (const p of c.pages)
        await cdp.call("Target.closeTarget", { targetId: p.id }).catch(() => undefined);
    }
    if (parkedWindows)
      this.log.info("closed windows restored off the screen", {
        windows: parkedWindows,
        tabs: parkedUrls.length,
        hosts: hostSummary(parkedUrls),
        addedToReopenLists: savedFor,
      });
    return windows.size;
  }

  /** The parked window: off the screen, owned by nobody, keeps Chromium (and its session) alive. */
  private async park(cdp: CdpClient): Promise<number> {
    const t = await cdp.call<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
    });
    const { windowId } = await cdp.call<{ windowId: number }>("Browser.getWindowForTarget", {
      targetId: t.targetId,
    });
    await cdp.call("Browser.setWindowBounds", {
      windowId,
      bounds: { left: PARK_X, top: 0, width: W, height: H, windowState: "normal" },
    });
    return windowId;
  }

  private async applyCarryOvers(cdp: CdpClient) {
    const root = path.dirname(paths.sharedProfileDir());
    let names: string[] = [];
    try {
      names = readdirSync(root).filter((n) => n.startsWith("agt_"));
    } catch {
      return;
    }
    // Every agent's saved logins go into the one browser; the agent with the most is applied last, so where
    // two agents were signed in to the same site, the busier agent's sign-in wins.
    const all = names
      .map((agentId) => ({ agentId, pending: readPendingRestore(path.join(root, agentId)) }))
      .filter((x): x is { agentId: string; pending: NonNullable<typeof x.pending> } => !!x.pending)
      .sort((a, b) => a.pending.cookies.length - b.pending.cookies.length);
    for (const { agentId, pending } of all) {
      const dir = path.join(root, agentId);
      try {
        renameSync(path.join(dir, RESTORE_FILE), path.join(dir, `${RESTORE_FILE}.applied`));
      } catch {
        continue;
      }
      try {
        const cookies = pending.cookies.map(toCookieParam).filter((c): c is Record<string, unknown> => !!c);
        if (cookies.length) await cdp.call("Storage.setCookies", { cookies });
        if (pending.tabs.length) this.saveTabs(agentId, pending.tabs);
        this.log.info("carried over a browser session", {
          agentId,
          cookies: cookies.length,
          tabs: pending.tabs.length,
        });
      } catch (err) {
        this.log.warn("browser carry-over failed", { agentId, err: errMsg(err) });
      } finally {
        rmSync(path.join(dir, `${RESTORE_FILE}.applied`), { force: true });
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopKeeper();
    await Promise.all([...this.seats.values()].map((s) => s.shutdown().catch(() => undefined)));
    this.cdp?.close();
    await this.display.shutdown();
  }
}

/**
 * One agent's place on the shared computer. Same surface as an agent's own Display (state, lease, ports,
 * ensure/hibernate), so the rest of agentd doesn't care which kind it has.
 */
export class Seat {
  state: ComputerState = "off";
  lease: LeaseHolder = "agent";
  lastActiveAt = 0;
  tile: number | null = null;
  readonly cdpPort: number;
  readonly vncPort: number;
  private booting: Promise<void> | null = null;
  private proxy: { close(): Promise<void> } | null = null;
  private vnc: ChildProcess | null = null;
  private vncWanted = false;
  private vncCrashes: number[] = [];
  onState: (state: ComputerState, lease: LeaseHolder, message?: string) => void = () => {};

  constructor(
    readonly agentId: string,
    readonly n: number,
    private readonly shared: SharedDesktop,
    private readonly log: Logger,
  ) {
    this.cdpPort = cdpPort(n);
    this.vncPort = vncPort(n);
  }

  awake(): boolean {
    return this.state === "ready" || this.state === "booting";
  }

  /** The tile in screen coordinates (screenshots, desktop tools, the live view). */
  area(): { x: number; y: number; width: number; height: number } | null {
    return this.tile === null ? null : { x: this.tile * W, y: 0, width: W, height: H };
  }

  private setState(state: ComputerState, message?: string) {
    const changed = state !== this.state;
    this.state = state;
    if (changed || message) this.onState(state, this.lease, message);
  }

  async ensure(): Promise<void> {
    this.lastActiveAt = Date.now();
    if (this.state === "ready" && this.proxy) return;
    if (this.booting) return this.booting;
    this.booting = this.boot().finally(() => {
      this.booting = null;
    });
    return this.booting;
  }

  private async boot() {
    this.setState("booting");
    try {
      await this.shared.ensure();
      if (this.tile === null) this.tile = this.shared.claimTile(this.agentId);
      const tile = this.tile;
      mkdirSync(path.dirname(seatFile(this.agentId)), { recursive: true });
      writeFileSync(seatFile(this.agentId), JSON.stringify(this.area()));
      this.proxy ??= await startCdpProxy({
        listenPort: this.cdpPort,
        upstreamPort: UPSTREAM,
        seat: () => this.shared.rect(this.tile ?? tile),
        createLock: this.shared.lock,
        onActivity: this.shared.touch,
        // Chromium's download folder is browser-wide; the proxy routes each download to its agent.
        downloadDir: path.join(config.runDir, "downloads"),
        ownsWindow: (windowId) => {
          const t = this.shared.windowTileOf(windowId);
          return t === undefined ? undefined : t === this.tile;
        },
        log: this.log.child("cdp"),
      });
      const open = await this.shared.pagesInTile(tile);
      const saved = this.shared.savedTabs(this.agentId);
      if (!open.length) await this.shared.openInTile(tile, saved);
      else {
        for (const p of open) this.shared.rememberWindow(p.windowId, tile);
        const missing = missingTabs(
          saved,
          open.map((p) => p.url),
        );
        if (missing.length) await this.shared.openInTile(tile, missing);
      }
      await this.startVnc();
      this.setState("ready");
      this.log.info("seat ready", { agentId: this.agentId, tile });
    } catch (err) {
      this.log.error("seat failed to start", { agentId: this.agentId, err: errMsg(err) });
      await this.stopParts();
      this.setState("error", errMsg(err));
      await this.shared.released();
      throw err;
    }
  }

  /** Saves the open tabs (and, with `close`, closes them: the agent's windows go away). */
  async snapshotTabs(close: boolean): Promise<void> {
    if (this.tile === null) return;
    const pages = await this.shared.pagesInTile(this.tile);
    // Most recently used first, so the tab cap on saving keeps the ones that matter.
    const urls = [...pages]
      .sort((a, b) => this.shared.usedAt(b.id) - this.shared.usedAt(a.id))
      .map((p) => p.url)
      .filter(isWebUrl);
    if (urls.length || close) this.shared.saveTabs(this.agentId, urls);
    if (!close) return;
    const cdp = await this.shared.client();
    for (const p of pages) await cdp.call("Target.closeTarget", { targetId: p.id }).catch(() => undefined);
  }

  async hibernate(): Promise<void> {
    if (this.booting) await this.booting.catch(() => undefined);
    if (this.state === "hibernated" || this.state === "off") return;
    try {
      if (this.shared.display.state === "ready") await this.snapshotTabs(true);
    } catch (err) {
      this.log.warn("couldn't save the seat's tabs", { agentId: this.agentId, err: errMsg(err) });
    }
    await this.stopParts();
    this.tile = null;
    this.setState("hibernated");
    await this.shared.released();
  }

  async shutdown(): Promise<void> {
    await this.stopParts();
  }

  /** Gone for good: close its windows WITHOUT saving its tabs (SharedDesktop.discard forgets the rest). */
  async discard(): Promise<void> {
    if (this.booting) await this.booting.catch(() => undefined);
    try {
      if (this.tile !== null && this.shared.display.state === "ready") {
        const cdp = await this.shared.client();
        for (const p of await this.shared.pagesInTile(this.tile))
          await cdp.call("Target.closeTarget", { targetId: p.id }).catch(() => undefined);
      }
    } catch (err) {
      this.log.warn("couldn't close the discarded seat's tabs", { agentId: this.agentId, err: errMsg(err) });
    }
    await this.stopParts();
    this.tile = null;
    this.state = "off";
    rmSync(seatFile(this.agentId), { force: true });
  }

  async setLease(holder: LeaseHolder): Promise<void> {
    if (holder === this.lease) return;
    this.lease = holder;
    if (this.vncWanted) await this.startVnc();
    this.onState(this.state, this.lease);
  }

  desktopFailed(message?: string) {
    if (this.awake()) this.setState("error", message ?? "the shared computer stopped");
  }

  desktopRestarting(message: string) {
    if (this.state === "ready") this.setState("booting", message);
  }

  desktopRecovered() {
    if (this.state === "booting" && !this.booting) {
      // Chromium came back (crash restart): reopen this seat's tabs if they didn't come back.
      void this.reopenAfterRestart();
    }
  }

  private async reopenAfterRestart() {
    try {
      await this.shared.ensure();
      if (this.tile !== null && !(await this.shared.pagesInTile(this.tile)).length)
        await this.shared.openInTile(this.tile, this.shared.savedTabs(this.agentId));
      this.setState("ready");
    } catch (err) {
      this.setState("error", errMsg(err));
    }
  }

  private async stopParts() {
    await this.stopVnc();
    const proxy = this.proxy;
    this.proxy = null;
    await proxy?.close().catch(() => undefined);
  }

  /* ------------------------------ live view ------------------------------ */

  private async startVnc() {
    const area = this.area();
    if (!area) return;
    // A live view from before (the seat woke again, or the screen restarted under it) still holds the port; a
    // new one would exit at once, over and over, and the live view would go off. Close the old one first.
    await this.stopVnc();
    this.vncWanted = true;
    this.vncCrashes = [];
    this.spawnVnc(area);
    const ok = await waitFor(() => tcpReady(this.vncPort), 10_000, 150);
    if (!ok) throw new Error(`x11vnc :${this.vncPort} not ready`);
  }

  private spawnVnc(area: { x: number; y: number; width: number; height: number }) {
    const child = spawn(
      "x11vnc",
      [
        "-display",
        `:${SHARED_DISPLAY}`,
        "-clip",
        `${area.width}x${area.height}+${area.x}+${area.y}`,
        "-localhost",
        "-noipv6",
        "-rfbportv6",
        "-1",
        "-rfbport",
        String(this.vncPort),
        "-forever",
        "-shared",
        "-nopw",
        "-noxdamage",
        "-quiet",
        ...(this.lease === "user" ? [] : ["-viewonly"]),
      ],
      { env: { ...scrubEnv(process.env), DISPLAY: `:${SHARED_DISPLAY}` }, stdio: "ignore", detached: true },
    );
    this.vnc = child;
    child.on("exit", () => {
      if (this.vnc === child) this.vnc = null;
      if (!this.vncWanted) return;
      const now = Date.now();
      this.vncCrashes = this.vncCrashes.filter((t) => now - t < 120_000);
      this.vncCrashes.push(now);
      if (this.vncCrashes.length > 6) {
        this.log.error("x11vnc keeps exiting; live view off", { agentId: this.agentId });
        return;
      }
      setTimeout(() => {
        const a = this.area();
        if (this.vncWanted && !this.vnc && a) this.spawnVnc(a);
      }, 1000).unref();
    });
  }

  /** Closes the live view. x11vnc stuck on a screen that went away ignores SIGTERM: after 2 s, SIGKILL. */
  private stopVnc(): Promise<void> {
    this.vncWanted = false;
    const child = this.vnc;
    this.vnc = null;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    const pid = child.pid;
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    return new Promise((resolve) => {
      const force = setTimeout(() => signal("SIGKILL"), 2000);
      const giveUp = setTimeout(resolve, 4000);
      force.unref();
      giveUp.unref();
      child.once("exit", () => {
        clearTimeout(force);
        clearTimeout(giveUp);
        resolve();
      });
      signal("SIGTERM");
    });
  }
}

/* --------------------------------- helpers --------------------------------- */

const hostOf = (url: string) => /^https?:\/\/([^/]+)/.exec(url)?.[1];

/** How many cookies a profile's store holds (its logins); its file size when it can't be read; null if none. */
function cookieCount(file: string): number | null {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return null;
  }
  try {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM cookies").get() as { n: number } | undefined;
      return row ? Number(row.n) : 0;
    } finally {
      db.close();
    }
  } catch {
    return size / 1e6; // unreadable: fall back to the file size (below any real count)
  }
}

function readSeatsFile(): SeatsFile {
  try {
    const raw = JSON.parse(readFileSync(paths.seatsFile(), "utf8")) as Partial<SeatsFile>;
    return {
      seats: raw.seats && typeof raw.seats === "object" ? raw.seats : {},
      tiles: raw.tiles && typeof raw.tiles === "object" ? raw.tiles : {},
    };
  } catch {
    return { seats: {}, tiles: {} };
  }
}

function writeSeatsFile(f: SeatsFile) {
  const file = paths.seatsFile();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Openbox places new windows (an app an agent launches) under the mouse, so they open in that agent's tile
 * (desktop-mcp moves the pointer there first). The rest of the stock config (focus on click, etc.) stays.
 */
function openboxConfigArgs(log: Logger): string[] {
  try {
    mkdirSync(config.runDir, { recursive: true });
    const stock = readFileSync("/etc/xdg/openbox/rc.xml", "utf8");
    const patched = stock.replace(
      /<placement>[\s\S]*?<\/placement>/,
      "<placement><policy>UnderMouse</policy><center>yes</center></placement>",
    );
    const file = path.join(config.runDir, "openbox-shared.xml");
    writeFileSync(file, patched);
    return ["--config-file", file];
  } catch (err) {
    log.warn("openbox config not patched", { err: errMsg(err) });
    return [];
  }
}
