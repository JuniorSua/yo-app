/**
 * <Softie>: one Softie in one state, as plain SVG (no WebGL, no filters). Light comes from the upper left: a
 * radial base gradient, bottom occlusion, a rim bounce, a soft highlight and a glint, glossy capsule eyes and a
 * contact shadow. Detail follows the size:
 * - xs (30px and below): base gradient, soft highlight and larger eyes; the state shows as a badge only.
 * - sm (up to 60px): adds the rim, the glint and the shadow; state overlays (thought bubble, orbit, sparkles).
 * - lg: adds blush and breathing.
 * The pose (tilt, where the eyes look) is drawn with attributes, so a still frame always looks designed. Motion is
 * CSS on inner groups (avatar.css): calm, one-shot for "needs you" and "done", none under prefers-reduced-motion.
 * Light and dark come from the page's `.dark` class, so a Softie needs no theme prop.
 */
import type { SoftieKind } from "@yo/contracts";
import { type CSSProperties, type ReactNode, useId } from "react";
import { mix } from "../color-math";
import { softieInfo } from "./characters";
import { defaultColor } from "./legacy";
import { type SoftiePalette, softiePalette } from "./palette";
import type { SoftieState } from "./state";

const INK = "#16130E";
const AMBER = "#FFA81F";
const DONE = "#1FBF84";
const ERROR = "#E5484D";

export type SoftieLevel = "xs" | "sm" | "lg";
export const softieLevel = (size: number): SoftieLevel => (size <= 30 ? "xs" : size <= 60 ? "sm" : "lg");

const f = (n: number) => Math.round(n * 100) / 100;

type Pose = {
  eyes: "open" | "happy" | "closed";
  lx: number;
  ly: number;
  sx: number;
  sy: number;
  tilt: number;
};
const POSE: Record<SoftieState, Pose> = {
  idle: { eyes: "open", lx: 0, ly: 0, sx: 1, sy: 1, tilt: 0 },
  thinking: { eyes: "open", lx: 2.6, ly: -3.4, sx: 0.92, sy: 0.88, tilt: 3 },
  working: { eyes: "open", lx: 2.4, ly: 2.2, sx: 0.98, sy: 0.84, tilt: -2 },
  needs: { eyes: "open", lx: 0, ly: -1.4, sx: 1.2, sy: 1.04, tilt: -6 },
  done: { eyes: "happy", lx: 0, ly: -0.6, sx: 1, sy: 1, tilt: 0 },
  sleeping: { eyes: "closed", lx: 0, ly: 1, sx: 1, sy: 1, tilt: 0 },
  error: { eyes: "open", lx: 0, ly: 0, sx: 1, sy: 0.96, tilt: 0 },
};

/** Where the status badge sits, per level (bottom right, overlapping the body a little). */
export function badgeGeometry(lvl: SoftieLevel) {
  if (lvl === "xs") return { cx: 81, cy: 81, r: 15.5, ring: 4.2 };
  if (lvl === "sm") return { cx: 82, cy: 80, r: 12.5, ring: 3.6 };
  return { cx: 83.5, cy: 79.5, r: 10.5, ring: 3 };
}

/** Which states show a badge at this level (small sizes show every state as a badge). */
export function badgeFor(state: SoftieState, lvl: SoftieLevel): SoftieState | null {
  if (state === "needs" || state === "done" || state === "error") return state;
  if (lvl === "xs" && (state === "thinking" || state === "working")) return state;
  return null;
}

function sparkle(cx: number, cy: number, r: number, k = 0.28): string {
  const q = r * k;
  return `M${f(cx)} ${f(cy - r)}Q${f(cx + q)} ${f(cy - q)} ${f(cx + r)} ${f(cy)}Q${f(cx + q)} ${f(cy + q)} ${f(cx)} ${f(cy + r)}Q${f(cx - q)} ${f(cy + q)} ${f(cx - r)} ${f(cy)}Q${f(cx - q)} ${f(cy - q)} ${f(cx)} ${f(cy - r)}Z`;
}

/**
 * The status badge: amber "!" (needs you), green check (done), red "×" (error), dark "…" (thinking) or a spinner
 * (working). Always a glyph, never colour alone. The ring around it is cut out of the figure (see `BadgeCutout`),
 * so it reads on any background.
 */
export function SoftieBadge({
  state,
  lvl,
  id,
  spin,
}: {
  state: SoftieState;
  lvl: SoftieLevel;
  /** Unique id prefix (gradients). */
  id: string;
  /** Spinner colour in light mode (the dark one comes from --sf-spin-d). */
  spin: string;
}) {
  const { cx, cy, r } = badgeGeometry(lvl);
  const sw = r * 0.3;
  const gloss = lvl !== "xs";
  let fill = "";
  let icon: ReactNode = null;
  if (state === "needs") {
    fill = AMBER;
    icon = (
      <>
        <path
          d={`M${f(cx)} ${f(cy - r * 0.5)}V${f(cy + r * 0.08)}`}
          stroke={INK}
          strokeWidth={f(sw)}
          strokeLinecap="round"
        />
        <circle cx={f(cx)} cy={f(cy + r * 0.5)} r={f(sw * 0.56)} fill={INK} />
      </>
    );
  } else if (state === "done") {
    fill = DONE;
    icon = (
      <path
        d={`M${f(cx - r * 0.44)} ${f(cy + r * 0.02)}L${f(cx - r * 0.1)} ${f(cy + r * 0.36)}L${f(cx + r * 0.46)} ${f(cy - r * 0.3)}`}
        fill="none"
        stroke="#fff"
        strokeWidth={f(sw)}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  } else if (state === "error") {
    fill = ERROR;
    const a = r * 0.36;
    icon = (
      <path
        d={`M${f(cx - a)} ${f(cy - a)}L${f(cx + a)} ${f(cy + a)}M${f(cx + a)} ${f(cy - a)}L${f(cx - a)} ${f(cy + a)}`}
        stroke="#fff"
        strokeWidth={f(sw * 0.92)}
        strokeLinecap="round"
      />
    );
  } else if (state === "thinking") {
    icon = [-1, 0, 1].map((i) => (
      <circle
        key={i}
        className={`sf-chip-fg sf-td sf-td${i + 2}`}
        cx={f(cx + i * r * 0.46)}
        cy={f(cy)}
        r={f(r * 0.15)}
        fill="#fff"
      />
    ));
  } else if (state === "working") {
    const rr = r * 0.52;
    icon = (
      <g className="sf-spin" style={{ transformOrigin: `${f(cx)}px ${f(cy)}px` }}>
        <path
          className="sf-spin-arc"
          d={`M${f(cx)} ${f(cy - rr)}A${f(rr)} ${f(rr)} 0 1 1 ${f(cx - rr)} ${f(cy)}`}
          fill="none"
          stroke={spin}
          strokeWidth={f(sw * 0.9)}
          strokeLinecap="round"
        />
      </g>
    );
  } else return null;
  const chip = state === "thinking" || state === "working";
  return (
    <g className={`sf-badge sf-badge-${state}`}>
      {gloss && !chip ? (
        <>
          <defs>
            <radialGradient id={`${id}bg`} cx=".35" cy=".3" r=".8">
              <stop offset="0" stopColor={mix(fill, "#ffffff", 0.45)} />
              <stop offset=".6" stopColor={fill} />
              <stop offset="1" stopColor={mix(fill, "#000000", 0.18)} />
            </radialGradient>
          </defs>
          <circle cx={f(cx)} cy={f(cy)} r={f(r)} fill={`url(#${id}bg)`} />
        </>
      ) : (
        <circle
          className={chip ? "sf-chip" : undefined}
          cx={f(cx)}
          cy={f(cy)}
          r={f(r)}
          fill={chip ? "#34302B" : fill}
        />
      )}
      {icon}
    </g>
  );
}

/** A mask that cuts the badge's ring out of everything under it (the page shows through, whatever its colour). */
export function BadgeCutout({ id, lvl }: { id: string; lvl: SoftieLevel }) {
  const { cx, cy, r, ring } = badgeGeometry(lvl);
  return (
    <mask id={`${id}m`} maskUnits="userSpaceOnUse" x={-30} y={-30} width={160} height={160}>
      <rect x={-30} y={-30} width={160} height={160} fill="#fff" />
      <circle cx={f(cx)} cy={f(cy)} r={f(r + ring)} fill="#000" />
    </mask>
  );
}

function Eyes({
  kind,
  lvl,
  state,
  id,
}: {
  kind: SoftieKind;
  lvl: SoftieLevel;
  state: SoftieState;
  id: string;
}) {
  const e = softieInfo(kind).eye;
  const xs = lvl === "xs";
  const k = xs ? 1.16 : 1;
  const P = POSE[state];
  const W = e.w * k;
  const H = e.h * k;
  const big = state === "needs" ? 1.25 : 1;
  return (
    <>
      {[-1, 1].map((s) => {
        const cx = e.x + s * e.dx * (xs ? 1.04 : 1);
        const cy = e.y;
        if (P.eyes === "happy") {
          const hw = W * 0.74;
          const hh = H * 0.34;
          return (
            <path
              key={s}
              d={`M${f(cx - hw)} ${f(cy + hh * 0.6)}Q${f(cx)} ${f(cy - hh * 1.55)} ${f(cx + hw)} ${f(cy + hh * 0.6)}`}
              fill="none"
              stroke={INK}
              strokeWidth={f(W * 0.56)}
              strokeLinecap="round"
            />
          );
        }
        if (P.eyes === "closed") {
          const hw = W * 0.7;
          const hh = H * 0.28;
          return (
            <path
              key={s}
              d={`M${f(cx - hw)} ${f(cy)}Q${f(cx)} ${f(cy + hh * 1.5)} ${f(cx + hw)} ${f(cy)}`}
              fill="none"
              stroke={INK}
              strokeWidth={f(W * (xs ? 0.5 : 0.42))}
              strokeLinecap="round"
            />
          );
        }
        const w = W * P.sx;
        const h = H * P.sy;
        return (
          <g key={s}>
            <rect
              x={f(cx - w / 2)}
              y={f(cy - h / 2)}
              width={f(w)}
              height={f(h)}
              rx={f(Math.min(w, h) / 2)}
              fill={`url(#${id}e)`}
            />
            {!xs && (
              <>
                <ellipse
                  cx={f(cx - w * 0.15)}
                  cy={f(cy - h * 0.2)}
                  rx={f(w * 0.2 * big)}
                  ry={f(h * 0.13 * big)}
                  fill="#fff"
                  opacity={0.95}
                />
                <circle
                  cx={f(cx + w * 0.14)}
                  cy={f(cy + h * 0.2)}
                  r={f(w * 0.09 * big)}
                  fill="#fff"
                  opacity={0.45}
                />
              </>
            )}
          </g>
        );
      })}
    </>
  );
}

function Thought({ p }: { p: SoftiePalette }) {
  const bx = 79;
  const by = 12.5;
  const bw = 28;
  const bh = 15.5;
  return (
    <g className="sf-thought">
      <g className="sf-tb" fill="#fff" stroke="#E6E2DA" strokeWidth={1}>
        <circle cx={64.5} cy={29.5} r={2} />
        <circle cx={69.5} cy={24} r={3.1} />
        <rect x={bx - bw / 2} y={f(by - bh / 2)} width={bw} height={bh} rx={f(bh / 2)} />
      </g>
      {[-1, 0, 1].map((i) => (
        <circle
          key={i}
          className={`sf-dot sf-td sf-td${i + 2}`}
          cx={bx + i * 7}
          cy={by}
          r={2.3}
          fill={p.shade}
        />
      ))}
    </g>
  );
}

/** A small satellite circling it while it works; the back half of its path is drawn behind the body. */
function orbit(p: SoftiePalette, id: string, cy: number) {
  const tr = `translate(50 ${f(cy)}) rotate(-12)`;
  const ring = { className: "sf-ring", fill: "none", stroke: p.shade, strokeOpacity: 0.45, strokeWidth: 1.6 };
  const dot = (
    <>
      <circle r={4.6} fill={`url(#${id}sat)`} />
      <ellipse cx={-1.4} cy={-1.6} rx={1.5} ry={1} fill="#fff" opacity={0.9} />
    </>
  );
  return {
    back: (
      <g className="sf-orbit" transform={tr}>
        <defs>
          <radialGradient id={`${id}sat`} cx=".35" cy=".3" r=".85">
            <stop offset="0" stopColor={p.light} />
            <stop offset=".55" stopColor={p.base} />
            <stop offset="1" stopColor={p.deep} />
          </radialGradient>
        </defs>
        <path d="M-44 0A44 12.5 0 0 1 44 0" {...ring} />
        <g className="sf-sat sf-sat-b" opacity={0}>
          {dot}
        </g>
      </g>
    ),
    front: (
      <g className="sf-orbit" transform={tr}>
        <path d="M44 0A44 12.5 0 0 1 -44 0" {...ring} />
        <g className="sf-sat sf-sat-f" transform="translate(38.61 5.99)">
          {dot}
        </g>
      </g>
    ),
  };
}

function Sparkles({ p }: { p: SoftiePalette }) {
  return (
    <g className="sf-sparkles">
      <path className="sf-sp sf-sp1 sf-sp-a" d={sparkle(15, 22, 7)} fill="#FFC21A" />
      <path className="sf-sp sf-sp2 sf-sp-b" d={sparkle(86, 13, 5.2)} fill={p.base} />
      <path className="sf-sp sf-sp3 sf-sp-a" d={sparkle(91, 33, 3.4)} fill="#FFC21A" />
    </g>
  );
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export interface SoftieProps {
  kind: SoftieKind;
  /** Wear another colour (hex), so two teammates can share a shape. Defaults to the Softie's own. */
  color?: string;
  /** Rendered size in px (square). */
  size?: number;
  state?: SoftieState;
  /** Off: a still frame (lists, pickers). Motion also stops under prefers-reduced-motion. */
  animated?: boolean;
  /** Accessible name (defaults to the Softie's name). */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function Softie({
  kind,
  color,
  size = 32,
  state = "idle",
  animated = true,
  title,
  className,
  style,
}: SoftieProps) {
  // A separator after the React id: "a1" + "b" must never meet "a1b" (two avatars on one page).
  const id = `sf${useId().replace(/[^a-zA-Z0-9]/g, "")}_`;
  const info = softieInfo(kind);
  const p = softiePalette(color ?? defaultColor(info.kind));
  const lvl = softieLevel(size);
  const xs = lvl === "xs";
  const lg = lvl === "lg";
  const S = info.shape;
  const [x0, y0, x1, y1] = S.box;
  const W = x1 - x0;
  const H = y1 - y0;
  const gx = x0 + W * 0.3;
  const gy = y0 + H * 0.24;
  const gr = Math.max(W, H) * 0.98;
  // Yo yellow is light already: softer occlusion, and a yellow (not pale) spinner.
  const sun = p.base.toUpperCase() === "#FFD43B";
  const P = POSE[state];
  const pivot = info.pivot;
  const badge = badgeFor(state, lvl);
  const orb = state === "working" && !xs ? orbit(p, id, Math.min(info.eye.y + 15, 72)) : null;
  const [hx, hy, glx, gly] = S.hl;
  const [sx, sy, srx, sry] = S.shadow;
  const vars = {
    "--sf-d": `${-(hash(id) % 5200) / 1000}s`,
    "--sf-dot-d": p.inkDark,
    "--sf-ring-d": p.light,
    "--sf-sp-d": p.light,
    "--sf-spin-d": p.ink,
  } as CSSProperties;

  const figure = (
    <>
      {state === "needs" && !xs && (
        <g className="sf-halo">
          <defs>
            <radialGradient id={`${id}halo`}>
              <stop offset=".45" stopColor={AMBER} stopOpacity={0.46} />
              <stop offset=".78" stopColor={AMBER} stopOpacity={0.16} />
              <stop offset="1" stopColor={AMBER} stopOpacity={0} />
            </radialGradient>
          </defs>
          <circle cx={50} cy={info.haloY} r={49} fill={`url(#${id}halo)`} />
        </g>
      )}
      {!xs && <ellipse className="sf-shadow" cx={sx} cy={sy} rx={srx} ry={sry} fill={`url(#${id}sh)`} />}
      {orb?.back}
      <g transform={P.tilt && !xs ? `rotate(${P.tilt} ${pivot[0]} ${pivot[1]})` : undefined}>
        <g className="sf-move">
          <g className="sf-breathe">
            {S.antenna && (
              <>
                <path
                  d="M50.5 26C50 19 52.5 13.5 57.5 10.5"
                  fill="none"
                  stroke={mix(p.shade, p.deep, 0.45)}
                  strokeWidth={xs ? 3.4 : 2.6}
                  strokeLinecap="round"
                />
                <circle cx={59} cy={9.6} r={xs ? 6 : 5.2} fill={`url(#${id}ab)`} />
                {!xs && (
                  <ellipse
                    cx={57.4}
                    cy={7.8}
                    rx={1.7}
                    ry={1.1}
                    fill="#fff"
                    opacity={0.9}
                    transform="rotate(-30 57.4 7.8)"
                  />
                )}
              </>
            )}
            {S.parts.map((d) => (
              <path key={d} d={d} fill={`url(#${id}b)`} />
            ))}
            <g clipPath={`url(#${id}c)`}>
              <rect x={0} y={0} width={100} height={100} fill={`url(#${id}ao)`} />
              {!xs &&
                S.parts.map((d) => (
                  <path key={d} d={d} fill="none" stroke={`url(#${id}rim)`} strokeWidth={lg ? 3.2 : 3.6} />
                ))}
              <ellipse
                cx={hx}
                cy={hy}
                rx={f(W * 0.27)}
                ry={f(H * 0.16)}
                fill={`url(#${id}hl)`}
                transform={`rotate(-28 ${hx} ${hy})`}
                opacity={xs ? 0.7 : 0.95}
              />
              {!xs && (
                <ellipse
                  cx={glx}
                  cy={gly}
                  rx={3.6}
                  ry={2.1}
                  fill="#fff"
                  opacity={0.92}
                  transform={`rotate(-38 ${glx} ${gly})`}
                />
              )}
            </g>
            {lg &&
              [-1, 1].map((s) => (
                <ellipse
                  key={s}
                  cx={f(info.eye.x + s * (info.eye.dx + 6.4))}
                  cy={f(info.eye.y + info.eye.h * 0.62)}
                  rx={4.6}
                  ry={2.6}
                  fill={mix(p.base, "#FF4F7A", 0.42)}
                  opacity={0.38}
                />
              ))}
            <g transform={P.lx || P.ly ? `translate(${P.lx} ${P.ly})` : undefined}>
              <g className="sf-gaze">
                <g className="sf-blink">
                  <Eyes kind={info.kind} lvl={lvl} state={state} id={id} />
                </g>
              </g>
            </g>
          </g>
        </g>
      </g>
      {orb?.front}
      {state === "thinking" && !xs && <Thought p={p} />}
      {state === "done" && !xs && <Sparkles p={p} />}
    </>
  );

  return (
    <svg
      className={["sf", `sf--${state}`, `sf--${lvl}`, animated ? "sf--anim" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      width={size}
      height={size}
      viewBox={xs ? "5 5 90 90" : "0 0 100 100"}
      overflow="visible"
      role="img"
      aria-label={title ?? info.name}
      data-softie={info.kind}
      data-state={state}
      style={{ ...vars, ...style }}
    >
      <defs>
        <radialGradient id={`${id}b`} gradientUnits="userSpaceOnUse" cx={f(gx)} cy={f(gy)} r={f(gr)}>
          <stop offset="0" stopColor={p.light} />
          <stop offset=".3" stopColor={mix(p.light, p.base, 0.72)} />
          <stop offset=".6" stopColor={p.base} />
          <stop offset=".86" stopColor={p.shade} />
          <stop offset="1" stopColor={mix(p.shade, p.deep, 0.55)} />
        </radialGradient>
        <clipPath id={`${id}c`}>
          {S.parts.map((d) => (
            <path key={d} d={d} />
          ))}
        </clipPath>
        <linearGradient
          id={`${id}ao`}
          gradientUnits="userSpaceOnUse"
          x1={0}
          y1={f(y1 - H * 0.42)}
          x2={0}
          y2={y1}
        >
          <stop offset="0" stopColor={p.deep} stopOpacity={0} />
          <stop offset="1" stopColor={p.deep} stopOpacity={sun ? 0.26 : 0.4} />
        </linearGradient>
        {!xs && (
          <linearGradient id={`${id}rim`} gradientUnits="userSpaceOnUse" x1={x0} y1={y0} x2={x1} y2={y1}>
            <stop offset=".55" stopColor={p.light} stopOpacity={0} />
            <stop offset="1" stopColor={p.light} stopOpacity={0.95} />
          </linearGradient>
        )}
        <radialGradient id={`${id}hl`} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#fff" stopOpacity={0.85} />
          <stop offset=".55" stopColor="#fff" stopOpacity={0.28} />
          <stop offset="1" stopColor="#fff" stopOpacity={0} />
        </radialGradient>
        {!xs && (
          <radialGradient id={`${id}sh`} cx=".5" cy=".5" r=".5">
            <stop className="sf-sh0" offset="0" stopColor={p.deep} stopOpacity={0.34} />
            <stop className="sf-sh1" offset=".55" stopColor={p.deep} stopOpacity={0.12} />
            <stop className="sf-sh2" offset="1" stopColor={p.deep} stopOpacity={0} />
          </radialGradient>
        )}
        <linearGradient id={`${id}e`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3A322A" />
          <stop offset=".5" stopColor={INK} />
          <stop offset="1" stopColor="#050403" />
        </linearGradient>
        {S.antenna && (
          <radialGradient id={`${id}ab`} cx=".36" cy=".32" r=".75">
            <stop offset="0" stopColor={p.light} />
            <stop offset=".5" stopColor={p.base} />
            <stop offset="1" stopColor={p.shade} />
          </radialGradient>
        )}
        {badge && <BadgeCutout id={id} lvl={lvl} />}
      </defs>
      {badge ? <g mask={`url(#${id}m)`}>{figure}</g> : figure}
      {badge && <SoftieBadge state={badge} lvl={lvl} id={id} spin={sun ? p.base : p.light} />}
    </svg>
  );
}
