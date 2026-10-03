import type { AgentActivity, Avatar as AvatarData, CreatureKind } from "@yo/contracts";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cachedStill, creatureEngine, type LiveSlot, stillPicture } from "./engine";
import type { CreaturePose } from "./meta";
import { creatureState, snapshotPx, type TurnInfo } from "./state";
import { CREATURE_CSS } from "./styles";

export interface CreatureAvatarProps {
  avatar: AvatarData & { creature: NonNullable<AvatarData["creature"]> };
  size?: number;
  state?: AgentActivity;
  /** The agent's current turn, when known: decides "thinking" vs "working". */
  turn?: TurnInfo;
  /** Ask for the live canvas (the agent you're viewing). Otherwise a cached still picture of the pose. */
  live?: boolean;
  animated?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
  /** Shown while loading and if the creature can't be drawn (no WebGL, lost context). */
  fallback: ReactNode;
}

function seedFrom(s: string) {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 100;
}

const dpr = () => Math.min(2, Math.max(1, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const q = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** A shared cached picture for (creature, pose, size). */
function StillCreature({
  kind,
  pose,
  size,
  onFail,
  pending,
}: {
  kind: CreatureKind;
  pose: CreaturePose;
  size: number;
  onFail(): void;
  pending: ReactNode;
}) {
  const px = snapshotPx(size, dpr());
  const [url, setUrl] = useState(() => cachedStill(kind, pose, px));
  const fail = useRef(onFail);
  fail.current = onFail;
  useEffect(() => {
    const ready = cachedStill(kind, pose, px);
    if (ready) {
      setUrl(ready);
      return;
    }
    let alive = true;
    stillPicture(kind, pose, px).then(
      (u) => {
        if (alive) setUrl(u);
      },
      () => {
        if (alive) fail.current();
      },
    );
    return () => {
      alive = false;
    };
  }, [kind, pose, px]);
  // Until the first picture of this creature exists, keep the previous one (or the drawn look).
  if (!url) return <>{pending}</>;
  return <img src={url} alt="" draggable={false} data-still={pose} />;
}

/**
 * Asks the engine for the live canvas. The largest live avatar on screen gets it; the others (and this one
 * until it's granted) show the still picture.
 */
function LiveCreature({
  kind,
  pose,
  size,
  still,
  onFail,
  pending,
}: {
  kind: CreatureKind;
  pose: CreaturePose;
  size: number;
  still: boolean;
  onFail(): void;
  pending: ReactNode;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const slot = useRef<LiveSlot | null>(null);
  const id = useId();
  const [granted, setGranted] = useState(false);
  const fail = useRef(onFail);
  fail.current = onFail;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let engine: ReturnType<typeof creatureEngine>;
    try {
      engine = creatureEngine();
    } catch {
      fail.current();
      return;
    }
    const s: LiveSlot = {
      host: el,
      kind,
      pose,
      size,
      visible: true,
      still,
      seed: seedFrom(id),
      setLive: setGranted,
      onFail: () => fail.current(),
    };
    slot.current = s;
    engine.add(s);
    const io =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([e]) => {
            s.visible = !!e?.isIntersecting;
            engine.update(s);
          })
        : null;
    io?.observe(el);
    return () => {
      io?.disconnect();
      engine.remove(s);
      slot.current = null;
    };
    // One slot per element; prop changes are synced below.
  }, []);

  useEffect(() => {
    const s = slot.current;
    if (!s) return;
    Object.assign(s, { kind, pose, size, still });
    try {
      creatureEngine().update(s);
    } catch {
      fail.current();
    }
  }, [kind, pose, size, still]);

  return (
    <>
      {/* The engine moves its canvas in here while this avatar holds it. */}
      <span ref={host} className="yo-cr-host" data-live={granted ? "" : undefined} />
      {!granted && <StillCreature kind={kind} pose={pose} size={size} onFail={onFail} pending={pending} />}
    </>
  );
}

/** Sprout, Pebble or Mimi, posed from the agent's activity (see state.ts). Loaded on demand. */
export function CreatureAvatar({
  avatar,
  size = 32,
  state = "idle",
  turn,
  live = false,
  animated = true,
  className,
  style,
  title,
  fallback,
}: CreatureAvatarProps) {
  const kind = avatar.creature.kind;
  const view = creatureState(state, turn);
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  const fail = () => setFailed(true);
  return (
    <span
      className={["yo-cr", className].filter(Boolean).join(" ")}
      role="img"
      aria-label={title ?? "avatar"}
      data-creature={kind}
      data-state={state}
      data-pose={view.pose}
      data-glow={view.glow ? "" : undefined}
      data-error={view.error ? "" : undefined}
      style={{ width: size, height: size, ...style }}
    >
      <style href="yo-creature-styles" precedence="low">
        {CREATURE_CSS}
      </style>
      {live ? (
        <LiveCreature
          kind={kind}
          pose={view.pose}
          size={size}
          still={!animated || reduced}
          onFail={fail}
          pending={fallback}
        />
      ) : (
        <StillCreature kind={kind} pose={view.pose} size={size} onFail={fail} pending={fallback} />
      )}
      {view.error && <span className="yo-cr-badge" aria-hidden />}
    </span>
  );
}

export default CreatureAvatar;
