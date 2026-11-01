import { YoLogo } from "@yo/avatar";
import { Brain, CalendarClock, ListTodo, MessageCircle, Search, Settings, Sparkles } from "lucide-react";
import { useEffect } from "react";
import { hasTrafficLights } from "../../lib/desktop";
import { cn, modKey } from "../../lib/utils";
import { useApp, usePrimaryAgent } from "../../stores/app";
import { load } from "../../stores/sync";
import { useTimeline } from "../../stores/timeline";
import { type Page, ui, useUI } from "../../stores/ui";
import { RailTeam } from "../Team";
import { UpdateButton } from "../UpdateButton";
import { Tip } from "../ui/overlay";
import { ProfileMenu } from "../WorkspaceMenu";

/** The pages each rail item stands for (Tasks covers its tabs: Needs you and Activity). */
const TASK_PAGES: Page[] = ["tasks", "approvals", "activity"];

/**
 * The thin icon rail on the far left (Dots-style): Chat · Tasks · Routines · Make · Memory · Search,
 * then Team (one icon; the same popover as the faces by Yo's head), updates, Settings and you at the bottom. Yo is
 * front and centre: its specialists are a side view, never a chat of their own. On phones the rail becomes a floating tab bar at the foot.
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
  const agentId = useUI((s) => s.agentId);
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
      // Yo is home: Chat always brings you back to Yo (a specialist's view is a side trip).
      active: page === "agent" && (!agentId || agentId === lead?.id),
      action: () => lead && ui.openAgent(lead.id),
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
      <RailTeam />
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
