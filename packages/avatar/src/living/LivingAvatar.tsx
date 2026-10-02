import type { AgentActivity, Avatar as AvatarData } from "@yo/contracts";
import { type CSSProperties, useEffect, useId, useRef } from "react";
import { type LivingSlot, livingEngine, OVER } from "./engine";
import { LivingMotion, livingMode } from "./motion";

export interface LivingAvatarProps {
  avatar: AvatarData & { living: NonNullable<AvatarData["living"]> };
  /** Box size in px (square). The animation can spill a little outside it. */
  size?: number;
  state?: AgentActivity;
  /** Decorative use (e.g. chat headers): calm awake eyes instead of the idle "asleep" look. */
  quiet?: boolean;
  animated?: boolean;
  /** Soft contact shadow under the body. */
  ground?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

function seedFrom(s: string) {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** A living character (original render + motion tied to the agent's state). */
export function LivingAvatar({
  avatar,
  size = 32,
  state = "idle",
  quiet = false,
  animated = true,
  ground,
  className,
  style,
  title,
}: LivingAvatarProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const slot = useRef<LivingSlot | null>(null);
  const id = useId();
  const mode = livingMode(state, quiet);
  const shadow = ground ?? size >= 26;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const engine = livingEngine();
    const s: LivingSlot = {
      canvas,
      size,
      living: avatar.living,
      motion: new LivingMotion(seedFrom(id), mode),
      visible: true,
      still: !animated,
      dirty: true,
      shadow,
      acc: 0,
      skip: 0,
      ink: "#888",
      inkAge: 0,
    };
    slot.current = s;
    engine.add(s);
    const io =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(
            ([e]) => {
              s.visible = !!e?.isIntersecting;
              if (s.visible) {
                s.dirty = true;
                engine.wake();
              }
            },
            { rootMargin: "40px" },
          )
        : null;
    io?.observe(canvas);
    return () => {
      io?.disconnect();
      engine.remove(s);
      slot.current = null;
    };
    // The slot lives as long as the element; props are synced by the effect below.
  }, []);

  useEffect(() => {
    const s = slot.current;
    if (!s) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(size * OVER * dpr);
    if (s.canvas.width !== px) {
      s.canvas.width = px;
      s.canvas.height = px;
    }
    if (s.living.character !== avatar.living.character) livingEngine().add(s);
    s.size = size;
    s.living = avatar.living;
    s.still = !animated;
    s.shadow = shadow;
    s.motion.setMode(mode);
    s.dirty = true;
    livingEngine().wake();
  }, [size, avatar.living, animated, mode, shadow]);

  const over = size * OVER;
  return (
    <span
      className={className}
      role="img"
      aria-label={title ?? "avatar"}
      data-living={avatar.living.character}
      data-state={state}
      style={{
        position: "relative",
        display: "inline-block",
        width: size,
        height: size,
        flex: "none",
        ...style,
      }}
    >
      <canvas
        ref={ref}
        aria-hidden
        style={{
          position: "absolute",
          left: (size - over) / 2,
          top: (size - over) / 2,
          width: over,
          height: over,
          pointerEvents: "none",
        }}
      />
    </span>
  );
}

export default LivingAvatar;
