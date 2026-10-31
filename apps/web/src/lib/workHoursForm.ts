/**
 * The work-hours form in Settings → Work & Personal: presets, one row per day (Monday first), friendly labels
 * and the time-zone list. Pure, so it's tested without a browser.
 */
import {
  type ActiveSpace,
  type DayHours,
  DEFAULT_WORK_HOURS,
  describeActive,
  SPACE_LABELS,
  type WorkHours,
} from "@yo/contracts";

/** Display order: the week starts on Monday (the data's index 0 is Sunday). */
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type PresetId = "9-5" | "11-7" | "custom";
export const PRESETS: { id: Exclude<PresetId, "custom">; label: string; start: string; end: string }[] = [
  { id: "9-5", label: "9 – 5", start: "09:00", end: "17:00" },
  { id: "11-7", label: "11 – 7", start: "11:00", end: "19:00" },
];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A time from a `<input type="time">` ("19:00" or "19:00:00") as "HH:MM", or null when it's empty or bad. */
export function cleanTime(v: string): string | null {
  const t = v.trim().slice(0, 5);
  return HHMM.test(t) ? t : null;
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** "19:00" → "7:00 PM". */
export function clockLabel(hhmm: string): string {
  const m = minutesOf(hhmm);
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Work hours that can be shown and edited: anything malformed (an older core) gets the defaults. */
export function formHours(hours: unknown): WorkHours {
  return Array.isArray(hours) &&
    hours.length === 7 &&
    hours.every((d) => d && typeof d.on === "boolean" && cleanTime(d.start ?? "") && cleanTime(d.end ?? ""))
    ? (hours as WorkHours)
    : DEFAULT_WORK_HOURS;
}

/** Which preset the hours match: every working day on the preset's hours. Anything else is "custom". */
export function presetOf(hours: WorkHours): PresetId {
  const on = hours.filter((d) => d.on);
  if (!on.length) return "custom";
  return PRESETS.find((p) => on.every((d) => d.start === p.start && d.end === p.end))?.id ?? "custom";
}

/**
 * Apply a preset's hours to every day, keeping which days are on (off days keep the new times too, so ticking
 * one on matches). With no day on yet, Monday to Friday come on.
 */
export function applyPreset(hours: WorkHours, id: Exclude<PresetId, "custom">): WorkHours {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return hours;
  const none = !hours.some((d) => d.on);
  return hours.map((d, day) => ({
    on: none ? day >= 1 && day <= 5 : d.on,
    start: p.start,
    end: p.end,
  })) as WorkHours;
}

/** A copy of the hours with one day changed. A bad time is ignored (a half-typed or cleared input). */
export function setDay(hours: WorkHours, day: number, patch: Partial<DayHours>): WorkHours {
  const next = { ...hours[day], ...patch } as DayHours;
  if (!cleanTime(next.start) || !cleanTime(next.end)) return hours;
  return hours.map((d, i) => (i === day ? next : d)) as WorkHours;
}

/** A note for unusual hours: past midnight ("Ends 2:00 AM the next day") or around the clock. */
export function dayHint(d: DayHours): string | null {
  if (d.start === d.end) return "Work all 24 hours";
  if (minutesOf(d.end) < minutesOf(d.start)) return `Ends ${clockLabel(d.end)} the next day`;
  return null;
}

/** "Right now" in Settings: "Work · until 7:00 PM", "Personal until Mon 11:00 AM", "Work · stays on". */
export function rightNow(a: ActiveSpace, now: number, tz: string): string {
  if (a.source === "schedule") return describeActive(a, now, tz).replace(/^Auto/, SPACE_LABELS[a.space]);
  return describeActive(a, now, tz);
}

/* ---------------------------------------------- Time zones ---------------------------------------------- */

/** Used when this browser can't list its zones. */
const COMMON_ZONES = [
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Denver",
  "America/Phoenix",
  "America/Chicago",
  "America/New_York",
  "America/Puerto_Rico",
  "America/Mexico_City",
  "America/Bogota",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Athens",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
];

/** "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export function zoneCity(tz: string): string {
  return (tz.split("/").at(-1) ?? tz).replace(/_/g, " ");
}

/** "GMT-4" right now in the zone ("GMT" for UTC itself), or "" when this runtime doesn't know it. */
export function zoneOffset(tz: string, now = Date.now()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? "";
  } catch {
    return "";
  }
}

/** "New York (GMT-4)". */
export function zoneLabel(tz: string, now = Date.now()): string {
  const off = zoneOffset(tz, now);
  return off ? `${zoneCity(tz)} (${off})` : zoneCity(tz);
}

/**
 * The zones to pick from: every zone the browser knows (or a short common list), always including the ones in use,
 * sorted by city so typing a letter jumps to it.
 */
export function zoneOptions(
  keep: (string | null | undefined)[],
  all: () => string[] = () =>
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : COMMON_ZONES,
): string[] {
  let zones: string[];
  try {
    zones = all();
  } catch {
    zones = COMMON_ZONES;
  }
  const set = new Set([...(zones.length ? zones : COMMON_ZONES), ...keep.filter((z): z is string => !!z)]);
  return [...set].sort((a, b) => zoneCity(a).localeCompare(zoneCity(b)) || a.localeCompare(b));
}
