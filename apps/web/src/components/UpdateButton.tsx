/**
 * The update button above Settings in the rail. While there's an update notice (UpdateNotice), the notice takes the
 * button's place, so the rail says it once and nothing covers the chat. With an update to decide on, a failed one
 * or one being applied, a click opens the update window. Otherwise it checks: its panel says Yo is up to date, or
 * shows a background download (a ring fills around the button), or a download that stopped. A dot means an update
 * is waiting after Later. Never updates by itself.
 */
import { AlertCircle, ArrowDownToLine, Check } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils";
import { currentOffer, failure, noticeKind, updates, useUpdates } from "../stores/updates";
import { useMedia } from "./agent/Presence";
import { PHONE_QUERY, RailUpdateNotice } from "./UpdateNotice";
import { Button } from "./ui/button";
import { Spinner } from "./ui/controls";
import { Popover, Tip } from "./ui/overlay";

type View = "idle" | "checking" | "downloading" | "paused" | "ready" | "applying" | "error";

function useView(checking: boolean): View {
  return useUpdates((s) => {
    if (s.applying) return "applying";
    if (currentOffer(s) || failure(s)?.kind === "server") return "ready";
    const d = s.desktop?.status;
    if (d === "downloading") return "downloading";
    // A feed build's download that stopped (a fresh "available" downloads right away: no flash of it).
    if (d === "available" && s.desktop?.canRetry) return "paused";
    if (checking || d === "checking" || d === "available") return "checking";
    if (d === "error") return "error";
    return "idle";
  });
}

const TIP: Record<View, string> = {
  idle: "Check for updates",
  checking: "Checking for updates…",
  downloading: "Downloading an update",
  paused: "Update paused",
  ready: "Update ready",
  applying: "Updating Yo…",
  error: "Update problem",
};

export function UpdateButton() {
  const ownBuild = useUpdates((s) => s.ownBuild);
  const percent = useUpdates((s) => Math.round(s.desktop?.percent ?? 0));
  // The dot only stands in for the notice: never both, and not behind the update window.
  const quiet = useUpdates((s) => noticeKind(s) === null && s.dialog === null);
  const notice = useUpdates((s) => noticeKind(s) !== null);
  const phone = useMedia(PHONE_QUERY);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const view = useView(checking);
  if (!ownBuild) return null; // development build: nothing to update
  if (notice && !phone) return <RailUpdateNotice />;

  const check = async () => {
    setChecking(true);
    try {
      await updates.checkNow();
    } finally {
      setChecking(false);
    }
  };
  const onOpenChange = (next: boolean) => {
    // Something to decide on or watch: the update window, not the panel.
    if (next && (view === "ready" || view === "applying")) return updates.open();
    setOpen(next);
    // Opening it is the check: nothing else to click when there's nothing pending.
    if (next && (view === "idle" || view === "error")) void check();
  };

  return (
    <Popover
      side="top"
      align="end"
      open={open}
      onOpenChange={onOpenChange}
      className="w-[248px] p-3"
      trigger={
        <button
          type="button"
          data-testid="update-button"
          data-state={view}
          aria-label={TIP[view]}
          className={cn(
            "relative grid size-[38px] shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg data-[popup-open]:bg-active",
            (view === "ready" || view === "downloading") && "text-fg",
          )}
        >
          <Tip label={TIP[view]}>
            <span className="grid size-full place-items-center">
              {view === "checking" || view === "applying" ? (
                <Spinner className="size-4" />
              ) : view === "error" ? (
                <AlertCircle className="size-[18px]" />
              ) : (
                <ArrowDownToLine className="size-[18px]" />
              )}
            </span>
          </Tip>
          {view === "downloading" && <ProgressRing percent={percent} />}
          {view === "ready" && quiet && (
            <span
              data-testid="update-dot"
              className="absolute top-1 right-1 size-2.5 rounded-full border-2 border-sidebar bg-brand"
            />
          )}
          {view === "error" && (
            <span className="absolute top-1 right-1 size-2.5 rounded-full border-2 border-sidebar bg-danger" />
          )}
        </button>
      }
    >
      <div data-testid="update-panel" data-state={view}>
        <UpdatePanel view={view} onCheck={() => void check()} />
      </div>
    </Popover>
  );
}

function ProgressRing({ percent }: { percent: number }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  return (
    <svg className="-rotate-90 pointer-events-none absolute inset-0" viewBox="0 0 38 38" aria-hidden>
      <circle cx="19" cy="19" r={r} fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="19"
        cy="19"
        r={r}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - percent / 100)}
        className="stroke-brand transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
      />
    </svg>
  );
}

function UpdatePanel({ view, onCheck }: { view: View; onCheck: () => void }) {
  const desktop = useUpdates((s) => s.desktop);
  const server = useUpdates((s) => s.server);
  const ownBuild = useUpdates((s) => s.ownBuild);
  const percent = Math.round(desktop?.percent ?? 0);
  const versions = [
    desktop ? `Yo app ${desktop.currentVersion}` : null,
    `server ${server?.web ?? server?.build ?? ownBuild}`,
  ]
    .filter(Boolean)
    .join(" · ");

  switch (view) {
    case "checking":
      return <Row icon={<Spinner className="size-4" />} title="Checking for updates…" line={versions} />;
    case "paused":
      return (
        <Row
          icon={<ArrowDownToLine />}
          title={`Yo ${desktop?.availableVersion} is available`}
          line="The download stopped. Start it again?"
          action={
            <Button size="sm" variant="primary" onClick={() => void updates.retry()}>
              Download
            </Button>
          }
        />
      );
    case "downloading":
      return (
        <div>
          <Row
            icon={<ArrowDownToLine />}
            title={`Downloading Yo ${desktop?.availableVersion ?? ""}`}
            line="Keep using Yo. It's ready to install when this finishes."
          />
          <div className="mt-3 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-active">
              <div
                className="h-full rounded-full bg-brand transition-[width] motion-reduce:transition-none"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="text-muted text-xs tabular-nums">{percent}%</span>
          </div>
        </div>
      );
    case "error":
      return (
        <Row
          icon={<AlertCircle />}
          title={desktop?.errorContext === "install" ? "Yo couldn't restart to update" : "Couldn't update"}
          line={desktop?.message ?? "Check your connection and try again."}
          action={
            <Button size="sm" onClick={onCheck}>
              Try again
            </Button>
          }
        />
      );
    default:
      return (
        <Row
          icon={<Check />}
          title={
            desktop?.status === "idle" && desktop.message ? "Couldn't check for updates" : "Yo is up to date"
          }
          line={desktop?.status === "idle" && desktop.message ? "Yo will try again later." : versions}
          action={
            <Button size="sm" variant="ghost" onClick={onCheck}>
              Check again
            </Button>
          }
        />
      );
  }
}

function Row({
  icon,
  title,
  line,
  action,
}: {
  icon: ReactNode;
  title: string;
  line: string;
  action?: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-start gap-2.5">
        <span className="mt-px grid size-7 shrink-0 place-items-center rounded-lg bg-active text-fg-2 [&_svg]:size-[15px]">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-base">{title}</div>
          <div className="text-muted text-sm">{line}</div>
        </div>
      </div>
      {action && <div className="mt-2.5 flex justify-end gap-1.5">{action}</div>}
    </div>
  );
}
