import { X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { cn } from "../../lib/utils";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A draggable, resizable glass window used for Terminal / Files over the computer screen. */
export function FloatingWindow({
  title,
  icon,
  initial,
  onClose,
  onFocus,
  z,
  children,
  testId,
}: {
  title: ReactNode;
  icon?: ReactNode;
  initial: Rect;
  onClose: () => void;
  onFocus: () => void;
  z: number;
  children: ReactNode;
  testId?: string;
}) {
  const [rect, setRect] = useState<Rect>(initial);
  const drag = useRef<{ sx: number; sy: number; r: Rect; mode: "move" | "resize" } | null>(null);

  const onPointerDown = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button") && mode === "move") return;
    e.preventDefault();
    onFocus();
    drag.current = { sx: e.clientX, sy: e.clientY, r: rect, mode };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === "move") {
      setRect({
        ...d.r,
        x: Math.min(window.innerWidth - 80, Math.max(-d.r.w + 80, d.r.x + dx)),
        y: Math.min(window.innerHeight - 40, Math.max(0, d.r.y + dy)),
      });
    } else {
      setRect({ ...d.r, w: Math.max(320, d.r.w + dx), h: Math.max(200, d.r.h + dy) });
    }
  };
  const end = () => {
    drag.current = null;
  };

  return (
    <div
      data-testid={testId}
      onPointerDownCapture={onFocus}
      className="fixed flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#141518]/92 text-[#ECECEE] shadow-[0_30px_80px_-10px_rgba(0,0,0,0.7)] backdrop-blur-2xl animate-pop"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: z }}
    >
      <div
        onPointerDown={onPointerDown("move")}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        className="flex h-10 shrink-0 cursor-grab select-none items-center gap-2 border-white/[0.06] border-b px-3 active:cursor-grabbing"
      >
        <button
          aria-label="Close window"
          onClick={onClose}
          className="group grid size-3 place-items-center rounded-full bg-[#ff5f57]"
        >
          <X className="size-2 text-black/70 opacity-0 group-hover:opacity-100" strokeWidth={3} />
        </button>
        <span className="size-3 rounded-full bg-white/12" />
        <span className="size-3 rounded-full bg-white/12" />
        <div className="flex flex-1 items-center justify-center gap-2 pr-12 font-medium text-[#bdbdc2] text-sm">
          {icon}
          {title}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
      <div
        onPointerDown={onPointerDown("resize")}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        className={cn("absolute right-0 bottom-0 size-4 cursor-nwse-resize")}
        aria-hidden
      />
    </div>
  );
}
