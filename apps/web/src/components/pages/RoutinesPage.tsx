import type { Routine } from "@yo/contracts";
import { CalendarClock, MoreHorizontal, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { describeCron, isValidCron, nextRun } from "../../lib/cron";
import { ago, cn, whenLabel } from "../../lib/utils";
import { sortAgents, useApp } from "../../stores/app";
import { load, run } from "../../stores/sync";
import { useUI } from "../../stores/ui";
import { AgentAvatar } from "../brand";
import { EmptyNote, PageShell } from "../PageHeader";
import { Button } from "../ui/button";
import { Field, Input, Segmented, Select, Switch, Textarea } from "../ui/controls";
import { Menu, MenuItem, MenuSeparator, Modal } from "../ui/overlay";

type Preset = "daily" | "weekdays" | "weekly" | "hourly" | "custom";

function parsePreset(cron: string | null | undefined): { preset: Preset; time: string; dow: string } {
  const d = { preset: "daily" as Preset, time: "08:00", dow: "1" };
  if (!cron) return d;
  const f = cron.split(/\s+/);
  const [mi, ho, dom, mon, dow] = f;
  const time =
    /^\d+$/.test(mi ?? "") && /^\d+$/.test(ho ?? "")
      ? `${ho!.padStart(2, "0")}:${mi!.padStart(2, "0")}`
      : d.time;
  if (f.length === 5 && dom === "*" && mon === "*") {
    if (mi === "0" && ho === "*" && dow === "*") return { ...d, preset: "hourly" };
    if (/^\d+$/.test(ho ?? "")) {
      if (dow === "*") return { ...d, preset: "daily", time };
      if (dow === "1-5") return { ...d, preset: "weekdays", time };
      if (/^\d$/.test(dow ?? "")) return { preset: "weekly", time, dow: dow! };
    }
  }
  return { ...d, preset: "custom" };
}

function buildCron(preset: Preset, time: string, dow: string, custom: string): string {
  const [h, m] = time.split(":").map((x) => Number(x));
  switch (preset) {
    case "daily":
      return `${m ?? 0} ${h ?? 8} * * *`;
    case "weekdays":
      return `${m ?? 0} ${h ?? 8} * * 1-5`;
    case "weekly":
      return `${m ?? 0} ${h ?? 8} * * ${dow}`;
    case "hourly":
      return "0 * * * *";
    default:
      return custom.trim();
  }
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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
  const [dow, setDow] = useState(init.dow);
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
    setDow(p.dow);
    setCustom(routine?.cron ?? "0 9 * * 1");
    setEnabled(routine?.enabled ?? true);
  }, [open, routine]);

  const cron = buildCron(preset, time, dow, custom);
  const valid = isValidCron(cron);
  const next = valid ? nextRun(cron) : null;

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
      description="Your agent runs this on a schedule — even while you're away."
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
              { value: "weekly", label: "Weekly" },
              { value: "hourly", label: "Hourly" },
              { value: "custom", label: "Custom" },
            ]}
          />
          <div className="flex items-center gap-2.5">
            {preset === "weekly" && (
              <div className="w-40">
                <Select
                  value={dow}
                  onChange={setDow}
                  options={DOW.map((d, i) => ({ value: String(i), label: d }))}
                />
              </div>
            )}
            {(preset === "daily" || preset === "weekdays" || preset === "weekly") && (
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
            {preset === "hourly" && <span className="text-muted text-sm">At the top of every hour</span>}
          </div>
          <div
            className={cn(
              "flex items-center gap-2 rounded-xl bg-active/60 px-3 py-2 text-sm",
              !valid && "text-danger",
            )}
          >
            <CalendarClock className="size-4 text-muted" />
            {valid ? (
              <span>
                {describeCron(cron)} <span className="text-muted">· next {next ? whenLabel(next) : "—"}</span>
              </span>
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
  useEffect(() => {
    void load.routines(true);
  }, []);
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
      subtitle="Recurring work your agents do on their own."
      icon={<CalendarClock className="size-4 text-muted" />}
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
                <div className="truncate text-muted text-sm">{r.prompt}</div>
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
