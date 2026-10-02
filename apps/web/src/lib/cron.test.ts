import { describe, expect, it } from "vitest";
import { describeCron, isValidCron, nextRun } from "./cron";

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
});
