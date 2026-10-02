import type { DeviceOperation, TimelineEntry } from "@yo/contracts";
import {
  ArrowUp,
  Check,
  CircleHelp,
  CircleX,
  Clock,
  FilePen,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  TimerOff,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { ago, cn, fileSize } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { load, run } from "../../stores/sync";
import { macApp } from "../macApps";
import { Button } from "../ui/button";

type Req = NonNullable<TimelineEntry["request"]>;

function Resolved({
  icon,
  children,
  tone,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  tone: string;
}) {
  return (
    <div className="flex items-center gap-2.5 py-1 text-sm animate-fade-in">
      <div className={cn("grid size-6 place-items-center rounded-lg", tone)}>{icon}</div>
      <span className="text-fg-2">{children}</span>
    </div>
  );
}

function inputChips(req: Req) {
  const input = (req.input ?? {}) as Record<string, unknown>;
  return Object.entries(input)
    .filter(
      ([k, v]) => ["category", "total", "recipient", "url", "amount"].includes(k) && typeof v === "string",
    )
    .map(([k, v]) => ({ k, v: String(v) }));
}

export function ApprovalCard({
  entry,
  agentName,
  compact,
}: {
  entry: TimelineEntry;
  agentName: string;
  compact?: boolean;
}) {
  const req = entry.request!;
  if (req.deviceWrite) return <DeviceWriteCard entry={entry} agentName={agentName} compact={compact} />;
  if (req.deviceAction) return <DeviceActionCard entry={entry} agentName={agentName} compact={compact} />;
  return <ToolApprovalCard entry={entry} agentName={agentName} compact={compact} />;
}

function ToolApprovalCard({
  entry,
  agentName,
  compact,
}: {
  entry: TimelineEntry;
  agentName: string;
  compact?: boolean;
}) {
  const req = entry.request!;
  const [busy, setBusy] = useState<string | null>(null);
  const respond = async (decision: "allow" | "allowAlways" | "deny") => {
    setBusy(decision);
    await run(api().call("request.respond", { agentId: entry.agentId, requestId: req.requestId, decision }));
    setBusy(null);
  };

  if (req.status !== "pending") {
    const map = {
      allowed: {
        icon: <ShieldCheck className="size-3.5" />,
        tone: "bg-success/12 text-success",
        label: "Allowed",
      },
      denied: { icon: <ShieldX className="size-3.5" />, tone: "bg-danger/12 text-danger", label: "Denied" },
      expired: { icon: <TimerOff className="size-3.5" />, tone: "bg-active text-muted", label: "Expired" },
      answered: {
        icon: <Check className="size-3.5" />,
        tone: "bg-success/12 text-success",
        label: "Answered",
      },
    } as const;
    const m = map[req.status as keyof typeof map] ?? map.expired;
    return (
      <Resolved icon={m.icon} tone={m.tone}>
        <span className="font-medium text-fg">{m.label}</span> · {req.title}
      </Resolved>
    );
  }

  const chips = inputChips(req);
  return (
    <div
      data-testid="approval-card"
      className={cn(
        "relative overflow-hidden rounded-2xl border border-warning/30 bg-card shadow-soft animate-rise",
        compact ? "" : "max-w-[560px]",
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-warning/[0.07] to-transparent" />
      <div className="relative flex gap-3 p-4">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-warning/14 text-warning">
          <ShieldAlert className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-warning text-xs font-medium">{agentName} needs your approval</div>
          <div className="mt-0.5 font-semibold text-md tracking-[-0.01em]">{req.title}</div>
          {req.detail && <div className="mt-1 text-fg-2 text-sm">{req.detail}</div>}
          {chips.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <span key={c.k} className="rounded-md bg-active px-2 py-0.5 text-2xs text-fg-2">
                  <span className="text-muted capitalize">{c.k}</span> {c.v}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="relative flex flex-wrap items-center gap-2 border-border border-t bg-bg/30 px-4 py-3">
        <Button
          variant="primary"
          size="sm"
          disabled={!!busy}
          onClick={() => respond("allow")}
          data-testid="approve-once"
        >
          Allow once
        </Button>
        <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => respond("allowAlways")}>
          Always allow
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          disabled={!!busy}
          onClick={() => respond("deny")}
          className="text-danger hover:text-danger"
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

/**
 * After an exact-action approval: the approval is only consent, so what happened comes from the device
 * operation (saved, failed, outcome unknown, or still saving).
 */
function approvedOutcome(
  op: DeviceOperation | undefined,
  checkWhat: string,
): { icon: React.ReactNode; tone: string; label: string } {
  if (op?.status === "succeeded")
    return { icon: <Check className="size-3.5" />, tone: "bg-success/12 text-success", label: "Saved" };
  if (op?.status === "failed" || op?.status === "cancelled")
    return {
      icon: <CircleX className="size-3.5" />,
      tone: "bg-danger/12 text-danger",
      label: `Approved, but not saved${op.reason ? ` (${op.reason})` : ""}`,
    };
  if (op?.status === "unknown-outcome")
    return {
      icon: <TriangleAlert className="size-3.5" />,
      tone: "bg-warning/14 text-warning",
      label: `Outcome unknown — check ${checkWhat}`,
    };
  return { icon: <Clock className="size-3.5" />, tone: "bg-active text-muted", label: "Approved · saving…" };
}

function useNow(everyMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}

function expiryHint(expiresAt: number, now: number) {
  const ms = expiresAt - now;
  if (ms <= 0) return "This request has expired";
  const min = Math.round(ms / 60_000);
  return min < 1 ? "Expires in under a minute" : `Expires in ${min} min`;
}

/**
 * Exact-action approval for a change to a file on the user's Mac. The card shows the precise file and
 * content; approving covers only these bytes (core binds the approval to them). Never "always allow".
 */
function DeviceWriteCard({
  entry,
  agentName,
  compact,
}: {
  entry: TimelineEntry;
  agentName: string;
  compact?: boolean;
}) {
  const req = entry.request!;
  const w = req.deviceWrite!;
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const now = useNow(15_000);
  const op = useApp((s) => s.operations?.find((o) => o.id === w.operationId));
  const allowed = req.status === "allowed";
  useEffect(() => {
    // The approval is only consent; the save's own outcome comes from the operation record.
    if (allowed) void load.operations();
  }, [allowed]);

  const respond = async (decision: "allow" | "deny") => {
    setBusy(decision);
    await run(api().call("request.respond", { agentId: entry.agentId, requestId: req.requestId, decision }));
    setBusy(null);
  };

  const where = (
    <>
      <span className="font-mono text-[12.5px]">{w.displayPath}</span> on {w.deviceName}
    </>
  );

  if (req.status !== "pending") {
    if (req.status === "allowed") {
      const r = approvedOutcome(op, "the file");
      return (
        <Resolved icon={r.icon} tone={r.tone}>
          <span className="font-medium text-fg" data-testid="device-write-result">
            {r.label}
          </span>{" "}
          · {where}
        </Resolved>
      );
    }
    const m =
      req.status === "denied"
        ? { icon: <ShieldX className="size-3.5" />, tone: "bg-danger/12 text-danger", label: "Declined" }
        : { icon: <TimerOff className="size-3.5" />, tone: "bg-active text-muted", label: "Expired" };
    return (
      <Resolved icon={m.icon} tone={m.tone}>
        <span className="font-medium text-fg" data-testid="device-write-result">
          {m.label}
        </span>{" "}
        · {where} · nothing was changed
      </Resolved>
    );
  }

  const expired = w.expiresAt <= now;
  return (
    <div
      data-testid="device-write-card"
      className={cn(
        "relative overflow-hidden rounded-2xl border border-warning/30 bg-card shadow-soft animate-rise",
        compact ? "" : "max-w-[560px]",
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-warning/[0.07] to-transparent" />
      <div className="relative flex gap-3 p-4">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-warning/14 text-warning">
          <FilePen className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-warning text-xs">
            {agentName} wants to change a file on your Mac
          </div>
          <div className="mt-0.5 font-semibold text-md tracking-[-0.01em]">{req.title}</div>
          <dl className="mt-2.5 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted">File</dt>
            <dd className="min-w-0 break-words" data-testid="device-write-path">
              {where}
            </dd>
            <dt className="text-muted">Size</dt>
            <dd className="tabular-nums">{fileSize(w.bytes)}</dd>
            <dt className="text-muted">Effect</dt>
            <dd>
              {w.replaces
                ? `Replaces a ${fileSize(w.replaces.bytes)} file${w.replaces.modifiedAt ? ` modified ${ago(w.replaces.modifiedAt)}` : ""}`
                : "Creates a new file"}
            </dd>
          </dl>
        </div>
      </div>
      <div className="relative px-4 pb-4">
        {w.preview != null ? (
          <pre
            // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be reachable by keyboard
            tabIndex={0}
            role="region"
            aria-label={`New content of ${w.displayPath}`}
            data-testid="device-write-preview"
            className="max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-bg/60 p-3 font-mono text-[12px] text-fg-2 leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-link/60"
          >
            {w.preview}
          </pre>
        ) : (
          <div className="rounded-xl border border-border border-dashed px-3 py-2.5 text-muted text-sm">
            Binary file — preview not available
          </div>
        )}
        {w.preview != null && new TextEncoder().encode(w.preview).length < w.bytes && (
          <div className="mt-1.5 text-muted text-xs">Showing the beginning of the file.</div>
        )}
      </div>
      <div className="relative flex flex-wrap items-center gap-2 border-border border-t bg-bg/30 px-4 py-3">
        <Button
          variant="primary"
          size="sm"
          disabled={!!busy || expired}
          onClick={() => respond("allow")}
          data-testid="device-write-save"
        >
          Save file
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!!busy || expired}
          onClick={() => respond("deny")}
          data-testid="device-write-cancel"
        >
          Cancel
        </Button>
        <div className="flex-1" />
        <span className="text-muted text-xs" data-testid="device-write-expiry">
          {expiryHint(w.expiresAt, now)}
        </span>
      </div>
    </div>
  );
}

/**
 * Exact-action approval for a change in a Mac app (Calendar, Reminders, Notes, a Mail draft) or for a
 * window session (one window, a few minutes). The card lists exactly what will happen; approving covers
 * only this (core binds the approval to it). Never "always allow".
 */
function DeviceActionCard({
  entry,
  agentName,
  compact,
}: {
  entry: TimelineEntry;
  agentName: string;
  compact?: boolean;
}) {
  const req = entry.request!;
  const a = req.deviceAction!;
  const info = macApp(a.app);
  /** A window session (R3) is an allowance for a few minutes, not a change to save. */
  const screen = a.app === "screen";
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const now = useNow(15_000);
  const op = useApp((s) => s.operations?.find((o) => o.id === a.operationId));
  const allowed = req.status === "allowed";
  useEffect(() => {
    // The approval is only consent; the change's own outcome comes from the operation record.
    if (allowed) void load.operations();
  }, [allowed]);

  const respond = async (decision: "allow" | "deny") => {
    setBusy(decision);
    await run(api().call("request.respond", { agentId: entry.agentId, requestId: req.requestId, decision }));
    setBusy(null);
  };

  if (req.status !== "pending") {
    const r =
      req.status === "allowed"
        ? screen
          ? {
              icon: <ShieldCheck className="size-3.5" />,
              tone: "bg-success/12 text-success",
              label: "Allowed",
            }
          : approvedOutcome(op, info.label)
        : req.status === "denied"
          ? { icon: <ShieldX className="size-3.5" />, tone: "bg-danger/12 text-danger", label: "Declined" }
          : { icon: <TimerOff className="size-3.5" />, tone: "bg-active text-muted", label: "Expired" };
    return (
      <Resolved icon={r.icon} tone={r.tone}>
        <span className="font-medium text-fg" data-testid="device-action-result">
          {r.label}
        </span>{" "}
        · {req.title}
        {req.status !== "allowed"
          ? screen
            ? " · Yo didn't use the window"
            : ` · ${info.label} wasn't changed`
          : ""}
      </Resolved>
    );
  }

  const expired = a.expiresAt <= now;
  // Window sessions: "Allow for 10 min", from the card's own "Time" line ("Up to 10 min").
  const minutes = screen
    ? a.lines.find((l) => l.label === "Time")?.value.match(/(\d+)\s*min/)?.[1]
    : undefined;
  const heading = screen
    ? `${agentName} wants to use a window on your Mac`
    : a.app === "mail"
      ? `${agentName} wants to save a draft in Mail on your Mac`
      : `${agentName} wants to change ${info.label} on your Mac`;
  return (
    <div
      data-testid="device-action-card"
      className={cn(
        "relative overflow-hidden rounded-2xl border border-warning/30 bg-card shadow-soft animate-rise",
        compact ? "" : "max-w-[560px]",
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-warning/[0.07] to-transparent" />
      <div className="relative flex gap-3 p-4">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-warning/14 text-warning">
          <info.icon className="size-[18px]" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-warning text-xs" data-testid="device-action-heading">
            {heading}
          </div>
          <div className="mt-0.5 font-semibold text-md tracking-[-0.01em]">{req.title}</div>
          <dl
            className="mt-2.5 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm"
            data-testid="device-action-lines"
          >
            {a.lines.map((l, i) => (
              // Labels can repeat, so the position keeps keys unique (the list never reorders).
              <div key={`${i}-${l.label}`} className="contents">
                <dt className="text-muted">{l.label}</dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words">{l.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <div className="relative flex flex-wrap items-center gap-2 border-border border-t bg-bg/30 px-4 py-3">
        <Button
          variant="primary"
          size="sm"
          disabled={!!busy || expired}
          onClick={() => respond("allow")}
          data-testid="device-action-save"
        >
          {screen ? (minutes ? `Allow for ${minutes} min` : "Allow") : info.saveLabel}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!!busy || expired}
          onClick={() => respond("deny")}
          data-testid="device-action-cancel"
        >
          {screen ? "Don't allow" : "Cancel"}
        </Button>
        <div className="flex-1" />
        <span className="text-muted text-xs" data-testid="device-action-expiry">
          {expiryHint(a.expiresAt, now)}
        </span>
      </div>
    </div>
  );
}

export function AskUserCard({ entry, agentName }: { entry: TimelineEntry; agentName: string }) {
  const req = entry.request!;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const qs = req.questions ?? [];
  const q = qs[0];

  const answer = async (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    const answers: Record<string, string> = {};
    for (const x of qs) answers[x.question] = value;
    await run(
      api().call("request.respond", {
        agentId: entry.agentId,
        requestId: req.requestId,
        decision: "allow",
        answers,
        message: value,
      }),
    );
    setBusy(false);
  };

  if (req.status !== "pending") {
    const input = req.input as { message?: string; answers?: Record<string, string> } | undefined;
    const ans = input?.message ?? Object.values(input?.answers ?? {})[0];
    return (
      <Resolved icon={<CircleHelp className="size-3.5" />} tone="bg-active text-muted">
        {q?.question ?? req.title}
        {ans && (
          <>
            {" "}
            → <span className="font-medium text-fg">{ans}</span>
          </>
        )}
      </Resolved>
    );
  }

  return (
    <div
      data-testid="ask-card"
      className="max-w-[560px] overflow-hidden rounded-2xl border border-border-strong/70 bg-card shadow-soft animate-rise"
    >
      <div className="flex gap-3 p-4 pb-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-link/12 text-link">
          <CircleHelp className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-link text-xs">
            {agentName} is asking{q?.header ? ` · ${q.header}` : ""}
          </div>
          <div className="mt-0.5 font-semibold text-md tracking-[-0.01em]">{q?.question ?? req.title}</div>
        </div>
      </div>
      {q && q.options.length > 0 && (
        <div className="grid gap-1.5 px-4 pb-3">
          {q.options.map((o) => (
            <button
              key={o.label}
              disabled={busy}
              onClick={() => answer(o.label)}
              className="group flex items-center gap-3 rounded-xl border border-border-strong/60 bg-bg/40 px-3.5 py-2.5 text-left transition-all hover:border-link/50 hover:bg-link/[0.06] disabled:opacity-50"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">{o.label}</div>
                {o.description && <div className="text-muted text-sm">{o.description}</div>}
              </div>
              <ArrowUp className="size-3.5 rotate-45 text-faint transition-colors group-hover:text-link" />
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-2 border-border border-t px-4 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void answer(text);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Or type your own answer…"
          className="h-8 flex-1 bg-transparent text-base outline-none"
        />
        <Button
          type="submit"
          variant="primary"
          size="icon-sm"
          disabled={!text.trim() || busy}
          aria-label="Send answer"
          className="rounded-full"
        >
          <ArrowUp className="size-4" />
        </Button>
      </form>
    </div>
  );
}
