import { Avatar, type TurnInfo, turnInfo } from "@yo/avatar";
import type { Account, AgentActivity, AgentView, ProviderKind } from "@yo/contracts";
import { useMemo } from "react";
import { cn } from "../lib/utils";
import { useTimeline } from "../stores/timeline";

export { PROVIDER_NAME } from "../lib/accounts";

export const PROVIDER_VENDOR: Record<ProviderKind, string> = {
  claude: "Anthropic",
  codex: "OpenAI",
  grok: "xAI",
};

/** Simple original provider glyphs (not official logos). */
export function ProviderIcon({ provider, className }: { provider: ProviderKind; className?: string }) {
  if (provider === "claude")
    return (
      <svg viewBox="0 0 24 24" className={cn("size-4", className)} aria-label="Claude">
        <g stroke="#D97757" strokeWidth="2.6" strokeLinecap="round">
          {[0, 45, 90, 135].map((r) => (
            <path key={r} d="M12 3.2V20.8" transform={`rotate(${r} 12 12)`} />
          ))}
        </g>
      </svg>
    );
  if (provider === "codex")
    return (
      <svg viewBox="0 0 24 24" className={cn("size-4 text-fg", className)} aria-label="ChatGPT" fill="none">
        <g stroke="currentColor" strokeWidth="1.7">
          {[0, 60, 120].map((r) => (
            <ellipse key={r} cx="12" cy="12" rx="8.6" ry="4.2" transform={`rotate(${r} 12 12)`} />
          ))}
        </g>
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" className={cn("size-4 text-fg", className)} aria-label="Grok" fill="none">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.9" />
      <path d="M6 18L18.5 5.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function accountTone(a: Pick<Account, "status">): "success" | "warning" | "danger" | "muted" {
  switch (a.status) {
    case "authenticated":
    case "unverified":
      return "success";
    case "signing_in":
      return "warning";
    case "error":
      return "danger";
    default:
      return "muted";
  }
}

export function StatusDot({
  tone,
  className,
}: {
  tone: "success" | "warning" | "danger" | "muted" | "brand";
  className?: string;
}) {
  const c = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    muted: "bg-faint",
    brand: "bg-brand",
  }[tone];
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", c, className)} />;
}

export function agentState(a: AgentView): AgentActivity {
  if (
    a.activity === "idle" &&
    (a.computer.state === "hibernated" || a.computer.state === "off") &&
    !a.isPrimary
  )
    return "sleeping";
  return a.activity;
}

export function AgentAvatar({
  agent,
  size = 32,
  className,
  ground,
  state,
  quiet,
  live,
}: {
  agent: Pick<AgentView, "avatar" | "name"> & Partial<AgentView>;
  size?: number;
  className?: string;
  ground?: boolean;
  state?: AgentActivity;
  /** Decorative (lists, headers): living characters stay awake instead of showing the idle "asleep" look. */
  quiet?: boolean;
  /**
   * The agent you're viewing (chat header, empty-state hero): a creature avatar animates on the one shared
   * renderer and shows "thinking" from the agent's timeline. Lists leave this off (cached still pictures).
   */
  live?: boolean;
}) {
  const s = state ?? (agent.activity ? agentState(agent as AgentView) : "idle");
  const creatureLive = !!live && !!agent.avatar.creature;
  // A primitive key, so streaming deltas don't re-render the avatar unless the pose would change.
  const turnKey = useTimeline((t) => {
    const info = creatureLive && agent.id ? turnInfo(t.byAgent[agent.id]) : undefined;
    return info ? `${info.toolRunning ? 1 : 0}:${info.lastKind ?? ""}` : "";
  });
  const turn = useMemo<TurnInfo | undefined>(() => {
    if (!turnKey) return undefined;
    const [tool, kind] = turnKey.split(":");
    return { toolRunning: tool === "1", lastKind: (kind || null) as TurnInfo["lastKind"] };
  }, [turnKey]);
  return (
    <Avatar
      avatar={agent.avatar}
      live={live}
      turn={turn}
      size={size}
      state={s}
      className={className}
      ground={ground}
      quiet={quiet}
      title={agent.name}
    />
  );
}

type PillKind = "working" | "waiting" | "idle" | "sleeping" | "done" | "error" | "control";

export function pillFor(a: AgentView): PillKind {
  if (a.computer.lease === "user") return "control";
  return agentState(a);
}

export function StatusPill({ kind, className }: { kind: PillKind; className?: string }) {
  const map: Record<PillKind, { label: string; cls: string; dot: string; pulse?: boolean }> = {
    working: { label: "Working", cls: "bg-brand/12 text-brand-ink", dot: "bg-brand", pulse: true },
    waiting: { label: "Needs you", cls: "bg-warning/14 text-warning", dot: "bg-warning", pulse: true },
    idle: { label: "Idle", cls: "bg-active text-muted", dot: "bg-faint" },
    sleeping: { label: "Sleeping", cls: "bg-active text-muted", dot: "bg-faint" },
    done: { label: "Done", cls: "bg-success/12 text-success", dot: "bg-success" },
    error: { label: "Error", cls: "bg-danger/12 text-danger", dot: "bg-danger" },
    control: { label: "You have control", cls: "bg-success/14 text-success", dot: "bg-success", pulse: true },
  };
  const m = map[kind];
  return (
    <span
      data-testid="status-pill"
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 font-medium text-xs",
        m.cls,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", m.dot, m.pulse && "pulse-dot")} />
      {m.label}
    </span>
  );
}
