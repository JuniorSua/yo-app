/**
 * Settings → Profile: your name, your work hours (one row per day, Monday first) and your time zone. The work hours
 * are context for every agent: each one's prompt says them, so work waits for work hours unless you bring it up.
 */
import { describeWorkHours, localTimeZone, type Settings, usableWorkHours } from "@yo/contracts";
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import {
  cleanTime,
  clockLabel,
  DAY_NAMES,
  DAY_ORDER,
  DAY_SHORT,
  dayHint,
  setDay,
  zoneLabel,
  zoneOptions,
} from "../../lib/workHoursForm";
import { useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { Input, Select, Switch } from "../ui/controls";
import { Group, H, Row } from "./parts";

/** Save a settings change, showing it straight away (core's settings.updated confirms it). */
function update(patch: Partial<Settings>) {
  useApp.setState((s) => ({ settings: { ...s.settings, ...patch } }));
  return run(api().call("settings.update", patch));
}

export function ProfileSettings() {
  const settings = useApp((s) => s.settings);
  const [name, setName] = useState(settings.userName);
  const hours = usableWorkHours(settings.workHours);
  const tz = settings.timezone || "UTC";
  return (
    <div data-testid="profile-settings">
      <H>Profile</H>
      <div className="divide-y divide-border">
        <Row title="Your name" desc="What Yo calls you.">
          <Input
            aria-label="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== settings.userName && update({ userName: name })}
            className="w-48"
          />
        </Row>
      </div>

      <Group title="Your work hours" testId="work-hours">
        <p className="mb-3 px-1 text-muted text-sm">
          Every agent knows your hours. Outside them, they keep work for later unless you bring it up. You can
          still ask for anything, any time.
        </p>
        <div className="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-card shadow-card">
          {DAY_ORDER.map((day) => {
            const d = hours[day];
            if (!d) return null;
            const short = DAY_SHORT[day]?.toLowerCase();
            const hint = d.on ? dayHint(d) : null;
            return (
              <div
                key={day}
                data-testid={`day-${short}`}
                className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2"
              >
                <Switch
                  size="sm"
                  checked={d.on}
                  label={`Work on ${DAY_NAMES[day]}`}
                  testId={`day-on-${short}`}
                  onCheckedChange={(v) => void update({ workHours: setDay(hours, day, { on: v }) })}
                />
                <span className={cn("w-24 font-medium", !d.on && "text-muted")}>{DAY_NAMES[day]}</span>
                {d.on ? (
                  <div className="ml-auto flex items-center gap-1.5 max-sm:ml-0 max-sm:w-full">
                    <TimeInput
                      value={d.start}
                      label={`${DAY_NAMES[day]} start`}
                      testId={`day-start-${short}`}
                      onChange={(v) => void update({ workHours: setDay(hours, day, { start: v }) })}
                    />
                    <span className="text-faint">–</span>
                    <TimeInput
                      value={d.end}
                      label={`${DAY_NAMES[day]} end`}
                      testId={`day-end-${short}`}
                      onChange={(v) => void update({ workHours: setDay(hours, day, { end: v }) })}
                    />
                  </div>
                ) : (
                  <span className="ml-auto text-muted text-sm">Off</span>
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
        <p className="mt-2.5 px-1 font-medium text-fg-2 text-sm" data-testid="work-hours-summary">
          {describeWorkHours(hours)}
        </p>
      </Group>

      <TimeZone tz={tz} />
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
