import type { Routine } from "@yo/contracts";
import { CalendarClock, MoreHorizontal, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import {
  buildCron,
  describeCron,
  HOUR_STEPS,
  isValidCron,
  nextRuns,
  type Preset,
  parsePreset,
} from "../../lib/cron";
import { ago, clockTime, cn, whenLabel } from "../../lib/utils";
import { sortAgents, useApp } from "../../stores/app";
import { load, run } from "../../stores/sync";
import { useUI } from "../../stores/ui";
import { AgentAvatar } from "../brand";
import { LoadState, useLoad } from "../LoadState";
import { EmptyNote, PageShell } from "../PageHeader";
import { Button } from "../ui/button";
import { Field, Input, Segmented, Select, Switch, Textarea } from "../ui/controls";
import { Menu, MenuItem, MenuSeparator, Modal } from "../ui/overlay";

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** S M T W T F S: pick any days of the week. The last day left on can't be turned off. */
function DayPicker({ days, onChange }: { days: number[]; onChange: (days: number[]) => void }) {
  return (
    <div className="flex gap-1" role="group" aria-label="Days of the week" data-testid="routine-days">
      {DOW.map((name, i) => {
        const on = days.includes(i);
        return (
          <button
            key={name}
            aria-pressed={on}
            aria-label={name}
            title={name}
            data-testid={`routine-day-${i}`}
            onClick={() => {
              if (on && days.length === 1) return;
              onChange(on ? days.filter((d) => d !== i) : [...days, i].sort((a, b) => a - b));
            }}
            className={cn(
              "grid size-9 place-items-center rounded-full font-medium text-sm transition-colors",
              on ? "bg-fg text-bg" : "bg-active/70 text-muted hover:text-fg",
            )}
          >
            {name[0]}
          </button>
        );
      })}
    </div>
  );
}

/** "Today, 9:00 AM · 1:00 PM · Wed, Oct 28, 9:00 AM": the day is said only when it changes. */
function runsLabel(times: number[]): string {
  return times
    .map((t, i) =>
      i > 0 && new Date(t).toDateString() === new Date(times[i - 1]!).toDateString()
        ? clockTime(t)
        : whenLabel(t),
    )
    .join(" · ");
}

export function RoutineDialog({
  open,
  onOpenChange,
  routine,
  defaultAgentId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  routine: Routine | null;
  defaultAgentId?: string;
}) {
  const agents = useApp((s) => s.agents);
  const roster = sortAgents(agents);
  const init = parsePreset(routine?.cron);
  const [agentId, setAgentId] = useState(routine?.agentId ?? defaultAgentId ?? roster[0]?.id ?? "");
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [preset, setPreset] = useState<Preset>(init.preset);
  const [time, setTime] = useState(init.time);
  const [days, setDays] = useState(init.days);
  const [every, setEvery] = useState(init.every);
  const [custom, setCustom] = useState(routine?.cron ?? "0 9 * * 1");
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const p = parsePreset(routine?.cron);
    setAgentId(routine?.agentId ?? defaultAgentId ?? roster[0]?.id ?? "");
    setName(routine?.name ?? "");
    setPrompt(routine?.prompt ?? "");
    setPreset(p.preset);
    setTime(p.time);
    setDays(p.days);
    setEvery(p.every);
    setCustom(routine?.cron ?? "0 9 * * 1");
    setEnabled(routine?.enabled ?? true);
  }, [open, routine]);

  const cron = buildCron({ preset, time, days, every }, custom);
  const valid = isValidCron(cron);
  const upcoming = useMemo(() => (valid ? nextRuns(cron, 3) : []), [cron, valid]);

  const save = async () => {
    if (!name.trim() || !prompt.trim() || !valid) return;
    setBusy(true);
    const r = routine
      ? await run(api().call("routine.update", { id: routine.id, patch: { name, prompt, cron, enabled } }))
      : await run(api().call("routine.create", { agentId, name, prompt, cron }));
    setBusy(false);
    if (r) {
      toast.success(routine ? "Routine updated" : "Routine created", {
        description: `${describeCron(cron)} · ${agents[agentId]?.name ?? ""}`,
      });
      void load.routines(true);
      onOpenChange(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={routine ? "Edit routine" : "New routine"}
      description="Runs on a schedule while its computer is available."
      className="w-[min(560px,calc(100vw-32px))]"
      testId="routine-dialog"
    >
      <div className="space-y-4 px-5 pt-4 pb-5">
        <div className="grid grid-cols-[1fr_1.3fr] gap-3">
          <Field label="Agent">
            <Select
              value={agentId}
              onChange={setAgentId}
              options={roster.map((a) => ({
                value: a.id,
                label: a.name,
                icon: <AgentAvatar agent={a} size={18} state="idle" quiet />,
              }))}
            />
          </Field>
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Morning brief"
              data-testid="routine-name"
            />
          </Field>
        </div>
        <Field label="What should it do?">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Summarize my calendar, deadlines and anything that needs a reply."
            rows={3}
            data-testid="routine-prompt"
          />
        </Field>
        <div className="space-y-2.5">
          <span className="block font-medium text-fg-2 text-sm">Schedule</span>
          <Segmented
            value={preset}
            onChange={setPreset}
            className="w-full [&>button]:flex-1"
            options={[
              { value: "daily", label: "Daily" },
              { value: "weekdays", label: "Weekdays" },
              { value: "days", label: "Days" },
              { value: "hours", label: "Hours" },
              { value: "custom", label: "Custom" },
            ]}
          />
          <div className="flex flex-wrap items-center gap-2.5">
            {preset === "days" && <DayPicker days={days} onChange={setDays} />}
            {(preset === "daily" || preset === "weekdays" || preset === "days") && (
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-32 tabular-nums"
              />
            )}
            {preset === "custom" && (
              <Input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                className="font-mono"
                placeholder="0 9 * * 1"
                aria-label="Cron expression"
              />
            )}
            {preset === "hours" && (
              <div className="w-44">
                <Select
                  value={String(every)}
                  onChange={(v) => setEvery(Number(v))}
                  label="How often"
                  testId="routine-every"
                  options={HOUR_STEPS.map((n) => ({
                    value: String(n),
                    label: n === 1 ? "Every hour" : `Every ${n} hours`,
                  }))}
                />
              </div>
            )}
          </div>
          <div
            className={cn(
              "flex items-start gap-2 rounded-xl bg-active/60 px-3 py-2 text-sm",
              !valid && "text-danger",
            )}
            data-testid="routine-schedule"
          >
            <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted" />
            {valid ? (
              <div className="min-w-0">
                <div>{describeCron(cron)}</div>
                <div className="text-muted text-xs" data-testid="routine-next">
                  Next: {upcoming.length ? runsLabel(upcoming) : "none in the next two months"}
                </div>
              </div>
            ) : (
              "That schedule doesn't look right (use 5-field cron: min hour day month weekday)"
            )}
          </div>
        </div>
        {routine && (
          <div className="flex items-center justify-between rounded-xl border border-border px-3 py-2.5">
            <span>Enabled</span>
            <Switch checked={enabled} onCheckedChange={setEnabled} label="Enabled" />
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-border border-t bg-bg/30 px-5 py-3.5">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={save}
          disabled={busy || !name.trim() || !prompt.trim() || !valid}
          data-testid="routine-save"
        >
          {routine ? "Save changes" : "Create routine"}
        </Button>
      </div>
    </Modal>
  );
}

export function RoutinesPage() {
  const routines = useApp((s) => s.routines);
  const agents = useApp((s) => s.agents);
  const selected = useUI((s) => s.agentId);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [open, setOpen] = useState(false);
  const status = useLoad(() => load.routines(true));
  const list = useMemo(
    () =>
      [...(routines ?? [])].sort(
        (a, b) =>
          Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity),
      ),
    [routines],
  );

  return (
    <PageShell
      title="Routines"
      subtitle="Things you ask Yo to do on a schedule."
      actions={
        <Button
          variant="primary"
          data-testid="new-routine"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <Plus className="size-4" /> New routine
        </Button>
      }
    >
      <LoadState ready={!!routines} {...status} what="your routines" />
      {routines && list.length === 0 && (
        <EmptyNote
          icon={<CalendarClock />}
          title="No routines yet"
          body="Try “Every weekday at 8am, brief me on my day.”"
        />
      )}
      <div className="space-y-2.5" data-testid="routine-list">
        {list.map((r) => {
          const a = agents[r.agentId];
          return (
            <div
              key={r.id}
              data-testid="routine-row"
              data-record-id={r.id}
              className={cn(
                "flex items-center gap-4 rounded-2xl border border-border bg-card shadow-card px-4 py-3.5 transition-opacity",
                !r.enabled && "opacity-60",
              )}
            >
              {a && <AgentAvatar agent={a} size={36} state="idle" quiet />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{r.name}</span>
                  <span className="text-faint text-xs">· {a?.name}</span>
                </div>
                <div className="line-clamp-2 text-muted text-sm" title={r.prompt}>
                  {r.prompt}
                </div>
                <div className="mt-1 flex items-center gap-3 text-xs">
                  <span className="flex items-center gap-1.5 text-fg-2">
                    <CalendarClock className="size-3.5 text-muted" />
                    {describeCron(r.cron)}
                  </span>
                  {r.enabled && r.nextRunAt && (
                    <span className="text-muted">Next {whenLabel(r.nextRunAt)}</span>
                  )}
                  {r.lastRunAt && <span className="text-faint">Last ran {ago(r.lastRunAt)}</span>}
                </div>
              </div>
              <Switch
                checked={r.enabled}
                label={`Enable ${r.name}`}
                onCheckedChange={(v) =>
                  run(api().call("routine.update", { id: r.id, patch: { enabled: v } }))
                }
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  await run(api().call("routine.runNow", { id: r.id }));
                  toast.success(`Running “${r.name}”`, { description: `${a?.name ?? "Agent"} is on it.` });
                }}
              >
                <Play className="size-3.5" /> Run now
              </Button>
              <Menu
                trigger={
                  <button
                    aria-label="Routine options"
                    className="grid size-8 place-items-center rounded-lg text-muted hover:bg-hover hover:text-fg"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                }
              >
                <MenuItem
                  icon={<Pencil />}
                  onClick={() => {
                    setEditing(r);
                    setOpen(true);
                  }}
                >
                  Edit
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  danger
                  icon={<Trash2 />}
                  onClick={() => run(api().call("routine.delete", { id: r.id }))}
                >
                  Delete
                </MenuItem>
              </Menu>
            </div>
          );
        })}
      </div>
      <RoutineDialog
        open={open}
        onOpenChange={setOpen}
        routine={editing}
        defaultAgentId={selected ?? undefined}
      />
    </PageShell>
  );
}
