import { Download, Maximize, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DialogClose, DialogTitle, Modal, Tip } from "../ui/overlay";

const MAX_ZOOM = 8; // × the picture's real size
const STEP = 1.25;
const TOOLBAR = 48; // header height, px
const PAD = 40; // room around the picture inside the frame, px (both sides together)
const HINT =
  "Pinch or ⌘ + scroll to zoom · double-click to zoom in or back to fit · drag to move · + − 0 1 keys";

type Anchor = { x: number; y: number };
type Size = { w: number; h: number };

/**
 * Size the viewer frame to the picture: no bigger than its real size, and always inside the window with room
 * around it, so the macOS traffic lights and the app behind stay visible.
 */
function frameSize(natural: Size | null, vw: number, vh: number) {
  const maxW = Math.max(320, Math.min(vw - 128, 1680));
  const maxH = Math.max(240, vh - 128);
  if (!natural) return { width: Math.min(maxW, 960), height: Math.min(maxH, 640) };
  const s = Math.min(1, (maxW - PAD) / natural.w, (maxH - TOOLBAR - PAD) / natural.h);
  return {
    width: Math.round(Math.min(maxW, Math.max(Math.min(maxW, 560), natural.w * s + PAD))),
    height: Math.round(Math.min(maxH, Math.max(Math.min(maxH, 320), natural.h * s + PAD + TOOLBAR))),
  };
}

function useViewport() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/**
 * Picture viewer with zoom: pinch or ⌘/Ctrl + scroll zooms at the pointer, double-click toggles
 * fit ↔ close-up, +/−/0/1 keys, and drag or scroll to move around a zoomed picture.
 */
export function ImageViewer({
  open,
  onOpenChange,
  url,
  label,
  download,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  label: string;
  download?: string | null;
}) {
  const [natural, setNatural] = useState<Size | null>(null);
  const viewport = useViewport();

  // Read the picture's size before the frame paints (it's usually cached from the chat thumbnail), so the
  // frame opens at its final size instead of jumping.
  useLayoutEffect(() => {
    if (!open) return;
    const img = new Image();
    const done = () => img.naturalWidth && setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    img.onload = done;
    img.src = url;
    if (img.complete) done();
    return () => {
      img.onload = null;
    };
  }, [open, url]);

  const frame = frameSize(natural, viewport.w, viewport.h);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      bare
      testId="image-viewer"
      className="flex max-h-none max-w-none flex-col rounded-[20px] bg-card transition-[opacity,transform,width,height]"
      style={{ width: frame.width, height: frame.height }}
    >
      {open && (
        <ZoomView url={url} label={label} download={download} natural={natural} onNatural={setNatural} />
      )}
    </Modal>
  );
}

function ZoomView({
  url,
  label,
  download,
  natural,
  onNatural,
}: {
  url: string;
  label: string;
  download?: string | null;
  natural: Size | null;
  onNatural: (size: Size) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const [scale, setScale] = useState<number | null>(null); // null = fit to window
  const pending = useRef<{ anchor: Anchor; point: Anchor } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const current = scale ?? fit;
  const minZoom = Math.min(fit, 1) * 0.5;

  // Fit scale follows the window size.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !natural) return;
    const update = () => {
      const pad = PAD;
      setFit(Math.min((el.clientWidth - pad) / natural.w, (el.clientHeight - pad) / natural.h));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [natural]);

  /** Zoom to `next`, keeping the picture point under `anchor` (box coordinates) in place. */
  const zoomTo = useCallback(
    (next: number, anchor?: Anchor) => {
      const el = box.current;
      if (!el || !natural) return;
      const clamped = Math.min(MAX_ZOOM, Math.max(minZoom, next));
      const a = anchor ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
      const img = el.querySelector("img")!;
      const r = img.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      // Point on the picture (in real pixels) currently under the anchor.
      const point = {
        x: Math.min(natural.w, Math.max(0, (b.left + a.x - r.left) / current)),
        y: Math.min(natural.h, Math.max(0, (b.top + a.y - r.top) / current)),
      };
      pending.current = { anchor: a, point };
      setScale(Math.abs(clamped - fit) < 0.001 ? null : clamped);
    },
    [natural, current, fit, minZoom],
  );

  // After a zoom renders, scroll so the anchored point stays under the pointer.
  useLayoutEffect(() => {
    const el = box.current;
    const p = pending.current;
    if (!el || !p) return;
    pending.current = null;
    const img = el.querySelector("img")!;
    const r = img.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    el.scrollLeft += r.left - b.left + p.point.x * current - p.anchor.x;
    el.scrollTop += r.top - b.top + p.point.y * current - p.anchor.y;
  }, [current]);

  // Pinch (reported as ctrl+wheel) and ⌘/Ctrl + scroll zoom; plain scroll pans.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const b = el.getBoundingClientRect();
      zoomTo(current * Math.exp(-e.deltaY * 0.01), { x: e.clientX - b.left, y: e.clientY - b.top });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo, current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") zoomTo(current * STEP);
      else if (e.key === "-" || e.key === "_") zoomTo(current / STEP);
      else if (e.key === "0") setScale(null);
      else if (e.key === "1") zoomTo(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomTo, current]);

  const w = natural ? Math.round(natural.w * current) : undefined;
  const pct = Math.round(current * 100);
  const btn =
    "grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent";

  return (
    <>
      <div
        className="flex shrink-0 items-center gap-2 border-border border-b pr-2.5 pl-4"
        style={{ height: TOOLBAR }}
      >
        <DialogTitle className="min-w-0 flex-1 truncate font-medium text-base tracking-[-0.005em]">
          {label}
        </DialogTitle>
        <div className="flex items-center gap-0.5 rounded-[10px] bg-active/60 p-0.5">
          <Tip label="Zoom out" shortcut="−">
            <button
              aria-label="Zoom out"
              data-testid="zoom-out"
              className={btn}
              onClick={() => zoomTo(current / STEP)}
            >
              <Minus className="size-3.5" />
            </button>
          </Tip>
          <Tip label={scale === null ? "Real size" : "Fit to window"} shortcut={scale === null ? "1" : "0"}>
            <button
              data-testid="zoom-level"
              aria-label={`Zoom ${pct}%`}
              onClick={() => (scale === null ? zoomTo(1) : setScale(null))}
              className="h-7 min-w-12 rounded-lg px-1.5 text-fg-2 text-sm tabular-nums transition-colors hover:bg-hover hover:text-fg"
            >
              {pct}%
            </button>
          </Tip>
          <Tip label="Zoom in" shortcut="+">
            <button
              aria-label="Zoom in"
              data-testid="zoom-in"
              className={btn}
              onClick={() => zoomTo(current * STEP)}
            >
              <Plus className="size-3.5" />
            </button>
          </Tip>
          <Tip label="Fit to window" shortcut="0">
            <button
              aria-label="Fit to window"
              data-testid="zoom-fit"
              disabled={scale === null}
              className={btn}
              onClick={() => setScale(null)}
            >
              <Maximize className="size-3.5" />
            </button>
          </Tip>
        </div>
        {download && (
          <Tip label="Download">
            <a href={download} download aria-label="Download" className={`${btn} size-8`}>
              <Download className="size-4" />
            </a>
          </Tip>
        )}
        <Tip label="Close" shortcut="esc">
          <DialogClose aria-label="Close" className={`${btn} size-8`}>
            <X className="size-4" />
          </DialogClose>
        </Tip>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={box}
          data-testid="zoom-box"
          className={
            "absolute inset-0 overflow-auto bg-sidebar/70 " +
            (dragging ? "cursor-grabbing" : scale !== null && scale > fit ? "cursor-grab" : "cursor-zoom-in")
          }
          onPointerDown={(e) => {
            const el = box.current;
            if (!el || e.button !== 0) return;
            drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
          }}
          onPointerMove={(e) => {
            const el = box.current;
            const d = drag.current;
            if (!el || !d) return;
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (!dragging && Math.hypot(dx, dy) < 4) return;
            if (!dragging) {
              setDragging(true);
              el.setPointerCapture(e.pointerId);
            }
            el.scrollLeft = d.left - dx;
            el.scrollTop = d.top - dy;
          }}
          onPointerUp={() => {
            drag.current = null;
            setTimeout(() => setDragging(false), 0);
          }}
          onDoubleClick={(e) => {
            const b = box.current!.getBoundingClientRect();
            const anchor = { x: e.clientX - b.left, y: e.clientY - b.top };
            if (scale !== null && scale > fit * 1.05) setScale(null);
            else zoomTo(Math.max(1, fit * 2.5), anchor);
          }}
        >
          <div className="grid min-h-full min-w-full w-max place-items-center p-5">
            <img
              src={url}
              alt={label}
              draggable={false}
              onLoad={(e) => {
                const i = e.currentTarget;
                onNatural({ w: i.naturalWidth || 1, h: i.naturalHeight || 1 });
              }}
              style={w ? { width: w, maxWidth: "none" } : undefined}
              className="block select-none rounded-[10px] shadow-card ring-1 ring-black/5 dark:ring-white/5"
            />
          </div>
        </div>
        <div
          aria-hidden
          className="glass pointer-events-none absolute bottom-3 left-1/2 animate-[viewer-hint_4.5s_ease-out_forwards] whitespace-nowrap rounded-full border border-border-strong/50 px-3 py-1 text-muted text-xs opacity-0 shadow-soft"
        >
          {HINT}
        </div>
      </div>
    </>
  );
}
