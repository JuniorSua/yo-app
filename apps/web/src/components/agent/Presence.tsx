import { type AgentView, isLead } from "@yo/contracts";
import {
  CalendarClock,
  Eye,
  Maximize2,
  MessageCircle,
  Minimize2,
  MoreHorizontal,
  Plus,
  Power,
  Settings2,
  ShieldCheck,
  SquarePen,
} from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  activeHelpers,
  type PresenceTone,
  presenceLine,
  presenceTone,
  runningStep,
} from "../../lib/presence";
import { useNow } from "../../lib/useNow";
import { clockTime, cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { useTimeline } from "../../stores/timeline";
import { ui, useUI } from "../../stores/ui";
import { AgentAvatar, pillFor, StatusPill } from "../brand";
import { TopBarButtons } from "../shell/TopBar";
import { Menu, MenuItem, Popover } from "../ui/overlay";
import { ModelPicker } from "./ModelPicker";

export function useMedia(query: string) {
  const [match, setMatch] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    const q = matchMedia(query);
    const on = () => setMatch(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** Wide enough for the computer pane beside the chat; narrower windows open the full-screen view instead. */
export const PANE_QUERY = "(min-width: 1024px)";

/** Tone, the "doing now" line (with how long, while working) and the one action that matters most. */
export function usePresence(agent: AgentView) {
  const agents = useApp((s) => s.agents);
  // The request it's waiting on: its own first, else one of its helpers'.
  const waiting = useApp((s) => (s.approvals.find((e) => e.agentId === agent.id) ?? s.approvals[0])?.request);
  const since = useApp((s) => s.workingSince[agent.id]);
  const step = useTimeline((s) => runningStep(s.byAgent[agent.id]));
  const tone = presenceTone(agent);
  const now = useNow(30_000, tone === "working" && !!since);
  const helpers = activeHelpers(agents, agent.id);
  let line = presenceLine({
    agent,
    tone,
    step,
    helpers,
    waitingOn: waiting?.title,
    asking: waiting?.kind === "user_input",
  });
  // Step titles mark commands with backticks ("Ran `ls`"); the line shows plain words.
  line = line.replace(/`/g, "");
  if (tone === "working" && since) line += ` · ${Math.max(1, Math.round((now - since) / 60_000))}m`;
  return { tone, line };
}

interface Action {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => void;
}

function actionsFor(agent: AgentView, tone: PresenceTone): { primary: Action; more: Action[] } {
  const wake: Action = {
    id: "wake",
    label: "Wake him up",
    icon: <Power />,
    run: () => run(api().call("computer.wake", { agentId: agent.id }), "Couldn't wake his computer"),
  };
  const review: Action = {
    id: "review",
    label: "Review what needs you",
    icon: <ShieldCheck />,
    run: () => ui.goto("approvals"),
  };
  const watch: Action = {
    id: "computer",
    label: tone === "working" ? "Watch him work" : "Watch his screen",
    icon: <Eye />,
    run: () => {
      if (matchMedia(PANE_QUERY).matches) useUI.setState({ workPaneOpen: true });
      else ui.openComputer(agent.id);
    },
  };
  const ask: Action = {
    id: "new",
    label: isLead(agent) ? "New request" : "Ask something",
    icon: isLead(agent) ? <Plus /> : <MessageCircle />,
    run: () => ui.focusComposer(agent.id),
  };
  const settings: Action = {
    id: "settings",
    label: "His settings",
    icon: <Settings2 />,
    run: () => useUI.setState({ agentSettingsId: agent.id }),
  };
  const primary =
    tone === "waiting"
      ? review
      : tone === "sleeping"
        ? wake
        : tone === "working" || tone === "control"
          ? watch
          : ask;
  return { primary, more: [watch, ask, settings].filter((a) => a !== primary) };
}

/** Clicking the assistant opens a small card: what he's doing, and the next useful thing to do. */
export function PresenceCard({
  agent,
  trigger,
  align = "start",
}: {
  agent: AgentView;
  trigger: ReactElement;
  align?: "start" | "center";
}) {
  const [open, setOpen] = useState(false);
  const { tone, line } = usePresence(agent);
  const { primary, more } = actionsFor(agent, tone);
  const go = (a: Action) => {
    setOpen(false);
    a.run();
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      align={align}
      sideOffset={10}
      className="presence-card"
    >
      <div data-testid="presence-card">
        <div className="presence-card-head">
          <strong>{agent.name}</strong>
          <StatusPill kind={pillFor(agent)} />
        </div>
        <p>{line}</p>
        <button
          className="presence-primary"
          data-testid={`presence-${primary.id}`}
          onClick={() => go(primary)}
        >
          {primary.icon}
          {primary.label}
        </button>
        <div className="presence-more">
          {more.map((a) => (
            <button key={a.id} data-testid={`presence-${a.id}`} onClick={() => go(a)}>
              {a.icon}
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );
}

/** Quiet chips along the top of the chat: what needs you and what's next. */
function PresenceChips() {
  const approvals = useApp((s) => s.approvals.length);
  const routines = useApp((s) => s.routines);
  const next = (routines ?? [])
    .filter((r) => r.enabled && r.nextRunAt)
    .sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0];
  return (
    <div className="chat-chips">
      {approvals > 0 && (
        <button
          className="chat-chip is-warning"
          data-testid="approvals-shortcut"
          onClick={() => ui.goto("approvals")}
        >
          <ShieldCheck />
          Needs you<b>{approvals}</b>
        </button>
      )}
      {next && (
        <button
          className="chat-chip"
          data-testid="next-routine"
          title={`Next routine: ${next.name} at ${clockTime(next.nextRunAt!)}`}
          onClick={() => {
            ui.goto("routines");
            useUI.setState({ focusRecordId: next.id });
          }}
        >
          <CalendarClock />
          <span>
            <em>Next: </em>
            <strong>{next.name}</strong>
          </span>
          <time>{clockTime(next.nextRunAt!)}</time>
        </button>
      )}
    </div>
  );
}

function AgentMenu({ agent }: { agent: AgentView }) {
  return (
    <Menu
      trigger={
        <button aria-label="Agent options" data-testid="agent-options" className="chat-icon-button">
          <MoreHorizontal />
        </button>
      }
    >
      <MenuItem icon={<Maximize2 />} testId="open-computer" onClick={() => ui.openComputer(agent.id)}>
        Open computer full screen
      </MenuItem>
      <MenuItem
        icon={<SquarePen />}
        testId="new-session"
        onClick={() => run(api().call("agent.newSession", { id: agent.id }))}
      >
        New session
      </MenuItem>
      <MenuItem
        icon={<Minimize2 />}
        testId="compact-conversation"
        onClick={() =>
          run(api().call("agent.compact", { id: agent.id }), "Couldn't compact the conversation")
        }
      >
        Compact conversation
      </MenuItem>
      <MenuItem
        icon={<Settings2 />}
        testId="open-agent-settings"
        onClick={() => useUI.setState({ agentSettingsId: agent.id })}
      >
        Agent settings
      </MenuItem>
    </Menu>
  );
}

/**
 * The chat's top bar, a quiet row beside the agent's head: what needs you, what's next, the agent's menu, then
 * the shell's computer button and inspector toggle at the far right.
 */
export function ChatBar({ agent }: { agent: AgentView }) {
  return (
    <div className="chat-bar app-drag">
      <PresenceChips />
      <AgentMenu agent={agent} />
      <TopBarButtons agent={agent} />
    </div>
  );
}

/**
 * The agent's head above the conversation, as in a messaging app: its avatar (live), a name pill hanging off
 * the bottom, the subscription and model it runs on (click to switch), and one calm line on what it's doing.
 * It folds into a slim title while you scroll back. `hero`: the bigger head of an empty chat, without the line.
 */
export function PresenceHeader({ agent, hero }: { agent: AgentView; hero?: boolean }) {
  const { tone, line } = usePresence(agent);
  const phone = useMedia("(max-width: 600px)");
  const compact = useCompactOnScroll() && !hero;
  const size = hero ? (phone ? 88 : 120) : phone ? 48 : 64;
  const Tag = hero ? "div" : "header";
  return (
    <Tag
      className={cn("chat-head", !hero && "app-drag", compact && "is-compact", hero && "is-hero")}
      data-testid={hero ? "presence-hero" : "presence-header"}
      data-tone={tone}
    >
      <PresenceCard
        agent={agent}
        align="center"
        trigger={
          <button
            className="chat-head-avatar"
            data-testid="presence-avatar"
            aria-label={`${agent.name}: what he’s doing and quick actions`}
          >
            <AgentAvatar agent={agent} size={size} ground={hero} live />
          </button>
        }
      />
      <div className="chat-head-name" data-testid="agent-title">
        {agent.name}
      </div>
      <div className="chat-head-meta">
        <ModelPicker agent={agent} />
        {!hero && (
          <div className="chat-head-status">
            <StatusPill kind={pillFor(agent)} />
            <span
              className={cn("chat-head-line", tone === "working" && "is-live")}
              data-testid="presence-line"
            >
              {line}
            </span>
          </div>
        )}
      </div>
    </Tag>
  );
}

/**
 * Slim head while reading back through the chat (scrolled well away from the newest message); full again near
 * the bottom. Hysteresis keeps the head's own height change from flipping it back.
 */
function useCompactOnScroll() {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement;
      if (el?.dataset?.testid !== "timeline") return;
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setCompact((c) => (c ? fromBottom > 60 : fromBottom > 280));
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, []);
  return compact;
}
