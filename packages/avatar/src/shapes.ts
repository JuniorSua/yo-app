import type { AVATAR_SHAPES } from "@yo/contracts";
import {
  BUBBLE_BODY,
  BUBBLE_TAIL,
  burstPath,
  CUPCAT_HEAD,
  circlePath,
  roundedPolygonPath,
  roundedRectPath,
  smoothClosedPath,
  superellipsePath,
} from "./geometry";

export type ShapeId = (typeof AVATAR_SHAPES)[number];

export interface ShapeGeometry {
  /** One or more paths, filled with the body color (union). */
  paths: string[];
  /** Face center (between the eyes). */
  face: { x: number; y: number };
  /** Horizontal distance from face center to each eye. */
  eyeDx: number;
  /** Hat anchor: center x, base y (where the brim/cuff sits) and head width at that height. */
  hat: { x: number; y: number; w: number };
  /** Head edges at eye level (for headsets / earbuds). */
  ears: { l: number; r: number; y: number };
  /** Where a bow tie sits. */
  neckY: number;
  /** Top of the body (used for the sleeping "z"). */
  top: number;
  /** Optional decorative detail drawn on top of the body in the eye color (low opacity). */
  detail?: string;
  /** Headset band control-point y (overrides the default derived from `top`). */
  band?: number;
  /** Where the boom-mic capsule sits (overrides the default below-right of the face). */
  mic?: { x: number; y: number };
  /** Earcup size override (width, height) in viewBox units. */
  earcup?: { w: number; h: number };
}

export const SHAPES: Record<ShapeId, ShapeGeometry> = {
  bubble: {
    paths: [BUBBLE_BODY, BUBBLE_TAIL],
    face: { x: 51, y: 46 },
    eyeDx: 11.5,
    hat: { x: 50, y: 28, w: 70 },
    ears: { l: 13.5, r: 86.5, y: 47 },
    neckY: 75,
    top: 14,
  },
  squircle: {
    paths: [superellipsePath(50, 53, 36, 35, 4.6)],
    face: { x: 50, y: 52 },
    eyeDx: 11.5,
    hat: { x: 50, y: 31, w: 70 },
    ears: { l: 14.5, r: 85.5, y: 53 },
    neckY: 81,
    top: 18,
  },
  pebble: {
    paths: [
      smoothClosedPath([
        [50, 19],
        [70, 21.5],
        [84, 35],
        [88, 55],
        [80.5, 75],
        [62, 87],
        [39, 88],
        [20, 78],
        [12, 58],
        [16, 37],
        [30, 24],
      ]),
    ],
    face: { x: 50, y: 53 },
    eyeDx: 11.5,
    hat: { x: 50, y: 31, w: 64 },
    ears: { l: 12.5, r: 87.5, y: 55 },
    neckY: 82,
    top: 19,
  },
  hex: {
    paths: [
      roundedPolygonPath(
        [
          [90, 54],
          [70, 88.64],
          [30, 88.64],
          [10, 54],
          [30, 19.36],
          [70, 19.36],
        ],
        11,
      ),
    ],
    face: { x: 50, y: 54 },
    eyeDx: 11.5,
    hat: { x: 50, y: 30, w: 58 },
    ears: { l: 11.5, r: 88.5, y: 54 },
    neckY: 83,
    top: 19,
  },
  drop: {
    paths: ["M50 11C57.5 24 81 37.5 81 60.5A31 31 0 0 1 19 60.5C19 37.5 42.5 24 50 11Z"],
    face: { x: 50, y: 62 },
    eyeDx: 10.5,
    hat: { x: 50, y: 37, w: 50 },
    ears: { l: 19.5, r: 80.5, y: 61 },
    neckY: 86,
    top: 14,
  },
  cloud: {
    paths: [
      circlePath(31, 55, 17),
      circlePath(53, 43, 22),
      circlePath(72, 57, 15.5),
      roundedRectPath(12.5, 52, 75, 33, 16.5),
    ],
    face: { x: 50, y: 63 },
    eyeDx: 10.5,
    hat: { x: 53, y: 32, w: 46 },
    ears: { l: 13, r: 87, y: 66 },
    neckY: 81,
    top: 21,
  },
  burst: {
    paths: [burstPath(50, 53, 36.5, 3.6, 10)],
    face: { x: 50, y: 53 },
    eyeDx: 11,
    hat: { x: 50, y: 27, w: 52 },
    ears: { l: 14, r: 86, y: 53 },
    neckY: 84,
    top: 16,
  },
  tablet: {
    paths: [roundedRectPath(21, 12.5, 58, 78, 17)],
    face: { x: 50, y: 45 },
    eyeDx: 10.5,
    hat: { x: 50, y: 25, w: 60 },
    ears: { l: 21, r: 79, y: 46 },
    neckY: 84,
    top: 12.5,
    detail: roundedRectPath(43.5, 80, 13, 3, 1.5),
  },
  // CupCat: a kawaii cat head sitting in a cup; everything else is drawn by cupcat.tsx.
  cupcat: {
    paths: [CUPCAT_HEAD],
    face: { x: 50, y: 45 },
    eyeDx: 14.5,
    hat: { x: 50, y: 22, w: 64 },
    ears: { l: 9.5, r: 90.5, y: 46 },
    neckY: 72,
    top: 20,
    band: 6.5,
    mic: { x: 67.5, y: 61.5 },
    earcup: { w: 9.5, h: 19 },
  },
};
