import type { AgentView, Artifact, LedgerTask, TodoEntry } from "@yo/contracts";
import {
  CalendarClock,
  Check,
  ChevronRight,
  Circle,
  CornerDownRight,
  Eye,
  Hand,
  LoaderCircle,
  Power,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { accentVars } from "../../lib/accent";
import { PROVIDER_NAME, usesApiKey } from "../../lib/accounts";
import { api } from "../../lib/api";
import { makeKindOf } from "../../lib/make";
import { activeHelpers } from "../../lib/presence";
import { rosterState } from "../../lib/roster";
import { whenLabel } from "../../lib/utils";
import { accountFor, chatFor, useApp } from "../../stores/app";
import { load, run } from "../../stores/sync";
import { ui, useUI } from "../../stores/ui";
import { modelInfo, shortModel } from "../agent/ModelPicker";
import { openPage } from "../agent/Pages";
import { usePaintedTheme } from "../agent/paintedTheme";
import { AgentAvatar, ProviderIcon } from "../brand";
import { ScreenView } from "../computer/ScreenView";
import { KindIcon } from "../pages/KindIcon";
import { Button } from "../ui/button";

const NO_QUEUE: never[] = [];
/** Rows per list before "See all" takes over. */
const ACTIVITY_ROWS = 6;
const LIST_ROWS = 4;

/**
 * The inspector beside the chat: the Dots profile panel, kept open. Who the agent is and what it runs on, its
 * computer, what it's doing (Activity), what it will do (Scheduled) and what it made (Outputs). The chat bar's
 * inspector button (or ⌘\) hides it.
 */
export function Inspector({ agent }: { agent: AgentView }) {
  const theme = usePaintedTheme();
  const accent = useMemo(() => accentVars(agent.avatar, theme), [agent.avatar, theme]);
  const agents = useApp((s) => s.agents);
  const { tone, line } = rosterState(agent, agents);
  useEffect(() => {
    if (agent.kind !== "helper") load.tasks(agent.id).catch(() => undefined);
    load.artifacts().catch(() => undefined);
  }, [agent.id, agent.kind]);
  return (
    <aside
      className="shell-inspector animate-panel-in"
      data-testid="work-pane"
      aria-label={`${agent.name}’s profile`}
      style={accent}
    >
      <div className="inspector-scroll">
        <header className="inspector-head">
          <AgentAvatar agent={agent} size={64} quiet />
          <div className="min-w-0">
            <h2 className="inspector-name">{agent.name}</h2>
            <p className="inspector-line" data-tone={tone}>
              {line}
            </p>
          </div>
        </header>
        <ModelChip agent={agent} />
        <ComputerCard agent={agent} />
        <ActivityList agent={agent} />
        <Scheduled agent={agent} />
        <Outputs agent={agent} />
      </div>
    </aside>
  );
}

/** What the agent runs on, and whose subscription that is. Opens its settings to switch. */
function ModelChip({ agent }: { agent: AgentView }) {
  const accounts = useApp((s) => s.accounts);
  const acc = accountFor(agent, accounts);
  if (!acc)
    return (
      <button type="button" className="inspector-model" onClick={() => ui.openSettings("accounts")}>
        <span className="inspector-model-name">Choose a model</span>
        <span className="inspector-model-note">Connect a subscription to start</span>
      </button>
    );
  const model = shortModel(modelInfo(acc, agent.model)?.label);
  const provider = PROVIDER_NAME[acc.provider];
  return (
    <button
      type="button"
      className="inspector-model"
      data-testid="inspector-model"
      onClick={() => useUI.setState({ agentSettingsId: agent.id })}
      aria-label={`${provider}${model ? ` · ${model}` : ""}. Change model`}
    >
      <span className="inspector-model-name">
        <ProviderIcon provider={acc.provider} className="size-3.5" />
        {provider}
        {model && <span className="text-muted">· {model}</span>}
        <ChevronRight className="ml-auto size-3.5 text-faint" aria-hidden />
      </span>
      <span className="inspector-model-note">
        {acc && acc.status !== "authenticated"
          ? `Your ${provider} subscription isn't connected`
          : usesApiKey(acc)
            ? `Uses your ${provider} API key`
            : `Uses your ${provider} subscription`}
      </span>
    </button>
  );
}

function computerStatus(agent: AgentView, running: boolean): { label: string; tone: string } {
  if (!running) return { label: "Off", tone: "off" };
  if (agent.computer.lease === "user") return { label: "You have control", tone: "control" };
  switch (agent.computer.state) {
    case "ready":
      return agent.activity === "working"
        ? { label: "Busy", tone: "busy" }
        : { label: "Ready", tone: "ready" };
    case "booting":
      return { label: "Waking up…", tone: "busy" };
    case "error":
      return { label: "Something went wrong", tone: "error" };
    default:
      return { label: "Asleep", tone: "off" };
  }
}

/**
 * The agent's computer: a live thumbnail while it works (or you have control), a still card otherwise so an idle
 * screen costs nothing. Watch opens it full screen; Take over hands you the mouse.
 */
function ComputerCard({ agent }: { agent: AgentView }) {
  const runtime = useApp((s) => s.computer?.runtime);
  // Never set up on this Mac (the customer picked "Do this later"): setting it up is the next step.
  const notSetUp = useApp(
    (s) => s.computer?.host.kind === "local" && (s.settings.computerSetup ?? "done") !== "done",
  );
  const owner = useApp((s) => Object.values(s.agents).find((a) => a.isPrimary)?.name ?? "Yo");
  const [busy, setBusy] = useState(false);
  const running = runtime === "running";
  const st = computerStatus(agent, running);
  const ready = running && agent.computer.state === "ready";
  const live = ready && (agent.activity === "working" || agent.computer.lease === "user");
  const asleep = running && (agent.computer.state === "hibernated" || agent.computer.state === "off");
  const hint = !running
    ? notSetUp
      ? `${owner}'s computer isn't set up yet. You can set it up in Settings → Computer.`
      : `Start ${owner}'s computer in Settings → Computer to see the live screen.`
    : null;
  const takeOver = async () => {
    setBusy(true);
    await run(api().call("computer.takeover", { agentId: agent.id }));
    setBusy(false);
    ui.openComputer(agent.id);
  };
  return (
    <Section title="Computer">
      <div className="inspector-computer" data-state={st.tone} data-live={live || undefined}>
        {live && (
          <button
            type="button"
            className="inspector-screen"
            data-testid="screen-preview"
            aria-label={`Watch ${agent.name}’s computer`}
            onClick={() => ui.openComputer(agent.id)}
          >
            <span className="inspector-screen-live">
              <ScreenView agent={agent} />
            </span>
          </button>
        )}
        <div className="inspector-computer-row">
          {!live && (
            <button
              type="button"
              className="inspector-thumb"
              data-testid="screen-preview"
              aria-label={`Watch ${agent.name}’s computer`}
              onClick={() => ui.openComputer(agent.id)}
            >
              <AgentAvatar agent={agent} size={24} quiet state={asleep || !running ? "sleeping" : "idle"} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{agent.name}’s computer</div>
            <div className="inspector-computer-status" data-testid="computer-status">
              <i aria-hidden />
              {notSetUp && !running ? "Not set up yet" : st.label}
            </div>
          </div>
        </div>
        {hint && (
          <p className="inspector-note" data-testid="screen-off-hint">
            {hint}
          </p>
        )}
        {running && (
          <div className="inspector-computer-actions">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => ui.openComputer(agent.id)}
              data-testid="open-computer-pane"
            >
              <Eye className="size-3.5" /> Watch
            </Button>
            {asleep ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => run(api().call("computer.wake", { agentId: agent.id }))}
              >
                <Power className="size-3.5" /> Wake
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || agent.computer.state !== "ready" || agent.computer.lease === "user"}
                onClick={takeOver}
                data-testid="pane-take-over"
              >
                <Hand className="size-3.5" /> Take over
              </Button>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

interface Row {
  key: string;
  testId: string;
  icon: ReactNode;
  title: string;
  sub?: string;
  /** Something new for the user (an accent dot, as in Dots). */
  fresh?: boolean;
  onClick?: () => void;
}

const TASK_ICON: Partial<Record<LedgerTask["status"], ReactNode>> = {
  in_progress: <LoaderCircle className="is-spinning" />,
  waiting: <ShieldCheck />,
  review: <Check />,
  open: <Circle />,
  done: <Check />,
};

const TODO_ICON: Record<TodoEntry["status"], ReactNode> = {
  completed: <Check />,
  in_progress: <LoaderCircle className="is-spinning" />,
  pending: <Circle />,
};

/**
 * What the agent is doing, newest concern first: what needs you, its helpers, the steps of the job in hand, its
 * tasks, then your messages waiting their turn.
 */
function ActivityList({ agent }: { agent: AgentView }) {
  const agents = useApp((s) => s.agents);
  const approvals = useApp((s) => s.approvals);
  const tasks = useApp((s) => s.tasks[agent.id]);
  const queue = useApp((s) => s.queues[agent.id]) ?? NO_QUEUE;
  const rows: Row[] = [];
  for (const e of approvals)
    if (chatFor(agents, e.agentId) === agent.id)
      rows.push({
        key: e.id,
        testId: "pane-approval",
        icon: <ShieldCheck className="text-warning" />,
        title: e.request?.title ?? "Needs your OK",
        sub: "Needs you",
        fresh: true,
        onClick: () =>
          e.agentId === agent.id ? useUI.setState({ focusEntryId: e.id }) : ui.goto("approvals"),
      });
  for (const h of activeHelpers(agents, agent.id))
    rows.push({
      key: h.id,
      testId: "pane-helper",
      icon: <Sparkles />,
      title: h.name,
      sub: h.activity === "waiting" ? "Helper · waiting on you" : "Helper · working",
    });
  if (agent.activity === "working")
    for (const [i, t] of agent.todos.entries())
      rows.push({ key: `todo-${i}`, testId: "pane-todo", icon: TODO_ICON[t.status], title: t.text });
  const open = (tasks ?? [])
    .filter((t) => ["review", "in_progress", "waiting", "open", "done"].includes(t.status))
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  for (const t of open)
    rows.push({
      key: t.id,
      testId: "pane-task",
      icon: TASK_ICON[t.status],
      title: t.title,
      fresh: t.status === "review",
      onClick: () => {
        ui.goto("tasks");
        useUI.setState({ focusRecordId: t.id });
      },
    });
  for (const [i, q] of queue.entries())
    rows.push({
      key: q.id,
      testId: "pane-queued",
      icon: <CornerDownRight />,
      title: q.text,
      sub: `Up next${queue.length > 1 ? ` · ${i + 1} of ${queue.length}` : ""}`,
    });
  return (
    <Section
      title="Activity"
      testId="pane-pending"
      more={rows.length > ACTIVITY_ROWS ? { label: "See all", run: () => ui.goto("tasks") } : undefined}
    >
      {rows.length ? <Rows rows={rows.slice(0, ACTIVITY_ROWS)} /> : <Empty>Nothing in progress.</Empty>}
    </Section>
  );
}

/** Needs you, then in hand, then the rest; finished work last. */
function rank(t: LedgerTask): number {
  return ["review", "waiting", "in_progress", "open", "done"].indexOf(t.status);
}

function Scheduled({ agent }: { agent: AgentView }) {
  const routines = useApp((s) => s.routines);
  const mine = (routines ?? [])
    .filter((r) => r.agentId === agent.id && r.enabled && r.nextRunAt)
    .sort((a, b) => a.nextRunAt! - b.nextRunAt!);
  const rows: Row[] = mine.map((r) => ({
    key: r.id,
    testId: "pane-routine",
    icon: <CalendarClock />,
    title: r.name,
    sub: whenLabel(r.nextRunAt),
    onClick: () => {
      ui.goto("routines");
      useUI.setState({ focusRecordId: r.id });
    },
  }));
  return (
    <Section
      title="Scheduled"
      more={rows.length > LIST_ROWS ? { label: "See all", run: () => ui.goto("routines") } : undefined}
    >
      {rows.length ? <Rows rows={rows.slice(0, LIST_ROWS)} /> : <Empty>Nothing scheduled.</Empty>}
    </Section>
  );
}

function openOutput(a: Artifact) {
  if (a.kind === "page") return openPage(a.id);
  ui.goto("artifacts");
  useUI.setState({ focusRecordId: a.id });
}

function Outputs({ agent }: { agent: AgentView }) {
  const artifacts = useApp((s) => s.artifacts);
  const mine = (artifacts ?? [])
    .filter((a) => a.agentId === agent.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  const rows: Row[] = mine.map((a) => ({
    key: a.id,
    testId: "pane-output",
    icon: <KindIcon kind={makeKindOf(a)} mime={a.mime} />,
    title: a.title,
    onClick: () => openOutput(a),
  }));
  return (
    <Section
      title="Outputs"
      more={rows.length > LIST_ROWS ? { label: "See all", run: () => ui.goto("artifacts") } : undefined}
    >
      {rows.length ? <Rows rows={rows.slice(0, LIST_ROWS)} /> : <Empty>Nothing made yet.</Empty>}
    </Section>
  );
}

function Section({
  title,
  testId,
  more,
  children,
}: {
  title: string;
  testId?: string;
  more?: { label: string; run: () => void };
  children: ReactNode;
}) {
  return (
    <section className="inspector-section" data-testid={testId} aria-label={title}>
      <div className="inspector-section-head">
        <h3>{title}</h3>
        {more && (
          <button type="button" onClick={more.run}>
            {more.label}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: Row[] }) {
  return (
    <ul className="inspector-rows">
      {rows.map((r) => {
        const body = (
          <>
            <span className="inspector-row-icon">{r.icon}</span>
            <span className="inspector-row-text">
              <span className="truncate">{r.title}</span>
              {r.sub && <small>{r.sub}</small>}
            </span>
            {r.fresh && (
              <>
                <i className="inspector-row-dot" aria-hidden />
                <span className="sr-only">New</span>
              </>
            )}
          </>
        );
        return (
          <li key={r.key}>
            {r.onClick ? (
              <button type="button" className="inspector-row" data-testid={r.testId} onClick={r.onClick}>
                {body}
              </button>
            ) : (
              <div className="inspector-row" data-testid={r.testId}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="inspector-empty">{children}</p>;
}
