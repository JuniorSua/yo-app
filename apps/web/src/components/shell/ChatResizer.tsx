import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { CHAT_MIN, chatMax, chatWidthAfterKey, chatWidthCss, clampChat } from "../../lib/chatWidth";
import { cn } from "../../lib/utils";
import { useUI } from "../../stores/ui";

/**
 * The edge between the chat and the workspace. Drag it to make the chat wider or narrower, or focus it and use the
 * arrow keys (Shift for bigger steps), Home and End. A double-click or Enter puts the default back. The width is
 * remembered (ui store).
 *
 * It renders last in the split, so in the Mac app its no-drag wins over the drag areas it overlaps (the chat's top
 * and the tab strip). While dragging, the width is written straight to the split's `--chat-w` (no re-render per
 * frame) and saved when the pointer lets go.
 */
export function ChatResizer() {
  const ref = useRef<HTMLDivElement>(null);
  // The chat column's real width (for aria-valuenow), and the widest it may be in this window.
  const [width, setWidth] = useState(0);
  const [max, setMax] = useState(() => chatMax(window.innerWidth));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; start: number; width: number; moved: boolean; frame: number } | null>(
    null,
  );

  const split = () => ref.current?.parentElement ?? null;
  const column = () => split()?.querySelector<HTMLElement>(":scope > .chat-column") ?? null;

  useEffect(() => {
    const host = split();
    const col = column();
    if (!host || !col) return;
    const measure = () => setWidth(Math.round(col.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(col);
    const onResize = () => setMax(chatMax(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      // Closed mid-drag (⌘\): don't leave the split unclickable.
      if (drag.current) cancelAnimationFrame(drag.current.frame);
      host.removeAttribute("data-resizing");
    };
  }, []);

  const save = (w: number | null) => useUI.setState({ chatWidth: w });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const col = column();
    if (e.button !== 0 || !col) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = col.getBoundingClientRect().width;
    drag.current = { x: e.clientX, start, width: start, moved: false, frame: 0 };
    split()?.setAttribute("data-resizing", "");
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.width = clampChat(d.start + e.clientX - d.x, window.innerWidth);
    d.moved ||= Math.abs(e.clientX - d.x) >= 2;
    if (d.frame || !d.moved) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      split()?.style.setProperty("--chat-w", chatWidthCss(d.width));
    });
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    cancelAnimationFrame(d.frame);
    drag.current = null;
    split()?.removeAttribute("data-resizing");
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    // A plain click (or the first half of a double-click) changes nothing.
    if (d.moved) save(d.width);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save(null);
      return;
    }
    const current = width || column()?.getBoundingClientRect().width || CHAT_MIN;
    const next = chatWidthAfterKey(e.key, e.shiftKey, current, window.innerWidth);
    if (next === null) return;
    e.preventDefault();
    save(next);
  };

  return (
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Chat width"
      aria-controls="chat-column"
      aria-valuemin={CHAT_MIN}
      aria-valuemax={max}
      aria-valuenow={width || undefined}
      title="Drag to resize · double-click to reset"
      data-testid="chat-resizer"
      className={cn("chat-resizer", dragging && "is-dragging")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onDoubleClick={() => save(null)}
      onKeyDown={onKeyDown}
    />
  );
}
