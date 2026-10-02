/** Building blocks of the first agent's scripted setup chat. */
import type { AgentView, CheckStatus, ComputerOverview, RequirementsReport } from "@yo/contracts";
import { Check, CircleHelp, Copy, RefreshCw, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../../lib/utils";
import { AgentAvatar } from "../brand";
import { Button } from "../ui/button";
import { Spinner } from "../ui/controls";

/** One message from the agent: its avatar and name, then the content. */
export function AgentLine({
  agent,
  children,
  testId,
}: {
  agent: AgentView;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="animate-rise" data-testid={testId}>
      <div className="mb-2.5 flex items-center gap-2 text-sm">
        <AgentAvatar agent={agent} size={22} state="idle" quiet />
        <span className="font-medium">{agent.name}</span>
      </div>
      <div className="space-y-3 text-[15px] leading-[1.6]">{children}</div>
    </div>
  );
}

/** What the user picked, shown as their reply. */
export function UserLine({ text }: { text: string }) {
  return (
    <div className="flex justify-end animate-rise" data-testid="setup-user-line">
      <div className="max-w-[80%] rounded-[18px] rounded-br-[5px] bg-bubble px-4.5 py-3 text-[15px] leading-[1.6]">
        {text}
      </div>
    </div>
  );
}

export function CopyBox({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group flex items-start gap-2 rounded-xl border border-border bg-bg py-2 pr-2 pl-3.5">
      <code
        className="min-w-0 flex-1 select-all whitespace-pre-wrap break-all py-1 font-mono text-[12.5px] leading-relaxed"
        data-testid="copy-command"
      >
        {command}
      </code>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard?.writeText(command).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

const STATUS_TEXT: Record<CheckStatus, string> = {
  pass: "Good",
  warn: "Works",
  block: "Not enough",
  unknown: "Couldn't check",
};

export function StatusIcon({ status }: { status: CheckStatus }) {
  return status === "pass" ? (
    <span className="grid size-5 place-items-center rounded-full bg-success">
      <Check className="size-3 text-black" strokeWidth={3.5} />
    </span>
  ) : status === "warn" ? (
    <span className="grid size-5 place-items-center rounded-full bg-warning/18 text-warning">
      <TriangleAlert className="size-3" strokeWidth={2.5} />
    </span>
  ) : status === "block" ? (
    <span className="grid size-5 place-items-center rounded-full bg-danger/16 text-danger">
      <X className="size-3" strokeWidth={3} />
    </span>
  ) : (
    <span className="grid size-5 place-items-center rounded-full bg-active text-muted">
      <CircleHelp className="size-3" strokeWidth={2.5} />
    </span>
  );
}

export function RequirementsCard({
  report,
  checking,
  onRecheck,
}: {
  report: RequirementsReport | null;
  checking: boolean;
  onRecheck: () => void;
}) {
  return (
    <div
      className="rounded-2xl border border-border bg-card px-5 py-1.5 shadow-card"
      data-testid="setup-requirements"
      data-verdict={report?.verdict}
    >
      {!report ? (
        <div className="flex items-center gap-2.5 py-4 text-muted text-sm">
          <Spinner /> Checking this Mac…
        </div>
      ) : (
        report.items.map((it, i) => (
          <div
            key={it.id}
            className={cn("flex items-start gap-3.5 py-3", i > 0 && "border-border border-t")}
            data-testid={`req-${it.id}`}
            data-status={it.status}
          >
            <div className="mt-0.5 shrink-0">
              <StatusIcon status={it.status} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium">{it.label}</span>
                <span className="text-fg-2 text-sm">{it.value}</span>
              </div>
              <div className="text-muted text-sm">
                <span
                  className={cn(
                    "font-medium",
                    it.status === "pass" && "text-success",
                    it.status === "warn" && "text-warning",
                    it.status === "block" && "text-danger",
                  )}
                >
                  {STATUS_TEXT[it.status]}.
                </span>{" "}
                {it.detail}
              </div>
            </div>
          </div>
        ))
      )}
      {report && (
        <div className="flex items-center justify-between border-border border-t py-2.5">
          <span className="text-faint text-xs">
            Checked {new Date(report.checkedAt).toLocaleTimeString([], { timeStyle: "short" })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRecheck}
            disabled={checking}
            data-testid="setup-recheck"
          >
            {checking ? <Spinner /> : <RefreshCw className="size-3.5" />} Check again
          </Button>
        </div>
      )}
    </div>
  );
}

/** A numbered step with copy-paste commands. */
export function Step({
  n,
  title,
  done,
  children,
  testId,
}: {
  n: number;
  title: ReactNode;
  done?: boolean;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex gap-3.5 py-3" data-testid={testId} data-done={done || undefined}>
      <div className="mt-0.5 shrink-0">
        {done ? (
          <span className="grid size-5 place-items-center rounded-full bg-success animate-pop">
            <Check className="size-3 text-black" strokeWidth={3.5} />
          </span>
        ) : (
          <span className="grid size-5 place-items-center rounded-full border-[1.5px] border-border-strong font-semibold text-2xs text-fg-2 tabular-nums">
            {n}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className={cn("font-medium", done && "text-muted line-through decoration-1")}>{title}</div>
        {!done && children}
      </div>
    </div>
  );
}

function Check3({
  state,
  label,
  sub,
}: {
  state: "done" | "active" | "pending";
  label: string;
  sub?: string;
}) {
  return (
    <div className="flex items-start gap-3.5 py-3">
      <div className="mt-0.5 grid size-5 shrink-0 place-items-center">
        {state === "done" ? (
          <span className="grid size-5 place-items-center rounded-full bg-success animate-pop">
            <Check className="size-3 text-black" strokeWidth={3.5} />
          </span>
        ) : state === "active" ? (
          <Spinner className="size-5 text-brand-ink" />
        ) : (
          <span className="size-5 rounded-full border-[1.5px] border-border-strong" />
        )}
      </div>
      <div>
        <div className={cn("font-medium", state === "pending" && "text-muted")}>{label}</div>
        {sub && <div className="text-muted text-sm">{sub}</div>}
      </div>
    </div>
  );
}

/** The computer's start-up, live from `computer.updated` (the same flow onboarding used to show). */
export function ComputerProgress({ c }: { c: ComputerOverview }) {
  const starting = c.runtime === "starting";
  const running = c.runtime === "running";
  const vm = running || c.imageReady ? "done" : starting ? "active" : "pending";
  const image = c.imageReady ? "done" : starting ? "active" : "pending";
  const conn = c.connected ? "done" : c.imageReady ? "active" : "pending";
  return (
    <div>
      <div
        className="rounded-2xl border border-border bg-card px-5 py-1.5 shadow-card"
        data-testid="computer-checklist"
      >
        <Check3
          state={vm}
          label="Start the virtual machine"
          sub={c.memLimitMB ? `Colima · up to ${Math.round(c.memLimitMB / 1024)} GB memory` : "Colima"}
        />
        <div className="h-px bg-border" />
        <Check3 state={image} label="Get my computer ready" sub="Chromium, a desktop, a terminal and tools" />
        <div className="h-px bg-border" />
        <Check3 state={conn} label="Connect to my computer" sub="A private, token-protected link" />
      </div>
      <div className={cn("text-muted text-sm", starting && "mt-2 min-h-5")} aria-live="polite">
        {starting && <span className="shimmer-text">{c.message ?? "Working…"}</span>}
      </div>
    </div>
  );
}
