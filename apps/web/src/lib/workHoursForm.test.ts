import { DEFAULT_WORK_HOURS, resolveSpace, type WorkHours } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import {
  applyPreset,
  cleanTime,
  clockLabel,
  DAY_NAMES,
  DAY_ORDER,
  dayHint,
  formHours,
  presetOf,
  rightNow,
  setDay,
  zoneCity,
  zoneLabel,
  zoneOptions,
} from "./workHoursForm";

const TZ = "America/New_York";
// Tue Oct 13 2026, 3:00 PM in New York.
const TUE_3PM = Date.UTC(2026, 9, 13, 19, 0);

describe("work hours form", () => {
  it("shows the week Monday first", () => {
    expect(DAY_ORDER.map((d) => DAY_NAMES[d])).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
  });

  it("recognises the presets", () => {
    expect(presetOf(DEFAULT_WORK_HOURS)).toBe("11-7");
    expect(presetOf(applyPreset(DEFAULT_WORK_HOURS, "9-5"))).toBe("9-5");
    expect(presetOf(setDay(DEFAULT_WORK_HOURS, 3, { end: "18:00" }))).toBe("custom");
    // Off days don't count: their times are only kept for when they're ticked on.
    expect(presetOf(setDay(DEFAULT_WORK_HOURS, 6, { start: "08:00" }))).toBe("11-7");
    expect(presetOf(DEFAULT_WORK_HOURS.map((d) => ({ ...d, on: false })) as WorkHours)).toBe("custom");
  });

  it("applies a preset to every day, keeping which days are on", () => {
    const withSat = setDay(DEFAULT_WORK_HOURS, 6, { on: true });
    const nine = applyPreset(withSat, "9-5");
    expect(nine.map((d) => d.on)).toEqual(withSat.map((d) => d.on));
    expect(nine.every((d) => d.start === "09:00" && d.end === "17:00")).toBe(true);
    // Nothing on yet: Monday to Friday come on.
    const none = DEFAULT_WORK_HOURS.map((d) => ({ ...d, on: false })) as WorkHours;
    expect(applyPreset(none, "11-7").map((d) => d.on)).toEqual([false, true, true, true, true, true, false]);
  });

  it("changes one day and ignores half-typed times", () => {
    const sat = setDay(DEFAULT_WORK_HOURS, 6, { on: true, end: "18:00" });
    expect(sat[6]).toEqual({ on: true, start: "11:00", end: "18:00" });
    expect(sat[5]).toBe(DEFAULT_WORK_HOURS[5]);
    expect(DEFAULT_WORK_HOURS[6]?.on).toBe(false); // not mutated
    expect(setDay(DEFAULT_WORK_HOURS, 1, { end: "" })).toBe(DEFAULT_WORK_HOURS);
    expect(setDay(DEFAULT_WORK_HOURS, 1, { end: "25:00" })).toBe(DEFAULT_WORK_HOURS);
  });

  it("cleans time input values", () => {
    expect(cleanTime("09:15")).toBe("09:15");
    expect(cleanTime("09:15:00")).toBe("09:15");
    expect(cleanTime("")).toBeNull();
    expect(cleanTime("9:15")).toBeNull();
  });

  it("labels times and unusual hours", () => {
    expect(clockLabel("00:00")).toBe("12:00 AM");
    expect(clockLabel("12:30")).toBe("12:30 PM");
    expect(clockLabel("19:00")).toBe("7:00 PM");
    expect(dayHint({ on: true, start: "11:00", end: "19:00" })).toBeNull();
    expect(dayHint({ on: true, start: "22:00", end: "06:00" })).toBe("Ends 6:00 AM the next day");
    expect(dayHint({ on: true, start: "09:00", end: "09:00" })).toBe("Work all 24 hours");
  });

  it("falls back to the defaults for hours an older core didn't send", () => {
    expect(formHours(undefined)).toBe(DEFAULT_WORK_HOURS);
    expect(formHours([{ on: true }])).toBe(DEFAULT_WORK_HOURS);
    const mine = setDay(DEFAULT_WORK_HOURS, 0, { on: true });
    expect(formHours(mine)).toBe(mine);
  });

  it("says what's on right now", () => {
    const base = { spacesOn: true, workHours: DEFAULT_WORK_HOURS, timezone: TZ };
    const sched = resolveSpace(TUE_3PM, { ...base, spaceManual: null });
    expect(rightNow(sched, TUE_3PM, TZ)).toBe("Work · until 7:00 PM");
    const pinned = resolveSpace(TUE_3PM, { ...base, spaceManual: { space: "personal", until: null } });
    expect(rightNow(pinned, TUE_3PM, TZ)).toBe("Personal · stays on");
    const manual = resolveSpace(TUE_3PM, {
      ...base,
      spaceManual: { space: "personal", until: TUE_3PM + 4 * 3600_000 },
    });
    expect(rightNow(manual, TUE_3PM, TZ)).toBe("Personal until 7:00 PM");
  });
});

describe("time zones", () => {
  it("labels a zone by its city and offset", () => {
    expect(zoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(zoneLabel(TZ, TUE_3PM)).toBe("New York (GMT-4)");
    expect(zoneLabel("Not/AZone", TUE_3PM)).toBe("AZone");
  });

  it("lists zones by city, always including the ones in use", () => {
    const list = zoneOptions(["Europe/Lisbon", null], () => ["America/New_York", "Asia/Tokyo"]);
    expect(list).toEqual(["Europe/Lisbon", "America/New_York", "Asia/Tokyo"]);
    // A browser that can't list them gets the common ones.
    const fallback = zoneOptions([], () => {
      throw new Error("no");
    });
    expect(fallback).toContain("America/New_York");
    expect(fallback).toContain("Asia/Kolkata");
  });
});
