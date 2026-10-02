/**
 * "Dimensional" finish for Yo Buddies — the Violet Copilot direction (the "agent depth" design exploration).
 *
 * A layered-SVG approximation of the satin 3D concept renders: one soft key light above-left, a broad
 * restrained highlight, deeper lower-right shading, contact occlusion under the earcups, and a padded
 * front/back headset with a short boom mic. No SVG filters (cheap enough for dense lists); detail is
 * scaled by rendered size so 20–34 px avatars stay crisp and legible.
 */
import { smoothClosedPath, superellipsePath } from "./geometry";
import type { ShapeGeometry } from "./shapes";

/**
 * Plumper geometry for the curated dimensional families (squircle, pebble): one continuous inflated body,
 * ~72 units wide, slightly fuller at the bottom. Other shapes keep their legacy geometry.
 */
export const DIM_SHAPES: Partial<Record<string, ShapeGeometry>> = {
  squircle: {
    paths: [superellipsePath(50, 55, 36, 33.5, 3.4, 48)],
    face: { x: 50, y: 53 },
    eyeDx: 12,
    hat: { x: 50, y: 33, w: 70 },
    ears: { l: 14.5, r: 85.5, y: 53 },
    neckY: 82,
    top: 21.5,
  },
  pebble: {
    paths: [
      smoothClosedPath([
        [50, 20],
        [69, 22.5],
        [82, 35],
        [86.5, 55],
        [81, 75],
        [63, 88],
        [38, 88.5],
        [20, 77],
        [13.5, 57],
        [17.5, 37],
        [31, 24.5],
      ]),
    ],
    face: { x: 50, y: 54 },
    eyeDx: 12,
    hat: { x: 50, y: 32, w: 64 },
    ears: { l: 14, r: 86, y: 55 },
    neckY: 83,
    top: 20,
  },
};

export interface Material {
  base: string;
  light: string;
  shade: string;
}

/** Tuned materials. Keyed by palette color id; anything else is derived from the base hex. */
const MATERIALS: Record<string, Material> = {
  // 01 Violet Copilot — satin silicone.
  violet: { base: "#8854FF", light: "#C9A4FF", shade: "#45208C" },
  // Matches the 04 Sunlit Satin logo so a dimensional "Yo" agent and the brand mark share a surface.
  yo: { base: "#FFD43B", light: "#FFF19A", shade: "#CF8615" },
  // Pale furs/cups need hand-tuned shades (a derived near-black shade would look muddy).
  white: { base: "#F4F0EA", light: "#FFFFFF", shade: "#B5A9B9" },
  "#f7f1e8": { base: "#F7F1E8", light: "#FFFFFF", shade: "#C9B79F" },
  "#a8d98a": { base: "#A8D98A", light: "#E0F6CC", shade: "#5E9A4A" },
  "#ff9ec7": { base: "#FF9EC7", light: "#FFD9EA", shade: "#C4527F" },
  "#ff9ec0": { base: "#FF9EC0", light: "#FFD6E6", shade: "#D0628A" },
  "#8fe3c8": { base: "#8FE3C8", light: "#D2F8EB", shade: "#3FA586" },
  "#b9a7ff": { base: "#B9A7FF", light: "#E4DCFF", shade: "#6D56C9" },
  "#bfe6ff": { base: "#BFE6FF", light: "#EEF9FF", shade: "#6FA9CF" },
  "#d9774b": { base: "#D9774B", light: "#F2B08E", shade: "#8E3F20" },
};

/** Shared eye ink for the dimensional finish. */
export const DIM_EYE = "#0B0C0E";
/** Headset: midnight + highlight. */
const HS = { ink: "#202338", hi: "#494763", deep: "#141627", rim: "#6B6A8C" } as const;

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  const full =
    m.length === 3
      ? m
          .split("")
          .map((c) => c + c)
          .join("")
      : m.slice(0, 6);
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const c = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

export function materialFor(colorId: string, hex: string): Material {
  const tuned = MATERIALS[colorId] ?? MATERIALS[hex.toLowerCase()];
  if (tuned) return tuned;
  // Derived satin: lift toward white for the key light, sink toward a cool near-black for the shade.
  return { base: hex, light: mix(hex, "#FFFFFF", 0.48), shade: mix(hex, "#10081F", 0.52) };
}

/** Detail tiers from the handoff's size guidance. */
export type Detail = "compact" | "standard" | "hero";
export function detailFor(size: number): Detail {
  if (size < 26) return "compact";
  if (size < 60) return "standard";
  return "hero";
}

interface BodyProps {
  g: ShapeGeometry;
  m: Material;
  rid: string;
  detail: Detail;
}

/** Gradient + mask defs for the dimensional body. IDs are namespaced by `rid`. */
export function DimDefs({ g, m, rid }: BodyProps) {
  return (
    <>
      <clipPath id={`dc${rid}`}>
        {g.paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </clipPath>
      {/* Key light above-left: light → base → shade, so the surface reads inflated, not flat-graded. */}
      <radialGradient id={`dk${rid}`} gradientUnits="userSpaceOnUse" cx={34} cy={27} r={70}>
        <stop offset="0" stopColor={m.light} />
        <stop offset="0.42" stopColor={m.base} />
        <stop offset="0.8" stopColor={mix(m.base, m.shade, 0.55)} />
        <stop offset="1" stopColor={m.shade} />
      </radialGradient>
      {/* Deeper lower-right core shadow. */}
      <radialGradient id={`dd${rid}`} gradientUnits="userSpaceOnUse" cx={74} cy={86} r={46}>
        <stop offset="0" stopColor={m.shade} stopOpacity={0.55} />
        <stop offset="1" stopColor={m.shade} stopOpacity={0} />
      </radialGradient>
      {/* Broad, restrained specular. */}
      <radialGradient id={`ds${rid}`} gradientUnits="objectBoundingBox" cx={0.5} cy={0.5} r={0.5}>
        <stop offset="0" stopColor="#FFFFFF" stopOpacity={0.5} />
        <stop offset="0.6" stopColor="#FFFFFF" stopOpacity={0.12} />
        <stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
      </radialGradient>
      {/* Soft bounce light along the lower-left rim. */}
      <radialGradient id={`dr${rid}`} gradientUnits="userSpaceOnUse" cx={24} cy={84} r={26}>
        <stop offset="0" stopColor={m.light} stopOpacity={0.28} />
        <stop offset="1" stopColor={m.light} stopOpacity={0} />
      </radialGradient>
      {/* Earcup contact occlusion. */}
      <radialGradient id={`do${rid}`} gradientUnits="objectBoundingBox" cx={0.5} cy={0.5} r={0.5}>
        <stop offset="0" stopColor="#0B0716" stopOpacity={0.42} />
        <stop offset="1" stopColor="#0B0716" stopOpacity={0} />
      </radialGradient>
      {/* Earcup shell: lit top-left. */}
      <linearGradient id={`de${rid}`} x1="0" y1="0" x2="0.8" y2="1">
        <stop offset="0" stopColor={HS.hi} />
        <stop offset="0.45" stopColor={HS.ink} />
        <stop offset="1" stopColor={HS.deep} />
      </linearGradient>
      {/* Ground contact shadow. */}
      <radialGradient id={`dg${rid}`} gradientUnits="objectBoundingBox" cx={0.5} cy={0.5} r={0.5}>
        <stop offset="0" stopColor="#000" stopOpacity={0.34} />
        <stop offset="1" stopColor="#000" stopOpacity={0} />
      </radialGradient>
    </>
  );
}

/** Contact shadow on the ground (hero/standard only). */
export function DimGround({ rid, g }: { rid: string; g: ShapeGeometry }) {
  const bottom = Math.min(97, g.neckY + 12);
  return <ellipse className="yo-av-shadow" cx={51} cy={bottom} rx={30} ry={4.2} fill={`url(#dg${rid})`} />;
}

/** The plump body with layered lighting. */
export function DimBody({ g, m, rid, detail }: BodyProps) {
  const top = g.top;
  return (
    <>
      <g fill={`url(#dk${rid})`}>
        {g.paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
      <g clipPath={`url(#dc${rid})`}>
        <rect x={0} y={0} width={100} height={100} fill={`url(#dd${rid})`} />
        {detail !== "compact" && <rect x={0} y={0} width={100} height={100} fill={`url(#dr${rid})`} />}
        <ellipse
          cx={37}
          cy={top + 13}
          rx={detail === "compact" ? 17 : 20}
          ry={detail === "compact" ? 9 : 11}
          transform={`rotate(-16 37 ${top + 13})`}
          fill={`url(#ds${rid})`}
        />
      </g>
    </>
  );
}

/** Dimensional capsule eyes (same animation hooks as the flat eyes), with a subtle catch-light at larger sizes. */
export function DimEyes({
  g,
  kind,
  detail,
}: {
  g: ShapeGeometry;
  kind: "capsule" | "round" | "sleepy" | "happy" | "x" | "closed";
  detail: Detail;
}) {
  const { x, y } = g.face;
  const dx = g.eyeDx;
  // Compact sizes get slightly bigger eyes (~10 units tall at 20–24 px per the handoff).
  const w = detail === "compact" ? 9.4 : 8.4;
  const h = detail === "compact" ? 16 : 15.4;
  const eye = (ex: number) => {
    switch (kind) {
      case "capsule":
      case "round":
        return (
          <g>
            <rect x={ex - w / 2} y={y - h / 2} width={w} height={h} rx={w / 2} fill={DIM_EYE} />
            {detail !== "compact" && (
              <rect
                x={ex - w / 2 + 1.7}
                y={y - h / 2 + 2}
                width={2.3}
                height={4.4}
                rx={1.15}
                fill="#FFFFFF"
                opacity={0.3}
              />
            )}
          </g>
        );
      case "happy":
        return (
          <path
            d={`M${ex - 5.2} ${y + 2.6}Q${ex} ${y - 6.4} ${ex + 5.2} ${y + 2.6}`}
            fill="none"
            stroke={DIM_EYE}
            strokeWidth={3.8}
            strokeLinecap="round"
          />
        );
      case "sleepy":
      case "closed":
        return (
          <path
            d={`M${ex - 5} ${y + 0.5}Q${ex} ${y + 4.8} ${ex + 5} ${y + 0.5}`}
            fill="none"
            stroke={DIM_EYE}
            strokeWidth={3.4}
            strokeLinecap="round"
          />
        );
      case "x":
        return (
          <path
            d={`M${ex - 4} ${y - 4}L${ex + 4} ${y + 4}M${ex + 4} ${y - 4}L${ex - 4} ${y + 4}`}
            fill="none"
            stroke={DIM_EYE}
            strokeWidth={3.2}
            strokeLinecap="round"
          />
        );
    }
  };
  return (
    <g className="yo-av-look">
      <g className="yo-av-blink">
        {eye(x - dx)}
        {eye(x + dx)}
      </g>
    </g>
  );
}

/** Headband: drawn BEHIND the body so it reads as wrapping over the head. */
export function DimHeadsetBack({ g, detail }: { g: ShapeGeometry; detail: Detail }) {
  const { l, r, y } = g.ears;
  // Controls well above the crown so the band visibly arcs over the head (peak ≈ top - 10).
  const top = g.band ?? g.top - 26;
  const sw = detail === "compact" ? 6.4 : 5.4;
  return (
    <g>
      <path
        d={`M${l + 0.5} ${y - 9}C${l - 2} ${top}, ${r + 2} ${top}, ${r - 0.5} ${y - 9}`}
        stroke={HS.ink}
        strokeWidth={sw}
        fill="none"
        strokeLinecap="round"
      />
      {/* Rim light along the top of the band keeps it legible on dark surfaces. */}
      <path
        d={`M${l + 1.2} ${y - 17}C${l - 0.4} ${top + 2.6}, ${r + 0.4} ${top + 2.6}, ${r - 1.2} ${y - 17}`}
        stroke={detail === "compact" ? HS.rim : HS.hi}
        strokeWidth={detail === "compact" ? 1.6 : 1.3}
        fill="none"
        strokeLinecap="round"
        opacity={0.9}
      />
    </g>
  );
}

/** Earcups, occlusion and boom mic: drawn IN FRONT of the body. */
export function DimHeadsetFront({ g, rid, detail }: { g: ShapeGeometry; rid: string; detail: Detail }) {
  const { l, r, y } = g.ears;
  const compact = detail === "compact";
  const cw = (g.earcup?.w ?? 11.5) + (compact ? 1 : 0); // handoff: 8–11 units; a touch wider when compact
  const ch = (g.earcup?.h ?? 24) + (compact ? 1 : 0);
  const cy = y - 1;
  // Boom mic from the right earcup, sweeping down-left to a capsule at the lower right of the face —
  // clearly a mic (not a mouth) and well clear of the eyes.
  const mx = g.mic?.x ?? g.face.x + 11;
  const my = g.mic?.y ?? g.face.y + 19;
  const micW = compact ? 3.4 : 2.9;
  const cup = (cx: number, side: -1 | 1) => (
    <g>
      <rect
        x={cx - cw / 2}
        y={cy - ch / 2}
        width={cw}
        height={ch}
        rx={cw / 2}
        fill={`url(#de${rid})`}
        stroke={HS.rim}
        strokeOpacity={0.55}
        strokeWidth={compact ? 1.1 : 0.8}
      />
      {!compact && (
        <>
          {/* Cushion edge facing the head. */}
          <rect
            x={side < 0 ? cx + cw / 2 - 3.6 : cx - cw / 2 + 0.6}
            y={cy - ch / 2 + 2.5}
            width={3}
            height={ch - 5}
            rx={1.5}
            fill={HS.deep}
            opacity={0.85}
          />
          {/* Specular on the shell. */}
          <rect
            x={cx - cw / 2 + (side < 0 ? 1.8 : 3.4)}
            y={cy - ch / 2 + 3}
            width={2.2}
            height={ch * 0.42}
            rx={1.1}
            fill={HS.hi}
            opacity={0.95}
          />
        </>
      )}
    </g>
  );
  return (
    <g>
      {!compact && (
        <g clipPath={`url(#dc${rid})`}>
          <ellipse cx={l + 6} cy={cy + 1} rx={8} ry={14} fill={`url(#do${rid})`} />
          <ellipse cx={r - 6} cy={cy + 1} rx={8} ry={14} fill={`url(#do${rid})`} />
          <ellipse cx={mx + 1} cy={my + 3} rx={7} ry={3.2} fill={`url(#do${rid})`} opacity={0.8} />
        </g>
      )}
      {cup(l, -1)}
      {cup(r, 1)}
      {/* Boom mic pivots from the earcup: while working it dips now and then (see styles.ts). */}
      <g
        className="yo-av-mic"
        style={{ transformBox: "view-box", transformOrigin: `${r - 1}px ${cy + ch / 2 - 4}px` }}
      >
        <path
          d={`M${r - 1} ${cy + ch / 2 - 4}C${r - 1} ${my + 1}, ${mx + 12} ${my + 1}, ${mx + 5} ${my}`}
          stroke={HS.ink}
          strokeWidth={micW}
          fill="none"
          strokeLinecap="round"
        />
        <g transform={`rotate(-8 ${mx} ${my})`}>
          <rect
            x={mx - 6.5}
            y={my - (compact ? 3.8 : 3.4)}
            width={compact ? 13 : 12.5}
            height={compact ? 7.6 : 6.8}
            rx={compact ? 3.8 : 3.4}
            fill={`url(#de${rid})`}
          />
          {!compact && <rect x={mx - 4.6} y={my - 2.3} width={4.6} height={1.7} rx={0.85} fill={HS.hi} />}
        </g>
      </g>
    </g>
  );
}
