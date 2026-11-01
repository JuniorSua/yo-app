/**
 * The user's work hours: context for every agent. Each prompt says the hours and whether it's inside them now, so
 * an agent can keep work out of the user's evenings and save non-urgent work news for work hours. Nothing switches
 * on them: the user can ask any agent for anything at any time. Pure, so core (the prompt, the message clock) and
 * the apps (Settings → Profile) work out the same answer from the same settings.
 */
import { z } from "zod";

/** "HH:MM", 24-hour clock. */
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * One day's work hours. `end` at or before `start` runs past midnight into the next day ("22:00"–"06:00"), so
 * `start` equal to `end` is a full 24 hours. A day that's off keeps its times, so ticking it on brings them back.
 */
export const DayHours = z.object({ on: z.boolean(), start: HHMM, end: HHMM });
export type DayHours = z.infer<typeof DayHours>;

/** Seven days, index 0 = Sunday (like Date.getDay()). */
export const WorkHours = z.array(DayHours).length(7);
export type WorkHours = z.infer<typeof WorkHours>;

/** Mon–Fri 11:00–19:00. Weekends are off but keep the same hours, so ticking Saturday on just works. */
export const DEFAULT_WORK_HOURS: WorkHours = [
  { on: false, start: "11:00", end: "19:00" },
  { on: true, start: "11:00", end: "19:00" },
  { on: true, start: "11:00", end: "19:00" },
  { on: true, start: "11:00", end: "19:00" },
  { on: true, start: "11:00", end: "19:00" },
  { on: true, start: "11:00", end: "19:00" },
  { on: false, start: "11:00", end: "19:00" },
];

/**
 * No work hours: every day off, with the suggested times filled in for when the user turns a day on. The default
 * until the user sets theirs, so no agent is told hours the user never gave.
 */
export const NO_WORK_HOURS: WorkHours = DEFAULT_WORK_HOURS.map((d) => ({ ...d, on: false }));

/** Work hours that can be trusted: anything else (missing, wrong length, a bad time) counts as none set. */
export function usableWorkHours(hours: unknown): WorkHours {
  return WorkHours.safeParse(hours).success ? (hours as WorkHours) : NO_WORK_HOURS;
}

/* ------------------------------------------- Time zone math ------------------------------------------- */

const DAY_MINUTES = 24 * 60;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A cached formatter for the zone. A zone this runtime doesn't know falls back to UTC (like messageClock). */
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = {
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    };
    try {
      f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
    }
    formatters.set(tz, f);
  }
  return f;
}

/** The wall-clock time at `instant` in the zone, as if that wall time were UTC (so it can be read with getUTC*). */
function localMs(instant: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(instant))
    if (part.type !== "literal") p[part.type] = Number(part.value);
  return Date.UTC(
    p.year ?? 1970,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    (p.hour ?? 0) % 24,
    p.minute ?? 0,
    p.second ?? 0,
  );
}

/** Day of the week (0 = Sunday) and minutes past midnight at `now` in the zone (UTC when it's not a real zone). */
export function wallClock(now: number | Date, tz: string): { day: number; minutes: number } {
  const local = new Date(localMs(+now, tz));
  return { day: local.getUTCDay(), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/* ---------------------------------------------- Schedule ---------------------------------------------- */

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** How long a day's hours last, in minutes: past midnight when `end` is at or before `start`. */
const span = (d: DayHours) => {
  const len = minutesOf(d.end) - minutesOf(d.start);
  return len > 0 ? len : len + DAY_MINUTES;
};

/**
 * Whether `now` is inside the work hours, on the zone's wall clock (so daylight saving moves nothing): today's
 * hours, or yesterday's when they run past midnight.
 */
export function inWorkHours(now: number | Date, tz: string, hours: WorkHours): boolean {
  const { day, minutes } = wallClock(now, tz);
  const today = hours[day];
  const yesterday = hours[(day + 6) % 7];
  const inToday =
    !!today?.on && minutes >= minutesOf(today.start) && minutes < minutesOf(today.start) + span(today);
  const inYesterday = !!yesterday?.on && minutes + DAY_MINUTES < minutesOf(yesterday.start) + span(yesterday);
  return inToday || inYesterday;
}

/* ---------------------------------------------- Wording ---------------------------------------------- */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 660 → "11:00 AM", or "11:00" on a 24-hour clock. */
function clock(minutes: number, h24 = false): string {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  return h24 ? `${String(h).padStart(2, "0")}:${mm}` : `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

function hoursText(d: DayHours, h24: boolean): string {
  if (d.start === d.end)
    return d.start === "00:00" ? "all day" : `${clock(minutesOf(d.start), h24)}, 24 hours`;
  return `${clock(minutesOf(d.start), h24)}–${clock(minutesOf(d.end), h24)}`;
}

/**
 * "Mon–Fri 11:00 AM–7:00 PM" (or "Mon–Fri 11:00–19:00" with `h24`): days with the same hours together, the week
 * starting Monday. "No work hours" when no day is on.
 */
export function describeWorkHours(hours: WorkHours, opts: { h24?: boolean } = {}): string {
  const h24 = !!opts.h24;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const groups = new Map<string, { hours: DayHours; days: number[] }>();
  order.forEach((day, pos) => {
    const d = hours[day];
    if (!d?.on) return;
    const key = `${d.start}-${d.end}`;
    const g = groups.get(key) ?? { hours: d, days: [] };
    g.days.push(pos);
    groups.set(key, g);
  });
  if (!groups.size) return "No work hours";
  const name = (pos: number) => WEEKDAYS[order[pos] ?? 0] ?? "";
  return [...groups.values()]
    .map((g) => {
      // Runs of three or more days read as a range ("Mon–Fri").
      const runs: number[][] = [];
      for (const pos of g.days) {
        const last = runs.at(-1);
        if (last && last.at(-1) === pos - 1) last.push(pos);
        else runs.push([pos]);
      }
      const days =
        g.days.length === 7
          ? "Every day"
          : runs
              .map((r) =>
                r.length >= 3 ? `${name(r[0] ?? 0)}–${name(r.at(-1) ?? 0)}` : r.map(name).join(", "),
              )
              .join(", ");
      const text = hoursText(g.hours, h24);
      return `${days}${text === "all day" ? ", " : " "}${text}`;
    })
    .join("; ");
}

/** Whether it's inside the user's work hours now, or null when they have none (no day on). */
export function workHoursNow(
  now: number | Date,
  s: { workHours?: unknown; timezone?: string },
): "inside" | "outside" | null {
  const hours = usableWorkHours(s.workHours);
  if (!hours.some((d) => d.on)) return null;
  return inWorkHours(now, s.timezone || "UTC", hours) ? "inside" : "outside";
}

/**
 * The work-hours line in every agent's prompt: "Sam's work hours: every day 11:00–19:00 (America/New_York). It's
 * now Sat 6:40 PM, inside work hours." ("The user's work hours" without a name.) Null when no day is on.
 */
export function workHoursLine(
  now: number | Date,
  s: { workHours?: unknown; timezone?: string },
  userName: string,
): string | null {
  const inside = workHoursNow(now, s);
  if (!inside) return null;
  const tz = s.timezone || "UTC";
  const { day, minutes } = wallClock(now, tz);
  const text = describeWorkHours(usableWorkHours(s.workHours), { h24: true }).replace(
    /^Every day/,
    "every day",
  );
  const whose = `${userName.charAt(0).toUpperCase()}${userName.slice(1)}'s`;
  return `${whose} work hours: ${text} (${tz}). It's now ${WEEKDAYS[day]} ${clock(minutes)}, ${inside} work hours.`;
}
