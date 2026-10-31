/**
 * Work & Personal: which space is active in this window, kept current by a clock, and the actions that change it.
 *
 * The space is worked out from the settings (spacesOn, workHours, spaceManual, timezone) with the pure helpers in
 * @yo/contracts, so this window, every other window and core (phone, Telegram) agree. A manual choice is saved in
 * Settings; the schedule needs no saving, so the clock just recomputes at the next boundary.
 */
import {
  type ActiveSpace,
  type AgentView,
  agentForSpace,
  manualSwitch,
  resolveSpace,
  type Settings,
  SPACE_LABELS,
  type Space,
  type SpaceManual,
} from "@yo/contracts";
import { toast } from "sonner";
import { create } from "zustand";
import { api } from "../lib/api";
import { friendlyError } from "../lib/connection";
import { sortAgents, useApp } from "./app";
import { ui, useUI } from "./ui";

export interface SpaceView extends ActiveSpace {
  /** Spaces are on and the Personal agent exists: the switch shows and Personal can change the look. */
  available: boolean;
  /** When this was worked out. */
  at: number;
}

const OFF: Omit<SpaceView, "at"> = {
  space: "work",
  source: "off",
  until: null,
  next: null,
  available: false,
};

/**
 * The space right now. Without spaces (turned off, an older core with no `spacesOn`, or no Personal agent yet)
 * it's always Work, so nothing about the app changes.
 */
export function spaceView(
  now: number,
  settings: Partial<Settings>,
  agents: Record<string, AgentView>,
): SpaceView {
  const available = settings.spacesOn === true && sortAgents(agents).some((a) => a.space === "personal");
  if (!available) return { ...OFF, at: now };
  return { ...resolveSpace(now, settings), available, at: now };
}

/** The agent that leads a space (Yo for Work, Pip for Personal); the primary when spaces aren't available. */
export function agentOf(
  agents: Record<string, AgentView>,
  space: Space,
  available: boolean,
): AgentView | undefined {
  return agentForSpace(sortAgents(agents), space, available) ?? undefined;
}

/**
 * Which chat a window should show after loading: the saved one, unless it's gone or it's the other space's
 * agent (then the active space's agent). Other agents (legacy teammates) stay open. `keepOpen` (a reconnect):
 * the chat on screen stays whichever space it's in, so waking the laptop never swaps it out from under the owner.
 */
export function pickAgentId(
  agents: Record<string, AgentView>,
  saved: string | null,
  view: Pick<SpaceView, "space" | "available">,
  opts: { keepOpen?: boolean } = {},
): string | null {
  const a = saved ? agents[saved] : undefined;
  const otherSpace = view.available && !!a?.space && a.space !== view.space;
  if (a && !a.archivedAt && (opts.keepOpen || !otherSpace)) return a.id;
  return agentOf(agents, view.space, view.available)?.id ?? null;
}

/** How long until the clock should look again: at the next change, and at least once a minute. */
export function nextCheck(view: Pick<SpaceView, "until" | "next" | "available">, now: number): number {
  const MINUTE = 60_000;
  if (!view.available) return MINUTE;
  const at = view.until ?? view.next;
  if (at === null) return MINUTE;
  // A little after the boundary, so the schedule has really flipped when it recomputes.
  return Math.max(250, Math.min(MINUTE, at - now + 50));
}

/**
 * What to save when the owner picks a space: back to the schedule when it already says that space, else held
 * until the schedule next changes. With automatic switching off (pinned) it stays pinned to the new space.
 */
export function manualFor(now: number, settings: Partial<Settings>, space: Space): SpaceManual | null {
  const current = resolveSpace(now, settings);
  if (current.source === "pinned") return { space, until: null };
  return manualSwitch(now, settings, space);
}

/** What the window does when the space changes on its own: follow it, offer it in a toast, or nothing. */
export type FollowPlan = "open" | "toast" | "none";

/**
 * Follow quietly only when it can't get in the way: the window shows the previous space's agent and the owner
 * isn't in a dialog or halfway through typing. Otherwise a schedule change asks with a toast; a change made
 * elsewhere (another window, Settings) stays quiet.
 */
export function followPlan(o: {
  cause: "clock" | "settings";
  fromId: string | undefined;
  toId: string | undefined;
  page: string;
  agentId: string | null;
  busy: boolean;
}): FollowPlan {
  if (!o.toId || o.fromId === o.toId) return "none";
  if (o.page === "agent" && o.agentId === o.toId) return "none";
  if (o.page === "agent" && o.agentId === o.fromId && !o.busy) return "open";
  return o.cause === "clock" ? "toast" : "none";
}

/* -------------------------------------------- Store -------------------------------------------- */

export const useSpace = create<SpaceView>(() => ({ ...OFF, at: Date.now() }));

/** The agent for the active space (Pip in Personal time, Yo otherwise). */
export function useActiveAgent(): AgentView | undefined {
  const space = useSpace((s) => s.space);
  const available = useSpace((s) => s.available);
  return useApp((s) => agentOf(s.agents, space, available));
}

export function activeAgent(): AgentView | undefined {
  const { space, available } = useSpace.getState();
  return agentOf(useApp.getState().agents, space, available);
}

/** A dialog or menu is open, or the owner is typing something: don't pull the chat out from under them. */
function busy(): boolean {
  const u = useUI.getState();
  if (u.settingsOpen || u.newAgentOpen || u.paletteOpen || u.agentSettingsId || u.computerAgentId)
    return true;
  if (document.querySelector('[role="dialog"]:not([data-space-intro]), [role="menu"]')) return true;
  const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
  if (el?.isContentEditable) return true;
  return !!el && "value" in el && typeof el.value === "string" && el.value.trim() !== "";
}

const timeIn = (t: number, tz: string) => {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).format(t).replace(":00", "");
  } catch {
    return new Intl.DateTimeFormat("en-US", opts).format(t).replace(":00", "");
  }
};

function follow(prev: SpaceView, next: SpaceView, cause: "clock" | "settings") {
  const { agents, settings } = useApp.getState();
  const from = agentOf(agents, prev.space, prev.available);
  const to = agentOf(agents, next.space, next.available);
  const u = useUI.getState();
  const plan = followPlan({
    cause,
    fromId: from?.id,
    toId: to?.id,
    page: u.page,
    agentId: u.agentId,
    busy: busy(),
  });
  if (plan === "open" && to) ui.openAgent(to.id);
  if (plan !== "toast" || !to) return;
  const label = SPACE_LABELS[next.space];
  const other = SPACE_LABELS[prev.space];
  const until = next.until ? ` ${to.name} is with you until ${timeIn(next.until, settings.timezone)}.` : "";
  toast(`${label} time`, {
    id: "space-switch",
    description: `It's ${timeIn(next.at, settings.timezone)}.${until}`,
    duration: 12_000,
    action: { label: `Open ${to.name}`, onClick: () => ui.openAgent(to.id) },
    cancel: { label: `Stay in ${other}`, onClick: () => void switchSpace(prev.space, { open: false }) },
  });
}

/** Work the space out again; `cause` says why (a follow-up only happens when the space really changed). */
export function recompute(cause: "clock" | "settings" | "user" | "boot" = "settings") {
  const { settings, agents } = useApp.getState();
  const prev = useSpace.getState();
  const next = spaceView(Date.now(), settings, agents);
  useSpace.setState(next, true);
  if (cause === "clock" || cause === "settings")
    if (prev.space !== next.space && prev.available && next.available) follow(prev, next, cause);
  return next;
}

let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule() {
  clearTimeout(timer);
  const v = useSpace.getState();
  timer = setTimeout(
    () => {
      recompute("clock");
      schedule();
    },
    nextCheck(v, Date.now()),
  );
}

/** Start the clock (once, from App): recompute when settings or agents change, and at each boundary. */
export function startSpaceClock() {
  if (started) return;
  started = true;
  recompute("boot");
  schedule();
  useApp.subscribe((s, p) => {
    if (s.settings === p.settings && s.agents === p.agents) return;
    // A new agents object on every agent push: only the space-relevant bits matter.
    if (s.settings === p.settings && sameLeads(s.agents, p.agents)) return;
    recompute(useApp.getState().booted && p.booted ? "settings" : "boot");
    schedule();
  });
  // A laptop waking from sleep: timers were frozen, so look again straight away.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    recompute("clock");
    schedule();
  });
}

function sameLeads(a: Record<string, AgentView>, b: Record<string, AgentView>): boolean {
  const key = (r: Record<string, AgentView>) =>
    Object.values(r)
      .filter((x) => x.space && !x.archivedAt && x.kind !== "helper")
      .map((x) => `${x.id}:${x.space}`)
      .sort()
      .join(",");
  return key(a) === key(b);
}

/* -------------------------------------------- Actions -------------------------------------------- */

async function saveManual(manual: SpaceManual | null) {
  const before = useApp.getState().settings;
  // Optimistic: the switch moves now; settings.updated confirms it (and tells every other window).
  useApp.setState({ settings: { ...before, spaceManual: manual } });
  recompute("user");
  schedule();
  try {
    await api().call("settings.update", { spaceManual: manual });
  } catch (e) {
    useApp.setState((s) => ({ settings: { ...s.settings, spaceManual: before.spaceManual } }));
    recompute("user");
    schedule();
    toast.error("Couldn't switch spaces", { description: friendlyError(e) });
  }
}

/** Switch to a space by hand (and open its agent, unless `open: false`). */
export async function switchSpace(space: Space, opts: { open?: boolean } = {}) {
  const now = Date.now();
  const { settings } = useApp.getState();
  const manual = manualFor(now, settings, space);
  const to = agentOf(useApp.getState().agents, space, useSpace.getState().available);
  if (opts.open !== false && to) ui.openAgent(to.id);
  if (JSON.stringify(manual) === JSON.stringify(settings.spaceManual ?? null)) return;
  await saveManual(manual);
}

/** The other space (⌘⇧M, the palette). */
export function toggleSpace() {
  const { space, available } = useSpace.getState();
  if (!available) return;
  void switchSpace(space === "work" ? "personal" : "work");
}

/** Follow the work hours (on), or stay in the current space until changed by hand (off). */
export async function setAutoSwitch(on: boolean) {
  const { space } = useSpace.getState();
  const manual = on ? null : { space, until: null };
  await saveManual(manual);
  if (on) {
    const to = activeAgent();
    const u = useUI.getState();
    // Back on the schedule: show its agent if the window shows the other lead.
    const shown = u.agentId ? useApp.getState().agents[u.agentId] : undefined;
    if (to && u.page === "agent" && shown?.space && shown.id !== to.id) ui.openAgent(to.id);
  }
}
