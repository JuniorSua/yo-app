import type {
  Account,
  ActivityEvent,
  AgentView,
  ApiPushes,
  ApprovalRule,
  Artifact,
  ComputerOverview,
  DeviceOperation,
  ExecutionStatus,
  LedgerTask,
  Memory,
  Placement,
  QueuedRequest,
  Routine,
  Settings,
  TimelineEntry,
} from "@yo/contracts";
import { DEFAULT_SETTINGS, isProviderEnabled } from "@yo/contracts";
import { create } from "zustand";
import type { ConnectionStatus } from "../lib/api";

export type LoginState = ApiPushes["account.login"];

export interface AppState {
  booted: boolean;
  connection: ConnectionStatus;
  version: string;
  settings: Settings;
  agents: Record<string, AgentView>;
  accounts: Account[];
  computer: ComputerOverview | null;
  logins: Record<string, LoginState>;
  approvals: TimelineEntry[];
  routines: Routine[] | null;
  memories: Memory[] | null;
  activity: ActivityEvent[] | null;
  artifacts: Artifact[] | null;
  rules: ApprovalRule[] | null;
  /**
   * Paired devices, grants and the Mac kill switches as core sees them. `null` = unavailable (a core
   * older than device support). Kept in memory only: grants never go to localStorage.
   */
  execution: ExecutionStatus | null;
  /** Recent operations on paired devices (loaded on demand, then kept live by pushes). */
  operations: DeviceOperation[] | null;
  /**
   * When each busy agent became busy, as this app saw it happen (agent.updated pushes). Missing for an agent
   * that was already busy when the app loaded; the chat then works it out from the conversation.
   */
  workingSince: Record<string, number>;
  /** The user's messages waiting for each agent's running task ("Up next"), kept live by queue.updated. */
  queues: Record<string, QueuedRequest[]>;
  /**
   * Each main agent's tasks as the Tasks page shows them (load.tasks), kept live by task.updated. An agent is only
   * here once its list was loaded.
   */
  tasks: Record<string, LedgerTask[]>;
  /** Core has no tasks.* (older than this app): the Tasks page is empty and offers no +. */
  tasksUnsupported: boolean;
}

export const useApp = create<AppState>(() => ({
  booted: false,
  connection: "connecting",
  version: "",
  settings: DEFAULT_SETTINGS,
  agents: {},
  accounts: [],
  computer: null,
  logins: {},
  approvals: [],
  routines: null,
  memories: null,
  activity: null,
  artifacts: null,
  rules: null,
  execution: null,
  operations: null,
  workingSince: {},
  queues: {},
  tasks: {},
  tasksUnsupported: false,
}));

/** Update `workingSince` for an agent push: start the clock when it gets busy, drop it once it's done. */
export function trackWorkingSince(
  since: Record<string, number>,
  prev: AgentView | undefined,
  next: AgentView,
  now = Date.now(),
): Record<string, number> {
  const busy = (a: AgentView | undefined) => a?.activity === "working" || a?.activity === "waiting";
  if (busy(next)) {
    if (next.id in since || busy(prev)) return since; // already counting (or busy before we saw it start)
    return { ...since, [next.id]: now };
  }
  if (!(next.id in since)) return since;
  const { [next.id]: _done, ...rest } = since;
  return rest;
}

/** Where a main agent sits: the Work agent (or the primary) first, then the Personal agent, then everyone else. */
function leadRank(a: AgentView): number {
  if (a.space === "work" || (a.isPrimary && a.space !== "personal")) return 0;
  return a.space === "personal" ? 1 : 2;
}

/**
 * Roster order: the main agents (Work, then Personal), then pinned, then most recently active. Helpers never
 * join the roster.
 */
export function sortAgents(agents: Record<string, AgentView>): AgentView[] {
  return Object.values(agents)
    .filter((a) => !a.archivedAt && a.kind !== "helper")
    .sort((a, b) => {
      const rank = leadRank(a) - leadRank(b);
      if (rank) return rank;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt);
    });
}

/** Yo's one-off helpers: their own chat isn't shown, so anything about one opens the chat that started it. */
export function chatFor(agents: Record<string, AgentView>, agentId: string): string {
  const a = agents[agentId];
  return a?.kind === "helper" && a.parentId ? a.parentId : agentId;
}

export function primaryAgent(agents: Record<string, AgentView>): AgentView | undefined {
  return Object.values(agents).find((a) => a.isPrimary) ?? sortAgents(agents)[0];
}

/**
 * Only accounts of providers Yo offers (ENABLED_PROVIDERS) ever reach the UI, even from an older core that
 * still sends an account of a provider this app no longer offers. An agent pinned to a hidden account then shows the default account, or
 * "Choose model" when there's no usable default.
 */
export function offeredAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => isProviderEnabled(a.provider));
}

/** Apply an `account.updated` push: upsert an offered account, drop a hidden one. */
export function applyAccountUpdate(accounts: Account[], a: Account): Account[] {
  if (!isProviderEnabled(a.provider)) return accounts.filter((x) => x.id !== a.id);
  return upsertById(accounts, a) ?? accounts;
}

export function accountFor(agent: AgentView | undefined, accounts: Account[]): Account | undefined {
  if (!agent) return undefined;
  return accounts.find((a) => a.id === agent.accountId) ?? accounts.find((a) => a.isDefault);
}

export function upsertById<T extends { id: string }>(list: T[] | null, item: T, prepend = false): T[] | null {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) {
    const next = [...list];
    next[i] = item;
    return next;
  }
  return prepend ? [item, ...list] : [...list, item];
}

export const PLACEMENT_LABEL: Record<Placement, string> = {
  "this-mac": "This Mac",
  "this-pc": "This PC",
  "home-pc": "Home PC",
  "custom-remote": "Remote computer",
};

/** Where the agent computer runs: core's execution status first, then the computer host it reports. */
export function usePlacement(): Placement | null {
  const runner = useApp((s) => s.execution?.runnerPlacement);
  const host = useApp((s) => s.computer?.host);
  return runner ?? host?.placement ?? (host?.kind === "local" ? "this-mac" : null);
}

/** Paired devices that haven't been unpaired. */
export function activeDevices(execution: ExecutionStatus | null) {
  return (execution?.devices ?? []).filter((d) => !d.revokedAt);
}

/** Grants that are still in force (not revoked, not expired). */
export function activeGrants(execution: ExecutionStatus | null, now = Date.now()) {
  return (execution?.grants ?? []).filter((g) => !g.revokedAt && (g.expiresAt === null || g.expiresAt > now));
}
