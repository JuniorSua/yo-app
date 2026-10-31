import type { AgentView, LedgerTask } from "@yo/contracts";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { applyTaskUpdate, latestSuggestion } from "../../lib/tasks";
import { cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { load, run } from "../../stores/sync";

/** How long "Started. Yo is on it." stays above the message box. */
const STARTED_MS = 4000;

/** Put a task the core sent back into its agent's list now (its task.updated push may come a moment later). */
export function keepTask(t: LedgerTask | undefined) {
  if (!t) return;
  useApp.setState((s) =>
    s.tasks[t.ownerId] ? { tasks: { ...s.tasks, [t.ownerId]: applyTaskUpdate(s.tasks[t.ownerId]!, t) } } : {},
  );
}

/** Start a suggestion or a saved task: its agent gets the request as the user's message. */
export async function startTask(id: string) {
  const t = await run(api().call("tasks.start", { id }), "Couldn't start it");
  keepTask(t);
  return t;
}

/** Hide a suggestion, check a task off, or put it back. */
export async function setTaskStatus(id: string, status: "done" | "hidden" | "open") {
  const t = await run(
    api().call("tasks.update", { id, status }),
    status === "hidden" ? "Couldn't hide it" : "Couldn't update the task",
  );
  keepTask(t);
  return t;
}

/** "Started. Yo is on it.", said for a moment after a Start. */
export function StartedLine({ name, className }: { name: string; className?: string }) {
  return (
    <p
      role="status"
      data-testid="suggestion-started"
      className={cn("ysuggest-started animate-pop", className)}
    >
      Started. {name} is on it.
    </p>
  );
}

/**
 * Something Yo offers to take on: what it would do, why, and Hide / Start. The Tasks page shows each under Up next;
 * the chat shows the newest just above the message box.
 */
export function SuggestionCard({
  task,
  name,
  testId,
  onStarted,
  bar,
  className,
}: {
  task: LedgerTask;
  /** The agent's name: "Yo could take this on". */
  name: string;
  testId: string;
  onStarted?: () => void;
  /** Above the message box: one row, with Hide and Start at the end (stacked on a phone). */
  bar?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<LedgerTask | undefined>, after?: () => void) => {
    setBusy(true);
    const t = await fn();
    setBusy(false);
    if (t) after?.();
  };
  return (
    <div
      data-testid={testId}
      data-task-id={task.id}
      className={cn("ysuggest air-raised animate-pop", bar && "is-bar", className)}
    >
      <div className="min-w-0 flex-1">
        <div className="ysuggest-eyebrow">
          <Sparkles aria-hidden />
          {name} could take this on
        </div>
        <div className="ysuggest-title">{task.title}</div>
        {task.why && <p className="ysuggest-why">{task.why}</p>}
      </div>
      <div className="ysuggest-actions">
        <button
          type="button"
          className="ycard-pill"
          data-testid="suggestion-hide"
          disabled={busy}
          onClick={() => void act(() => setTaskStatus(task.id, "hidden"))}
        >
          Hide
        </button>
        <button
          type="button"
          className="ycard-pill is-primary"
          data-testid="suggestion-start"
          disabled={busy}
          onClick={() => void act(() => startTask(task.id), onStarted)}
        >
          Start
        </button>
      </div>
    </div>
  );
}

/** Above the message box: the newest thing this agent offers to take on. Nothing when there's none. */
export function TaskSuggestion({ agent }: { agent: AgentView }) {
  const tasks = useApp((s) => s.tasks[agent.id]);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    // Pushes keep it live; this catches up when the chat opens (an older core has no tasks: nothing shows).
    if (agent.kind !== "helper") load.tasks(agent.id).catch(() => undefined);
  }, [agent.id, agent.kind]);
  useEffect(() => {
    if (!started) return;
    const timer = setTimeout(() => setStarted(false), STARTED_MS);
    return () => clearTimeout(timer);
  }, [started]);
  useEffect(() => setStarted(false), [agent.id]);

  if (started) return <StartedLine name={agent.name} className="mb-2" />;
  const suggestion = latestSuggestion(tasks, agent.id);
  if (!suggestion) return null;
  return (
    <SuggestionCard
      key={suggestion.id}
      task={suggestion}
      name={agent.name}
      testId="task-suggestion"
      onStarted={() => setStarted(true)}
      bar
      className="mb-2"
    />
  );
}
