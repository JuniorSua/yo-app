import { describe, expect, it } from "vitest";
import { LIVING_CHARACTERS_INFO, livingAvatar, livingParts } from "./characters";
import { LivingMotion, livingMode } from "./motion";

const run = (m: LivingMotion, ms: number) => {
  let f = m.tick(16, 80);
  for (let t = 16; t < ms; t += 16) f = m.tick(16, 80);
  return f;
};

describe("living avatars", () => {
  it("maps agent states to motion modes", () => {
    expect(livingMode("idle")).toBe("asleep");
    expect(livingMode("sleeping")).toBe("asleep");
    expect(livingMode("working")).toBe("working");
    expect(livingMode("waiting")).toBe("question");
    expect(livingMode("done")).toBe("done");
    expect(livingMode("error")).toBe("alert");
    expect(livingMode("idle", true)).toBe("awake");
  });

  it("sleeps with closed eyes and z's when idle", () => {
    const f = run(new LivingMotion(1, "asleep"), 1500);
    expect(f.close).toBeGreaterThan(0.95);
    expect(f.zzz.length).toBe(3);
    expect(f.glow).toBe(0);
  });

  it("keeps the eyes moving while working", () => {
    const m = new LivingMotion(2, "asleep");
    m.setMode("working");
    const xs = new Set<number>();
    for (let i = 0; i < 120; i++) xs.add(Math.round(m.tick(16, 80).gaze[0] * 100));
    expect(xs.size).toBeGreaterThan(8);
    expect(run(m, 10).zzz.length).toBe(0);
  });

  it("shows ? eyes and the yellow glow when it needs you — even with reduced motion", () => {
    const m = new LivingMotion(3, "working");
    m.still = true;
    m.setMode("question");
    const f = m.tick(16, 80);
    expect(f.qpop).toBe(1);
    expect(f.question).toBeGreaterThan(0.99);
    expect(f.glow).toBeGreaterThan(0.9);
  });

  it("builds complete avatar records with a drawn fallback", () => {
    const a = livingAvatar("coral", "rose", "graphite");
    expect(a.living).toEqual({ character: "coral", body: "rose", headset: "graphite" });
    expect(a.shape).toBe(LIVING_CHARACTERS_INFO.coral.fallback.shape);
    expect(livingParts({ character: "violet", body: "nope", headset: "nope" }).body.id).toBe("violet");
  });
});
