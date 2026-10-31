import { describe, expect, it } from "vitest";
import { buildCron, describeCron, isValidCron, nextRun, nextRuns, parsePreset } from "./cron";

describe("cron helpers", () => {
  it("describes common schedules", () => {
    expect(describeCron("0 8 * * 1-5")).toMatch(/^Weekdays at 8:00/);
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours");
    expect(describeCron("0 17 * * 5")).toMatch(/^Fridays at 5:00/);
  });

  it("validates and computes the next run", () => {
    expect(isValidCron("0 8 * * *")).toBe(true);
    expect(isValidCron("every day")).toBe(false);
    const from = new Date(2026, 8, 29, 9, 30).getTime(); // Tue 09:30
    const next = new Date(nextRun("0 8 * * 1-5", from)!);
    expect(next.getDate()).toBe(30);
    expect(next.getHours()).toBe(8);
  });

  it("describes lists of days in words", () => {
    expect(describeCron("0 9 * * 1,3,5")).toMatch(/^Mon, Wed and Fri at 9:00/);
    expect(describeCron("30 18 * * 2,4")).toMatch(/^Tue and Thu at 6:30/);
    expect(describeCron("0 9 * * 0,1,2,3,4,5,6")).toMatch(/^Every day at 9:00/);
    expect(describeCron("0 9 * * 1,2,3,4,5")).toMatch(/^Weekdays at 9:00/);
    expect(describeCron("0 10 * * 0,6")).toMatch(/^Weekends at 10:00/);
    expect(describeCron("0 10 * * 6,0")).toMatch(/^Weekends at 10:00/);
    expect(describeCron("0 9 * * 7,1")).toMatch(/^Sun and Mon at 9:00/);
  });

  it("keeps describing the shapes it already knew the same way", () => {
    expect(describeCron(null)).toBe("Once");
    expect(describeCron("0 8 * * *")).toMatch(/^Every day at 8:00/);
    expect(describeCron("15 * * * *")).toBe("Every hour at :15");
    expect(describeCron("0 9 1 * *")).toMatch(/^Monthly on day 1 at 9:00/);
    expect(describeCron("0 9 * 1 1")).toBe("0 9 * 1 1");
  });

  it("lists the next few runs", () => {
    const from = new Date(2026, 8, 29, 9, 30).getTime(); // Tue 09:30
    const runs = nextRuns("0 9 * * 1,3,5", 3, from).map((t) => new Date(t));
    expect(runs.map((d) => d.getDay())).toEqual([3, 5, 1]);
    expect(runs.every((d) => d.getHours() === 9 && d.getMinutes() === 0)).toBe(true);
    expect(nextRuns("0 */4 * * *", 3, from).map((t) => new Date(t).getHours())).toEqual([12, 16, 20]);
    expect(nextRuns("bad", 3, from)).toEqual([]);
  });
});

describe("routine presets", () => {
  it("opens saved schedules in the right preset", () => {
    expect(parsePreset(null)).toMatchObject({ preset: "daily", time: "08:00" });
    expect(parsePreset("30 7 * * *")).toMatchObject({ preset: "daily", time: "07:30" });
    expect(parsePreset("0 8 * * 1-5")).toMatchObject({ preset: "weekdays", time: "08:00" });
    expect(parsePreset("0 17 * * 5")).toMatchObject({ preset: "days", time: "17:00", days: [5] });
    expect(parsePreset("0 9 * * 1,3,5")).toMatchObject({ preset: "days", days: [1, 3, 5] });
    expect(parsePreset("0 * * * *")).toMatchObject({ preset: "hours", every: 1 });
    expect(parsePreset("0 */6 * * *")).toMatchObject({ preset: "hours", every: 6 });
  });

  it("opens anything it can't write back exactly as custom", () => {
    for (const cron of [
      "*/15 * * * *",
      "0 */5 * * *",
      "0 */1 * * *",
      "15 * * * *",
      "0 9 1 * *",
      "0 9 * * 5,1",
      "0 9 * * 1,1",
      "0 9 * * 7",
      "00 09 * * *",
      "0 9 * * 6,0",
      "every day",
    ])
      expect(parsePreset(cron).preset, cron).toBe("custom");
  });

  it("saves an unchanged schedule back exactly as it was", () => {
    for (const cron of [
      "0 8 * * *",
      "30 7 * * *",
      "0 8 * * 1-5",
      "0 17 * * 5",
      "0 9 * * 0",
      "0 9 * * 1,3,5",
      "0 10 * * 0,6",
      "0 * * * *",
      "0 */2 * * *",
      "0 */12 * * *",
      "*/15 * * * *",
      "0 9 * * 5,1",
    ])
      expect(buildCron(parsePreset(cron), cron)).toBe(cron);
  });

  it("builds every-few-hours and day-list schedules", () => {
    const s = parsePreset(null);
    expect(buildCron({ ...s, preset: "hours", every: 1 }, "")).toBe("0 * * * *");
    expect(buildCron({ ...s, preset: "hours", every: 3 }, "")).toBe("0 */3 * * *");
    expect(buildCron({ ...s, preset: "days", time: "09:05", days: [5, 1, 3] }, "")).toBe("5 9 * * 1,3,5");
  });
});
