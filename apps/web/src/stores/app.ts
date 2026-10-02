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
  Memory,
  Placement,
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
}));

/** Roster order: primary first, then pinned, then most recently active. */
export function sortAgents(agents: Record<string, AgentView>): AgentView[] {
  return Object.values(agents)
    .filter((a) => !a.archivedAt)
    .sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt);
    });
}

export function primaryAgent(agents: Record<string, AgentView>): AgentView | undefined {
  return Object.values(agents).find((a) => a.isPrimary) ?? sortAgents(agents)[0];
}

/**
 * Only accounts of providers Yo offers (ENABLED_PROVIDERS) ever reach the UI, even from an older core that
 * still sends, say, a Grok account. An agent pinned to a hidden account then shows the default account, or
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
