/**
 * The "update window": a small card that asks (Refresh / Restart, or Later) and, after Later, a quiet pill
 * that stays until the update is applied. Lives at the bottom of the sidebar; floats bottom-left when the
 * sidebar is hidden. Never blocks anything, never reloads or restarts on its own. After a server update it
 * says how it went ("Yo was updated", or why it didn't finish) until OK.
 */
import { AlertCircle, ArrowDownToLine, RefreshCw, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { type Notice, pendingServerUpdate, pickNotice } from "../lib/updates";
import { cn } from "../lib/utils";
import { useApp } from "../stores/app";
import { noticeInput, updates, useUpdates } from "../stores/updates";
import { ApplyBar, applyCopy, useApplyFill, useApplying, useApplyLate } from "./UpdateProgress";
import { Button } from "./ui/button";
import { Tip } from "./ui/overlay";

/** Restarting Yo.app restarts a core that runs on this Mac, which stops agents mid-task. */
export function useLocalAgentsWorking() {
  return useApp(
    (s) => s.computer?.host.kind === "local" && Object.values(s.agents).some((a) => a.activity === "working"),
  );
}

export function UpdateNotice({ floating = false }: { floating?: boolean }) {
  // Shallow-compared: a new { kind, mode } object for the same notice must not re-render.
  const notice = useUpdates(useShallow((s) => pickNotice(noticeInput(s)) ?? EMPTY));
  if (!notice.kind) return null;
  // In the sidebar the update button next to the profile carries the quiet states; the pill is only for the
  // floating notice (sidebar hidden).
  if (notice.mode !== "card" && !floating) return null;
  return (
    <div className={cn(floating ? "update-float fixed bottom-4 left-4 z-[70] w-[264px]" : "mb-1.5")}>
      {notice.mode === "card" ? (
        <UpdateCard notice={notice as Notice} floating={floating} />
      ) : (
        <UpdatePill notice={notice as Notice} />
      )}
    </div>
  );
}

const EMPTY = { kind: null, mode: null } as const;

function UpdateCard({ notice, floating }: { notice: Notice; floating: boolean }) {
  const version = useUpdates((s) => s.desktop?.downloadedVersion);
  const serverPending = useUpdates((s) => !!pendingServerUpdate(s.server));
  const result = useUpdates((s) => s.server?.server?.lastResult);
  const applying = useApplying();
  const late = useApplyLate(applying);
  const restart = notice.kind === "restart";
  const report = notice.kind === "updated" || notice.kind === "update-failed";

  const copy = applying
    ? applyCopy(applying, late)
    : restart
      ? {
          title: serverPending ? "Update ready" : version ? `Yo ${version} is ready` : "Yo is ready",
          line: "Restart to update.",
        }
      : notice.kind === "updated"
        ? { title: "Yo was updated", line: "You're on the new version." }
        : notice.kind === "update-failed"
          ? {
              title: "The update didn't finish",
              line: result?.message || "Yo stays on the version it had. Try again later.",
            }
          : { title: "Yo was updated", line: "Refresh to load the new version." };

  return (
    <div
      data-testid="update-card"
      data-kind={notice.kind}
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-2xl border border-border-strong/60 bg-elevated p-3 animate-rise",
        floating ? "shadow-pop" : "shadow-card",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-px grid size-7 shrink-0 place-items-center rounded-lg",
            notice.kind === "update-failed" && !applying
              ? "bg-warning/15 text-warning"
              : "bg-brand/15 text-brand-ink",
          )}
        >
          {notice.kind === "update-failed" && !applying ? (
            <AlertCircle className="size-[15px]" />
          ) : restart || report || applying?.kind === "restart" || applying?.kind === "server" ? (
            <Sparkles className="size-[15px]" />
          ) : (
            <RefreshCw className="size-[15px]" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-base">{copy.title}</div>
          <div className="text-muted text-sm">{copy.line}</div>
        </div>
      </div>
      {applying ? (
        <ApplyBar applying={applying} className="mt-3" />
      ) : report ? (
        <div className="mt-2.5 flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            data-testid="update-result-ok"
            onClick={() => updates.dismissResult()}
          >
            OK
          </Button>
        </div>
      ) : (
        <div className="mt-2.5 flex justify-end gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            data-testid="update-later"
            onClick={() => updates.later(restart ? "restart" : "refresh")}
          >
            Later
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-testid="update-primary"
            onClick={restart ? () => updates.askRestart() : () => void updates.apply("refresh")}
          >
            {restart ? "Restart" : "Refresh"}
          </Button>
        </div>
      )}
    </div>
  );
}

function UpdatePill({ notice }: { notice: Notice }) {
  const desktop = useUpdates((s) => s.desktop);
  const serverPending = useUpdates((s) => !!pendingServerUpdate(s.server));
  const applying = useApplying();
  const late = useApplyLate(applying);
  const percent = Math.round(desktop?.percent ?? 0);

  let icon: ReactNode;
  let label: string;
  let trailing: string | null = null;
  let onClick: (() => void) | undefined;
  switch (notice.kind) {
    case "restart":
      icon = <Sparkles />;
      label = "Restart to update";
      trailing = serverPending ? null : (desktop?.downloadedVersion ?? null);
      onClick = () => updates.askRestart();
      break;
    case "refresh":
      icon = <RefreshCw />;
      label = "Refresh to update";
      onClick = () => void updates.apply("refresh");
      break;
    case "downloading":
      icon = <ArrowDownToLine />;
      label = "Downloading update";
      trailing = `${percent}%`;
      break;
    case "download":
      icon = <ArrowDownToLine />;
      label = "Download update";
      trailing = desktop?.availableVersion ?? null;
      onClick = () => void updates.download();
      break;
    case "available":
      icon = <ArrowDownToLine />;
      label = "Update available";
      trailing = desktop?.availableVersion ?? null;
      onClick = () => void updates.retry();
      break;
    default:
      icon = <AlertCircle />;
      label = "Update failed";
      trailing = "Retry";
      onClick = () => void updates.retry();
  }

  if (applying) {
    label = applyCopy(applying, late).short;
    onClick = undefined;
  }

  const pill = (
    <button
      data-testid="update-pill"
      data-kind={notice.kind}
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "relative flex h-8 w-full items-center gap-2 overflow-hidden rounded-[10px] bg-active/60 px-3 text-fg-2 text-sm transition-colors animate-rise [&_svg]:size-3.5 [&_svg]:shrink-0",
        onClick && "hover:bg-active hover:text-fg",
        notice.kind === "error" ? "[&_svg]:text-warning" : "[&_svg]:text-brand-ink",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      {trailing && <span className="ml-auto shrink-0 text-faint text-xs tabular-nums">{trailing}</span>}
      {applying && <PillBar />}
      {!applying && notice.kind === "downloading" && (
        <span className="absolute inset-x-0 bottom-0 h-[2px] bg-border" aria-hidden>
          <span
            className="block h-full bg-link transition-[width] duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        </span>
      )}
    </button>
  );
  if (notice.kind === "error" && desktop?.message) return <Tip label={desktop.message}>{pill}</Tip>;
  return pill;
}

/** The pill's thin bottom bar while an update is applied. */
function PillBar() {
  const applying = useApplying();
  if (!applying) return null;
  return <PillFill key={applying.startedAt} />;
}

function PillFill() {
  const { fraction, transition } = useApplyFill(useApplying()!);
  return (
    <span className="absolute inset-x-0 bottom-0 h-[2px] bg-border" aria-hidden>
      <span
        className="block h-full bg-link"
        style={{
          width: `${fraction * 100}%`,
          transition: transition === "none" ? "none" : `width ${transition}`,
        }}
      />
    </span>
  );
}
