import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, Settings } from "./domain";
import { labelOfArea } from "./memoryLabels";
import {
  type DayHours,
  DEFAULT_WORK_HOURS,
  describeWorkHours,
  inWorkHours,
  NO_WORK_HOURS,
  usableWorkHours,
  WorkHours,
  wallClock,
  workHoursLine,
} from "./workHours";

const NY = "America/New_York";
const OFF: DayHours = { on: false, start: "11:00", end: "19:00" };
/** Work hours with only the given days (0 = Sunday) on. */
const only = (days: Record<number, [string, string]>): WorkHours =>
  Array.from({ length: 7 }, (_, d) => {
    const h = days[d];
    return h ? { on: true, start: h[0], end: h[1] } : OFF;
  });
const every = (start: string, end: string): WorkHours =>
  Array.from({ length: 7 }, () => ({ on: true, start, end }));
/** New York wall time in October 2026 (EDT, UTC-4). */
const edt = (day: number, h: number, m = 0) => Date.UTC(2026, 9, day, h + 4, m);
/** The owner's: every day 11:00–19:00, New York. */
const OWNER = { workHours: every("11:00", "19:00"), timezone: NY };

describe("inWorkHours", () => {
  it("is inside the day's hours, start included and end not", () => {
    // Tue Oct 13 2026.
    expect(inWorkHours(edt(13, 12), NY, DEFAULT_WORK_HOURS)).toBe(true);
    expect(inWorkHours(edt(13, 11), NY, DEFAULT_WORK_HOURS)).toBe(true);
    expect(inWorkHours(edt(13, 18, 59), NY, DEFAULT_WORK_HOURS)).toBe(true);
    expect(inWorkHours(edt(13, 19), NY, DEFAULT_WORK_HOURS)).toBe(false);
    expect(inWorkHours(edt(13, 10, 59), NY, DEFAULT_WORK_HOURS)).toBe(false);
  });

  it("days off are outside all day", () => {
    // Sat Oct 17 is off by default; only Mon and Wed on leaves Tue out.
    expect(inWorkHours(edt(17, 12), NY, DEFAULT_WORK_HOURS)).toBe(false);
    const monWed = only({ 1: ["09:00", "17:00"], 3: ["09:00", "17:00"] });
    expect(inWorkHours(edt(12, 10), NY, monWed)).toBe(true);
    expect(inWorkHours(edt(13, 10), NY, monWed)).toBe(false);
    expect(inWorkHours(edt(14, 10), NY, monWed)).toBe(true);
    expect(inWorkHours(edt(13, 12), NY, only({}))).toBe(false);
  });

  it("an overnight shift runs into the next day, even when that day is off", () => {
    // Fri Oct 16 22:00 to Sat 06:00; Saturday itself is off.
    const fri = only({ 5: ["22:00", "06:00"] });
    expect(inWorkHours(edt(16, 21, 59), NY, fri)).toBe(false);
    expect(inWorkHours(edt(16, 23), NY, fri)).toBe(true);
    expect(inWorkHours(edt(17, 3), NY, fri)).toBe(true);
    expect(inWorkHours(edt(17, 6), NY, fri)).toBe(false);
    // Start equal to end is a full 24 hours (from Wed 00:00 here).
    const wed = only({ 3: ["00:00", "00:00"] });
    expect(inWorkHours(edt(14, 0), NY, wed)).toBe(true);
    expect(inWorkHours(edt(14, 23, 59), NY, wed)).toBe(true);
    expect(inWorkHours(edt(15, 0), NY, wed)).toBe(false);
    expect(inWorkHours(edt(17, 3), NY, every("00:00", "00:00"))).toBe(true);
  });

  it("follows the zone's clock across daylight saving", () => {
    const hours = every("11:00", "19:00");
    // Spring forward, Sun Mar 8 2026: 11:00 is 16:00 UTC the day before (EST), 15:00 UTC on the day (EDT).
    expect(inWorkHours(Date.UTC(2026, 2, 7, 15, 59), NY, hours)).toBe(false);
    expect(inWorkHours(Date.UTC(2026, 2, 7, 16), NY, hours)).toBe(true);
    expect(inWorkHours(Date.UTC(2026, 2, 8, 14, 59), NY, hours)).toBe(false);
    expect(inWorkHours(Date.UTC(2026, 2, 8, 15), NY, hours)).toBe(true);
    // Fall back, Sun Nov 1 2026: 15:30 UTC is 10:30 EST (it was 11:30 EDT the day before).
    expect(inWorkHours(Date.UTC(2026, 9, 31, 15, 30), NY, hours)).toBe(true);
    expect(inWorkHours(Date.UTC(2026, 10, 1, 15, 30), NY, hours)).toBe(false);
    expect(inWorkHours(Date.UTC(2026, 10, 1, 16), NY, hours)).toBe(true);
    // An overnight shift through the extra hour: Sat 22:00–06:00 ends at 06:00 EST (11:00 UTC), not 06:00 EDT.
    const sat = only({ 6: ["22:00", "06:00"] });
    expect(inWorkHours(Date.UTC(2026, 10, 1, 10, 30), NY, sat)).toBe(true);
    expect(inWorkHours(Date.UTC(2026, 10, 1, 11), NY, sat)).toBe(false);
  });

  it("reads the wall clock in the zone, and falls back to UTC for a bad one", () => {
    expect(wallClock(edt(13, 9, 30), NY)).toEqual({ day: 2, minutes: 9 * 60 + 30 });
    expect(wallClock(Date.UTC(2026, 9, 13, 2), NY)).toEqual({ day: 1, minutes: 22 * 60 });
    expect(wallClock(Date.UTC(2026, 9, 13, 12), "Not/AZone")).toEqual({ day: 2, minutes: 720 });
    expect(inWorkHours(Date.UTC(2026, 9, 13, 12), "Not/AZone", DEFAULT_WORK_HOURS)).toBe(true);
  });
});

describe("describeWorkHours", () => {
  it("groups days with the same hours, Monday first", () => {
    expect(describeWorkHours(DEFAULT_WORK_HOURS)).toBe("Mon–Fri 11:00 AM–7:00 PM");
    const sat = DEFAULT_WORK_HOURS.map((d, i) => (i === 6 ? { on: true, start: "10:00", end: "14:00" } : d));
    expect(describeWorkHours(sat)).toBe("Mon–Fri 11:00 AM–7:00 PM; Sat 10:00 AM–2:00 PM");
    expect(describeWorkHours(only({ 1: ["09:00", "17:00"], 3: ["09:00", "17:00"] }))).toBe(
      "Mon, Wed 9:00 AM–5:00 PM",
    );
    expect(describeWorkHours(only({ 5: ["22:00", "06:00"] }))).toBe("Fri 10:00 PM–6:00 AM");
    expect(describeWorkHours(every("00:00", "00:00"))).toBe("Every day, all day");
    expect(describeWorkHours(every("12:00", "12:30"))).toBe("Every day 12:00 PM–12:30 PM");
    expect(describeWorkHours(only({}))).toBe("No work hours");
  });

  it("on a 24-hour clock", () => {
    expect(describeWorkHours(DEFAULT_WORK_HOURS, { h24: true })).toBe("Mon–Fri 11:00–19:00");
    expect(describeWorkHours(only({ 5: ["22:00", "06:00"] }), { h24: true })).toBe("Fri 22:00–06:00");
    expect(describeWorkHours(every("09:00", "09:00"), { h24: true })).toBe("Every day 09:00, 24 hours");
  });
});

describe("workHoursLine", () => {
  it("says the hours, the zone, the time now and whether it's inside them", () => {
    // Sat Oct 31 2026.
    expect(workHoursLine(edt(31, 18, 40), OWNER, "Sam")).toBe(
      "Sam's work hours: every day 11:00–19:00 (America/New_York). It's now Sat 6:40 PM, inside work hours.",
    );
    expect(workHoursLine(edt(31, 19, 5), OWNER, "Sam")).toBe(
      "Sam's work hours: every day 11:00–19:00 (America/New_York). It's now Sat 7:05 PM, outside work hours.",
    );
  });

  it("days off and overnight shifts", () => {
    const weekdays = { workHours: DEFAULT_WORK_HOURS, timezone: NY };
    expect(workHoursLine(edt(31, 12), weekdays, "Sam")).toBe(
      "Sam's work hours: Mon–Fri 11:00–19:00 (America/New_York). It's now Sat 12:00 PM, outside work hours.",
    );
    const nights = { workHours: only({ 5: ["22:00", "06:00"] }), timezone: NY };
    expect(workHoursLine(edt(17, 3), nights, "the user")).toBe(
      "The user's work hours: Fri 22:00–06:00 (America/New_York). It's now Sat 3:00 AM, inside work hours.",
    );
  });

  it("uses the zone's time after daylight saving ends", () => {
    // Sun Nov 1 2026, 16:00 UTC: 11:00 AM EST (an hour earlier than the day before's 16:00 UTC).
    expect(workHoursLine(Date.UTC(2026, 10, 1, 16), OWNER, "Sam")).toContain(
      "It's now Sun 11:00 AM, inside work hours.",
    );
    expect(workHoursLine(Date.UTC(2026, 10, 1, 15, 30), OWNER, "Sam")).toContain(
      "It's now Sun 10:30 AM, outside work hours.",
    );
  });

  it("says nothing without work hours, and falls back for missing settings", () => {
    expect(workHoursLine(edt(13, 12), { workHours: only({}), timezone: NY }, "Sam")).toBeNull();
    // Settings without work hours (an older core, or a user who never set them): no line, so no agent is told
    // hours the user never gave.
    expect(workHoursLine(Date.UTC(2026, 9, 13, 12), {}, "Sam")).toBeNull();
  });
});

describe("settings", () => {
  it("the defaults parse, and bad work hours don't", () => {
    const s = Settings.parse(DEFAULT_SETTINGS);
    expect(s.workHours).toEqual(NO_WORK_HOURS);
    expect(NO_WORK_HOURS.every((d) => !d.on)).toBe(true);
    expect(s).not.toHaveProperty("spacesOn");
    expect(s).not.toHaveProperty("spaceManual");
    expect(WorkHours.safeParse(DEFAULT_WORK_HOURS.slice(1)).success).toBe(false);
    expect(WorkHours.safeParse(every("09:00", "24:00")).success).toBe(false);
    expect(WorkHours.safeParse(every("9:00", "17:00")).success).toBe(false);
    expect(usableWorkHours([{ on: true }])).toBe(NO_WORK_HOURS);
  });
});

describe("memory labels", () => {
  it("maps life-map areas to labels", () => {
    expect(labelOfArea("Work")).toBe("work");
    expect(labelOfArea("personal")).toBe("personal");
    expect(labelOfArea("yo-project")).toBeNull();
    expect(labelOfArea(null)).toBeNull();
  });
});
