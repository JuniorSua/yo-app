/**
 * Pure path helpers for the Yo Buddies avatar system. Everything is drawn in a 100x100 viewBox.
 * No DOM / React here so the same geometry can be used for static SVG export (icons, favicons).
 */

export type Pt = readonly [number, number];

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** Smooth closed path through points (Catmull-Rom -> cubic Bezier). */
export function smoothClosedPath(points: readonly Pt[], tension = 1): string {
  const n = points.length;
  if (n < 3) return "";
  const p = (i: number) => points[((i % n) + n) % n]!;
  let d = `M${f(p(0)[0])} ${f(p(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p(i - 1);
    const p1 = p(i);
    const p2 = p(i + 1);
    const p3 = p(i + 2);
    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension;
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension;
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension;
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension;
    d += `C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

/** Superellipse ("squircle") |x/a|^n + |y/b|^n = 1. */
export function superellipsePath(cx: number, cy: number, a: number, b: number, n = 4, steps = 40): string {
  const pts: Pt[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push([
      cx + a * Math.sign(c) * Math.abs(c) ** (2 / n),
      cy + b * Math.sign(s) * Math.abs(s) ** (2 / n),
    ]);
  }
  return smoothClosedPath(pts);
}

/** Polygon with rounded corners (quadratic corner curves). */
export function roundedPolygonPath(vertices: readonly Pt[], r: number): string {
  const n = vertices.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const v = vertices[i]!;
    const prev = vertices[(i - 1 + n) % n]!;
    const next = vertices[(i + 1) % n]!;
    const toward = (a: Pt, b: Pt): Pt => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      return [a[0] + (dx / len) * r, a[1] + (dy / len) * r];
    };
    const a = toward(v, prev);
    const b = toward(v, next);
    d += `${i === 0 ? "M" : "L"}${f(a[0])} ${f(a[1])}Q${f(v[0])} ${f(v[1])} ${f(b[0])} ${f(b[1])}`;
  }
  return `${d}Z`;
}

export function circlePath(cx: number, cy: number, r: number): string {
  return `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
}

export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${f(x + r)} ${f(y)}H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}` +
    `V${f(y + h - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)}H${f(x + r)}` +
    `A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)}V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}Z`
  );
}

/** Radial "burst": a soft sun with rounded lobes. */
export function burstPath(cx: number, cy: number, r: number, amp: number, lobes: number, steps = 90): string {
  const pts: Pt[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2 - Math.PI / 2;
    const rr = r + amp * Math.cos(lobes * (t + Math.PI / 2));
    pts.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)]);
  }
  return smoothClosedPath(pts);
}

/** The Yo bubble: a soft squircle speech bubble with a small tail bottom-left. */
export const BUBBLE_BODY = superellipsePath(50, 47, 37, 33, 4.2, 44);
export const BUBBLE_TAIL = "M20.5 66C21.5 77 18.5 85 12.5 91.5C23 91.5 33.5 86.5 40 77.5Z";

/**
 * CupCat head: wide, with sharp corner ears and cheeks that bulge at the bottom sides (the CupCats
 * silhouette), a touch bigger than the other avatars. The base sits inside the cup (hidden below y≈60).
 */
export const CUPCAT_HEAD = smoothClosedPath(
  [
    [14.5, 6],
    [24.5, 15.5],
    [35, 21],
    [50, 20],
    [65, 21],
    [75.5, 15.5],
    [85.5, 6],
    [87.5, 24],
    [90.5, 45],
    [91, 60],
    [79, 70],
    [50, 73],
    [21, 70],
    [9, 60],
    [9.5, 45],
    [12.5, 24],
  ],
  0.82,
);
