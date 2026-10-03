import { creatureAvatar, livingAvatar } from "@yo/avatar";
import type { Avatar } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { editDrawn, pickCreature } from "./avatarEdit";

const drawn: Avatar = {
  shape: "hex",
  color: "violet",
  eyes: "round",
  accessory: "headset",
  variant: "matcha",
};

describe("avatar studio: creatures", () => {
  it("picking a creature sets it with a drawn fallback and keeps the rolled CupCat", () => {
    const a = pickCreature(drawn, "pebble");
    expect(a.creature).toEqual({ kind: "pebble" });
    expect(a.shape).not.toBe("cupcat");
    expect(a.variant).toBe("matcha");
    expect(a.image).toBeUndefined();
  });

  it("picking a creature replaces a living character", () => {
    const a = pickCreature(livingAvatar("lagoon"), "mimi");
    expect(a.living).toBeUndefined();
    expect(a.creature).toEqual({ kind: "mimi" });
  });

  it("any drawn edit clears the creature (and the living character)", () => {
    const sprout = pickCreature(drawn, "sprout");
    for (const patch of [
      { shape: "cloud" as const },
      { color: "red" },
      { eyes: "happy" as const },
      { image: "x" },
    ]) {
      const a = editDrawn(sprout, patch);
      expect(a.creature).toBeUndefined();
      expect(a.living).toBeUndefined();
      expect(a.accessory).toBe("headset");
    }
    expect(editDrawn({ ...creatureAvatar("mimi"), accessory: "none" }, {}).accessory).toBe("headset");
  });
});
