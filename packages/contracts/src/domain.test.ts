import { describe, expect, it } from "vitest";
import { Avatar } from "./domain";

const base = { shape: "bubble", color: "yo", eyes: "capsule", accessory: "headset" } as const;

describe("Avatar.creature", () => {
  it("is optional, so saved avatars keep parsing", () => {
    expect(Avatar.parse(base).creature).toBeUndefined();
  });
  it("accepts the three creatures", () => {
    for (const kind of ["sprout", "pebble", "mimi"] as const)
      expect(Avatar.parse({ ...base, creature: { kind } }).creature).toEqual({ kind });
  });
  it("rejects unknown creatures", () => {
    expect(Avatar.safeParse({ ...base, creature: { kind: "dragon" } }).success).toBe(false);
  });
});
