import { describe, expect, it } from "vitest";
import { Avatar, localTimeZone } from "./domain";

describe("localTimeZone", () => {
  it("returns the machine's IANA zone", () => {
    expect(localTimeZone(() => "Europe/Lisbon")).toBe("Europe/Lisbon");
    expect(localTimeZone(() => "America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    expect(localTimeZone(() => "UTC")).toBe("UTC");
  });

  it("is null when the runtime can't tell or reports something unusable", () => {
    expect(localTimeZone(() => undefined)).toBeNull();
    expect(localTimeZone(() => "")).toBeNull();
    expect(localTimeZone(() => "Not/AZone")).toBeNull();
    expect(localTimeZone(() => "$(rm -rf ~)")).toBeNull();
    expect(
      localTimeZone(() => {
        throw new Error("no Intl");
      }),
    ).toBeNull();
  });
});

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
