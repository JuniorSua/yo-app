/**
 * The one small update notice (stores/updates.ts noticeKind): "Update ready", "Updating Yo…", "Update didn't
 * finish", or "Updated to Yo 2.0.N" for a few seconds after an update. It never sits on content:
 * - On a computer it takes the update button's place in the rail (UpdateButton renders RailUpdateNotice): a small
 *   tile with an icon and one word, the whole sentence on hover or focus.
 * - On phones, where the rail is a tab bar, it gets its own strip just above the tab bar; the chat and the pages
 *   make room for it (styles/dots.css, .update-notice-phone).
 * - Before the workspace exists (onboarding) it floats bottom-left.
 * A click opens the update window (after an update: What's new).
 */
import { AlertTriangle, ArrowDownToLine, Check, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { elapsedText } from "../lib/updates";
import { useNow } from "../lib/useNow";
import { cn } from "../lib/utils";
import { useApp } from "../stores/app";
import {
  currentOffer,
  DONE_NOTICE_MS,
  justUpdated,
  noticeKind,
  updates,
  useUpdates,
} from "../stores/updates";
import { useMedia } from "./agent/Presence";
import { Spinner } from "./ui/controls";
import { Tip } from "./ui/overlay";

/** Phones: the rail becomes a tab bar without the update button (styles/shell.css). */
export const PHONE_QUERY = "(max-width: 600px)";

/** The floating notice, only where the rail's update button isn't there to carry it (phones, onboarding). */
export function FloatingUpdateNotice() {
  const phone = useMedia(PHONE_QUERY);
  const workspace = useApp((s) => s.settings.onboarded);
  if (workspace && !phone) return null;
  return (
    <UpdateNotice
      className={cn(
        "fixed z-[45]",
        workspace
          ? "update-notice-phone bottom-[calc(90px+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2"
          : "bottom-4 left-4",
      )}
    />
  );
}

const PILL =
  "flex h-8 items-center gap-2 whitespace-nowrap rounded-full border border-border-strong/60 bg-elevated pr-3.5 pl-3 font-medium text-fg text-sm shadow-pop transition-colors";

export function UpdateNotice({ className }: { className?: string }) {
  const kind = useUpdates(noticeKind);
  if (!kind) return null;
  return (
    <div
      data-testid="update-notice"
      data-kind={kind}
      role="status"
      aria-live="polite"
      className={cn("animate-rise", className)}
    >
      {kind === "done" ? <Done /> : <Pill kind={kind} />}
    </div>
  );
}

function Pill({ kind }: { kind: "ready" | "updating" | "failed" }) {
  const download = useUpdates((s) => currentOffer(s) === "download");
  const startedAt = useUpdates((s) => s.applying?.startedAt ?? 0);
  const now = useNow(1000, kind === "updating");
  return (
    <button
      type="button"
      data-testid="update-notice-open"
      onClick={() => updates.open()}
      className={cn(PILL, "hover:bg-hover active:scale-[0.98] motion-reduce:active:scale-100")}
    >
      {kind === "ready" ? (
        <>
          <span className="size-2 shrink-0 rounded-full bg-brand" aria-hidden />
          {download ? "Update available" : "Update ready"}
        </>
      ) : kind === "updating" ? (
        <>
          <Spinner className="size-3.5 text-brand-ink" />
          Updating Yo…
          <span className="text-faint text-xs tabular-nums">{elapsedText(now - startedAt)}</span>
        </>
      ) : (
        <>
          <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden />
          Update didn't finish
        </>
      )}
    </button>
  );
}

/** "Updated to Yo 2.0.N · What's new", gone by itself after a few seconds (not while the pointer is on it). */
function Done() {
  const done = useUpdates(useShallow(justUpdated));
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const t = setTimeout(() => updates.dismissDone(), DONE_NOTICE_MS);
    return () => clearTimeout(t);
  }, [held]);
  if (!done) return null;
  return (
    <div
      className={cn(PILL, "pr-1.5")}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-success/15 text-success">
        <Check className="size-2.5" strokeWidth={3} aria-hidden />
      </span>
      <span data-testid="update-done-text">{doneText(done.version)}</span>
      {done.notes && (
        <>
          <span className="text-faint" aria-hidden>
            ·
          </span>
          <button
            type="button"
            data-testid="update-whatsnew"
            onClick={() => updates.openWhatsNew()}
            className="text-link-ink underline-offset-2 hover:underline"
          >
            What's new
          </button>
        </>
      )}
      <button
        type="button"
        data-testid="update-done-dismiss"
        aria-label="Dismiss"
        onClick={() => updates.dismissDone()}
        className="ml-0.5 grid size-6 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** "Updated to Yo 2.0.N", or the same without a version. */
function doneText(version?: string | null) {
  return version ? `Updated to Yo ${version}` : "Yo was updated";
}

const TILE =
  "flex w-11 flex-col items-center gap-[3px] rounded-[13px] pt-[7px] pb-[5px] font-medium text-[10px] leading-3 tabular-nums transition-[background-color,scale] active:scale-[0.96] motion-reduce:active:scale-100 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 [&_svg]:size-4 [&_svg]:shrink-0";

/**
 * The notice in the rail, in the update button's place: an icon and one word that fit the 52px rail, the whole
 * sentence in a tip on hover or focus. Ready is the one filled tile (it's the thing to act on); the rest are quiet.
 */
export function RailUpdateNotice() {
  const kind = useUpdates(noticeKind);
  if (!kind) return null;
  return (
    <div
      data-testid="update-notice"
      data-kind={kind}
      role="status"
      aria-live="polite"
      className="animate-rise"
    >
      {kind === "done" ? <DoneTile /> : <StateTile kind={kind} />}
    </div>
  );
}

function StateTile({ kind }: { kind: "ready" | "updating" | "failed" }) {
  const download = useUpdates((s) => currentOffer(s) === "download");
  const startedAt = useUpdates((s) => s.applying?.startedAt ?? 0);
  const now = useNow(1000, kind === "updating");
  const elapsed = elapsedText(now - startedAt);
  const [label, word, icon, tone]: [string, string, ReactNode, string] =
    kind === "ready"
      ? [
          download ? "Update available" : "Update ready",
          "Update",
          <ArrowDownToLine key="i" strokeWidth={2} />,
          "bg-brand text-brand-fg hover:opacity-90",
        ]
      : kind === "updating"
        ? [`Updating Yo… ${elapsed}`, elapsed, <Spinner key="i" />, "bg-active text-fg hover:bg-hover"]
        : [
            "Update didn't finish",
            "Update",
            <AlertTriangle key="i" strokeWidth={2} />,
            "bg-warning/12 text-warning hover:bg-warning/18",
          ];
  return (
    <Tip label={label} side="right">
      <button
        type="button"
        data-testid="update-notice-open"
        aria-label={label}
        onClick={() => updates.open()}
        className={cn(TILE, tone)}
      >
        {icon}
        <span aria-hidden>{word}</span>
      </button>
    </Tip>
  );
}

/** "Updated": gone by itself after a few seconds (not while the pointer or focus is on it); a click shows What's new. */
function DoneTile() {
  const done = useUpdates(useShallow(justUpdated));
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const t = setTimeout(() => updates.dismissDone(), DONE_NOTICE_MS);
    return () => clearTimeout(t);
  }, [held]);
  if (!done) return null;
  const text = doneText(done.version);
  const label = done.notes ? `${text} · What's new` : text;
  return (
    <Tip label={label} side="right">
      <button
        type="button"
        data-testid={done.notes ? "update-whatsnew" : "update-done-open"}
        aria-label={label}
        onClick={() => (done.notes ? updates.openWhatsNew() : updates.dismissDone())}
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={() => setHeld(false)}
        className={cn(TILE, "bg-success/12 text-success hover:bg-success/18")}
      >
        <Check strokeWidth={2.4} />
        <span data-testid="update-done-text" data-version={done.version ?? ""} aria-hidden>
          Updated
        </span>
      </button>
    </Tip>
  );
}
