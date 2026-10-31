/**
 * Which of a seat's tabs to close to save memory and keep the browser responsive: tabs no agent has used for
 * a while (the idle sweep), extra copies of a page the seat already has open, and, above the seat's tab cap,
 * its least recently used ones. Pure apart from the injected page reads and closes, so the choice is
 * testable without a browser.
 */

export interface SeatTab {
  id: string;
  url: string;
  title: string;
}

/**
 * Read in a tab before closing it. null: couldn't tell, so it stays. `hung`: the page didn't answer in time
 * (a frozen tab, often at 100% CPU), so it's safe and useful to close.
 */
export type TabState = { dirty: boolean; media: boolean; hung?: boolean } | null;

export type CloseReason = "idle" | "tab cap" | "duplicate" | "frozen" | "orphan";

export interface TrimOptions {
  /** The seat's tabs, in any order. */
  tabs: SeatTab[];
  /** When an agent last used the tab (undefined: unknown, counts as just now). */
  lastUse: (id: string) => number | undefined;
  /**
   * Whether someone typed into the tab since it last loaded a page. Sites fill their own search boxes and
   * set beforeunload handlers, so "unsaved input" only counts in tabs that were really typed into.
   */
  typed?: (id: string) => boolean;
  now: number;
  /** Close web tabs unused for this long (0: no idle closing this round). */
  idleMs: number;
  /** Close the least recently used web tabs while there are more than this (0: no cap). */
  maxTabs: number;
  /** Close another copy of a page the seat has open once the copy is unused for this long (0: off). */
  duplicateMs?: number;
  /** Unsaved typing keeps a tab only until it has been unused for this long (0: no limit). */
  typedGraceMs?: number;
  state: (id: string) => Promise<TabState>;
  /** Closes the tab; false when it couldn't (it then counts as still open). */
  close: (tab: SeatTab, why: CloseReason) => Promise<boolean>;
  /** A tab that would have closed but stays (unsaved input, playing media, unreadable). */
  kept?: (tab: SeatTab, why: string) => void;
}

export const isWebUrl = (u: string) => /^https?:\/\//.test(u);

/** The page a URL shows, for spotting copies: the same address apart from its #fragment. */
export function samePage(u: string): string {
  const i = u.indexOf("#");
  return i < 0 ? u : u.slice(0, i);
}

/** At most `max` web URLs, without copies of the same page, in their original order. */
export function tabsToSave(urls: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!isWebUrl(u) || seen.has(samePage(u))) continue;
    seen.add(samePage(u));
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Why a tab that would close stays (null: it may close). A frozen tab always may go; one we couldn't read
 * stays; so does one with playing audio/video, and one someone typed into (`typed`) that has unsaved input,
 * until it has been unused for `typedGraceMs` (0: no limit).
 */
export function keepReason(
  state: TabState,
  typed: boolean,
  idleFor: number,
  typedGraceMs = 0,
): "unreadable" | "unsaved input" | "media playing" | null {
  if (state?.hung) return null;
  if (!state) return "unreadable";
  if (state.dirty && typed && !(typedGraceMs && idleFor >= typedGraceMs)) return "unsaved input";
  if (state.media) return "media playing";
  return null;
}

/**
 * Closes the tabs that should go, least recently used first. Never the seat's most recently used tab
 * (normally the one showing) or its last one, never a non-web page, never a tab with playing audio/video,
 * and never a tab someone typed into recently (unsaved input). A frozen tab always may go. Returns the
 * closed tabs.
 */
export async function trimSeatTabs(o: TrimOptions): Promise<SeatTab[]> {
  const used = (t: SeatTab) => o.lastUse(t.id) ?? o.now;
  // Most recently used first: that one always stays.
  const mine = [...o.tabs].sort((a, b) => used(b) - used(a));
  let left = mine.length;
  let web = mine.filter((t) => isWebUrl(t.url)).length;
  // The most recently used copy of each page stays; older copies may go.
  const newestCopy = new Map<string, string>();
  for (const t of mine) if (!newestCopy.has(samePage(t.url))) newestCopy.set(samePage(t.url), t.id);
  const closed: SeatTab[] = [];
  for (const t of mine.slice(1).reverse()) {
    if (left <= 1) break;
    if (!isWebUrl(t.url)) continue;
    const idleFor = o.now - used(t);
    const why: CloseReason | null =
      o.idleMs > 0 && idleFor >= o.idleMs
        ? "idle"
        : o.duplicateMs && idleFor >= o.duplicateMs && newestCopy.get(samePage(t.url)) !== t.id
          ? "duplicate"
          : o.maxTabs > 0 && web > o.maxTabs
            ? "tab cap"
            : null;
    if (!why) continue;
    const state = await o.state(t.id);
    const keep = keepReason(state, o.typed?.(t.id) ?? true, idleFor, o.typedGraceMs);
    if (keep) {
      o.kept?.(t, keep);
      continue;
    }
    if (!(await o.close(t, state?.hung ? "frozen" : why))) continue;
    left--;
    web--;
    closed.push(t);
  }
  return closed;
}

/**
 * Frozen-tab watch: counts, per tab, how many checks in a row it failed to answer. A tab that stays frozen
 * for `strikes` checks should be closed (it blocks the agent's browser tools and burns a CPU core).
 */
export class FreezeWatch {
  private readonly misses = new Map<string, number>();
  constructor(private readonly strikes: number) {}

  /** Records one check's results; returns the tabs frozen for `strikes` checks in a row. */
  record(results: { id: string; answered: boolean }[]): string[] {
    const seen = new Set<string>();
    const frozen: string[] = [];
    for (const r of results) {
      seen.add(r.id);
      const n = r.answered ? 0 : (this.misses.get(r.id) ?? 0) + 1;
      if (n === 0) this.misses.delete(r.id);
      else this.misses.set(r.id, n);
      if (n >= this.strikes) frozen.push(r.id);
    }
    for (const id of [...this.misses.keys()]) if (!seen.has(id)) this.misses.delete(id);
    return frozen;
  }

  forget(id: string) {
    this.misses.delete(id);
  }
}
