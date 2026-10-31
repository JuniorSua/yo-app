/** Minimal 5-field cron helpers (minute hour dom month dow) for UI previews and the mock backend. */

function parseField(field: string, min: number, max: number): Set<number> | null {
  if (field === "*") return null;
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    let lo = min;
    let hi = max;
    if (range && range !== "*") {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = b !== undefined ? Number(b) : stepStr ? max : lo;
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || !step) return new Set();
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function isValidCron(cron: string): boolean {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return false;
  return f.every((x) => /^[\d*,\-/]+$/.test(x));
}

/** Next fire time after `from` (ms), or null if none within ~2 months. */
export function nextRun(cron: string, from = Date.now()): number | null {
  if (!isValidCron(cron)) return null;
  const [mi, ho, dom, mon, dow] = cron.trim().split(/\s+/) as [string, string, string, string, string];
  const sMi = parseField(mi, 0, 59);
  const sHo = parseField(ho, 0, 23);
  const sDom = parseField(dom, 1, 31);
  const sMon = parseField(mon, 1, 12);
  const sDow = parseField(dow, 0, 6);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 62; i++) {
    const ok =
      (!sMi || sMi.has(d.getMinutes())) &&
      (!sHo || sHo.has(d.getHours())) &&
      (!sDom || sDom.has(d.getDate())) &&
      (!sMon || sMon.has(d.getMonth() + 1)) &&
      (!sDow || sDow.has(d.getDay()) || (sDow.has(7) && d.getDay() === 0));
    if (ok) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

const CLOCK = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });

function fmtTime(h: number, m: number): string {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return CLOCK.format(d);
}

/** The next `count` fire times after `from`, oldest first (fewer if the schedule runs out within ~2 months). */
export function nextRuns(cron: string, count: number, from = Date.now()): number[] {
  const out: number[] = [];
  let t = nextRun(cron, from);
  while (t !== null && out.length < count) {
    out.push(t);
    t = out.length < count ? nextRun(cron, t) : null;
  }
  return out;
}

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A weekday list like "1,3,5" as day numbers (Sunday 0, 7 too), sorted; null if it isn't a plain list. */
function dayList(dow: string): number[] | null {
  if (!/^[0-7](,[0-7])+$/.test(dow)) return null;
  return [...new Set(dow.split(",").map((d) => Number(d) % 7))].sort((a, b) => a - b);
}

/** "Mon, Wed and Fri". */
function joinDays(days: number[]): string {
  const names = days.map((d) => DAY_SHORT[d]!);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

/** Human description for common cron shapes; falls back to the raw expression. */
export function describeCron(cron: string | null | undefined): string {
  if (!cron) return "Once";
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [mi, ho, dom, mon, dow] = f as [string, string, string, string, string];
  const everyN = /^\*\/(\d+)$/;
  if (everyN.test(mi) && ho === "*" && dom === "*" && mon === "*" && dow === "*")
    return `Every ${mi.match(everyN)![1]} minutes`;
  if (/^\d+$/.test(mi) && ho === "*" && dom === "*" && mon === "*" && dow === "*")
    return mi === "0" ? "Every hour" : `Every hour at :${mi.padStart(2, "0")}`;
  if (/^\d+$/.test(mi) && everyN.test(ho) && dom === "*" && mon === "*" && dow === "*")
    return `Every ${ho.match(everyN)![1]} hours`;
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && dom === "*" && mon === "*") {
    const t = fmtTime(Number(ho), Number(mi));
    if (dow === "*") return `Every day at ${t}`;
    if (dow === "1-5") return `Weekdays at ${t}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends at ${t}`;
    if (/^\d$/.test(dow)) return `${DAYS[Number(dow) % 7]} at ${t}`;
    const days = dayList(dow);
    if (days) {
      const key = days.join(",");
      if (days.length === 7) return `Every day at ${t}`;
      if (key === "1,2,3,4,5") return `Weekdays at ${t}`;
      if (key === "0,6") return `Weekends at ${t}`;
      return `${joinDays(days)} at ${t}`;
    }
  }
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && /^\d+$/.test(dom) && mon === "*" && dow === "*")
    return `Monthly on day ${dom} at ${fmtTime(Number(ho), Number(mi))}`;
  return cron;
}

/* ------------------------------ Routine dialog ----------------------------- */

/** The routine dialog's ready-made schedules; anything else is edited as raw cron. */
export type Preset = "daily" | "weekdays" | "days" | "hours" | "custom";

export interface Schedule {
  preset: Preset;
  /** "HH:MM", for daily, weekdays and days. */
  time: string;
  /** Weekdays it runs on (Sunday 0), sorted, for days. */
  days: number[];
  /** Every this many hours, on the hour, for hours. */
  every: number;
}

/** How often "Every few hours" can run (they divide the day evenly). */
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];

/** A plain number as cron writes it (no leading zero), within `max`. */
function plain(field: string | undefined, max: number): boolean {
  return !!field && /^(0|[1-9]\d?)$/.test(field) && Number(field) <= max;
}

/**
 * The preset a saved cron opens in. Only shapes `buildCron` writes back exactly are recognized, so saving without
 * changes keeps the cron as it was; anything else opens as custom.
 */
export function parsePreset(cron: string | null | undefined): Schedule {
  const d: Schedule = { preset: "daily", time: "08:00", days: [1], every: 1 };
  if (!cron) return d;
  const f = cron.trim().split(/\s+/);
  const [mi, ho, dom, mon, dow] = f as [string, string, string, string, string];
  if (f.length !== 5 || dom !== "*" || mon !== "*") return { ...d, preset: "custom" };
  if (mi === "0" && dow === "*") {
    if (ho === "*") return { ...d, preset: "hours", every: 1 };
    const n = /^\*\/(\d+)$/.exec(ho)?.[1];
    if (n && n !== "1" && HOUR_STEPS.includes(Number(n)) && String(Number(n)) === n)
      return { ...d, preset: "hours", every: Number(n) };
  }
  if (plain(mi, 59) && plain(ho, 23)) {
    const time = `${ho.padStart(2, "0")}:${mi.padStart(2, "0")}`;
    if (dow === "*") return { ...d, preset: "daily", time };
    if (dow === "1-5") return { ...d, preset: "weekdays", time, days: [1, 2, 3, 4, 5] };
    // One day, or a list in order without repeats (what the day picker writes).
    if (/^[0-6](,[0-6])*$/.test(dow)) {
      const days = dow.split(",").map(Number);
      if (days.every((x, i) => i === 0 || x > days[i - 1]!)) return { ...d, preset: "days", time, days };
    }
  }
  return { ...d, preset: "custom" };
}

/** The cron a preset saves as; `custom` is the raw expression typed in. */
export function buildCron(s: Schedule, custom: string): string {
  const [h, m] = s.time.split(":").map((x) => Number(x));
  const at = `${m ?? 0} ${h ?? 8}`;
  switch (s.preset) {
    case "daily":
      return `${at} * * *`;
    case "weekdays":
      return `${at} * * 1-5`;
    case "days":
      return `${at} * * ${[...s.days].sort((a, b) => a - b).join(",")}`;
    case "hours":
      return s.every > 1 ? `0 */${s.every} * * *` : "0 * * * *";
    default:
      return custom.trim();
  }
}
