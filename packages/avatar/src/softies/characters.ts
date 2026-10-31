/**
 * The six Softies: soft-touch vinyl toys, one inflated silhouette each (design: Yo 2 avatar direction A).
 * Everything is in a 100x100 box. Shapes are computed once at module load. No React here.
 */
import type { SoftieKind } from "@yo/contracts";
import { BUBBLE_BODY, BUBBLE_TAIL, circlePath, radialPath, superellipsePath } from "../geometry";
import type { SoftieAccentId } from "./palette";

export interface SoftieShape {
  parts: readonly string[];
  /** Bounding box: x0, y0, x1, y1 (the light and shading are placed from it). */
  box: readonly [number, number, number, number];
  /** Contact shadow: cx, cy, rx, ry. */
  shadow: readonly [number, number, number, number];
  /** Soft highlight centre, then the sharp glint. */
  hl: readonly [number, number, number, number];
  antenna?: boolean;
}

export interface SoftieInfo {
  kind: SoftieKind;
  name: string;
  /** One-word job: Lead, Research, Builder… */
  role: string;
  /** What they're good at, for pickers. */
  hint: string;
  /** A first job line, offered when you make one. */
  job: string;
  accent: SoftieAccentId;
  shape: SoftieShape;
  eye: { x: number; y: number; dx: number; w: number; h: number };
  /** Where it leans from (its feet). */
  pivot: readonly [number, number];
  haloY: number;
}

const SHAPES = {
  // Yo: the logo bubble, same geometry as the brand mark.
  bubble: {
    parts: [BUBBLE_TAIL, BUBBLE_BODY],
    box: [13, 14, 87, 91.5],
    shadow: [52, 94, 27, 3.2],
    hl: [37, 28, 31, 24.5],
  },
  // Dew: a drop whose tip leans to the right.
  drop: {
    parts: [
      "M55 11.5C50.5 24 22 38 22 61C22 76.5 34.5 87 50 87C65.5 87 78 76.5 78 61C78 44 64.5 31.5 58.5 21.5C57 19 56 15.5 55 11.5Z",
    ],
    box: [22, 11.5, 78, 87],
    shadow: [50, 88, 25, 3.6],
    hl: [41, 43, 37, 40.5],
  },
  // Pico: a gumdrop with gently inflated sides.
  gumdrop: {
    parts: [
      "M50 14C56.5 14 60.5 18.5 64.5 25.5C71 37 79.5 52.5 83 63C86.5 74 81 86 68 86H32C19 86 13.5 74 17 63C20.5 52.5 29 37 35.5 25.5C39.5 18.5 43.5 14 50 14Z",
    ],
    box: [15.5, 14, 84.5, 86],
    shadow: [50, 87.5, 31, 3.8],
    hl: [41, 36, 37.5, 34.5],
  },
  // Mochi: a soft dome with two round ears.
  dome: {
    parts: [
      circlePath(30.5, 33, 8.6),
      circlePath(69.5, 33, 8.6),
      "M15 70C15 45 30 29 50 29C70 29 85 45 85 70C85 80.5 78.5 86 68 86H32C21.5 86 15 80.5 15 70Z",
    ],
    box: [15, 24.4, 85, 86],
    shadow: [50, 87.5, 32, 3.8],
    hl: [36, 45, 31, 43],
  },
  // Clove: a soft five-point star, a point on top.
  star: {
    parts: [radialPath(50, 51.5, (t) => 31.5 + 5.6 * Math.cos(5 * t), 110)],
    box: [14, 14.4, 86, 84],
    shadow: [50, 86.5, 27, 3.4],
    hl: [38, 37, 33, 38],
  },
  // Kiki: a tall rounded body with an antenna.
  tall: {
    parts: [superellipsePath(50, 55.5, 23.5, 30.5, 3.3, 56)],
    box: [26.5, 25, 73.5, 86],
    shadow: [50, 87.5, 21, 3.4],
    hl: [39, 38, 35, 36.5],
    antenna: true,
  },
} satisfies Record<string, SoftieShape>;

const FEET = [50, 86] as const;

export const SOFTIES: readonly SoftieInfo[] = [
  {
    kind: "yo",
    name: "Yo",
    role: "Lead",
    hint: "Runs the team and talks to you",
    job: "Be my main assistant: take my requests, hand work to the team and keep me posted.",
    accent: "sun",
    shape: SHAPES.bubble,
    eye: { x: 51, y: 46, dx: 11.2, w: 9.2, h: 16.4 },
    pivot: [50, 91],
    haloY: 50,
  },
  {
    kind: "dew",
    name: "Dew",
    role: "Research",
    hint: "Reads, digs and cites sources",
    job: "Research what I ask and bring back a short answer with sources.",
    accent: "cobalt",
    shape: SHAPES.drop,
    eye: { x: 49, y: 61, dx: 9.6, w: 8.2, h: 14.2 },
    pivot: FEET,
    haloY: 52,
  },
  {
    kind: "pico",
    name: "Pico",
    role: "Builder",
    hint: "Code, sites, scripts and fixes",
    job: "Build and fix small apps, sites and scripts, and test them before you report back.",
    accent: "tangerine",
    shape: SHAPES.gumdrop,
    eye: { x: 50, y: 61, dx: 10.4, w: 8.4, h: 14.4 },
    pivot: FEET,
    haloY: 52,
  },
  {
    kind: "mochi",
    name: "Mochi",
    role: "Inbox",
    hint: "Mail, calendar and follow-ups",
    job: "Keep my inbox and calendar tidy, and draft replies for me to approve.",
    accent: "mint",
    shape: SHAPES.dome,
    eye: { x: 50, y: 59, dx: 11, w: 8.6, h: 14.6 },
    pivot: FEET,
    haloY: 52,
  },
  {
    kind: "clove",
    name: "Clove",
    role: "Writer",
    hint: "Drafts, edits and finds the tone",
    job: "Draft and edit my writing in my voice, and show me before anything goes out.",
    accent: "grape",
    shape: SHAPES.star,
    eye: { x: 50, y: 52, dx: 10.4, w: 8.4, h: 14.4 },
    pivot: FEET,
    haloY: 52,
  },
  {
    kind: "kiki",
    name: "Kiki",
    role: "Scout",
    hint: "Browses, watches and alerts",
    job: "Keep an eye on prices, news and pages I care about, and tell me when something changes.",
    accent: "berry",
    shape: SHAPES.tall,
    eye: { x: 50, y: 52, dx: 9.4, w: 8, h: 13.8 },
    pivot: FEET,
    haloY: 52,
  },
];

export const SOFTIE_ORDER: readonly SoftieKind[] = SOFTIES.map((s) => s.kind);

/** The teammates (everyone but Yo, who leads). */
export const TEAMMATE_KINDS: readonly SoftieKind[] = SOFTIE_ORDER.filter((k) => k !== "yo");

export function softieInfo(kind: SoftieKind | string | undefined): SoftieInfo {
  return SOFTIES.find((s) => s.kind === kind) ?? SOFTIES[0]!;
}

export function isSoftieKind(v: unknown): v is SoftieKind {
  return typeof v === "string" && SOFTIES.some((s) => s.kind === v);
}
