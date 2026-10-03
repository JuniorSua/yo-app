import type { CreatureId, CreatureState } from "./meta";

export type Point = [number, number, number];

/** Body-local targets: raised palms stay outside the head/headset silhouette. */
export function armPose(id: CreatureId, side: number, row: number, t: number, state: CreatureState) {
  const lower = row === 1;
  const shoulder: Point = [side * (id === "mimi" ? 0.48 : lower ? 0.73 : 0.66), lower ? 0.89 : 1.36, 0.16];
  let elbow: Point = [side * 0.92, lower ? 0.76 : 1.15, 0.34];
  let hand: Point = [side * 1.04, (lower ? 0.78 : 1.17) + Math.sin(t * 1.7 + side) * 0.022, 0.58];
  let pitch = 0;
  let roll = -side * 0.1;
  if (state === "working") {
    if (side === -1 && lower === (id === "sprout")) {
      // Palm supports the underside of the deck. No independent oscillation here.
      hand = [-0.63, 0.835, 1.14];
      elbow = [-1.01, lower ? 0.74 : 1.03, 0.66];
      pitch = -Math.PI / 2;
      roll = 0;
    } else if (side === 1 && !lower) {
      hand = [0.64 + Math.sin(t * 2.2) * 0.04, 1.245 + (Math.sin(t * 7) + 1) * 0.018, 1.03];
      elbow = [0.99, 1.13, 0.64];
      pitch = 0.85;
      roll = 0.55;
    }
  } else if (state === "thinking" && side === 1 && !lower) {
    // An open, thoughtful palm beside the body instead of a fist inside the cheek.
    hand = [1.16, 1.38 + Math.sin(t * 1.5) * 0.025, 0.74];
    elbow = [1.0, 1.18, 0.42];
    pitch = -0.35;
    roll = 0.2;
  } else if (state === "question" && !lower) {
    hand = [side * 1.19, (side === 1 ? 1.55 : 1.35) + Math.sin(t * 1.6) * 0.025, 0.79];
    elbow = [side * 1.03, 1.23, 0.46];
    pitch = -0.25;
    roll = side * 0.22;
  } else if (state === "sleeping") {
    hand = [side * 1.01, lower ? 0.65 : 1.06, 0.55];
    pitch = 0.2;
  }
  return { shoulder, elbow, hand, pitch, roll };
}
