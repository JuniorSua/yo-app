import { YoWordmark } from "@yo/avatar";
import type { AgentView } from "@yo/contracts";
import {
  Activity,
  Archive,
  Brain,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Shapes,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useMemo } from "react";
import { accountDetail, accountState } from "../lib/accounts";
import { api } from "../lib/api";
import { hasTrafficLights } from "../lib/desktop";
import { cn, modKey, relTime } from "../lib/utils";
import { sortAgents, useApp } from "../stores/app";
import { run } from "../stores/sync";
import { type Page, ui, useUI } from "../stores/ui";
import { AgentAvatar, accountTone, PROVIDER_NAME, ProviderIcon, StatusDot } from "./brand";
import { UpdateButton } from "./UpdateButton";
import { UpdateNotice } from "./UpdateNotice";
import { Kbd } from "./ui/controls";
import { Menu, MenuItem, MenuSeparator, Tip } from "./ui/overlay";

function AgentRow({ agent, active }: { agent: AgentView; active: boolean }) {
  const working = agent.activity === "working";
  const waiting = agent.activity === "waiting";
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`agent-row-${agent.name}`}
      onClick={() => ui.openAgent(agent.id)}
      onKeyDown={(e) => e.key === "Enter" && ui.openAgent(agent.id)}
      className={cn(
        "group relative flex items-center gap-3 rounded-xl px-2.5 py-2.5 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-link/50",
        active ? "bg-active" : "hover:bg-hover",
      )}
    >
      <AgentAvatar agent={agent} size={42} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="max-w-[62%] shrink-0 truncate font-medium text-fg">{agent.name}</span>
          <span data-testid="agent-role" className="min-w-0 truncate text-faint text-xs">
            {agent.role}
          </span>
          {agent.pinned && !agent.isPrimary && <Pin className="size-3 shrink-0 text-faint" />}
          <span className="ml-auto shrink-0 self-center text-2xs text-faint tabular-nums group-hover:opacity-0">
            {relTime(agent.lastActiveAt)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              working ? "shimmer-text" : waiting ? "text-warning" : agent.unread ? "text-fg-2" : "text-muted",
            )}
          >
            {agent.preview ?? "No messages yet"}
          </span>
          {agent.unread > 0 && !waiting && (
            <span data-testid="unread-dot" className="size-2 shrink-0 rounded-full bg-link" />
          )}
          {waiting && <span className="size-2 shrink-0 rounded-full bg-warning pulse-dot" />}
        </div>
      </div>
      <div
        className="-translate-y-1/2 absolute top-[22px] right-1.5 opacity-0 transition-opacity group-hover:opacity-100 has-[[data-popup-open]]:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <Menu
          trigger={
            <button
              aria-label="Agent options"
              className="grid size-6 place-items-center rounded-md text-muted hover:bg-active hover:text-fg"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          }
        >
          {!agent.isPrimary && (
            <MenuItem
              icon={agent.pinned ? <PinOff /> : <Pin />}
              onClick={() =>
                run(api().call("agent.update", { id: agent.id, patch: { pinned: !agent.pinned } }))
              }
            >
              {agent.pinned ? "Unpin" : "Pin to top"}
            </MenuItem>
          )}
          <MenuItem icon={<Settings />} onClick={() => useUI.setState({ agentSettingsId: agent.id })}>
            Agent settings
          </MenuItem>
          {!agent.isPrimary && (
            <>
              <MenuSeparator />
              <MenuItem
                danger
                icon={<Archive />}
                onClick={() => run(api().call("agent.archive", { id: agent.id }))}
              >
                Archive
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </div>
  );
}

export const NAV: { page: Page; label: string; icon: typeof Activity }[] = [
  { page: "activity", label: "Activity", icon: Activity },
  { page: "approvals", label: "Approvals", icon: ShieldCheck },
  { page: "routines", label: "Routines", icon: CalendarClock },
  { page: "memory", label: "Memory", icon: Brain },
  { page: "artifacts", label: "Artifacts", icon: Shapes },
];

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : parts[0]!.slice(0, 2)).toUpperCase();
}

/** Let the menu close and hand focus back to its trigger before a dialog takes it. */
const openAfterMenu = (open: () => void) => setTimeout(open, 0);

function ApprovalsShortcut({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <button
      data-testid="approvals-shortcut"
      aria-label={`Needs approval, ${count} ${count === 1 ? "request" : "requests"}`}
      onClick={() => ui.goto("approvals")}
      className="mb-1.5 flex h-9 w-full items-center gap-2.5 rounded-[10px] bg-warning/8 px-3 text-sm text-warning transition-colors hover:bg-warning/14 animate-rise"
    >
      <ShieldCheck className="size-4" strokeWidth={1.8} />
      Needs approval
      <span
        data-testid="approvals-badge"
        className="ml-auto grid h-[18px] min-w-[18px] place-items-center rounded-md bg-warning/15 px-1.5 font-semibold text-xs tabular-nums"
      >
        {count}
      </span>
    </button>
  );
}

/** Bottom-left profile trigger + workspace menu (the five global pages, the default account, Settings). */
function ProfileMenu({ approvals }: { approvals: number }) {
  const page = useUI((s) => s.page);
  const userName = useApp((s) => s.settings.userName);
  const accounts = useApp((s) => s.accounts);
  const acc = accounts.find((a) => a.isDefault) ?? accounts[0];
  const name = userName.trim() || "Workspace";
  const mono = initials(userName);
  return (
    <Menu
      side="top"
      align="start"
      sideOffset={8}
      testId="profile-menu"
      className="w-[288px] max-w-[calc(100vw-24px)] rounded-[17px] p-2"
      trigger={
        <button
          data-testid="profile-trigger"
          className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-hover data-[popup-open]:bg-active"
        >
          <span className="grid size-[34px] shrink-0 place-items-center rounded-full border border-border-strong bg-elevated font-semibold text-xs text-fg-2">
            {mono ?? <UserRound className="size-4 text-muted" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{name}</span>
            <span className="flex items-center gap-1.5 truncate text-muted text-xs">
              {acc ? (
                <>
                  <StatusDot tone={accountTone(acc)} />
                  <span className="truncate">
                    {PROVIDER_NAME[acc.provider]} · {accountState(acc)}
                  </span>
                </>
              ) : (
                "Connect a subscription"
              )}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted" />
        </button>
      }
    >
      <div className="px-2.5 pt-2 pb-2.5">
        <div className="font-medium">Your workspace</div>
        <div className="text-muted text-xs">Across all agents</div>
      </div>
      {NAV.map((n) => (
        <MenuItem
          key={n.page}
          testId={`nav-${n.page}`}
          icon={<n.icon strokeWidth={1.8} />}
          onClick={() => ui.goto(n.page)}
          className={cn("h-9", page === n.page && "bg-active")}
          trailing={
            n.page === "approvals" && approvals > 0 ? (
              <span className="grid h-[18px] min-w-[18px] place-items-center rounded-md bg-warning/15 px-1.5 font-semibold text-warning text-xs tabular-nums">
                {approvals}
              </span>
            ) : undefined
          }
        >
          {n.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        testId="account-chip"
        onClick={() => openAfterMenu(() => ui.openSettings("accounts"))}
        className="h-auto py-2"
        icon={
          acc ? (
            <span className="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-card">
              <ProviderIcon provider={acc.provider} className="!size-[17px]" />
            </span>
          ) : undefined
        }
        trailing={<ChevronRight />}
      >
        {acc ? (
          <span className="min-w-0">
            <span className="flex items-center gap-2 font-medium">
              {PROVIDER_NAME[acc.provider]}
              {acc.isDefault && accounts.length > 1 && (
                <span className="rounded-md bg-active px-1.5 font-normal text-2xs text-muted leading-[18px]">
                  Default
                </span>
              )}
            </span>
            <span className="flex items-center gap-1.5 truncate text-muted text-xs">
              <StatusDot tone={accountTone(acc)} />
              <span className="truncate">{accountDetail(acc)}</span>
            </span>
          </span>
        ) : (
          <span className="text-muted">Connect a subscription</span>
        )}
      </MenuItem>
      <MenuItem
        testId="open-settings"
        icon={<Settings strokeWidth={1.8} />}
        onClick={() => openAfterMenu(() => ui.openSettings())}
        className="h-9"
        trailing={<span className="text-faint text-xs">{modKey},</span>}
      >
        Settings
      </MenuItem>
    </Menu>
  );
}

export function Sidebar() {
  const agents = useApp((s) => s.agents);
  const approvals = useApp((s) => s.approvals.length);
  const { page, agentId, sidebarCollapsed, search } = useUI();
  const roster = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sortAgents(agents).filter(
      (a) => !q || a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q),
    );
  }, [agents, search]);

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        "relative flex h-full shrink-0 flex-col overflow-hidden border-border bg-sidebar transition-[width,border-color] duration-200 ease-out-soft",
        sidebarCollapsed ? "w-0 border-transparent" : "w-[276px] border-r max-[1100px]:w-[248px]",
      )}
    >
      <div className="flex h-full w-[276px] flex-col max-[1100px]:w-[248px]">
        <div
          className={cn(
            "app-drag flex h-[52px] shrink-0 items-center gap-2 pr-2.5 pl-4",
            hasTrafficLights && "pl-[84px]",
          )}
        >
          <YoWordmark size={22} />
          <div className="flex-1" />
          <Tip label="Hide sidebar" shortcut={`${modKey}\\`} side="bottom">
            <button
              aria-label="Hide sidebar"
              onClick={() => useUI.setState({ sidebarCollapsed: true })}
              className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <PanelLeftClose className="size-[17px]" />
            </button>
          </Tip>
        </div>

        <div className="space-y-2 px-2.5 pt-1.5 pb-2">
          <button
            data-testid="new-agent"
            onClick={() => useUI.setState({ newAgentOpen: true })}
            className="flex h-9 w-full items-center gap-2.5 rounded-xl border border-border-strong/60 bg-elevated px-3 font-medium shadow-soft transition-colors hover:border-border-strong hover:bg-hover"
          >
            <Plus className="size-4" />
            New agent
            <span className="ml-auto flex gap-0.5">
              <Kbd>{modKey}</Kbd>
              <Kbd>N</Kbd>
            </span>
          </button>
          <div className="relative">
            <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-3.5 text-faint" />
            <input
              value={search}
              onChange={(e) => useUI.setState({ search: e.target.value })}
              placeholder="Search agents"
              className="h-8 w-full rounded-[10px] bg-transparent pr-12 pl-8.5 text-sm outline-none transition-colors placeholder:text-faint hover:bg-hover focus:bg-hover"
            />
            <button
              onClick={() => useUI.setState({ paletteOpen: true })}
              className="-translate-y-1/2 absolute top-1/2 right-2 flex gap-0.5"
              aria-label="Open command palette"
            >
              <Kbd>{modKey}</Kbd>
              <Kbd>K</Kbd>
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between px-5 pt-2 pb-1.5">
          <span className="text-muted text-xs">Your agents</span>
          <span className="text-faint text-xs tabular-nums">{roster.length}</span>
        </div>
        <nav
          data-testid="roster"
          className="scroll-fade min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-3 [--scroll-fade:20px]"
        >
          {roster.map((a) => (
            <AgentRow key={a.id} agent={a} active={page === "agent" && agentId === a.id} />
          ))}
          {roster.length === 0 && (
            <div className="px-3 py-6 text-center text-muted text-sm">No agents match “{search}”</div>
          )}
        </nav>

        <div className="px-2.5 pt-1 pb-2.5">
          {!sidebarCollapsed && <UpdateNotice />}
          <ApprovalsShortcut count={approvals} />
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <ProfileMenu approvals={approvals} />
            </div>
            <UpdateButton />
          </div>
        </div>
      </div>
    </aside>
  );
}
