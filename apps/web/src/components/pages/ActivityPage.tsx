import { YoLogo } from "@yo/avatar";
import type { ActivityEvent } from "@yo/contracts";
import {
  Activity,
  Brain,
  CalendarClock,
  CircleCheck,
  CircleX,
  Hand,
  Laptop,
  Play,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import { clockTime, cn, dayLabel } from "../../lib/utils";
import { sortAgents, useApp } from "../../stores/app";
import { load } from "../../stores/sync";
import { ui } from "../../stores/ui";
import { AgentAvatar } from "../brand";
import { LoadState, useLoad } from "../LoadState";
import { EmptyNote, PageShell } from "../PageHeader";
import { Select } from "../ui/controls";

const KIND: Record<ActivityEvent["kind"], { icon: typeof Activity; tone: string; label: string }> = {
  "run.started": { icon: Play, tone: "text-brand-ink bg-brand/12", label: "Started" },
  "run.completed": { icon: CircleCheck, tone: "text-success bg-success/12", label: "Completed" },
  "run.failed": { icon: CircleX, tone: "text-danger bg-danger/12", label: "Failed" },
  approval: { icon: ShieldCheck, tone: "text-warning bg-warning/14", label: "Approval" },
  routine: { icon: CalendarClock, tone: "text-link-ink bg-link/12", label: "Routine" },
  memory: { icon: Brain, tone: "text-[#a78bfa] bg-[#a78bfa]/12", label: "Memory" },
  takeover: { icon: Hand, tone: "text-success bg-success/12", label: "Takeover" },
  system: { icon: Sparkles, tone: "text-muted bg-active", label: "System" },
  device: { icon: Laptop, tone: "text-link-ink bg-link/12", label: "Mac" },
};

export function ActivityPage() {
  const activity = useApp((s) => s.activity);
  const agents = useApp((s) => s.agents);
  const [show, setShow] = useState<"now" | "history">("now");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const status = useLoad(() => load.activity(true));

  const groups = useMemo(() => {
    const list = (activity ?? []).filter(
      (e) => e.kind !== "run.started" && (agentFilter === "all" || e.agentId === agentFilter),
    );
    const out: { day: string; items: ActivityEvent[] }[] = [];
    for (const e of list) {
      const d = dayLabel(e.ts);
      const last = out[out.length - 1];
      if (last && last.day === d) last.items.push(e);
      else out.push({ day: d, items: [e] });
    }
    return out;
  }, [activity, agentFilter]);

  return (
    <PageShell
      title="Everything in motion, in one place."
      subtitle="What’s moving, what needs you, and what’s already taken care of."
      actions={
        <div className="w-52">
          <Select
            value={agentFilter}
            onChange={setAgentFilter}
            options={[
              { value: "all", label: "Whole workspace" },
              ...sortAgents(agents).map((a) => ({
                value: a.id,
                label: a.name,
                icon: <AgentAvatar agent={a} size={18} state="idle" quiet />,
              })),
            ]}
          />
        </div>
      }
    >
      <div className="mb-6 flex gap-2">
        <button
          className={cn("rounded-lg px-3 py-2 text-sm", show === "now" && "bg-active")}
          onClick={() => setShow("now")}
          aria-pressed={show === "now"}
        >
          In progress
        </button>
        <button
          className={cn("rounded-lg px-3 py-2 text-sm", show === "history" && "bg-active")}
          onClick={() => setShow("history")}
          aria-pressed={show === "history"}
        >
          History
        </button>
      </div>
      {show === "now" && (
        <div className="space-y-3">
          {sortAgents(agents)
            .filter(
              (a) =>
                ["working", "waiting"].includes(a.activity) &&
                (agentFilter === "all" || a.id === agentFilter),
            )
            .map((a) => (
              <button
                key={a.id}
                onClick={() => ui.openAgent(a.id)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-4 text-left"
              >
                <AgentAvatar agent={a} size={32} />
                <span className="min-w-0">
                  <strong className="font-medium">{a.name}</strong>
                  <span className="block truncate text-muted text-sm">
                    {a.preview || "Working on your request"}
                  </span>
                </span>
                <span className="ml-auto text-muted text-xs">
                  {a.activity === "waiting" ? "Needs you" : "Working"}
                </span>
              </button>
            ))}
          {!sortAgents(agents).some(
            (a) =>
              ["working", "waiting"].includes(a.activity) && (agentFilter === "all" || a.id === agentFilter),
          ) && (
            <EmptyNote
              icon={<CircleCheck />}
              title="A little room for what’s next."
              body="Nothing is running right now. Start a new request whenever you’re ready."
            />
          )}
        </div>
      )}
      {/* A failed load shows on either tab (with its retry); the spinner only where the list goes. */}
      {(show === "history" || status.error) && (
        <LoadState ready={!!activity} {...status} what="your activity" />
      )}
      {show === "history" && activity && groups.length === 0 && (
        <EmptyNote
          icon={<Activity />}
          title="No activity yet"
          body="Runs, approvals and routines will show up here."
        />
      )}
      <div className="space-y-8" hidden={show !== "history"}>
        {groups.map((g) => (
          <section key={g.day}>
            <div className="mb-2 font-medium text-muted text-sm">{g.day}</div>
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-card">
              {g.items.map((e, i) => {
                const k = KIND[e.kind];
                const a = e.agentId ? agents[e.agentId] : undefined;
                return (
                  <button
                    key={e.id}
                    onClick={() => a && ui.openAgent(a.id)}
                    className={cn(
                      "flex w-full items-center gap-3.5 px-4 py-3 text-left transition-colors hover:bg-hover",
                      i > 0 && "border-border border-t",
                    )}
                  >
                    <div className="relative">
                      {a ? <AgentAvatar agent={a} size={30} state="idle" quiet /> : <YoLogo size={30} />}
                      <div
                        className={cn(
                          "-right-1 -bottom-1 absolute grid size-4 place-items-center rounded-full ring-2 ring-card",
                          k.tone,
                        )}
                      >
                        <k.icon className="size-2.5" strokeWidth={2.5} />
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{e.summary}</div>
                      <div className="text-muted text-xs">
                        {a?.name ?? "Yo"} · {k.label}
                      </div>
                    </div>
                    <div className="shrink-0 text-faint text-xs tabular-nums">{clockTime(e.ts)}</div>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </PageShell>
  );
}
