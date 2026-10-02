import type { AgentView } from "@yo/contracts";
import { CalendarClock, ListChecks, Maximize2, PanelRightClose, Plus, Power } from "lucide-react";
import { useEffect, useMemo } from "react";
import { api } from "../../lib/api";
import { describeCron } from "../../lib/cron";
import { cn, modKey, whenLabel } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { load, run } from "../../stores/sync";
import { ui, useUI } from "../../stores/ui";
import { TodoList } from "../cards/MiscCards";
import { ScreenView } from "../computer/ScreenView";
import { Button } from "../ui/button";
import { Tip } from "../ui/overlay";

function screenStatus(agent: AgentView, running: boolean) {
  if (!running) return { label: "Off", dot: "bg-faint" };
  if (agent.computer.lease === "user") return { label: "You have control", dot: "bg-success" };
  switch (agent.computer.state) {
    case "ready":
      return agent.activity === "working"
        ? { label: "Live · working", dot: "bg-brand pulse-dot" }
        : { label: "Live", dot: "bg-success" };
    case "booting":
      return { label: "Waking up…", dot: "bg-warning pulse-dot" };
    case "hibernated":
      return { label: "Sleeping", dot: "bg-faint" };
    case "error":
      return { label: "Error", dot: "bg-danger" };
    default:
      return { label: "Off", dot: "bg-faint" };
  }
}

export function WorkPane({ agent }: { agent: AgentView }) {
  const routines = useApp((s) => s.routines);
  const runtime = useApp((s) => s.computer?.runtime);
  useEffect(() => {
    void load.routines();
  }, []);
  const upcoming = useMemo(
    () =>
      (routines ?? [])
        .filter((r) => r.agentId === agent.id && r.enabled && r.nextRunAt)
        .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
        .slice(0, 4),
    [routines, agent.id],
  );
  const st = screenStatus(agent, runtime === "running");
  const asleep = agent.computer.state === "hibernated" || agent.computer.state === "off";

  return (
    <aside
      data-testid="work-pane"
      className="flex h-full w-[300px] shrink-0 flex-col overflow-x-hidden border-border border-l bg-bg animate-panel-in"
    >
      <div className="app-drag flex h-[52px] shrink-0 items-center gap-2 border-border border-b px-4">
        <span className="font-medium text-sm">Workspace</span>
        <div className="flex-1" />
        <Tip label="Hide workspace" shortcut={`${modKey}.`} side="bottom">
          <button
            aria-label="Hide workspace"
            onClick={() => useUI.setState({ workPaneOpen: false })}
            className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <PanelRightClose className="size-[17px]" />
          </button>
        </Tip>
      </div>

      <div className="scroll-fade min-h-0 flex-1 space-y-5 overflow-y-auto p-5 [--scroll-fade:24px]">
        <section>
          <button
            data-testid="screen-preview"
            onClick={() => ui.openComputer(agent.id)}
            className="group relative block aspect-[16/10] w-full overflow-hidden rounded-[14px] border border-border-strong/60 bg-[#0b0c0e] shadow-soft outline-none focus-visible:ring-2 focus-visible:ring-link/60"
          >
            <div className="pointer-events-none absolute inset-0">
              <ScreenView agent={agent} compact />
            </div>
            <div className="absolute inset-0 grid place-items-center bg-black/0 transition-colors duration-200 group-hover:bg-black/35">
              <span className="flex translate-y-1 items-center gap-1.5 rounded-full bg-white/90 px-3 py-1.5 font-medium text-black text-sm opacity-0 shadow-pop transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
                <Maximize2 className="size-3.5" /> Open
              </span>
            </div>
          </button>
          <div className="mt-2.5 flex items-center gap-2 px-0.5">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">{agent.name}'s computer</div>
              <div className="flex items-center gap-1.5 text-muted text-xs">
                <span className={cn("size-1.5 rounded-full", st.dot)} />
                {st.label}
              </div>
            </div>
            {asleep && runtime === "running" ? (
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
                variant="ghost"
                onClick={() => ui.openComputer(agent.id)}
                data-testid="open-computer-pane"
              >
                <Maximize2 className="size-3.5" /> Full screen
              </Button>
            )}
          </div>
        </section>

        <section className="border-border border-t pt-5">
          <div className="mb-2 flex items-center gap-2 px-1">
            <ListChecks className="size-4 text-muted" />
            <span className="font-medium text-sm">Current task</span>
            {agent.todos.length > 0 && (
              <span className="ml-auto text-muted text-xs tabular-nums">
                {agent.todos.filter((t) => t.status === "completed").length}/{agent.todos.length}
              </span>
            )}
          </div>
          {agent.todos.length ? (
            <TodoList todos={agent.todos} dense />
          ) : (
            <div className="px-1 pb-1 text-muted text-sm">
              {agent.activity === "working"
                ? "Working on it — a plan will show up here."
                : "Nothing in progress."}
            </div>
          )}
        </section>

        <section className="border-border border-t pt-5">
          <div className="mb-1.5 flex items-center gap-2 px-1">
            <CalendarClock className="size-4 text-muted" />
            <span className="font-medium text-sm">Upcoming</span>
            <button
              onClick={() => ui.goto("routines")}
              className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted text-xs transition-colors hover:bg-hover hover:text-fg"
            >
              <Plus className="size-3" /> Routine
            </button>
          </div>
          {upcoming.length ? (
            <div className="space-y-0.5">
              {upcoming.map((r) => (
                <button
                  key={r.id}
                  onClick={() => ui.goto("routines")}
                  className="flex w-full items-start gap-3 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-hover"
                >
                  <div className="mt-0.5 w-14 shrink-0 whitespace-nowrap text-right text-2xs text-muted tabular-nums">
                    {new Date(r.nextRunAt!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </div>
                  <div className="min-w-0 flex-1 border-border border-l pl-3">
                    <div className="truncate font-medium text-sm">{r.name}</div>
                    <div className="truncate text-muted text-xs">
                      {whenLabel(r.nextRunAt).split(",")[0]} · {describeCron(r.cron)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-1 pb-1 text-muted text-sm">No routines scheduled for {agent.name}.</div>
          )}
        </section>
      </div>
    </aside>
  );
}
