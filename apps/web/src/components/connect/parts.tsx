/** Building blocks of the "Connect your model" walkthrough: numbered steps, copy boxes, the live status. */
import { AlertCircle, Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui/controls";

/** A Terminal command with a Copy button. Commands never contain secrets. */
export function CopyBox({ command, testId }: { command: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = () => {
    // Clipboard can be unavailable (plain http, denied permission): the command is selectable either way.
    navigator.clipboard?.writeText(command).catch(() => {});
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div
      data-testid={testId}
      className="mt-2.5 flex items-center gap-2 rounded-xl border border-border-strong/70 bg-bg/70 py-1.5 pr-1.5 pl-3.5"
    >
      <span className="select-none font-mono text-muted text-sm">$</span>
      <code className="min-w-0 flex-1 select-all whitespace-pre-wrap font-mono text-[13px] text-fg leading-relaxed [overflow-wrap:anywhere]">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${command}`}
        data-testid={testId ? `${testId}-copy` : undefined}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 font-medium text-xs transition-colors",
          copied ? "bg-success/14 text-success" : "bg-elevated text-fg-2 hover:bg-hover hover:text-fg",
        )}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** One numbered step. `done` swaps the number for a green check. */
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
    <li className="flex gap-3.5 py-3.5" data-testid={testId} data-done={done ? "true" : "false"}>
      {done ? (
        <span className="mt-px grid size-6 shrink-0 place-items-center rounded-full bg-success animate-pop">
          <Check className="size-3.5 text-black" strokeWidth={3.2} />
        </span>
      ) : (
        <span className="mt-px grid size-6 shrink-0 place-items-center rounded-full bg-fg font-semibold text-bg text-xs tabular-nums">
          {n}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        {children && <div className="mt-1 text-muted text-sm leading-relaxed">{children}</div>}
      </div>
    </li>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="rounded-2xl border border-border bg-card px-5 py-1 shadow-card [&>li+li]:border-border [&>li+li]:border-t">
      {children}
    </ol>
  );
}

export type LiveState = "idle" | "waiting" | "checking" | "connected" | "error";

/** The live connection status: grey while waiting, green once Yo detects the connection, red with a next step. */
export function LiveStatus({
  state,
  title,
  detail,
  action,
}: {
  state: LiveState;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="connect-status"
      data-state={state}
      className={cn(
        "mt-4 flex items-start gap-3 rounded-2xl border px-4 py-3.5 transition-colors duration-300",
        state === "connected"
          ? "border-success/40 bg-success/10"
          : state === "error"
            ? "border-danger/35 bg-danger/[0.06]"
            : "border-border bg-card/60",
      )}
    >
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center">
        {state === "connected" ? (
          <span className="grid size-5 place-items-center rounded-full bg-success animate-pop">
            <Check className="size-3 text-black" strokeWidth={3.5} />
          </span>
        ) : state === "error" ? (
          <AlertCircle className="size-5 text-danger" />
        ) : state === "idle" ? (
          <span className="size-2.5 rounded-full bg-faint" />
        ) : (
          <Spinner className="size-4 text-brand-ink" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn("font-medium", state === "connected" && "text-success")}>{title}</div>
        {detail && <div className="mt-0.5 text-muted text-sm leading-snug">{detail}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
