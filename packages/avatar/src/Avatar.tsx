import type { AgentActivity, Avatar as AvatarData } from "@yo/contracts";
import { Component, type CSSProperties, lazy, type ReactNode, Suspense, useId } from "react";
import { Accessory } from "./accessories";
import { colorById } from "./colors";
import { creatureFallback } from "./creatures/meta";
import type { TurnInfo } from "./creatures/state";
import { CupCatFigure } from "./cupcat";
import {
  DIM_SHAPES,
  DimBody,
  DimDefs,
  DimEyes,
  DimGround,
  DimHeadsetBack,
  DimHeadsetFront,
  detailFor,
  materialFor,
} from "./dimensional";
import { type EyeStyle, Eyes } from "./eyes";
import { superellipsePath } from "./geometry";
import { SHAPES } from "./shapes";
import { AVATAR_CSS } from "./styles";

// Living characters load their engine + textures on demand (keeps node scripts and first paint light).
const LivingAvatar = lazy(() => import("./living/LivingAvatar"));
// Creatures bring in three.js: it loads only once a creature avatar is on screen (never in the main bundle).
const CreatureAvatar = lazy(() => import("./creatures/CreatureAvatar"));

/** A creature that fails to load or render shows its drawn fallback instead of blanking the app. */
class CreatureBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("[yo] creature avatar fell back to its drawn look:", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface AvatarProps {
  avatar: AvatarData;
  /** Rendered size in px (square). */
  size?: number;
  state?: AgentActivity;
  /** Disable all motion (static render). */
  animated?: boolean;
  /** Draw a soft ground shadow (nice for hero sizes). */
  ground?: boolean;
  /** Decorative use (chat headers, lists): living characters look awake instead of asleep when idle. */
  quiet?: boolean;
  /**
   * Creatures only: animate on a live canvas (the agent you're viewing). Otherwise a creature is a shared,
   * cached still picture of its current pose (lists, pickers).
   */
  live?: boolean;
  /** Creatures only: the agent's current turn, when known ("thinking" vs "working"). */
  turn?: TurnInfo;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

const IMAGE_CLIP = superellipsePath(50, 50, 46, 46, 4.4);

/** Injects the avatar stylesheet once (React 19 hoists + dedupes by href). */
export function AvatarStyles() {
  return (
    <style href="yo-avatar-styles" precedence="low">
      {AVATAR_CSS}
    </style>
  );
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function eyeFor(state: AgentActivity, eyes: AvatarData["eyes"], dimensional = false): EyeStyle {
  // Dimensional finish: errors keep a still, attentive face (the status label carries the meaning).
  if (state === "error") return dimensional ? eyes : "x";
  if (state === "sleeping") return "closed";
  if (state === "done") return "happy";
  return eyes;
}

export function Avatar({
  avatar,
  size = 32,
  state = "idle",
  animated = true,
  ground = false,
  className,
  style,
  title,
  quiet,
  live,
  turn,
}: AvatarProps) {
  const rid = useId().replace(/[^a-zA-Z0-9]/g, "");
  if (avatar.creature && !avatar.image) {
    const creature = avatar.creature;
    const drawn = (
      <Avatar
        avatar={creatureFallback(avatar)}
        size={size}
        state={state}
        animated={false}
        className={className}
        style={style}
        title={title}
      />
    );
    return (
      <CreatureBoundary key={creature.kind} fallback={drawn}>
        <Suspense fallback={drawn}>
          <CreatureAvatar
            avatar={{ ...avatar, creature }}
            size={size}
            state={state}
            turn={turn}
            live={live}
            animated={animated}
            className={className}
            style={style}
            title={title}
            fallback={drawn}
          />
        </Suspense>
      </CreatureBoundary>
    );
  }
  if (avatar.living && !avatar.image) {
    const living = avatar.living;
    const drawn = { ...avatar, living: undefined };
    return (
      <Suspense
        fallback={
          <Avatar
            avatar={drawn}
            size={size}
            state={state}
            animated={false}
            className={className}
            style={style}
            title={title}
          />
        }
      >
        <LivingAvatar
          avatar={{ ...avatar, living }}
          size={size}
          state={state}
          quiet={quiet}
          animated={animated}
          ground={ground}
          className={className}
          style={style}
          title={title}
        />
      </Suspense>
    );
  }
  const g = SHAPES[avatar.shape] ?? SHAPES.bubble;
  const color = colorById(avatar.color);
  const dimensional = avatar.finish === "dimensional" && !avatar.image;
  const eyes = eyeFor(state, avatar.eyes, dimensional);
  const delay = `${-(hash(rid) % 5200) / 1000}s`;
  const noBlink = eyes === "happy" || eyes === "x" || eyes === "closed" || eyes === "sleepy";
  const classes = [
    "yo-av",
    `yo-av--${state}`,
    animated ? "yo-av--anim" : "",
    noBlink ? "yo-av--noblink" : "",
    dimensional ? "yo-av--dim" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  if (avatar.shape === "cupcat" && !avatar.image) {
    const detail = detailFor(size);
    // CupCats always use the calm "dimensional" motion set (blink, glance, one nod) + the mic bob.
    const cls = classes.includes("yo-av--dim") ? classes : `${classes} yo-av--dim`;
    return (
      <>
        <AvatarStyles />
        <svg
          className={cls}
          width={size}
          height={size}
          viewBox="0 0 100 100"
          role="img"
          aria-label={title ?? "avatar"}
          data-state={state}
          data-finish="cupcat"
          data-variant={avatar.variant ?? "sakura"}
          style={{ ...style, ["--yo-av-d" as string]: delay }}
        >
          <circle
            className="yo-av-ring"
            cx={50}
            cy={52}
            r={47}
            fill="none"
            stroke="#E9C46A"
            strokeWidth={3.2}
          />
          {(ground || detail === "hero") && (
            <ellipse className="yo-av-shadow" cx={50} cy={98.5} rx={34} ry={3.2} fill="#000" opacity={0.2} />
          )}
          <g className="yo-av-figure">
            <g className="yo-av-body">
              <CupCatFigure avatar={avatar} rid={rid} eyes={eyeFor(state, "capsule", true)} detail={detail} />
            </g>
          </g>
          {state === "sleeping" && (
            <g fill="currentColor" fontFamily="inherit" fontWeight={700}>
              <text className="yo-av-z" x={80} y={16} fontSize={15}>
                z
              </text>
              <text className="yo-av-z yo-av-z2" x={86} y={7} fontSize={11}>
                z
              </text>
            </g>
          )}
        </svg>
      </>
    );
  }

  if (dimensional) {
    const gd = DIM_SHAPES[avatar.shape] ?? g;
    const m = materialFor(color.id, color.hex);
    const detail = detailFor(size);
    const headset = avatar.accessory === "headset";
    return (
      <>
        <AvatarStyles />
        <svg
          className={classes}
          width={size}
          height={size}
          viewBox="0 0 100 100"
          role="img"
          aria-label={title ?? "avatar"}
          data-state={state}
          data-finish="dimensional"
          style={{ ...style, ["--yo-av-d" as string]: delay }}
        >
          <defs>
            <DimDefs g={gd} m={m} rid={rid} detail={detail} />
          </defs>
          <circle
            className="yo-av-ring"
            cx={50}
            cy={52}
            r={47}
            fill="none"
            stroke="#E9C46A"
            strokeWidth={3.2}
          />
          {(ground || detail === "hero") && <DimGround rid={rid} g={gd} />}
          <g className="yo-av-figure">
            <g className="yo-av-body">
              {/* A small, fixed curious tilt carries the character; motion stays in the eyes. */}
              <g transform="rotate(-3 50 60)">
                {headset && <DimHeadsetBack g={gd} detail={detail} />}
                <DimBody g={gd} m={m} rid={rid} detail={detail} />
                {gd.detail && <path d={gd.detail} fill={m.shade} opacity={0.35} />}
                <DimEyes g={gd} kind={eyes} detail={detail} />
                {headset ? (
                  <DimHeadsetFront g={gd} rid={rid} detail={detail} />
                ) : (
                  <Accessory id={avatar.accessory} g={gd} />
                )}
              </g>
            </g>
          </g>
          {state === "sleeping" && (
            <g fill="currentColor" fontFamily="inherit" fontWeight={700}>
              <text className="yo-av-z" x={78} y={gd.top + 8} fontSize={15}>
                z
              </text>
              <text className="yo-av-z yo-av-z2" x={84} y={gd.top - 2} fontSize={11}>
                z
              </text>
            </g>
          )}
        </svg>
      </>
    );
  }

  return (
    <>
      <AvatarStyles />
      <svg
        className={classes}
        width={size}
        height={size}
        viewBox="0 0 100 100"
        role="img"
        aria-label={title ?? "avatar"}
        data-state={state}
        style={{ ...style, ["--yo-av-d" as string]: delay }}
      >
        <defs>
          <clipPath id={`c${rid}`}>
            {avatar.image ? <path d={IMAGE_CLIP} /> : g.paths.map((d, i) => <path key={i} d={d} />)}
          </clipPath>
          <radialGradient id={`h${rid}`} cx="30%" cy="18%" r="75%">
            <stop offset="0" stopColor="#fff" stopOpacity={0.34} />
            <stop offset="0.55" stopColor="#fff" stopOpacity={0.04} />
            <stop offset="1" stopColor="#fff" stopOpacity={0} />
          </radialGradient>
          <linearGradient id={`s${rid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.55" stopColor="#000" stopOpacity={0} />
            <stop offset="1" stopColor="#000" stopOpacity={0.16} />
          </linearGradient>
        </defs>

        <circle
          className="yo-av-ring"
          cx={50}
          cy={52}
          r={47}
          fill="none"
          stroke="#E9C46A"
          strokeWidth={3.2}
        />
        {ground && (
          <ellipse className="yo-av-shadow" cx={50} cy={96} rx={26} ry={3.2} fill="#000" opacity={0.28} />
        )}

        <g className="yo-av-figure">
          <g className="yo-av-body">
            {avatar.image ? (
              <g>
                <path d={IMAGE_CLIP} fill={color.hex} />
                <image
                  href={avatar.image}
                  x={4}
                  y={4}
                  width={92}
                  height={92}
                  preserveAspectRatio="xMidYMid slice"
                  clipPath={`url(#c${rid})`}
                />
              </g>
            ) : (
              <>
                <g fill={color.hex}>
                  {g.paths.map((d, i) => (
                    <path key={i} d={d} />
                  ))}
                </g>
                <g clipPath={`url(#c${rid})`}>
                  <rect x={0} y={0} width={100} height={100} fill={`url(#h${rid})`} />
                  <rect x={0} y={0} width={100} height={100} fill={`url(#s${rid})`} />
                </g>
                {g.detail && <path d={g.detail} fill={color.eye} opacity={0.22} />}
                <Eyes kind={eyes} x={g.face.x} y={g.face.y} dx={g.eyeDx} color={color.eye} />
                <Accessory id={avatar.accessory} g={g} />
              </>
            )}
          </g>
        </g>

        {state === "sleeping" && (
          <g fill="currentColor" fontFamily="inherit" fontWeight={700} opacity={0.75}>
            <text className="yo-av-z" x={78} y={g.top + 8} fontSize={15}>
              z
            </text>
            <text className="yo-av-z yo-av-z2" x={84} y={g.top - 2} fontSize={11}>
              z
            </text>
          </g>
        )}
      </svg>
    </>
  );
}
