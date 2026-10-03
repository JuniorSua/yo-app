import { useEffect, useRef, useState } from "react";
import { type CreatureId, type CreatureState, createCreatureScene } from "./creatures";

export function CreatureCanvas({
  id,
  background,
  state,
  headset,
  paused,
  miniature = false,
}: {
  id: CreatureId;
  background: string;
  state: CreatureState;
  headset: boolean;
  paused: boolean;
  miniature?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const settings = useRef({ state, headset, paused });
  settings.current = { state, headset, paused };
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = canvas.current!;
    let scene: ReturnType<typeof createCreatureScene>;
    try {
      scene = createCreatureScene(element, id, background);
    } catch {
      setFailed(true);
      return;
    }
    let pointer = 0;
    let smoothPointer = 0;
    let time = id === "sprout" ? 0 : id === "pebble" ? 1.7 : 3.4;
    let last = performance.now();
    let frame = 0;
    let visible = true;
    let dirty = true;
    let previousSettings = "";
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const resize = new ResizeObserver(([entry]) => {
      if (entry) {
        scene.resize(entry.contentRect.width, entry.contentRect.height);
        dirty = true;
      }
    });
    resize.observe(element);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      dirty = true;
    });
    intersection.observe(element);
    const move = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      pointer = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    };
    const leave = () => {
      pointer = 0;
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", leave);
    const exportFrame = () => {
      const opts = settings.current;
      scene.render(time, opts.state, smoothPointer, opts.headset);
    };
    element.addEventListener("creature-export", exportFrame);
    const tick = (now: number) => {
      const delta = Math.min((now - last) / 1000, 1);
      last = now;
      const opts = settings.current;
      if (!opts.paused && !reduced.matches && visible && !document.hidden) time += delta;
      smoothPointer += ((reduced.matches || opts.paused ? 0 : pointer) - smoothPointer) * 0.06;
      const signature = `${opts.state}-${opts.headset}-${opts.paused}-${reduced.matches}`;
      const moving = !opts.paused && !reduced.matches;
      if (visible && !document.hidden && (moving || dirty || signature !== previousSettings)) {
        scene.render(time, opts.state, smoothPointer, opts.headset);
        dirty = false;
        previousSettings = signature;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("creature-export", exportFrame);
      scene.dispose();
    };
  }, [id, background]);
  if (failed)
    return <div className="cl-render-error">3D preview unavailable. Try a browser with WebGL enabled.</div>;
  return (
    <canvas
      key={`${id}-${background}`}
      className={miniature ? "cl-canvas cl-canvas-mini" : "cl-canvas"}
      ref={canvas}
      data-creature={id}
      role="img"
      aria-label={`${id}, a 3D creature agent, ${state}${headset ? " with a headset" : ""}`}
    />
  );
}
