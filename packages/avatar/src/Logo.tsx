import type { AgentActivity } from "@yo/contracts";
import { type CSSProperties, useId } from "react";
import { AvatarStyles } from "./Avatar";
import { YO_YELLOW } from "./colors";
import { BUBBLE_BODY, BUBBLE_TAIL } from "./geometry";

export const LOGO_EYE = "#0B0C0E";

/**
 * Logo finishes. "satin" = 04 Sunlit Satin (the brand mark): golden radial shading, a broad soft highlight
 * and a warm drop shadow over the exact original bubble + eye geometry. "flat" = the original mark.
 */
export type LogoFinish = "satin" | "flat";

/** Below this size gradients stop reading; the flat mark is crisper. */
const SATIN_MIN_SIZE = 18;

export const SUNLIT_SATIN = {
  stops: ["#FFF19A", "#FFD43B", "#F9BD24", "#CF8615"],
  shadow: "#754516",
} as const;

export interface YoLogoProps {
  size?: number;
  animated?: boolean;
  /** Defaults to "satin" (falls back to flat below 18px). */
  finish?: LogoFinish;
  /** idle = blink, working = eyes scan, waiting = looks up. */
  state?: AgentActivity;
  className?: string;
  style?: CSSProperties;
}

/** The Yo mark: a soft squircle speech bubble in Yo Yellow with two capsule eyes. */
export function YoLogo({
  size = 28,
  animated = false,
  state = "idle",
  finish = "satin",
  className,
  style,
}: YoLogoProps) {
  const rid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const satin = finish === "satin" && size >= SATIN_MIN_SIZE;
  const fill = satin ? `url(#lf${rid})` : YO_YELLOW;
  const cls = ["yo-av", `yo-av--${state}`, animated ? "yo-av--anim" : "", "yo-logo", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <AvatarStyles />
      <svg
        className={cls}
        width={size}
        height={size}
        viewBox="0 0 100 100"
        role="img"
        aria-label="Yo"
        style={style}
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
        {satin && (
          <defs>
            <radialGradient id={`lf${rid}`} gradientUnits="userSpaceOnUse" cx={28} cy={15} r={85}>
              <stop stopColor={SUNLIT_SATIN.stops[0]} />
              <stop offset=".38" stopColor={SUNLIT_SATIN.stops[1]} />
              <stop offset=".75" stopColor={SUNLIT_SATIN.stops[2]} />
              <stop offset="1" stopColor={SUNLIT_SATIN.stops[3]} />
            </radialGradient>
            <radialGradient id={`ls${rid}`} gradientUnits="userSpaceOnUse" cx={30} cy={5} r={70}>
              <stop stopColor="#fff" stopOpacity={0.75} />
              <stop offset=".65" stopColor="#fff" stopOpacity={0} />
            </radialGradient>
            <clipPath id={`lc${rid}`}>
              <path d={BUBBLE_BODY} />
              <path d={BUBBLE_TAIL} />
            </clipPath>
            <filter id={`lh${rid}`} x="-30%" y="-25%" width="170%" height="170%">
              <feDropShadow
                dx="1"
                dy="3"
                stdDeviation="2"
                floodColor={SUNLIT_SATIN.shadow}
                floodOpacity=".24"
              />
            </filter>
          </defs>
        )}
        <g className="yo-av-figure">
          <g className="yo-av-body" filter={satin ? `url(#lh${rid})` : undefined}>
            <path d={BUBBLE_BODY} fill={fill} />
            <path d={BUBBLE_TAIL} fill={fill} />
            {satin && (
              <g clipPath={`url(#lc${rid})`} opacity={0.55}>
                <rect width={100} height={100} fill={`url(#ls${rid})`} />
              </g>
            )}
            <g className="yo-av-look">
              <g className="yo-av-blink">
                <rect x={35.2} y={37.6} width={9.2} height={17} rx={4.6} fill={LOGO_EYE} />
                <rect x={57.6} y={37.6} width={9.2} height={17} rx={4.6} fill={LOGO_EYE} />
              </g>
            </g>
          </g>
        </g>
      </svg>
    </>
  );
}

export interface YoWordmarkProps {
  size?: number;
  finish?: LogoFinish;
  animated?: boolean;
  state?: AgentActivity;
  className?: string;
}

/** Logo mark + lowercase "yo" in Geist Bold. Text inherits currentColor. */
export function YoWordmark({ size = 24, animated = false, state, finish, className }: YoWordmarkProps) {
  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: size * 0.28, lineHeight: 1 }}
    >
      <YoLogo size={size} animated={animated} state={state} finish={finish} />
      <span
        style={{
          fontWeight: 700,
          fontSize: size * 0.92,
          letterSpacing: "-0.045em",
          transform: `translateY(-${size * 0.04}px)`,
        }}
      >
        yo
      </span>
    </span>
  );
}
