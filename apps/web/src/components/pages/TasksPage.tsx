import type { LedgerTask } from "@yo/contracts";
import { Check, ChevronRight, Inbox } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  type ActiveGroup,
  activeGroups,
  rememberedView,
  rememberView,
  statusWord,
  type TasksView,
  upNext,
} from "../../lib/tasks";
import { cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { useActiveAgent } from "../../stores/space";
import { load, run } from "../../stores/sync";
import { ui } from "../../stores/ui";
import { keepTask, StartedLine, SuggestionCard, setTaskStatus, startTask } from "../agent/TaskSuggestion";
import { LoadState, useLoad } from "../LoadState";
import { PageShell } from "../PageHeader";
import { Button, PillButton } from "../ui/button";
import { Field, Input, Textarea } from "../ui/controls";
import { Fab } from "../ui/Fab";
import { Modal } from "../ui/overlay";

/** Tasks: what Yo is working on, what's ready for review or needs you, and what it could take on next. */
export function TasksPage() {
  const agent = useActiveAgent();
  const name = agent?.name ?? "Yo";
  const [view, setView] = useState<TasksView>(rememberedView);
  const [adding, setAdding] = useState(false);
  const [started, setStarted] = useState(false);
  // An older core can't keep tasks: nothing to add them to.
  const canAdd = useApp((s) => !s.tasksUnsupported);
  const show = (v: TasksView) => {
    setView(v);
    rememberView(v);
  };
  useEffect(() => {
    if (!started) return;
    const timer = setTimeout(() => setStarted(false), 4000);
    return () => clearTimeout(timer);
  }, [started]);

  return (
    <PageShell
      title="Tasks"
      subtitle={`What ${name} is on, and what's next.`}
      actions={<ViewSwitch view={view} onView={show} />}
    >
      <div data-testid="tasks-page" className="pb-24">
        {started && <StartedLine name={name} className="mb-4" />}
        {agent ? (
          // Keyed: switching spaces (Yo ⇄ Pip) loads that agent's list afresh.
          <TaskLists
            key={agent.id}
            agentId={agent.id}
            name={name}
            view={view}
            onStarted={() => setStarted(true)}
          />
        ) : null}
      </div>
      {agent && canAdd && <Fab label="Add a task" onClick={() => setAdding(true)} />}
      <NewTaskDialog
        open={adding}
        name={name}
        onOpenChange={setAdding}
        onAdded={(t) => {
          keepTask(t);
          setAdding(false);
          show(t.status === "open" ? "upnext" : "active");
          if (t.status !== "open") setStarted(true);
        }}
      />
    </PageShell>
  );
}

/** Active | Up next. */
function ViewSwitch({ view, onView }: { view: TasksView; onView: (v: TasksView) => void }) {
  const tab = (id: TasksView, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === id}
      data-testid={id === "active" ? "tasks-view-active" : "tasks-view-upnext"}
      onClick={() => onView(id)}
      className={cn(
        "inline-flex h-8 items-center rounded-[9px] px-3.5 font-medium text-sm outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-link/60 max-sm:h-11 max-sm:flex-1 max-sm:justify-center",
        view === id ? "bg-elevated text-fg shadow-soft" : "text-muted hover:text-fg",
      )}
    >
      {label}
    </button>
  );
  return (
    <div
      role="tablist"
      aria-label="Tasks"
      className="inline-flex rounded-[11px] bg-active/70 p-0.5 max-sm:w-full"
    >
      {tab("active", "Active")}
      {tab("upnext", "Up next")}
    </div>
  );
}

function TaskLists({
  agentId,
  name,
  view,
  onStarted,
}: {
  agentId: string;
  name: string;
  view: TasksView;
  onStarted: () => void;
}) {
  const tasks = useApp((s) => s.tasks[agentId]);
  const loader = useCallback(() => load.tasks(agentId), [agentId]);
  const { error, retry } = useLoad(loader);
  if (!tasks) return <LoadState ready={false} error={error} retry={retry} what="your tasks" />;
  return view === "active" ? (
    <ActiveList tasks={tasks} />
  ) : (
    <UpNextList tasks={tasks} name={name} onStarted={onStarted} />
  );
}

/* ---------------------------------- Active ---------------------------------- */

function ActiveList({ tasks }: { tasks: LedgerTask[] }) {
  const canAdd = useApp((s) => !s.tasksUnsupported);
  const groups = activeGroups(tasks);
  const open = groups.filter((g) => g.id !== "done");
  const resolved = groups.find((g) => g.id === "done");
  return (
    <div className="space-y-7">
      {open.length === 0 && (
        <p
          data-testid="tasks-empty"
          className="rounded-2xl border border-border border-dashed px-6 py-10 text-center text-muted"
        >
          {canAdd
            ? "Nothing active right now. Add a task with +, or start one from Up next."
            : "Nothing active right now."}
        </p>
      )}
      {open.map((g) => (
        <TaskGroup key={g.id} group={g} />
      ))}
      {resolved && <TaskGroup group={resolved} folded />}
    </div>
  );
}

function TaskGroup({ group, folded }: { group: ActiveGroup; folded?: boolean }) {
  const [shown, setShown] = useState(!folded);
  return (
    <section data-testid={`task-group-${group.id}`} aria-label={group.label}>
      <div className="mb-2 flex items-center gap-2 px-1">
        <h2 className="font-semibold text-fg-2 text-sm">{group.label}</h2>
        <span className="rounded-full bg-active px-1.5 py-px font-medium text-2xs text-muted tabular-nums">
          {group.tasks.length}
        </span>
        {folded && (
          <button
            type="button"
            aria-expanded={shown}
            data-testid="task-group-toggle"
            onClick={() => setShown((s) => !s)}
            className="ml-auto rounded-lg px-2 py-1 font-medium text-link-ink text-sm hover:bg-hover max-sm:min-h-11"
          >
            {shown ? "Hide" : "Show"}
          </button>
        )}
      </div>
      {shown && (
        <ul className="air-raised overflow-hidden rounded-2xl border border-border-strong/50 bg-card shadow-soft">
          {group.tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

const WORD_TONE: Partial<Record<LedgerTask["status"], string>> = {
  review: "text-success",
  waiting: "text-warning",
  in_progress: "text-link-ink",
  done: "text-muted",
};

/** Plays the check landing once (skipped with reduced motion). */
function landing(el: HTMLElement | null) {
  if (!el || typeof el.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  el.animate(
    [
      { transform: "scale(0.3)", opacity: 0 },
      { transform: "scale(1.18)", opacity: 1, offset: 0.6 },
      { transform: "scale(1)", opacity: 1 },
    ],
    { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
}

function TaskRow({ task }: { task: LedgerTask }) {
  const [landed, setLanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const done = task.status === "done";
  const checked = done || landed;
  const checkOff = () => {
    if (checked) return;
    setLanded(true);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // Let the check land before the row moves to Resolved.
    timer.current = setTimeout(
      () => void setTaskStatus(task.id, "done").then((t) => !t && setLanded(false)),
      reduced ? 0 : 420,
    );
  };
  const word = statusWord(task);
  return (
    <li
      data-testid="task-row"
      data-task-id={task.id}
      className="flex items-center border-border [&+&]:border-t"
    >
      <button
        type="button"
        data-testid="task-check"
        aria-label={done ? "Done" : `Check off “${task.title}”`}
        aria-pressed={checked}
        disabled={done}
        onClick={checkOff}
        className="group/check grid size-11 shrink-0 place-items-center self-stretch pl-2 outline-none"
      >
        <span
          className={cn(
            "grid size-[22px] place-items-center rounded-full border-[1.5px] transition-colors duration-150 group-focus-visible/check:ring-2 group-focus-visible/check:ring-link/60",
            checked
              ? done
                ? "border-transparent bg-active text-muted"
                : "border-transparent bg-success text-white"
              : "border-border-strong text-transparent group-hover/check:border-fg-2 group-hover/check:text-faint",
          )}
        >
          <span ref={landed ? landing : undefined} className="grid place-items-center">
            <Check className="size-3.5" strokeWidth={3} />
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => ui.openAgent(task.ownerId)}
        className="flex min-w-0 flex-1 items-center gap-2 py-3 pr-3 pl-1.5 text-left outline-none transition-colors hover:bg-hover/60 focus-visible:bg-hover"
      >
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate font-medium", done && "text-muted")}>{task.title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm">
            {task.status === "in_progress" && (
              <span
                aria-hidden
                data-glyph="working"
                className="block size-3 shrink-0 animate-spin rounded-full border-[1.75px] border-link/25 border-t-link motion-reduce:animate-none"
              />
            )}
            <span className="min-w-0 truncate">
              {word && <span className={cn("font-medium", WORD_TONE[task.status])}>{word}</span>}
              {task.note && <span className="text-muted">{` · ${task.note.replace(/\s+/g, " ")}`}</span>}
            </span>
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
      </button>
    </li>
  );
}

/* ---------------------------------- Up next --------------------------------- */

function UpNextList({
  tasks,
  name,
  onStarted,
}: {
  tasks: LedgerTask[];
  name: string;
  onStarted: () => void;
}) {
  const { suggestions, saved } = upNext(tasks);
  if (!suggestions.length && !saved.length)
    return (
      <div
        data-testid="tasks-empty"
        className="flex flex-col items-center rounded-2xl border border-border border-dashed px-6 py-12 text-center"
      >
        <div className="mb-3 grid size-11 place-items-center rounded-2xl bg-active text-muted">
          <Inbox className="size-5" />
        </div>
        <p className="text-muted">Nothing new right now. I'll keep checking.</p>
      </div>
    );
  return (
    <div className="space-y-7">
      {suggestions.length > 0 && (
        <div className="grid gap-3">
          {suggestions.map((t) => (
            <SuggestionCard key={t.id} task={t} name={name} testId="suggestion-card" onStarted={onStarted} />
          ))}
        </div>
      )}
      {saved.length > 0 && (
        <section data-testid="task-group-open" aria-label="Saved for later">
          <div className="mb-2 flex items-center gap-2 px-1">
            <h2 className="font-semibold text-fg-2 text-sm">Saved for later</h2>
            <span className="rounded-full bg-active px-1.5 py-px font-medium text-2xs text-muted tabular-nums">
              {saved.length}
            </span>
          </div>
          <ul className="air-raised overflow-hidden rounded-2xl border border-border-strong/50 bg-card shadow-soft">
            {saved.map((t) => (
              <SavedRow key={t.id} task={t} onStarted={onStarted} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SavedRow({ task, onStarted }: { task: LedgerTask; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <li
      data-testid="saved-task"
      className="flex items-center gap-3 border-border py-3 pr-3 pl-4 [&+&]:border-t"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{task.title}</div>
        {task.note && <div className="mt-0.5 truncate text-muted text-sm">{task.note}</div>}
      </div>
      <PillButton
        primary
        data-testid="saved-start"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const t = await startTask(task.id);
          setBusy(false);
          if (t) onStarted();
        }}
        className="min-h-9 flex-none basis-auto px-5 text-[13px] max-sm:min-h-11"
      >
        Start
      </PillButton>
    </li>
  );
}

/* --------------------------------- New task --------------------------------- */

function NewTaskDialog({
  open,
  name,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  name: string;
  onOpenChange: (o: boolean) => void;
  onAdded: (t: LedgerTask) => void;
}) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setNote("");
  }, [open]);
  const add = async (start: boolean) => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const t = await run(
      api().call("tasks.create", {
        title: title.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
        start,
      }),
      start ? "Couldn't start the task" : "Couldn't save the task",
    );
    setBusy(false);
    if (t) onAdded(t);
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New task"
      description={`${name} can start it now, or keep it under Up next.`}
      testId="new-task-dialog"
    >
      <form
        className="space-y-4 px-5 pt-3 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          void add(true);
        }}
      >
        <Field label="What should I do?">
          <Input
            data-testid="new-task-title"
            value={title}
            maxLength={200}
            placeholder="Find a gift for Mia under $40"
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Details (optional)">
          <Textarea
            data-testid="new-task-note"
            value={note}
            rows={3}
            maxLength={2000}
            placeholder="Anything that helps: links, dates, what done looks like."
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button
            data-testid="new-task-save"
            disabled={!title.trim() || busy}
            onClick={() => void add(false)}
            className="max-sm:h-11 max-sm:flex-1"
          >
            Save for Up next
          </Button>
          <Button
            type="submit"
            variant="primary"
            data-testid="new-task-start"
            disabled={!title.trim() || busy}
            className="max-sm:h-11 max-sm:flex-1"
          >
            Start now
          </Button>
        </div>
      </form>
    </Modal>
  );
}
