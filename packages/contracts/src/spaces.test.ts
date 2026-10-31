import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, Settings } from "./domain";
import {
  agentForSpace,
  type DayHours,
  DEFAULT_WORK_HOURS,
  describeActive,
  describeWorkHours,
  isLead,
  manualSwitch,
  nextBoundary,
  resolveSpace,
  scheduledSpace,
  spaceOfArea,
  WorkHours,
  wallClock,
} from "./spaces";

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
const settings = { spacesOn: true, workHours: DEFAULT_WORK_HOURS, spaceManual: null, timezone: NY };

describe("schedule", () => {
  it("weekdays inside the hours are Work, everything else Personal", () => {
    // Tue Oct 13 2026.
    expect(scheduledSpace(edt(13, 12), NY, DEFAULT_WORK_HOURS)).toBe("work");
    expect(scheduledSpace(edt(13, 11), NY, DEFAULT_WORK_HOURS)).toBe("work");
    expect(scheduledSpace(edt(13, 18, 59), NY, DEFAULT_WORK_HOURS)).toBe("work");
    expect(scheduledSpace(edt(13, 19), NY, DEFAULT_WORK_HOURS)).toBe("personal");
    expect(scheduledSpace(edt(13, 10, 59), NY, DEFAULT_WORK_HOURS)).toBe("personal");
    // Sat Oct 17: off by default.
    expect(scheduledSpace(edt(17, 12), NY, DEFAULT_WORK_HOURS)).toBe("personal");
    expect(nextBoundary(edt(13, 12), NY, DEFAULT_WORK_HOURS)).toBe(edt(13, 19));
    expect(nextBoundary(edt(13, 20), NY, DEFAULT_WORK_HOURS)).toBe(edt(14, 11));
    // Friday evening: Personal until Monday.
    expect(nextBoundary(edt(16, 19), NY, DEFAULT_WORK_HOURS)).toBe(edt(19, 11));
  });

  it("hours that end before they start run past midnight", () => {
    const fri = only({ 5: ["22:00", "06:00"] });
    expect(scheduledSpace(edt(16, 21, 59), NY, fri)).toBe("personal");
    expect(scheduledSpace(edt(16, 23), NY, fri)).toBe("work");
    expect(scheduledSpace(edt(17, 3), NY, fri)).toBe("work");
    expect(scheduledSpace(edt(17, 6), NY, fri)).toBe("personal");
    expect(nextBoundary(edt(16, 21), NY, fri)).toBe(edt(16, 22));
    expect(nextBoundary(edt(17, 3), NY, fri)).toBe(edt(17, 6));
  });

  it("start equal to end is 24 hours, and back-to-back days aren't a change", () => {
    const wed = only({ 3: ["00:00", "00:00"] });
    expect(scheduledSpace(edt(14, 0), NY, wed)).toBe("work");
    expect(scheduledSpace(edt(14, 23, 59), NY, wed)).toBe("work");
    expect(scheduledSpace(edt(15, 0), NY, wed)).toBe("personal");
    expect(nextBoundary(edt(13, 12), NY, wed)).toBe(edt(14, 0));

    const monTue = only({ 1: ["00:00", "00:00"], 2: ["00:00", "00:00"] });
    expect(nextBoundary(edt(12, 12), NY, monTue)).toBe(edt(14, 0));

    // Work around the clock never changes.
    expect(scheduledSpace(edt(17, 3), NY, every("00:00", "00:00"))).toBe("work");
    expect(nextBoundary(edt(17, 3), NY, every("00:00", "00:00"))).toBeNull();
  });

  it("with every day off it's always Personal", () => {
    const none = only({});
    expect(scheduledSpace(edt(13, 12), NY, none)).toBe("personal");
    expect(nextBoundary(edt(13, 12), NY, none)).toBeNull();
    const a = resolveSpace(edt(13, 12), { ...settings, workHours: none });
    expect(a).toEqual({ space: "personal", source: "schedule", until: null, next: null });
    expect(describeActive(a, edt(13, 12), NY)).toBe("Auto");
  });
});

describe("daylight saving (America/New_York)", () => {
  it("spring forward, Sun Mar 8 2026: boundaries land on the new offset", () => {
    // Sat Mar 7 8:00 PM EST; Monday 11:00 AM is EDT (15:00 UTC), not EST (16:00).
    expect(nextBoundary(Date.UTC(2026, 2, 8, 1), NY, DEFAULT_WORK_HOURS)).toBe(Date.UTC(2026, 2, 9, 15));
    // Sun 1:00 AM EST, every day on: 11:00 AM EDT the same day.
    expect(nextBoundary(Date.UTC(2026, 2, 8, 6), NY, every("11:00", "19:00"))).toBe(Date.UTC(2026, 2, 8, 15));
    // 2:30 AM never shows on the clock: the change happens at the jump (3:00 AM EDT = 07:00 UTC).
    const late = only({ 6: ["22:00", "02:30"] });
    expect(scheduledSpace(Date.UTC(2026, 2, 8, 6), NY, late)).toBe("work");
    expect(nextBoundary(Date.UTC(2026, 2, 8, 6), NY, late)).toBe(Date.UTC(2026, 2, 8, 7));
    expect(scheduledSpace(Date.UTC(2026, 2, 8, 7), NY, late)).toBe("personal");
  });

  it("fall back, Sun Nov 1 2026: boundaries land on the new offset", () => {
    // Sat Oct 31 8:00 PM EDT; Monday 11:00 AM is EST (16:00 UTC).
    expect(nextBoundary(Date.UTC(2026, 10, 1, 0), NY, DEFAULT_WORK_HOURS)).toBe(Date.UTC(2026, 10, 2, 16));
    // Sun 00:00 EDT, every day on: 11:00 AM EST the same day.
    expect(nextBoundary(Date.UTC(2026, 10, 1, 4), NY, every("11:00", "19:00"))).toBe(
      Date.UTC(2026, 10, 1, 16),
    );
    // 1:30 AM happens twice: the first one (EDT, 05:30 UTC).
    const late = only({ 6: ["22:00", "01:30"] });
    expect(scheduledSpace(Date.UTC(2026, 10, 1, 4, 30), NY, late)).toBe("work");
    expect(nextBoundary(Date.UTC(2026, 10, 1, 4, 30), NY, late)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });
});

describe("resolveSpace and manualSwitch", () => {
  it("a manual choice holds until it expires; a pinned one stays", () => {
    const until = edt(13, 19);
    const manual = { ...settings, spaceManual: { space: "personal" as const, until } };
    expect(resolveSpace(edt(13, 12), manual)).toEqual({
      space: "personal",
      source: "manual",
      until,
      next: until,
    });
    // Expired: back to the schedule without anyone clearing it.
    expect(resolveSpace(edt(13, 20), manual)).toMatchObject({ space: "personal", source: "schedule" });
    expect(resolveSpace(edt(14, 12), manual)).toMatchObject({ space: "work", source: "schedule" });

    const pinned = { ...settings, spaceManual: { space: "personal" as const, until: null } };
    expect(resolveSpace(edt(14, 12), pinned)).toEqual({
      space: "personal",
      source: "pinned",
      until: null,
      next: edt(14, 19),
    });
  });

  it("follows the schedule, and is off (Work) on an older core", () => {
    expect(resolveSpace(edt(13, 12), settings)).toEqual({
      space: "work",
      source: "schedule",
      until: edt(13, 19),
      next: edt(13, 19),
    });
    expect(resolveSpace(edt(13, 22), {})).toEqual({ space: "work", source: "off", until: null, next: null });
    expect(resolveSpace(edt(13, 22), { ...settings, spacesOn: false }).source).toBe("off");
    // Missing work hours or zone: the defaults and UTC.
    expect(resolveSpace(Date.UTC(2026, 9, 13, 12), { spacesOn: true })).toMatchObject({
      space: "work",
      source: "schedule",
      until: Date.UTC(2026, 9, 13, 19),
    });
  });

  it("picking a space holds it until the schedule agrees; picking the scheduled one goes back to Auto", () => {
    expect(manualSwitch(edt(13, 12), settings, "personal")).toEqual({
      space: "personal",
      until: edt(13, 19),
    });
    expect(manualSwitch(edt(13, 12), settings, "work")).toBeNull();
    expect(manualSwitch(edt(17, 12), settings, "work")).toEqual({ space: "work", until: edt(19, 11) });
    // No schedule change ever: the choice stays.
    expect(manualSwitch(edt(13, 12), { ...settings, workHours: only({}) }, "work")).toEqual({
      space: "work",
      until: null,
    });
  });
});

describe("time zones", () => {
  it("reads the wall clock in the zone, and falls back to UTC for a bad one", () => {
    expect(wallClock(edt(13, 9, 30), NY)).toEqual({ day: 2, minutes: 9 * 60 + 30 });
    expect(wallClock(Date.UTC(2026, 9, 13, 2), NY)).toEqual({ day: 1, minutes: 22 * 60 });
    expect(wallClock(Date.UTC(2026, 9, 13, 12), "Not/AZone")).toEqual({ day: 2, minutes: 720 });
    expect(scheduledSpace(Date.UTC(2026, 9, 13, 12), "Not/AZone", DEFAULT_WORK_HOURS)).toBe("work");
    expect(nextBoundary(Date.UTC(2026, 9, 13, 12), "", DEFAULT_WORK_HOURS)).toBe(Date.UTC(2026, 9, 13, 19));
  });
});

describe("wording", () => {
  it("describes the active space", () => {
    const at = edt(13, 12);
    expect(describeActive(resolveSpace(at, settings), at, NY)).toBe("Auto · until 7:00 PM");
    const morning = edt(13, 8);
    const work = { ...settings, spaceManual: manualSwitch(morning, settings, "work") };
    expect(describeActive(resolveSpace(morning, work), morning, NY)).toBe("Work until 11:00 AM");
    const noon = { ...settings, spaceManual: manualSwitch(at, settings, "personal") };
    expect(describeActive(resolveSpace(at, noon), at, NY)).toBe("Personal until 7:00 PM");
    // More than a day away: with the weekday.
    const sat = edt(17, 12);
    const weekend = { ...settings, spaceManual: manualSwitch(sat, settings, "work") };
    expect(describeActive(resolveSpace(sat, weekend), sat, NY)).toBe("Work until Mon 11:00 AM");
    const pinned = { ...settings, spaceManual: { space: "work" as const, until: null } };
    expect(describeActive(resolveSpace(at, pinned), at, NY)).toBe("Work · stays on");
    expect(describeActive(resolveSpace(at, {}), at, NY)).toBe("Work");
  });

  it("describes work hours", () => {
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
});

describe("agents", () => {
  const yo = { id: "yo", isPrimary: true, space: "work" as const, kind: "agent" };
  const pip = { id: "pip", isPrimary: false, space: "personal" as const, kind: "agent" };
  const mate = { id: "mate", isPrimary: false, space: null, kind: "agent" };
  const helper = { id: "hlp", isPrimary: false, space: "personal" as const, kind: "helper" };

  it("finds the space's agent, else the primary, else the first", () => {
    expect(agentForSpace([mate, yo, pip, helper], "personal", true)?.id).toBe("pip");
    expect(agentForSpace([mate, yo, pip], "work", true)?.id).toBe("yo");
    expect(agentForSpace([mate, yo, pip], "personal", false)?.id).toBe("yo");
    expect(agentForSpace([mate, yo, helper], "personal", true)?.id).toBe("yo");
    expect(agentForSpace([mate, yo, { ...pip, archivedAt: 1 }], "personal", true)?.id).toBe("yo");
    expect(agentForSpace([helper, mate], "work", true)?.id).toBe("mate");
    expect(agentForSpace([], "work", true)).toBeNull();
  });

  it("leads are the primary and the space agents, never helpers", () => {
    expect(isLead(yo)).toBe(true);
    expect(isLead(pip)).toBe(true);
    expect(isLead(mate)).toBe(false);
    expect(isLead(helper)).toBe(false);
    expect(isLead({ isPrimary: true })).toBe(true);
  });

  it("maps life-map areas to spaces", () => {
    expect(spaceOfArea("Work")).toBe("work");
    expect(spaceOfArea("personal")).toBe("personal");
    expect(spaceOfArea("yo-project")).toBeNull();
    expect(spaceOfArea(null)).toBeNull();
  });
});

describe("settings", () => {
  it("the defaults parse, and bad work hours don't", () => {
    expect(Settings.parse(DEFAULT_SETTINGS)).toMatchObject({
      spacesOn: true,
      spaceManual: null,
      workHours: DEFAULT_WORK_HOURS,
    });
    expect(WorkHours.safeParse(DEFAULT_WORK_HOURS.slice(1)).success).toBe(false);
    expect(WorkHours.safeParse(every("09:00", "24:00")).success).toBe(false);
    expect(WorkHours.safeParse(every("9:00", "17:00")).success).toBe(false);
  });
});
