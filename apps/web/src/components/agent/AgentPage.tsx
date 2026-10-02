import type { AgentView } from "@yo/contracts";
import {
  CalendarClock,
  Minimize2,
  Monitor,
  MoreHorizontal,
  PanelRight,
  Plane,
  Search,
  Settings2,
  ShoppingBag,
  SquarePen,
} from "lucide-react";
import { useEffect } from "react";
import { api } from "../../lib/api";
import { cn, modKey } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { useTimeline } from "../../stores/timeline";
import { ui, useUI } from "../../stores/ui";
import { AgentAvatar, pillFor, StatusPill } from "../brand";
import { PageHeader } from "../PageHeader";
import { SetupBanner, SetupChat, useSetupChat } from "../setup/SetupChat";
import { Spinner } from "../ui/controls";
import { Menu, MenuItem, Tip } from "../ui/overlay";
import { Composer, composerBus } from "./Composer";
import { Timeline } from "./Timeline";
import { WorkPane } from "./WorkPane";

function HeaderButton({
  label,
  shortcut,
  onClick,
  children,
  testId,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Tip label={label} shortcut={shortcut} side="bottom">
      <button
        aria-label={label}
        data-testid={testId}
        onClick={onClick}
        className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg [&_svg]:size-[17px]"
      >
        {children}
      </button>
    </Tip>
  );
}

function AgentHeader({ agent }: { agent: AgentView }) {
  const workPaneOpen = useUI((s) => s.workPaneOpen);
  return (
    <PageHeader>
      <div className="flex min-w-0 items-center gap-2.5">
        <AgentAvatar agent={agent} size={30} />
        <div className="min-w-0 leading-tight">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold" data-testid="agent-title">
              {agent.name}
            </span>
            <StatusPill kind={pillFor(agent)} />
          </div>
          <div className="truncate text-muted text-xs">{agent.role}</div>
        </div>
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-0.5">
        <Tip label={workPaneOpen ? "Hide workspace" : "Show workspace"} shortcut={`${modKey}.`} side="bottom">
          <button
            data-testid="toggle-workspace"
            aria-expanded={workPaneOpen}
            onClick={() => useUI.setState({ workPaneOpen: !workPaneOpen })}
            className={cn(
              "hidden h-8 items-center gap-2 rounded-lg px-2.5 text-fg-2 text-sm transition-colors hover:bg-hover hover:text-fg xl:flex",
              workPaneOpen && "bg-active text-fg",
            )}
          >
            <PanelRight className="size-4 text-muted" />
            Workspace
          </button>
        </Tip>
        <HeaderButton label="Open computer" testId="open-computer" onClick={() => ui.openComputer(agent.id)}>
          <Monitor />
        </HeaderButton>
        <Menu
          trigger={
            <button
              aria-label="Agent options"
              data-testid="agent-options"
              className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg data-[popup-open]:bg-active [&_svg]:size-[17px]"
            >
              <MoreHorizontal />
            </button>
          }
        >
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
      </div>
    </PageHeader>
  );
}

const SUGGESTIONS = [
  { icon: Plane, text: "Find me a flight to Lisbon in October" },
  { icon: Search, text: "Research the best standing desks under $600" },
  { icon: CalendarClock, text: "Every morning, summarize the top AI news for me" },
  { icon: ShoppingBag, text: "Buy me a USB-C charging cable under $15" },
];

function EmptyState({ agent }: { agent: AgentView }) {
  const userName = useApp((s) => s.settings.userName);
  return (
    <div
      className="scroll-fade flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6"
      data-testid="empty-state"
    >
      <div className="flex max-w-[620px] flex-col items-center text-center animate-rise">
        <div className="relative">
          <div className="-inset-10 absolute rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--brand)_14%,transparent),transparent)] blur-xl" />
          <AgentAvatar agent={agent} size={128} ground className="relative" />
        </div>
        <h2 className="mt-5 font-semibold text-3xl tracking-[-0.025em]">
          {userName ? `Hey ${userName}, I'm ${agent.name}.` : `Hi, I'm ${agent.name}.`}
        </h2>
        <p className="mt-2 max-w-md text-md text-muted">
          {agent.isPrimary
            ? "I have my own computer and browser. Tell me what you need done — I'll handle it and check in when it matters."
            : `${agent.role}. I work on my own computer and ask before anything important.`}
        </p>
        <div className="mt-7 grid w-full grid-cols-2 gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.text}
              data-testid="suggestion"
              onClick={() => composerBus.send?.(s.text)}
              className="group flex items-center gap-3 rounded-2xl border border-border bg-card shadow-card px-4 py-3 text-left text-sm transition-all duration-200 hover:-translate-y-px hover:border-border-strong hover:bg-elevated hover:shadow-soft"
            >
              <s.icon className="size-4 shrink-0 text-muted transition-colors group-hover:text-fg" />
              <span className="text-fg-2 group-hover:text-fg">{s.text}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AgentPage() {
  const agentId = useUI((s) => s.agentId);
  const workPaneOpen = useUI((s) => s.workPaneOpen);
  const agent = useApp((s) => (agentId ? s.agents[agentId] : undefined));
  const entries = useTimeline((s) => (agentId ? s.byAgent[agentId] : undefined));
  const loaded = useTimeline((s) => (agentId ? s.loaded[agentId] : false));
  const setupChat = useSetupChat(agent);

  useEffect(() => {
    if (!agentId) return;
    void useTimeline.getState().load(agentId);
    const a = useApp.getState().agents[agentId];
    if (a?.unread) void api().call("agent.markRead", { id: agentId });
  }, [agentId]);

  if (!agent) return null;
  const empty = loaded && (entries?.length ?? 0) === 0;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <AgentHeader agent={agent} />
        {/* First run: the agent sets up its own computer (components/setup). */}
        {setupChat ? (
          <SetupChat agent={agent} />
        ) : !loaded ? (
          <div className="grid flex-1 place-items-center text-muted">
            <Spinner className="size-5" />
          </div>
        ) : empty ? (
          <EmptyState agent={agent} />
        ) : (
          <Timeline agent={agent} entries={entries ?? []} />
        )}
        {!setupChat && <SetupBanner />}
        {!setupChat && <Composer agent={agent} />}
      </div>
      <div className={cn("hidden xl:flex", workPaneOpen ? "" : "xl:hidden")}>
        {workPaneOpen && <WorkPane agent={agent} />}
      </div>
    </div>
  );
}
