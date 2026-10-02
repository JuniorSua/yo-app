import type { TimelineEntry } from "@yo/contracts";
import { Brain, Check, ChevronRight, FilePen, Globe, Search, SquareTerminal, Wrench, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn, duration, hostOf } from "../../lib/utils";
import { Spinner } from "../ui/controls";

const ICONS = {
  browser: Globe,
  web: Search,
  command: SquareTerminal,
  file_change: FilePen,
  tool: Wrench,
  reasoning: Brain,
} as const;

function StepIcon({ e }: { e: TimelineEntry }) {
  const Icon = ICONS[e.item.kind as keyof typeof ICONS] ?? Wrench;
  return (
    <div className="grid size-6 shrink-0 place-items-center rounded-lg border border-border bg-card">
      <Icon className="size-3.5 text-muted" strokeWidth={1.9} />
    </div>
  );
}

function StatusIcon({ status }: { status: TimelineEntry["item"]["status"] }) {
  if (status === "running") return <Spinner className="size-3.5 text-brand-ink" />;
  if (status === "failed") return <X className="size-3.5 text-danger" />;
  return <Check className="size-3.5 text-faint" />;
}

function renderTitle(title: string) {
  // Render `code` spans inside titles like "Ran `ls -la`".
  const parts = title.split(/(`[^`]+`)/g);
  return parts.map((p, i) =>
    p.startsWith("`") && p.endsWith("`") ? (
      <code key={i} className="rounded-[5px] bg-active px-1.5 py-px font-mono text-[11.5px] text-fg-2">
        {p.slice(1, -1)}
      </code>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function StepRow({ e }: { e: TimelineEntry }) {
  const [open, setOpen] = useState(false);
  const url = (e.item.input as { url?: string } | undefined)?.url;
  const expandable = !!(e.item.output || (e.item.kind === "reasoning" && e.item.text));
  const title = e.item.title ?? e.item.toolName ?? e.item.kind;
  return (
    <div className="animate-fade-in">
      <button
        onClick={() => expandable && setOpen((o) => !o)}
        className={cn(
          "group flex w-full items-center gap-2.5 rounded-lg py-1 pr-2 pl-1 text-left",
          expandable && "hover:bg-hover",
        )}
      >
        <StepIcon e={e} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            e.item.status === "running"
              ? "shimmer-text"
              : e.item.status === "failed"
                ? "text-danger"
                : "text-fg-2",
          )}
        >
          {renderTitle(title)}
        </span>
        {url && e.item.kind === "browser" && (
          <span className="hidden shrink-0 text-2xs text-faint sm:inline">{hostOf(url)}</span>
        )}
        {expandable && (
          <ChevronRight className={cn("size-3.5 text-faint transition-transform", open && "rotate-90")} />
        )}
        <StatusIcon status={e.item.status} />
      </button>
      {open && expandable && (
        <pre className="mt-1 mb-2 ml-9 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-card px-3 py-2 font-mono text-[11.5px] text-fg-2 leading-relaxed">
          {e.item.output ?? e.item.text}
        </pre>
      )}
    </div>
  );
}

export function ActivityGroup({ entries, live }: { entries: TimelineEntry[]; live: boolean }) {
  const running = entries.find((e) => e.item.status === "running");
  const [open, setOpen] = useState(false);
  // Steps are only in the DOM while open (and during the close animation): collapsed groups held most of
  // a long conversation's elements and icons without showing them.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), 250);
    return () => clearTimeout(t);
  }, [open]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  const elapsed = (running ? now : last.createdAt + 1500) - first.createdAt;
  const failed = entries.some((e) => e.item.status === "failed");
  const n = entries.length;

  return (
    <div data-testid="activity-group" className="-ml-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="group flex items-center gap-2 rounded-lg py-1 pr-2 pl-1 text-left text-sm transition-colors hover:bg-hover"
      >
        {running && live ? (
          <>
            <Spinner className="size-3.5 text-brand-ink" />
            <span className="shimmer-text max-w-[46ch] truncate">{running.item.title ?? "Working"}</span>
            <span className="text-faint">· {duration(elapsed)}</span>
          </>
        ) : (
          <span className="text-muted">
            Worked for {duration(elapsed)} · {n} {n === 1 ? "step" : "steps"}
            {failed && <span className="text-danger"> · 1 issue</span>}
          </span>
        )}
        <ChevronRight
          className={cn("size-3.5 text-faint transition-transform duration-200", open && "rotate-90")}
        />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out-soft",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 space-y-0.5 pb-1">
            <div className="absolute top-3 bottom-3 left-[12.5px] w-px bg-border" />
            {(open || mounted) && entries.map((e) => <StepRow key={e.id} e={e} />)}
          </div>
        </div>
      </div>
    </div>
  );
}
