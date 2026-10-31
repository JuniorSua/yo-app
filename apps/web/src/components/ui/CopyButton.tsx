import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/utils";

/** How long "Copied" stays up. */
export const COPIED_MS = 1500;

/**
 * A small Copy button that flips to a green "Copied" check for a moment. `text` may be a function so callers
 * can read the text at click time (a rendered code block).
 */
export function CopyButton({
  text,
  label = "Copy",
  showLabel = true,
  className,
  testId,
}: {
  text: string | (() => string);
  /** Accessible name, e.g. "Copy reply". */
  label?: string;
  showLabel?: boolean;
  className?: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = async () => {
    const ok = await copyText(typeof text === "function" ? text() : text);
    if (!ok) {
      toast.error("Couldn't copy. Select the text and copy it yourself.");
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      data-testid={testId}
      data-copied={copied || undefined}
      className={cn(
        "inline-flex h-6 shrink-0 select-none items-center gap-1 rounded-md px-1.5 font-medium text-xs outline-none transition-[background-color,color,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-link/60",
        copied ? "bg-success/14 text-success" : "text-muted hover:bg-hover hover:text-fg",
        className,
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {showLabel && <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>}
    </button>
  );
}
