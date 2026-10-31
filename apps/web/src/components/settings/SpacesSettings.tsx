/**
 * Settings → Work & Personal: turn spaces on or off, follow the work hours or stay put, edit the hours (Monday
 * first) and time zone, and see which agent (and model) runs each space.
 */
import {
  type AgentView,
  agentForSpace,
  describeWorkHours,
  localTimeZone,
  resolveSpace,
  type Settings,
  SPACE_LABELS,
  type Space,
} from "@yo/contracts";
import { Briefcase, House, Settings2 } from "lucide-react";
import { useMemo } from "react";
import { api } from "../../lib/api";
import { useNow } from "../../lib/useNow";
import { cn } from "../../lib/utils";
import {
  applyPreset,
  cleanTime,
  clockLabel,
  DAY_NAMES,
  DAY_ORDER,
  DAY_SHORT,
  dayHint,
  formHours,
  PRESETS,
  type PresetId,
  presetOf,
  rightNow,
  setDay,
  zoneLabel,
  zoneOptions,
} from "../../lib/workHoursForm";
import { accountFor, useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { useUI } from "../../stores/ui";
import { modelInfo, shortModel } from "../agent/ModelPicker";
import { AgentAvatar, PROVIDER_NAME, ProviderIcon } from "../brand";
import { Button } from "../ui/button";
import { Segmented, Select, Switch } from "../ui/controls";
import { Group, H, Row } from "./parts";

/** Save a settings change, showing it straight away (core's settings.updated confirms it). */
function update(patch: Partial<Settings>) {
  useApp.setState((s) => ({ settings: { ...s.settings, ...patch } }));
  return run(api().call("settings.update", patch));
}

export const SPACE_ICON: Record<Space, typeof Briefcase> = { work: Briefcase, personal: House };

/** The tint each space uses in Settings and on the Memory page: cool for Work, warm for Personal. */
export const SPACE_TINT: Record<Space, string> = {
  work: "bg-link/12 text-link-ink",
  personal: "bg-brand/18 text-brand-ink",
};

export function SpacesSettings() {
  const settings = useApp((s) => s.settings);
  const agents = useApp((s) => s.agents);
  const now = useNow(30_000);
  const on = settings.spacesOn === true;
  const hours = formHours(settings.workHours);
  const tz = settings.timezone || "UTC";
  const active = resolveSpace(now, settings);
  const list = Object.values(agents);
  const work = agentForSpace(list, "work", true);
  const personal = list.find((a) => a.space === "personal" && !a.archivedAt && a.kind !== "helper") ?? null;
  const preset = presetOf(hours);
  const auto = active.source !== "pinned";

  return (
    <div data-testid="spaces-settings">
      <H desc="Split your day in two. One agent helps during work hours, another the rest of the time — each with its own memory and model.">
        Work & Personal
      </H>

      <div className="divide-y divide-border">
        <Row
          title="Work & Personal spaces"
          desc={on ? "On: Yo switches with your work hours." : "Off: one assistant, all the time."}
        >
          <Switch
            checked={on}
            label="Work & Personal spaces"
            testId="spaces-on"
            onCheckedChange={(v) => void update({ spacesOn: v })}
          />
        </Row>
      </div>

      {on && (
        <>
          <NowCard
            space={active.space}
            text={rightNow(active, now, tz)}
            agent={active.space === "work" ? work : personal}
            auto={auto}
            manual={active.source === "manual"}
            onAuto={(v) => void update({ spaceManual: v ? null : { space: active.space, until: null } })}
          />

          <Group title="Work hours" testId="work-hours">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <Segmented<PresetId>
                value={preset}
                onChange={(v) => v !== "custom" && void update({ workHours: applyPreset(hours, v) })}
                options={[
                  ...PRESETS.map((p) => ({ value: p.id, label: p.label })),
                  { value: "custom" as const, label: "Custom" },
                ]}
              />
              <span className="text-muted text-xs">Pick a preset or set each day.</span>
            </div>
            <div className="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-card shadow-card">
              {DAY_ORDER.map((day) => {
                const d = hours[day];
                if (!d) return null;
                const hint = d.on ? dayHint(d) : null;
                return (
                  <div
                    key={day}
                    data-testid={`day-${DAY_SHORT[day]?.toLowerCase()}`}
                    className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2"
                  >
                    <Switch
                      size="sm"
                      checked={d.on}
                      label={`Work on ${DAY_NAMES[day]}`}
                      testId={`day-on-${DAY_SHORT[day]?.toLowerCase()}`}
                      onCheckedChange={(v) => void update({ workHours: setDay(hours, day, { on: v }) })}
                    />
                    <span className={cn("w-24 font-medium", !d.on && "text-muted")}>{DAY_NAMES[day]}</span>
                    {d.on ? (
                      <div className="ml-auto flex items-center gap-1.5 max-sm:ml-0 max-sm:w-full">
                        <TimeInput
                          value={d.start}
                          label={`${DAY_NAMES[day]} start`}
                          testId={`day-start-${DAY_SHORT[day]?.toLowerCase()}`}
                          onChange={(v) => void update({ workHours: setDay(hours, day, { start: v }) })}
                        />
                        <span className="text-faint">–</span>
                        <TimeInput
                          value={d.end}
                          label={`${DAY_NAMES[day]} end`}
                          testId={`day-end-${DAY_SHORT[day]?.toLowerCase()}`}
                          onChange={(v) => void update({ workHours: setDay(hours, day, { end: v }) })}
                        />
                      </div>
                    ) : (
                      <span className="ml-auto text-muted text-sm">Personal all day</span>
                    )}
                    {hint && (
                      <div className="w-full pl-[42px] text-warning text-xs" data-testid="day-hint">
                        {hint}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-2.5 px-1 text-muted text-sm" data-testid="work-hours-summary">
              <span className="font-medium text-fg-2">{describeWorkHours(hours)}.</span> Anything outside
              these hours is Personal.
            </p>
          </Group>

          <TimeZone tz={tz} />

          <Group title="Agents" testId="space-agents">
            <div className="grid gap-2.5 sm:grid-cols-2">
              <AgentCard space="work" agent={work} hours={hours.some((d) => d.on)} />
              <AgentCard space="personal" agent={personal} hours />
            </div>
            <p className="mt-2.5 px-1 text-muted text-sm">
              Each space keeps its own agent, memory and model — e.g. Claude for Work, ChatGPT for Personal.
            </p>
          </Group>
        </>
      )}
    </div>
  );
}

function NowCard({
  space,
  text,
  agent,
  auto,
  manual,
  onAuto,
}: {
  space: Space;
  text: string;
  agent: AgentView | null;
  auto: boolean;
  manual: boolean;
  onAuto: (v: boolean) => void;
}) {
  const Icon = SPACE_ICON[space];
  return (
    <div
      data-testid="space-now"
      data-space={space}
      className="mt-3 overflow-hidden rounded-[14px] border border-border bg-card shadow-card"
    >
      <div className="flex items-center gap-3.5 p-4">
        <div className={cn("grid size-10 shrink-0 place-items-center rounded-xl", SPACE_TINT[space])}>
          <Icon className="size-[18px]" strokeWidth={1.9} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-2xs text-muted uppercase tracking-[0.08em]">Right now</div>
          <div className="font-semibold text-lg tracking-[-0.01em]" data-testid="space-now-text">
            {text}
          </div>
        </div>
        {agent && (
          <div className="flex shrink-0 items-center gap-2 text-muted text-sm max-sm:hidden">
            with <span className="font-medium text-fg">{agent.name}</span>
            <AgentAvatar agent={agent} size={28} state="idle" quiet />
          </div>
        )}
      </div>
      <div className="border-border border-t px-4">
        <Row
          title="Switch automatically"
          desc={
            !auto
              ? `Staying in ${SPACE_LABELS[space]} until you switch.`
              : manual
                ? `You picked ${SPACE_LABELS[space]} for now. Your hours take over at the next change.`
                : "Follow your work hours."
          }
          className="py-3"
        >
          <Switch checked={auto} label="Switch automatically" testId="space-auto" onCheckedChange={onAuto} />
        </Row>
      </div>
    </div>
  );
}

function TimeInput({
  value,
  label,
  testId,
  onChange,
}: {
  value: string;
  label: string;
  testId: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type="time"
      step={900}
      value={value}
      aria-label={label}
      title={clockLabel(value)}
      data-testid={testId}
      onChange={(e) => {
        const v = cleanTime(e.target.value);
        if (v && v !== value) onChange(v);
      }}
      className="h-8 w-[118px] rounded-[9px] border border-border-strong/70 bg-bg/60 px-2.5 text-sm text-fg tabular-nums outline-none transition-[border-color,box-shadow] duration-150 focus:border-link/60 focus:ring-3 focus:ring-link/15 max-sm:flex-1"
    />
  );
}

function TimeZone({ tz }: { tz: string }) {
  const device = useMemo(() => localTimeZone(), []);
  const zones = useMemo(() => zoneOptions([tz, device]), [tz, device]);
  const options = useMemo(() => {
    const now = Date.now();
    return zones.map((z) => ({ value: z, label: zoneLabel(z, now), description: z.replace(/_/g, " ") }));
  }, [zones]);
  return (
    <Group title="Time zone">
      <div className="divide-y divide-border">
        <Row
          title="Your time zone"
          desc={
            device && device !== tz ? (
              <button
                type="button"
                data-testid="use-device-zone"
                className="text-link-ink hover:underline"
                onClick={() => void update({ timezone: device })}
              >
                Use this device's ({zoneLabel(device)})
              </button>
            ) : (
              "Your work hours and reminders follow this clock."
            )
          }
        >
          <div className="w-56 max-sm:w-40">
            <Select
              value={tz}
              label="Time zone"
              testId="timezone"
              onChange={(v) => void update({ timezone: v })}
              options={options}
            />
          </div>
        </Row>
      </div>
    </Group>
  );
}

function AgentCard({ space, agent, hours }: { space: Space; agent: AgentView | null; hours: boolean }) {
  const accounts = useApp((s) => s.accounts);
  const Icon = SPACE_ICON[space];
  const acc = accountFor(agent ?? undefined, accounts);
  const own = !agent?.accountId || acc?.id === agent.accountId;
  const m = modelInfo(acc, own ? agent?.model : null);
  return (
    <div
      data-testid={`space-agent-${space}`}
      className="flex flex-col rounded-[14px] border border-border bg-card p-4 shadow-card"
    >
      <div
        className={cn(
          "mb-3 inline-flex h-5 w-fit items-center gap-1 rounded-full px-2 font-medium text-2xs",
          SPACE_TINT[space],
        )}
      >
        <Icon className="size-3" strokeWidth={2} />
        {SPACE_LABELS[space]}
        {space === "work" && !hours && <span className="opacity-70">· no hours set</span>}
      </div>
      {agent ? (
        <>
          <div className="flex items-center gap-3">
            <AgentAvatar agent={agent} size={40} state="idle" quiet />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{agent.name}</div>
              <div className="flex min-w-0 items-center gap-1.5 text-muted text-sm">
                {acc ? (
                  <>
                    <ProviderIcon provider={acc.provider} className="size-3.5 shrink-0" />
                    <span className="truncate" data-testid="space-agent-model">
                      {PROVIDER_NAME[acc.provider]}
                      {m ? ` · ${shortModel(m.label)}` : ""}
                    </span>
                  </>
                ) : (
                  "No model yet"
                )}
              </div>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3.5 w-full"
            data-testid={`space-agent-edit-${space}`}
            onClick={() => useUI.setState({ agentSettingsId: agent.id })}
          >
            <Settings2 className="size-3.5" /> Change model or look
          </Button>
        </>
      ) : (
        <div className="text-muted text-sm">
          Your {SPACE_LABELS[space]} agent appears here once Yo has finished updating.
        </div>
      )}
    </div>
  );
}
