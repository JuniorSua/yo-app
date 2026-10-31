import {
  Activity,
  Brain,
  CalendarClock,
  ChevronRight,
  ListTodo,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import { accountDetail, accountState } from "../lib/accounts";
import { cn, modKey } from "../lib/utils";
import { useApp } from "../stores/app";
import { type Page, ui, useUI } from "../stores/ui";
import { accountTone, PROVIDER_NAME, ProviderIcon, StatusDot } from "./brand";
import { Menu, MenuItem, MenuSeparator } from "./ui/overlay";

export const NAV: { page: Page; label: string; icon: typeof Activity }[] = [
  { page: "tasks", label: "Tasks", icon: ListTodo },
  { page: "activity", label: "Work history", icon: Activity },
  { page: "approvals", label: "Needs you", icon: ShieldCheck },
  { page: "routines", label: "Routines", icon: CalendarClock },
  { page: "memory", label: "Memory", icon: Brain },
  { page: "artifacts", label: "Make", icon: Sparkles },
];

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : parts[0]!.slice(0, 2)).toUpperCase();
}

/** Let the menu close and hand focus back to its trigger before a dialog takes it. */
const openAfterMenu = (open: () => void) => setTimeout(open, 0);

/** The rail's profile button (bottom left) and the workspace menu: the global pages, the default account, Settings. */
export function ProfileMenu({ approvals }: { approvals: number }) {
  const page = useUI((s) => s.page);
  const userName = useApp((s) => s.settings.userName);
  const accounts = useApp((s) => s.accounts);
  const acc = accounts.find((a) => a.isDefault) ?? accounts[0];
  const name = userName.trim() || "Workspace";
  const mono = initials(userName);
  const status = acc ? `${PROVIDER_NAME[acc.provider]} · ${accountState(acc)}` : "Connect a subscription";
  return (
    <Menu
      side="right"
      align="end"
      sideOffset={10}
      testId="profile-menu"
      className="w-[288px] max-w-[calc(100vw-24px)] rounded-[16px] p-1.5"
      trigger={
        <button
          type="button"
          data-testid="profile-trigger"
          className="shell-profile"
          aria-label={`${name}. ${status}. Workspace menu`}
          title={`${name} · ${status}`}
        >
          <span className="shell-profile-mono">{mono ?? <UserRound aria-hidden />}</span>
          {acc && <StatusDot tone={accountTone(acc)} className="shell-profile-dot" />}
        </button>
      }
    >
      <div className="px-2.5 pt-2 pb-2.5">
        <div className="font-medium">Your workspace</div>
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
