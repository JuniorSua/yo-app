import { type AgentView, isLead } from "@yo/contracts";
import { Archive, MoreHorizontal, Pin, PinOff, Plus, Settings, Star } from "lucide-react";
import { memo, useEffect, useMemo } from "react";
import { accentVars } from "../lib/accent";
import { api } from "../lib/api";
import { hasTrafficLights } from "../lib/desktop";
import { makeKindOf } from "../lib/make";
import { roster, rosterState } from "../lib/roster";
import { cn } from "../lib/utils";
import { useApp } from "../stores/app";
import { useSpace } from "../stores/space";
import { load, run } from "../stores/sync";
import { ui, useUI } from "../stores/ui";
import { openPage } from "./agent/Pages";
import { usePaintedTheme } from "./agent/paintedTheme";
import { AgentAvatar } from "./brand";
import { KindIcon } from "./pages/KindIcon";
import { SpaceTitle } from "./SpaceSwitch";
import { Menu, MenuItem, MenuSeparator, Tip } from "./ui/overlay";

/** How many pages the sidebar lists (pinned first, then the newest); the rest are on the Make page. */
const PAGE_LIMIT = 5;

/**
 * The sidebar is the team, like a contact list: the space's main agent first (with a star), then every teammate,
 * each with a live line on what it's doing. The faces are the navigation. Pages the team made sit below. Helpers
 * never join the roster (they show inside the chat that started them).
 */
export function Sidebar() {
  const agents = useApp((s) => s.agents);
  const space = useSpace((s) => s.space);
  const spaces = useSpace((s) => s.available);
  const openId = useUI((s) => (s.page === "agent" ? s.agentId : null));
  const team = useMemo(() => roster(agents, space, spaces), [agents, space, spaces]);
  return (
    <aside className="shell-sidebar" aria-label="Team" data-testid="roster">
      <div className={cn("shell-sidebar-head app-drag", hasTrafficLights && "with-window-controls")}>
        {spaces ? <SpaceTitle /> : <span className="shell-sidebar-title">Team</span>}
        <Tip label="New teammate" side="bottom">
          <button
            type="button"
            className="shell-icon-button"
            aria-label="New teammate"
            data-testid="new-agent"
            onClick={() => useUI.setState({ newAgentOpen: true })}
          >
            <Plus aria-hidden />
          </button>
        </Tip>
      </div>
      <div className="shell-sidebar-scroll">
        <section aria-labelledby="roster-agents">
          <h2 id="roster-agents" className="shell-section-label">
            Agents
          </h2>
          <ul className="roster-list">
            {team.map((a) => (
              <li key={a.id}>
                <AgentRow agent={a} agents={agents} active={a.id === openId} />
              </li>
            ))}
          </ul>
        </section>
        <RecentPages />
      </div>
    </aside>
  );
}

/** Memoized: a push about one agent re-renders only the rows whose agent (or its helpers) changed. */
const AgentRow = memo(function AgentRow({
  agent,
  agents,
  active,
}: {
  agent: AgentView;
  agents: Record<string, AgentView>;
  active: boolean;
}) {
  const theme = usePaintedTheme();
  const accent = useMemo(() => accentVars(agent.avatar, theme), [agent.avatar, theme]);
  const { tone, line } = rosterState(agent, agents);
  const lead = isLead(agent);
  const busy = tone === "working" || tone === "thinking";
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`agent-row-${agent.name}`}
      data-tone={tone}
      aria-current={active ? "page" : undefined}
      onClick={() => ui.openAgent(agent.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          ui.openAgent(agent.id);
        }
      }}
      className={cn("roster-row group", active && "is-active")}
      style={accent}
    >
      <span className="roster-avatar">
        <AgentAvatar agent={agent} size={28} quiet />
      </span>
      <span className="roster-text">
        <span className="roster-name">
          <span className="truncate">{agent.name}</span>
          {lead && <Star className="roster-star" aria-label="Main agent" />}
          {agent.pinned && !lead && <Pin className="roster-star" aria-label="Pinned" />}
        </span>
        <span className="roster-line" data-testid="agent-state">
          {line}
        </span>
      </span>
      <span className="roster-end" aria-hidden>
        {agent.unread > 0 && tone !== "waiting" ? (
          <i className="roster-unread" data-testid="unread-dot" />
        ) : busy ? (
          <i className="roster-online" />
        ) : null}
      </span>
      <div
        className="roster-menu"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Menu
          trigger={
            <button type="button" aria-label={`${agent.name} options`} className="shell-icon-button is-small">
              <MoreHorizontal aria-hidden />
            </button>
          }
        >
          {!lead && (
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
            Customize {agent.name}
          </MenuItem>
          {/* Yo and Pip can't be archived (turning Work & Personal off is the way). */}
          {!lead && (
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
});

/** Pages the team made (create_page): pinned first, then the newest. Opens them in the page viewer. */
function RecentPages() {
  const artifacts = useApp((s) => s.artifacts);
  useEffect(() => {
    load.artifacts().catch(() => undefined);
  }, []);
  const pages = useMemo(
    () =>
      (artifacts ?? [])
        .filter((a) => a.kind === "page")
        .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.createdAt - a.createdAt)
        .slice(0, PAGE_LIMIT),
    [artifacts],
  );
  if (!pages.length) return null;
  return (
    <section aria-labelledby="roster-pages">
      <h2 id="roster-pages" className="shell-section-label">
        Pages
      </h2>
      <ul className="roster-list">
        {pages.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="roster-page"
              data-testid="sidebar-page"
              onClick={() => openPage(p.id)}
              title={p.title}
            >
              <KindIcon kind={makeKindOf(p)} />
              <span className="truncate">{p.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
