import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { copyImage } from "../../lib/clipboard";
import { cn } from "../../lib/utils";
import { COPIED_MS } from "./CopyButton";

/** A small "Copy image" button: puts the picture itself on the clipboard, then shows a green check. */
export function CopyImageButton({
  url,
  className,
  testId,
}: {
  url: string;
  className?: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const ok = await copyImage(url);
    setBusy(false);
    if (!ok) {
      toast.error("Couldn't copy the picture. Open it and use Download instead.");
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  const label = copied ? "Copied" : "Copy image";
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={label}
      data-testid={testId}
      data-copied={copied || undefined}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg outline-none transition-[background-color,color,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-link/60",
        copied ? "bg-success/14 text-success" : "text-muted hover:bg-hover hover:text-fg",
        busy && "opacity-60",
        className,
      )}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </button>
  );
}
