import { type AgentView, isSpecialist } from "@yo/contracts";
import { Bot, ImageIcon, MessageCirclePlus, Plus, ScrollText, Trash2, Type, Users } from "lucide-react";
import { memo, type ReactElement, useEffect, useMemo, useState } from "react";
import { accentVars } from "../lib/accent";
import { api } from "../lib/api";
import { rosterState } from "../lib/roster";
import { ago, cn } from "../lib/utils";
import { primaryAgent, sortAgents, useApp } from "../stores/app";
import { run } from "../stores/sync";
import { ui, useUI } from "../stores/ui";
import { usePaintedTheme } from "./agent/paintedTheme";
import { AgentAvatar } from "./brand";
import { Menu, MenuItem, MenuSeparator, Popover, Tip } from "./ui/overlay";

/**
 * Yo's specialists (Dots, not Grok Bot): the user talks to Yo only, and Yo hands work to these standing teammates.
 * They sit at the top, by Yo's head, as small faces; a click opens the Team popover (every one of them, what each
 * one's job is and what it's doing). A specialist's own view is read-only: to give it work, you ask Yo.
 */

/** A specialist (docs/one-yo.md): core's `teamRole`, else (older cores) any long-lived agent that isn't Yo. */
export const isSpecialistAgent = (a: AgentView) =>
  a.teamRole ? a.teamRole === "specialist" : isSpecialist(a);

/** Every specialist, in roster order (pinned, then most recently active). Yo and one-off helpers aren't in it. */
export function specialistsOf(agents: Record<string, AgentView>): AgentView[] {
  return sortAgents(agents).filter(isSpecialistAgent);
}

export function useSpecialists(): AgentView[] {
  const agents = useApp((s) => s.agents);
  return useMemo(() => specialistsOf(agents), [agents]);
}

export const isBusy = (a: AgentView) => a.activity === "working" || a.activity === "waiting";

/** "Polestar desk": the specialist's job (`role`), or "" when none is set. */
export function jobLine(a: Pick<AgentView, "role">): string {
  const role = a.role.trim();
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : "";
}

/** Give Yo the specialist's work: Yo's chat with "@Pepe " (or any text) in its message box. */
export function askYo(text: string) {
  const yo = primaryAgent(useApp.getState().agents);
  if (yo) ui.prefillComposer(yo.id, text);
}

/** Open a specialist's read-only view (its work and its exchanges with Yo) in the chat column. */
export const viewSpecialist = (id: string) => ui.openAgent(id);

export const editSpecialist = (id: string) => useUI.setState({ agentSettingsId: id });

export function removeSpecialist(a: AgentView) {
  ui.confirm({
    title: `Remove ${a.name}?`,
    body: `${a.name} stops what it's doing, drops its queued work and turns its routines off. Yo stops handing it work. You can't bring it back from the app.`,
    action: `Remove ${a.name}`,
    run: () => run(api().call("agent.archive", { id: a.id })),
  });
}

/**
 * The Team popover around any trigger: the head's faces (opening downwards) or the rail's Team icon. It closes on
 * its own when you go somewhere (a View, Ask Yo, another page).
 */
export function TeamPopover({
  trigger,
  side = "bottom",
  align = "center",
}: {
  trigger: (open: boolean) => ReactElement;
  side?: "bottom" | "right";
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const openId = useUI((s) => s.agentId);
  const page = useUI((s) => s.page);
  const draft = useUI((s) => s.composerDraft);
  const editing = useUI((s) => !!s.agentSettingsId || !!s.confirm);
  useEffect(() => setOpen(false), [openId, page, draft, editing]);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side={side}
      align={align}
      sideOffset={side === "right" ? 10 : 8}
      className="team-popover"
      label="Team"
      trigger={trigger(open)}
    >
      <TeamPanel />
    </Popover>
  );
}

/** How many faces the head shows before a "+N". The popover always lists everyone. */
const FACES = 4;

/**
 * Yo's specialists as small faces beside its head: working ones first, each with a ring while it works (amber when
 * it needs you). Helpers keep their own heads on the other side. Opens the Team popover.
 */
export function TeamFaces({ size = 26 }: { size?: number }) {
  const team = useSpecialists();
  const shown = useMemo(() => {
    const busy = team.filter(isBusy);
    const rest = team.filter((a) => !isBusy(a));
    const order = [...busy, ...rest];
    return order.length > FACES ? order.slice(0, FACES - 1) : order;
  }, [team]);
  if (!team.length) return null;
  const more = team.length - shown.length;
  const working = team.filter(isBusy).length;
  return (
    <div className="chat-team-faces">
      <TeamPopover
        trigger={(open) => (
          <button
            type="button"
            className={cn("chat-team-button", open && "is-open")}
            data-testid="chat-team"
            aria-label={`Yo's team: ${team.length} ${team.length === 1 ? "specialist" : "specialists"}${working ? `, ${working} working` : ""}`}
          >
            {shown.map((a, i) => (
              <span
                key={a.id}
                className="chat-team-face"
                data-testid="team-face"
                data-working={a.activity === "working" || undefined}
                data-waiting={a.activity === "waiting" || undefined}
                style={{ zIndex: shown.length - i }}
              >
                <AgentAvatar agent={a} size={size} quiet />
              </span>
            ))}
            {more > 0 && (
              <span className="chat-team-face chat-team-more" data-testid="team-more">
                +{more}
              </span>
            )}
          </button>
        )}
      />
    </div>
  );
}

/**
 * The Team popover's card: every specialist with its face, name, job line, status and what it's on (or last did),
 * a View and an Edit for each, and "Ask Yo to add a specialist". Scrolls when there are many.
 */
export function TeamPanel() {
  const team = useSpecialists();
  const yo = useApp((s) => primaryAgent(s.agents));
  const openId = useUI((s) => (s.page === "agent" ? s.agentId : null));
  const agents = useApp((s) => s.agents);
  return (
    <section className="shell-sidebar team-panel" aria-label="Team" data-testid="roster">
      <div className="team-panel-head">
        <div className="min-w-0 flex-1">
          <span className="shell-sidebar-title">Team</span>
          <p className="team-panel-sub">
            {team.length
              ? `${yo?.name ?? "Yo"} hands work to ${team.length === 1 ? "this specialist" : `these ${team.length} specialists`}.`
              : `No specialists yet. ${yo?.name ?? "Yo"} does the work itself.`}
          </p>
        </div>
        <Tip label="New specialist" side="bottom">
          <button
            type="button"
            className="shell-icon-button"
            aria-label="New specialist"
            data-testid="new-agent"
            onClick={() => useUI.setState({ newAgentOpen: true })}
          >
            <Plus aria-hidden />
          </button>
        </Tip>
      </div>
      <div className="shell-sidebar-scroll team-panel-scroll" data-testid="team-list">
        <ul className="roster-list">
          {team.map((a) => (
            <li key={a.id}>
              <SpecialistRow agent={a} agents={agents} active={a.id === openId} />
            </li>
          ))}
        </ul>
      </div>
      <div className="team-panel-foot">
        <button
          type="button"
          className="team-ask-add"
          data-testid="ask-yo-add"
          onClick={() => askYo("Add a specialist for ")}
        >
          <MessageCirclePlus aria-hidden />
          Ask {yo?.name ?? "Yo"} to add a specialist
        </button>
      </div>
    </section>
  );
}

const STATUS: Record<string, string> = {
  working: "Working",
  thinking: "Working",
  control: "You have control",
  waiting: "Needs you",
  error: "Hit a problem",
  asleep: "Asleep",
  idle: "Idle",
};

/**
 * What it's on now (core's `currentTask` while busy, else its live line), else what it last did ("Brief ready: … ·
 * 3 min ago"), else that it hasn't started.
 */
function activityLine(agent: AgentView, line: string, tone: string): string {
  if (tone === "working" || tone === "thinking") return agent.currentTask?.trim() || line;
  if (tone === "control" || tone === "waiting" || tone === "error") return line;
  if (agent.preview) return `${agent.preview}${agent.lastActiveAt ? ` · ${ago(agent.lastActiveAt)}` : ""}`;
  return "No work yet";
}

/** Memoized: a push about one agent re-renders only its row. */
const SpecialistRow = memo(function SpecialistRow({
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
  const job = jobLine(agent);
  const busy = tone === "working" || tone === "thinking";
  return (
    <div
      data-testid={`agent-row-${agent.name}`}
      data-tone={tone}
      aria-current={active ? "page" : undefined}
      className={cn("roster-row team-row", active && "is-active")}
      style={accent}
    >
      <button
        type="button"
        className="team-row-main"
        onClick={() => viewSpecialist(agent.id)}
        aria-label={`View ${agent.name}`}
      >
        <span className="roster-avatar team-row-face" data-working={busy || undefined}>
          <AgentAvatar agent={agent} size={40} quiet />
        </span>
        <span className="roster-text">
          <span className="roster-name">
            <span className="truncate">{agent.name}</span>
            <span className="team-status" data-tone={tone} data-testid="agent-status">
              {STATUS[tone] ?? "Idle"}
            </span>
          </span>
          <span className={cn("team-job", !job && "is-empty")} data-testid="agent-job-line">
            {job || "No job set"}
          </span>
          <span className="roster-line" data-testid="agent-state">
            {activityLine(agent, line, tone)}
          </span>
        </span>
      </button>
      <div className="team-row-actions">
        {!job && (
          <button
            type="button"
            className="team-row-hint"
            onClick={() => editSpecialist(agent.id)}
            data-testid="agent-set-job"
          >
            Set a job
          </button>
        )}
        <button
          type="button"
          className="team-row-button"
          onClick={() => viewSpecialist(agent.id)}
          data-testid="agent-view"
        >
          View
        </button>
        <Menu
          testId="agent-edit-menu"
          trigger={
            <button
              type="button"
              className="team-row-button"
              aria-label={`Edit ${agent.name}`}
              data-testid="agent-edit"
            >
              Edit
            </button>
          }
        >
          <MenuItem icon={<Type />} onClick={() => editSpecialist(agent.id)} testId="edit-rename">
            Rename
          </MenuItem>
          <MenuItem icon={<ScrollText />} onClick={() => editSpecialist(agent.id)} testId="edit-job">
            Job and instructions
          </MenuItem>
          <MenuItem icon={<Bot />} onClick={() => editSpecialist(agent.id)} testId="edit-model">
            Model
          </MenuItem>
          <MenuItem icon={<ImageIcon />} onClick={() => editSpecialist(agent.id)} testId="edit-avatar">
            Avatar
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Trash2 />} onClick={() => removeSpecialist(agent)} testId="edit-remove">
            Remove {agent.name}
          </MenuItem>
        </Menu>
      </div>
    </div>
  );
});

/** The rail's single Team icon: the same popover, opening to the right. */
export function RailTeam() {
  const team = useSpecialists();
  const news = team.some((a) => a.activity === "waiting");
  return (
    <TeamPopover
      side="right"
      align="end"
      trigger={(open) => (
        <button
          type="button"
          className={cn("shell-rail-link shell-rail-team-link", open && "is-active")}
          aria-label={`Team, ${team.length} ${team.length === 1 ? "specialist" : "specialists"}${news ? ", one needs you" : ""}`}
          data-testid="rail-team"
        >
          <Users strokeWidth={1.6} aria-hidden />
          <span className="shell-rail-label">Team</span>
          {news && <i className="shell-rail-team-dot" data-testid="rail-team-dot" aria-hidden />}
        </button>
      )}
    />
  );
}
