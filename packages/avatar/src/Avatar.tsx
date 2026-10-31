import type { AgentActivity, Avatar as AvatarData } from "@yo/contracts";
import { type CSSProperties, useId } from "react";
import { colorById } from "./colors";
import { superellipsePath } from "./geometry";
import { softieOf } from "./softies/legacy";
import { BadgeCutout, badgeFor, Softie, SoftieBadge, softieLevel } from "./softies/Softie";
import { softieState, type TurnInfo } from "./softies/state";

export interface AvatarProps {
  avatar: AvatarData;
  /** Rendered size in px (square). */
  size?: number;
  state?: AgentActivity;
  /** The agent's current turn, when known: a working agent that's reasoning shows "thinking". */
  turn?: TurnInfo;
  /** The main agent (Yo): an older avatar that predates Softies shows as Yo. */
  primary?: boolean;
  /** Disable all motion (still frame). */
  animated?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

const IMAGE_CLIP = superellipsePath(50, 50, 46, 46, 4.4);

/** An uploaded photo, clipped to a soft squircle, with the same status badges as a Softie. */
function PhotoAvatar({
  avatar,
  size,
  state,
  className,
  style,
  title,
}: Required<Pick<AvatarProps, "size">> & Omit<AvatarProps, "size" | "turn" | "primary" | "animated">) {
  const id = `ph${useId().replace(/[^a-zA-Z0-9]/g, "")}_`;
  const lvl = softieLevel(size);
  const badge = badgeFor(softieState(state ?? "idle"), lvl);
  const photo = (
    <g>
      <path d={IMAGE_CLIP} fill={colorById(avatar.color).hex} />
      <image
        href={avatar.image}
        x={4}
        y={4}
        width={92}
        height={92}
        preserveAspectRatio="xMidYMid slice"
        clipPath={`url(#${id}c)`}
      />
    </g>
  );
  return (
    <svg
      className={["sf sf--photo", className ?? ""].filter(Boolean).join(" ")}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      overflow="visible"
      role="img"
      aria-label={title ?? "avatar"}
      data-state={state}
      style={style}
    >
      <defs>
        <clipPath id={`${id}c`}>
          <path d={IMAGE_CLIP} />
        </clipPath>
        {badge && <BadgeCutout id={id} lvl={lvl} />}
      </defs>
      {badge ? <g mask={`url(#${id}m)`}>{photo}</g> : photo}
      {badge && <SoftieBadge state={badge} lvl={lvl} id={id} spin="#fff" />}
    </svg>
  );
}

/** An agent's avatar: its Softie (older avatars map to one, see softies/legacy.ts), or its uploaded photo. */
export function Avatar({
  avatar,
  size = 32,
  state = "idle",
  turn,
  primary,
  animated = true,
  className,
  style,
  title,
}: AvatarProps) {
  if (avatar.image)
    return (
      <PhotoAvatar
        avatar={avatar}
        size={size}
        state={state}
        className={className}
        style={style}
        title={title}
      />
    );
  const look = softieOf(avatar, { primary });
  return (
    <Softie
      kind={look.kind}
      color={look.color}
      size={size}
      state={softieState(state, turn)}
      animated={animated}
      className={className}
      style={style}
      title={title}
    />
  );
}
