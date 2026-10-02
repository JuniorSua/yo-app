import type { TimelineEntry, TodoEntry } from "@yo/contracts";
import { AlertTriangle, Check, Download, FileText, ListChecks } from "lucide-react";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { ui } from "../../stores/ui";
import { Button } from "../ui/button";
import { Spinner } from "../ui/controls";

export function TodoList({ todos, dense }: { todos: TodoEntry[]; dense?: boolean }) {
  return (
    <ul className={cn("space-y-0.5", dense && "space-y-0")}>
      {todos.map((t, i) => (
        <li
          key={i}
          className={cn("flex items-start gap-2.5 rounded-lg px-1 py-1", dense ? "text-sm" : "text-base")}
        >
          <span className="mt-[2px] grid size-4 shrink-0 place-items-center">
            {t.status === "completed" ? (
              <span className="grid size-4 place-items-center rounded-full bg-success/90 animate-pop">
                <Check className="size-2.5 text-black" strokeWidth={3.5} />
              </span>
            ) : t.status === "in_progress" ? (
              <Spinner className="size-4 text-brand-ink" />
            ) : (
              <span className="size-4 rounded-full border-[1.5px] border-border-strong" />
            )}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1",
              t.status === "completed"
                ? "text-muted line-through decoration-faint/70"
                : t.status === "in_progress"
                  ? "text-fg"
                  : "text-fg-2",
            )}
          >
            {t.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TodoCard({ entry }: { entry: TimelineEntry }) {
  const todos = entry.item.todos ?? [];
  const done = todos.filter((t) => t.status === "completed").length;
  const pct = todos.length ? (done / todos.length) * 100 : 0;
  return (
    <div
      data-testid="todo-card"
      className="max-w-[560px] rounded-2xl border border-border bg-card shadow-card p-3.5 animate-rise"
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <ListChecks className="size-4 text-muted" />
        <span className="font-medium text-sm">{entry.item.title ?? "Plan"}</span>
        <span className="ml-auto text-muted text-xs tabular-nums">
          {done} of {todos.length}
        </span>
      </div>
      <div className="mx-1 mb-2.5 h-1 overflow-hidden rounded-full bg-active">
        <div
          className="h-full rounded-full bg-success transition-[width] duration-500 ease-out-soft"
          style={{ width: `${pct}%` }}
        />
      </div>
      <TodoList todos={todos} />
    </div>
  );
}

function extOf(path: string) {
  return path.split(".").pop()?.toUpperCase().slice(0, 4) ?? "FILE";
}

export function FileTile({ path, className }: { path: string; className?: string }) {
  return (
    <div
      className={cn(
        "relative grid size-10 shrink-0 place-items-center rounded-xl border border-border-strong/60 bg-gradient-to-b from-elevated to-card",
        className,
      )}
    >
      <FileText className="size-4 text-muted" />
      <span className="absolute -bottom-1.5 rounded-[4px] bg-fg px-1 font-semibold text-[8.5px] text-bg leading-[13px]">
        {extOf(path)}
      </span>
    </div>
  );
}

export function ArtifactCard({ entry }: { entry: TimelineEntry }) {
  const input = (entry.item.input ?? {}) as { path?: string; title?: string; artifactId?: string };
  const artifacts = useApp((s) => s.artifacts);
  const art = artifacts?.find((a) => a.id === input.artifactId || a.path === input.path);
  const title = input.title ?? art?.title ?? input.path?.split("/").pop() ?? "Artifact";
  const path = input.path ?? art?.path ?? "";
  const href = art
    ? api().artifactUrl(art.id)
    : input.artifactId
      ? api().artifactUrl(input.artifactId)
      : null;
  return (
    <div
      data-testid="artifact-card"
      className="flex max-w-[460px] items-center gap-3.5 rounded-2xl border border-border bg-card shadow-card p-3 pr-3.5 animate-rise"
    >
      <FileTile path={path} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{title}</div>
        <div className="truncate text-muted text-xs">
          Saved to Artifacts · {path.replace("/home/agent", "~")}
        </div>
      </div>
      {href && (
        <a
          href={href}
          download={path.split("/").pop()}
          aria-label="Download"
          className="grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <Download className="size-4" />
        </a>
      )}
      <Button variant="secondary" size="sm" onClick={() => ui.goto("artifacts")}>
        View
      </Button>
    </div>
  );
}

export function NoticeRow({ entry }: { entry: TimelineEntry }) {
  const failed = entry.item.status === "failed";
  const text = entry.item.title ?? entry.item.text ?? "";
  if (failed)
    return (
      <div
        data-testid="error-row"
        className="flex max-w-[560px] items-start gap-2.5 rounded-xl border border-danger/20 bg-danger/[0.06] px-3.5 py-2.5 text-sm animate-fade-in"
      >
        <AlertTriangle className="mt-px size-4 shrink-0 text-danger" />
        <span className="text-fg-2">{text}</span>
      </div>
    );
  return (
    <div data-testid="notice-row" className="flex items-center gap-3 py-1 text-muted text-xs animate-fade-in">
      <div className="h-px flex-1 bg-border" />
      <span className="max-w-[70%] text-center">{text}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
