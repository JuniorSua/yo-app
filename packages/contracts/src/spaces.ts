/**
 * Work & Personal spaces: the owner's day splits into Work (inside their work hours) and Personal (everything
 * else), each with its own main agent (Yo for Work, Pip for Personal), memory focus and look. The space follows
 * the work-hours schedule unless the owner picks one by hand. Everything here is pure, so core (prompt, phone,
 * Telegram routing) and every window (the switch, the theme) work out the same answer from the same settings.
 */
import { z } from "zod";
import { normalizeArea } from "./lifeMap";

export const SPACES = ["work", "personal"] as const;
export const Space = z.enum(SPACES);
export type Space = z.infer<typeof Space>;

/** What the UI calls each space. */
export const SPACE_LABELS: Record<Space, string> = { work: "Work", personal: "Personal" };

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

/** A space picked by hand: it holds `until` the schedule next changes, or for good when `until` is null. */
export const SpaceManual = z.object({ space: Space, until: z.number().nullable() });
export type SpaceManual = z.infer<typeof SpaceManual>;

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

/** The settings the space depends on (all in Settings; any may be missing on an older core). */
export interface SpaceSettings {
  spacesOn: boolean;
  workHours: WorkHours;
  spaceManual: SpaceManual | null;
  timezone: string;
}

export interface ActiveSpace {
  space: Space;
  /**
   * "off": spaces are turned off (or the core predates them), so everything is Work. "schedule": from the work
   * hours. "manual": picked by hand until the schedule catches up. "pinned": picked by hand, for good.
   */
  source: "off" | "schedule" | "manual" | "pinned";
  /** When this space ends on its own (a manual choice expiring, or the schedule changing); null = it stays. */
  until: number | null;
  /** When the schedule next changes, whatever is active now (what Auto would do); null = never. */
  next: number | null;
}

/* ------------------------------------------- Time zone math ------------------------------------------- */

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;
const DAY_MS = DAY_MINUTES * MINUTE;

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

/** The wall-clock time at `instant` in the zone, as if that wall time were UTC (so it can be compared). */
function localMs(instant: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(instant))
    if (part.type !== "literal") p[part.type] = Number(part.value);
  return (
    Date.UTC(
      p.year ?? 1970,
      (p.month ?? 1) - 1,
      p.day ?? 1,
      (p.hour ?? 0) % 24,
      p.minute ?? 0,
      p.second ?? 0,
    ) +
    (((instant % 1000) + 1000) % 1000)
  );
}

/**
 * The instant the zone's clocks first show `minutes` past midnight on that date (`minutes` may run past one day).
 * Exact across daylight saving: an hour that happens twice gives its first time; a time skipped when clocks spring
 * forward gives the moment of the jump, which is when the clock passes it.
 */
function zonedEpoch(year: number, month: number, day: number, minutes: number, tz: string): number {
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  // The two offsets that can apply on that day: before and after any change.
  const a = wall - (localMs(wall - DAY_MS, tz) - (wall - DAY_MS));
  const b = wall - (localMs(wall + DAY_MS, tz) - (wall + DAY_MS));
  const hits = [a, b].filter((t) => localMs(t, tz) === wall);
  if (hits.length) return Math.min(...hits);
  // Skipped by the jump: find the first instant whose clock is at or past it.
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localMs(mid, tz) >= wall) hi = mid;
    else lo = mid;
  }
  return hi;
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

/** Work hours that can be trusted: anything else (missing, wrong length) gets the defaults. */
const usable = (hours: unknown): WorkHours =>
  WorkHours.safeParse(hours).success ? (hours as WorkHours) : DEFAULT_WORK_HOURS;

/** Which space the work hours say it is at `now`. */
export function scheduledSpace(now: number | Date, tz: string, hours: WorkHours): Space {
  const { day, minutes } = wallClock(now, tz);
  const today = hours[day];
  const yesterday = hours[(day + 6) % 7];
  const inToday =
    !!today?.on && minutes >= minutesOf(today.start) && minutes < minutesOf(today.start) + span(today);
  // Yesterday's late hours that ran past midnight.
  const inYesterday = !!yesterday?.on && minutes + DAY_MINUTES < minutesOf(yesterday.start) + span(yesterday);
  return inToday || inYesterday ? "work" : "personal";
}

/** The next instant the schedule changes space, or null when it never does (no day on, or work around the clock). */
export function nextBoundary(now: number | Date, tz: string, hours: WorkHours): number | null {
  const at = +now;
  const local = new Date(localMs(at, tz));
  const current = scheduledSpace(at, tz, hours);
  const candidates: number[] = [];
  // Yesterday (its hours may end today) through a week ahead (a single working day comes round again).
  for (let k = -1; k <= 7; k++) {
    const date = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + k));
    const d = hours[date.getUTCDay()];
    if (!d?.on) continue;
    const start = minutesOf(d.start);
    for (const m of [start, start + span(d)])
      candidates.push(zonedEpoch(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), m, tz));
  }
  // Back-to-back days (one ending as the next starts) aren't a change, so check the space really flips.
  return (
    candidates.sort((a, b) => a - b).find((t) => t > at && scheduledSpace(t, tz, hours) !== current) ?? null
  );
}

/**
 * The space right now. Tolerates settings from an older core (no `spacesOn`: spaces are off) and bad work hours
 * (the defaults). A manual choice whose time has passed is ignored, so nothing has to clear it on the dot.
 */
export function resolveSpace(now: number | Date, s: Partial<SpaceSettings>): ActiveSpace {
  const at = +now;
  if (s.spacesOn !== true) return { space: "work", source: "off", until: null, next: null };
  const tz = s.timezone || "UTC";
  const hours = usable(s.workHours);
  const next = nextBoundary(at, tz, hours);
  const manual = SpaceManual.safeParse(s.spaceManual).success ? s.spaceManual : null;
  if (manual && manual.until === null) return { space: manual.space, source: "pinned", until: null, next };
  if (manual && manual.until !== null && manual.until > at)
    return { space: manual.space, source: "manual", until: manual.until, next };
  return { space: scheduledSpace(at, tz, hours), source: "schedule", until: next, next };
}

/**
 * What to save as `spaceManual` when the owner picks a space by hand: null when the schedule already says that
 * space (back to Auto), else that space until the schedule next changes (which is when it agrees again).
 */
export function manualSwitch(
  now: number | Date,
  s: Partial<SpaceSettings>,
  space: Space,
): SpaceManual | null {
  const tz = s.timezone || "UTC";
  const hours = usable(s.workHours);
  if (scheduledSpace(now, tz, hours) === space) return null;
  return { space, until: nextBoundary(now, tz, hours) };
}

/* ---------------------------------------------- Wording ---------------------------------------------- */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 660 → "11:00 AM" (minutes may run past midnight). */
function clock(minutes: number): string {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function hoursText(d: DayHours): string {
  if (d.start === d.end) return d.start === "00:00" ? "all day" : `${clock(minutesOf(d.start))}, 24 hours`;
  return `${clock(minutesOf(d.start))}–${clock(minutesOf(d.end))}`;
}

/** "Mon–Fri 11:00 AM–7:00 PM": days with the same hours together, the week starting Monday. */
export function describeWorkHours(hours: WorkHours): string {
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
      const text = hoursText(g.hours);
      return `${days}${text === "all day" ? ", " : " "}${text}`;
    })
    .join("; ");
}

/** "11:00 AM" within the next day, else "Mon 11:00 AM". */
function when(t: number, now: number, tz: string): string {
  const { day, minutes } = wallClock(t, tz);
  return t - now < DAY_MS ? clock(minutes) : `${WEEKDAYS[day]} ${clock(minutes)}`;
}

/**
 * The caption under the switch: "Auto · until 7:00 PM" (following the schedule), "Personal until 11:00 AM" (picked
 * by hand), "Work · stays on" (pinned), or just "Work" when spaces are off.
 */
export function describeActive(a: ActiveSpace, now: number | Date, tz: string): string {
  const label = SPACE_LABELS[a.space];
  switch (a.source) {
    case "off":
      return label;
    case "pinned":
      return `${label} · stays on`;
    case "manual":
      return a.until === null ? `${label} · stays on` : `${label} until ${when(a.until, +now, tz)}`;
    case "schedule":
      return a.until === null ? "Auto" : `Auto · until ${when(a.until, +now, tz)}`;
  }
}

/* ---------------------------------------------- Agents ---------------------------------------------- */

/** A life-map area that names a space ("work", "Personal"), or null for any other area. */
export function spaceOfArea(area: string | null | undefined): Space | null {
  const a = area ? normalizeArea(area) : "";
  return a === "work" || a === "personal" ? a : null;
}

interface LeadLike {
  kind?: string;
  isPrimary: boolean;
  space?: Space | null;
  archivedAt?: number | null;
}

/** A main, first-class agent: the primary (Yo) or a space's agent (Pip). Never a one-off helper. */
export function isLead(a: LeadLike): boolean {
  return a.kind !== "helper" && (a.isPrimary || !!a.space);
}

/**
 * The agent for a space: the space's own agent, else the primary, else the first agent. With spaces off it's
 * always the primary. Helpers and archived agents never count.
 */
export function agentForSpace<T extends LeadLike>(
  agents: readonly T[],
  space: Space,
  spacesOn: boolean,
): T | null {
  const live = agents.filter((a) => a.kind !== "helper" && !a.archivedAt);
  return (
    (spacesOn ? live.find((a) => a.space === space) : undefined) ??
    live.find((a) => a.isPrimary) ??
    live[0] ??
    null
  );
}
