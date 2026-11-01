import { YoLogo } from "@yo/avatar";
import { Brain, CalendarClock, ListTodo, MessageCircle, Search, Settings, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { hasTrafficLights } from "../../lib/desktop";
import { cn, modKey } from "../../lib/utils";
import { sortAgents, useApp, usePrimaryAgent } from "../../stores/app";
import { load } from "../../stores/sync";
import { useTimeline } from "../../stores/timeline";
import { type Page, ui, useUI } from "../../stores/ui";
import { AgentAvatar } from "../brand";
import { TeamPanel } from "../Sidebar";
import { UpdateButton } from "../UpdateButton";
import { Popover, Tip } from "../ui/overlay";
import { ProfileMenu } from "../WorkspaceMenu";

/** The pages each rail item stands for (Tasks covers its tabs: Needs you and Activity). */
const TASK_PAGES: Page[] = ["tasks", "approvals", "activity"];

/**
 * The thin icon rail on the far left (Dots-style): Chat · Tasks · Routines · Make · Memory · Search,
 * then the Team (stacked faces; a popover with everyone), updates, Settings and you at the bottom. There's no
 * roster column: one agent is front and centre. On phones the rail becomes a floating tab bar at the foot.
 */
export function Rail() {
  // Yo: the logo talks to it, and Chat opens it when no chat is open yet.
  const lead = usePrimaryAgent();
  const approvals = useApp((s) => s.approvals);
  // Work ready for the user to look at (the Tasks page's "Ready for review").
  const reviews = useApp((s) =>
    lead ? (s.tasks[lead.id]?.filter((t) => t.status === "review").length ?? 0) : 0,
  );
  const page = useUI((s) => s.page);
  useEffect(() => {
    // The chat's "Next" chip, the inspector and the palette's Recent requests read these. A failed routines load
    // just hides them (the Routines page shows the retry).
    load.routines().catch(() => undefined);
    if (lead) void useTimeline.getState().load(lead.id);
    if (lead) load.tasks(lead.id).catch(() => undefined);
  }, [lead?.id]);
  const links = [
    {
      id: "chat",
      label: "Chat",
      icon: MessageCircle,
      active: page === "agent",
      action: () => {
        const open = useUI.getState().agentId;
        // Back to the chat that was open; the primary agent's when there's none.
        if (open && useApp.getState().agents[open]) ui.openAgent(open);
        else if (lead) ui.openAgent(lead.id);
      },
    },
    {
      id: "tasks",
      label: "Tasks",
      icon: ListTodo,
      active: TASK_PAGES.includes(page),
      action: () => ui.goto("tasks"),
      // What's waiting on you: approvals and work ready for review.
      badge: approvals.length + reviews,
    },
    {
      id: "routines",
      label: "Routines",
      icon: CalendarClock,
      active: page === "routines",
      action: () => ui.goto("routines"),
    },
    {
      id: "make",
      label: "Make",
      icon: Sparkles,
      active: page === "artifacts",
      action: () => ui.goto("artifacts"),
    },
    {
      id: "memory",
      label: "Memory",
      icon: Brain,
      active: page === "memory",
      action: () => ui.goto("memory"),
    },
    // Opens on Recent requests (the palette's empty state).
    {
      id: "search",
      label: "Search",
      icon: Search,
      active: false,
      shortcut: `${modKey}K`,
      action: () => useUI.setState({ paletteOpen: true }),
    },
  ];
  return (
    <nav
      className={cn("shell-rail", hasTrafficLights && "with-window-controls")}
      aria-label="Workspace"
      data-testid="sidebar"
    >
      {/* The Mac's close / minimize / zoom buttons sit here; in a browser, Yo's mark. */}
      <div className="shell-rail-top app-drag">
        {!hasTrafficLights && (
          <button
            type="button"
            className="shell-rail-brand"
            aria-label={`Talk to ${lead?.name ?? "Yo"}`}
            onClick={() => lead && ui.openAgent(lead.id)}
          >
            <YoLogo size={22} />
          </button>
        )}
      </div>
      <div className="shell-rail-links">
        {links.map((l) => (
          <Tip key={l.id} label={l.label} shortcut={l.shortcut} side="right">
            <button
              type="button"
              className={cn("shell-rail-link", l.active && "is-active")}
              aria-current={l.active ? "page" : undefined}
              aria-label={l.badge ? `${l.label}, ${l.badge} waiting` : l.label}
              onClick={l.action}
              data-testid={`rail-${l.id}`}
            >
              <l.icon strokeWidth={l.active ? 1.9 : 1.6} aria-hidden />
              <span className="shell-rail-label">{l.label}</span>
              {!!l.badge && (
                <b data-testid="rail-badge" aria-hidden>
                  {l.badge > 99 ? "99+" : l.badge}
                </b>
              )}
            </button>
          </Tip>
        ))}
      </div>
      <TeamButton />
      <div className="shell-rail-bottom">
        <span className="shell-rail-update">
          <UpdateButton />
        </span>
        <Tip label="Settings" shortcut={`${modKey},`} side="right">
          <button
            type="button"
            className="shell-rail-link"
            onClick={() => ui.openSettings()}
            aria-label="Settings"
            data-testid="rail-settings"
          >
            <Settings strokeWidth={1.6} aria-hidden />
            <span className="shell-rail-label">Settings</span>
          </button>
        </Tip>
        <ProfileMenu approvals={approvals.length} />
      </div>
    </nav>
  );
}

/**
 * The team, as stacked mini faces (up to three): opens a popover listing every teammate and what it's doing, to
 * switch (that teammate becomes the big head) or make a new one. A dot when one of them needs you or has news.
 * In the rail; on phones (no rail Team) in the chat's top-left, `compact`, opening downwards.
 */
export function TeamButton({ compact }: { compact?: boolean }) {
  const agents = useApp((s) => s.agents);
  const [open, setOpen] = useState(false);
  const team = useMemo(() => sortAgents(agents), [agents]);
  const openId = useUI((s) => s.agentId);
  const page = useUI((s) => s.page);
  // Picking someone closes the popover (also when their chat is the one already open, from another page).
  useEffect(() => setOpen(false), [openId, page]);
  const news = team.some((a) => a.id !== openId && (a.unread > 0 || a.activity === "waiting"));
  const faces = team.slice(0, compact ? 2 : 3);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side={compact ? "bottom" : "right"}
      align={compact ? "start" : "end"}
      sideOffset={compact ? 6 : 10}
      className="team-popover"
      label="Team"
      trigger={
        <button
          type="button"
          className={cn("shell-rail-team", open && "is-open")}
          aria-label={`Team, ${team.length} ${team.length === 1 ? "agent" : "agents"}${news ? ", something new" : ""}`}
          data-testid={compact ? "chat-team" : "rail-team"}
        >
          {faces.map((a) => (
            <span key={a.id} className="shell-rail-team-face">
              <AgentAvatar agent={a} size={30} quiet />
            </span>
          ))}
          {news && <i className="shell-rail-team-dot" data-testid="rail-team-dot" aria-hidden />}
        </button>
      }
    >
      <TeamPanel />
    </Popover>
  );
}
