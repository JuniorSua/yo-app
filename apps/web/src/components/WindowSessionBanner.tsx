/**
 * While Yo has an approved window session on this Mac (R3): who is using which window, until when, and a
 * Stop that ends it at once. Shown at the top of the app and in Settings → Devices & access. Desktop app
 * only (the lease lives on the Mac); the Mac also shows its own always-on-top banner and menu bar item.
 */
import { AppWindow, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import { errorText, stopWindowLease, useWindowLease } from "../stores/device";
import { Button } from "./ui/button";
import { Spinner } from "./ui/controls";

export const STOP_SHORTCUT = "⌃⌥⌘.";

function endsText(expiresAt: number, now: number) {
  const ms = expiresAt - now;
  if (ms < 60_000) return "ends in under a minute";
  return `ends in ${Math.round(ms / 60_000)} min`;
}

function useNow(everyMs: number, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs, active]);
  return now;
}

export function WindowSessionBanner({ variant = "global" }: { variant?: "global" | "inline" }) {
  const lease = useWindowLease();
  const now = useNow(15_000, !!lease);
  const [busy, setBusy] = useState(false);
  if (!lease || lease.expiresAt <= now) return null;

  const stop = async () => {
    setBusy(true);
    try {
      await stopWindowLease();
    } catch (e) {
      toast.error(`Couldn't stop the window session: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const global = variant === "global";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={global ? "window-session-banner" : "window-session-strip"}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-warning/40 bg-warning/[0.08] text-sm",
        global ? "border-b px-4 py-2" : "rounded-[14px] border px-4 py-3",
      )}
    >
      <span className="relative grid size-6 shrink-0 place-items-center rounded-lg bg-warning/15 text-warning">
        <AppWindow className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate">
          <span className="font-medium" data-testid="window-session-text">
            Yo is {lease.control ? "using" : "looking at"} “{lease.title}”
          </span>
          <span className="text-fg-2"> · {endsText(lease.expiresAt, now)}</span>
        </div>
        {!global && (
          <div className="text-muted text-xs">
            Only this window. Stop here, in the banner or menu bar on your Mac, or press{" "}
            <kbd className="font-sans">{STOP_SHORTCUT}</kbd>
          </div>
        )}
      </div>
      {global && (
        <span className="hidden text-muted text-xs sm:inline">
          or press <kbd className="font-sans">{STOP_SHORTCUT}</kbd>
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        data-testid="window-session-stop"
        aria-label={`Stop Yo using “${lease.title}”`}
        disabled={busy}
        onClick={() => void stop()}
        className="border-danger/70 text-danger hover:bg-danger/10 hover:text-danger"
      >
        {busy ? <Spinner /> : <Square className="size-3 fill-current" aria-hidden />}
        Stop
      </Button>
    </div>
  );
}
