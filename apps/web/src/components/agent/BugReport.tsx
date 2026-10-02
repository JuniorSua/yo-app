/**
 * Bug reports in the chat, deliberately red so they never read as regular conversation:
 * "Reporting a bug…" while report_bug runs, the draft card with [Report it] / [Not now] (sent as the user's
 * message; core only accepts a submit after one), and the submitted card ("Filed as #123" or "Open on GitHub").
 */
import type { TimelineEntry } from "@yo/contracts";
import { Bug, ChevronDown, Download, ExternalLink } from "lucide-react";
import { Component, type ReactNode, useEffect, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { load } from "../../stores/sync";
import { Button } from "../ui/button";
import type { BugInfo } from "./blocks";
import { type BugFields, bugCall, outputText } from "./bugFields";
import { composerBus } from "./Composer";

const MD_PLUGINS = [remarkGfm];

/** The report's markdown: red section headings, compact type. Self-contained (no shared prose styles). */
const MD: Components = {
  h2: ({ children }) => (
    <div
      role="heading"
      aria-level={3}
      className="mt-3.5 mb-1 flex items-center gap-1.5 font-semibold text-[11px] text-danger uppercase tracking-[0.06em] first:mt-0"
    >
      {children}
    </div>
  ),
  p: ({ children }) => <p className="text-[14px] text-fg-2 leading-relaxed">{children}</p>,
  ol: ({ children }) => (
    <ol className="list-decimal space-y-0.5 pl-5 text-[14px] text-fg-2 marker:text-danger/70">{children}</ol>
  ),
  ul: ({ children }) => (
    <ul className="list-disc space-y-0.5 pl-5 text-[14px] text-fg-2 marker:text-danger/70">{children}</ul>
  ),
  pre: ({ children }) => (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-danger/15 bg-card px-3 py-2 font-mono text-[11.5px] text-fg-2 leading-relaxed">
      {children}
    </pre>
  ),
  code: ({ children }) => <code className="font-mono text-[0.9em]">{children}</code>,
  a: ({ node: _n, ...p }) => (
    <a {...p} target="_blank" rel="noreferrer" className="text-link hover:underline" />
  ),
};

function reportMarkdown(f: BugFields, full: boolean): string {
  const parts: string[] = [];
  const add = (h: string, body: string | undefined) => {
    if (body?.trim()) parts.push(`## ${h}\n\n${body.trim()}`);
  };
  add("What happened", f.what_happened);
  if (full) {
    add("Expected", f.expected);
    add("Steps to reproduce", f.steps?.map((s, i) => `${i + 1}. ${s}`).join("\n"));
    if (f.evidence?.trim()) parts.push(`## Evidence\n\n~~~~\n${f.evidence.trim()}\n~~~~`);
  }
  add("Suspected cause", f.suspected_cause);
  add("Suggested fix", f.suggested_fix);
  return parts.join("\n\n");
}

function ReportBody({ fields, collapsible = true }: { fields: BugFields; collapsible?: boolean }) {
  const [open, setOpen] = useState(!collapsible);
  const more = !!(fields.expected?.trim() || fields.steps?.length || fields.evidence?.trim());
  return (
    <div data-testid="bug-report-body">
      <Markdown remarkPlugins={MD_PLUGINS} components={MD}>
        {reportMarkdown(fields, open)}
      </Markdown>
      {collapsible && more && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-2 flex items-center gap-1 rounded-md font-medium text-danger text-xs hover:underline"
        >
          {open ? "Show less" : "Show steps and evidence"}
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      )}
    </div>
  );
}

function BugIcon({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-[10px] bg-danger/15 text-danger",
        className,
      )}
    >
      <Bug className="size-4" />
    </span>
  );
}

function Chip({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-danger px-2.5 py-[3px] font-semibold text-bg text-xs"
    >
      <Bug className="size-3.5" strokeWidth={2.2} />
      {children}
    </span>
  );
}

function Shell({ children, testId, state }: { children: ReactNode; testId: string; state?: string }) {
  return (
    <div
      data-testid={testId}
      data-state={state}
      className="w-full max-w-[580px] overflow-hidden rounded-2xl border border-danger/45 bg-danger/[0.05] shadow-card animate-rise"
    >
      {children}
    </div>
  );
}

function Header({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-danger/20 border-b bg-danger/[0.07] px-3.5 py-2.5">
      {children}
    </div>
  );
}

/** While report_bug runs: a red "Reporting a bug…" row with a soft pulse. */
function Running({ stage }: { stage: BugInfo["stage"] }) {
  return (
    <div data-testid="bug-report-running" className="flex items-center gap-2.5 py-1 text-sm animate-fade-in">
      <span className="relative grid size-6 place-items-center">
        <span className="absolute inset-0 rounded-lg bg-danger/25 motion-safe:animate-ping motion-safe:[animation-duration:1.8s]" />
        <span className="relative grid size-6 place-items-center rounded-lg bg-danger/15 text-danger">
          <Bug className="size-3.5" strokeWidth={2.1} />
        </span>
      </span>
      <span className="font-medium text-danger">Reporting a bug…</span>
      <span className="text-muted">{stage === "submit" ? "sending it" : "writing it up"}</span>
    </div>
  );
}

function Draft({ entry, bug }: { entry: TimelineEntry; bug: BugInfo }) {
  const fields = bugCall(entry.item.input);
  const sent = bug.related?.item.status === "completed";
  const canAnswer = bug.latest && !bug.answered && !sent;
  const status = sent
    ? "reported"
    : !bug.draftId
      ? "not saved"
      : bug.answered
        ? "you answered"
        : "waiting for your OK";
  return (
    <Shell testId="bug-draft-card" state={sent ? "sent" : bug.answered ? "answered" : "waiting"}>
      <Header>
        <Chip testId="bug-draft-chip">Bug report · Draft</Chip>
        <span className={cn("text-xs", canAnswer ? "font-medium text-danger" : "text-muted")}>
          — {status}
        </span>
        {fields.severity && (
          <span className="ml-auto rounded-md border border-danger/25 px-1.5 py-px text-[11px] text-danger capitalize">
            {fields.severity}
          </span>
        )}
      </Header>
      <div className="px-4 pt-3 pb-3.5">
        <div className="mb-2 font-semibold text-[15px] leading-snug">{fields.title ?? "Bug report"}</div>
        <ReportBody fields={fields} />
      </div>
      {canAnswer && (
        <div className="flex flex-wrap items-center gap-2 border-danger/20 border-t px-3.5 py-2.5">
          <Button
            size="sm"
            data-testid="bug-report-it"
            className="bg-danger text-bg hover:bg-danger/90"
            variant="primary"
            onClick={() => composerBus.send?.("Report it")}
          >
            <Bug className="size-3.5" /> Report it
          </Button>
          <Button size="sm" data-testid="bug-not-now" onClick={() => composerBus.send?.("Not now")}>
            Not now
          </Button>
          <span className="ml-auto text-muted text-xs">Nothing is sent until you say so.</span>
        </div>
      )}
    </Shell>
  );
}

function Submitted({ entry, bug }: { entry: TimelineEntry; bug: BugInfo }) {
  const output = outputText(entry.item.output);
  const artifactId = /\[artifact:(art_[A-Za-z0-9]+)\]/.exec(output)?.[1];
  const filedMatch = /issue #(\d+) \((https:\/\/[^)\s]+)\)/.exec(output);
  const art = useApp((s) => (artifactId ? s.artifacts?.find((a) => a.id === artifactId) : undefined));
  // The prefilled GitHub link lives on the artifact (it's long; the model never sees it).
  const filed = !!filedMatch;
  useEffect(() => {
    if (artifactId && !filed) void load.artifacts();
  }, [artifactId, filed]);
  const number = filedMatch ? Number(filedMatch[1]) : art?.issue?.number;
  const url = filedMatch?.[2] ?? art?.issue?.url;
  const { stage: _s, draft_id: _d, ...edits } = bugCall(entry.item.input);
  const fields: BugFields = { ...bugCall(bug.related?.item.input), ...edits };
  const title =
    fields.title ?? (typeof art?.title === "string" ? art.title.replace(/^Bug: /, "") : "Bug report");
  const [open, setOpen] = useState(false);
  const hasBody = !!(fields.what_happened || fields.suggested_fix);

  if (entry.item.status === "failed")
    return (
      <Shell testId="bug-report-card" state="refused">
        <div className="flex items-start gap-3 p-3.5">
          <BugIcon />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-danger text-xs uppercase tracking-wide">
              Bug report · Not sent
            </div>
            <div className="truncate font-medium">{title}</div>
            <div className="mt-0.5 text-muted text-xs">
              {output.replace(/^Error:\s*/, "") || "It wasn't sent."}
            </div>
          </div>
        </div>
      </Shell>
    );

  return (
    <Shell testId="bug-report-card" state={number ? "filed" : "saved"}>
      <Header>
        <Chip testId="bug-report-status">
          {number ? `Bug report · Filed as #${number}` : "Bug report · Saved"}
        </Chip>
        <span className="text-muted text-xs">
          {number ? "on GitHub" : url ? "— not sent yet" : "— saved to Artifacts"}
        </span>
      </Header>
      <div className="flex items-center gap-3 px-3.5 py-3">
        <BugIcon />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 font-medium leading-snug">{title}</div>
          <div className="mt-0.5 text-muted text-xs">
            {number
              ? "The developer has it. A copy is in Artifacts."
              : url
                ? "Open it on GitHub to submit it. A copy is in Artifacts."
                : "A copy is in Artifacts."}
          </div>
        </div>
        {artifactId && (
          <a
            href={api().artifactUrl(artifactId)}
            download={art?.path.split("/").pop() ?? "bug-report.md"}
            aria-label="Download bug report"
            data-testid="bug-report-download"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-danger transition-colors hover:bg-danger/15"
          >
            <Download className="size-4" />
          </a>
        )}
      </div>
      {(url || hasBody) && (
        <div className="flex flex-wrap items-center gap-2 border-danger/20 border-t px-3.5 py-2.5">
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              data-testid="bug-report-github"
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/12 px-2.5 font-medium text-danger text-sm transition-colors hover:bg-danger/18"
            >
              {number ? `View issue #${number}` : "Open on GitHub"}
              <ExternalLink className="size-3.5" />
            </a>
          )}
          {hasBody && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="ml-auto flex items-center gap-1 rounded-md font-medium text-danger text-xs hover:underline"
            >
              {open ? "Hide report" : "Show report"}
              <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
            </button>
          )}
        </div>
      )}
      {open && (
        <div className="border-danger/20 border-t px-4 py-3">
          <ReportBody fields={fields} collapsible={false} />
        </div>
      )}
    </Shell>
  );
}

/** A plain row: for a report that never finished, or when a card can't be drawn. */
function PlainRow({ text, testId }: { text: string; testId: string }) {
  return (
    <div data-testid={testId} className="flex items-center gap-2.5 py-1 text-muted text-sm">
      <span className="grid size-6 place-items-center rounded-lg border border-border bg-card">
        <Bug className="size-3.5 text-danger" strokeWidth={1.9} />
      </span>
      {text}
    </div>
  );
}

/** Keeps one bad report card from taking the whole app down (apps/web has no error boundary of its own). */
class BugCardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.warn("bug report card failed to render", err);
  }
  render() {
    return this.state.failed ? (
      <PlainRow testId="bug-report-fallback" text="Bug report" />
    ) : (
      this.props.children
    );
  }
}

function BugReportCard({ entry, bug, live }: { entry: TimelineEntry; bug: BugInfo; live: boolean }) {
  if (entry.item.status === "running")
    // Left "running" by a turn that ended without a result (e.g. core restarted): don't pulse forever.
    return live ? (
      <Running stage={bug.stage} />
    ) : (
      <PlainRow testId="bug-report-unfinished" text="Bug report · didn't finish" />
    );
  if (bug.stage === "draft" && entry.item.status !== "failed") return <Draft entry={entry} bug={bug} />;
  return <Submitted entry={entry} bug={bug} />;
}

export function BugReportBlock(props: { entry: TimelineEntry; bug: BugInfo; live: boolean }) {
  return (
    <BugCardBoundary>
      <BugReportCard {...props} />
    </BugCardBoundary>
  );
}

/** Next to the agent's name on a response that reports a bug. */
export function BugTurnBadge() {
  return (
    <span
      data-testid="bug-turn-badge"
      className="inline-flex items-center gap-1 rounded-full bg-danger/12 px-2 py-0.5 font-semibold text-[11px] text-danger"
    >
      <Bug className="size-3" strokeWidth={2.2} />
      Bug report
    </span>
  );
}
