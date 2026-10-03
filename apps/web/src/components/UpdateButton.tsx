/**
 * The update button next to the profile (bottom left). One click checks for updates; while a new Yo.app
 * downloads it shows the progress; when an update is ready a dot appears and its panel offers Restart (new
 * Yo.app) or Refresh (new server build). Never updates by itself.
 */
import { AlertCircle, ArrowDownToLine, Check, RefreshCw, Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";
import { isGithubDownload } from "../lib/updates";
import { cn } from "../lib/utils";
import { updates, useUpdates } from "../stores/updates";
import { useLocalAgentsWorking } from "./UpdateNotice";
import { Button } from "./ui/button";
import { Spinner } from "./ui/controls";
import { Popover, Tip } from "./ui/overlay";

type View = "idle" | "checking" | "available" | "downloading" | "ready" | "refresh" | "error";

function useView(checking: boolean): View {
  return useUpdates((s) => {
    const d = s.desktop?.status;
    if (d === "downloaded") return "ready";
    if (s.refresh) return "refresh";
    if (d === "downloading") return "downloading";
    if (d === "available") return "available";
    if (checking || d === "checking") return "checking";
    if (d === "error") return "error";
    return "idle";
  });
}

const TIP: Record<View, string> = {
  idle: "Check for updates",
  checking: "Checking for updates…",
  available: "Update available",
  downloading: "Downloading update",
  ready: "Update ready: restart Yo",
  refresh: "Yo was updated: refresh",
  error: "Update problem",
};

export function UpdateButton() {
  const ownBuild = useUpdates((s) => s.ownBuild);
  const percent = useUpdates((s) => Math.round(s.desktop?.percent ?? 0));
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const view = useView(checking);
  if (!ownBuild) return null; // development build: nothing to update

  const check = async () => {
    setChecking(true);
    try {
      await updates.checkNow();
    } finally {
      setChecking(false);
    }
  };
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // Opening it is the check: nothing else to click when there's nothing pending.
    if (next && (view === "idle" || view === "error")) void check();
  };
  const dot = view === "ready" || view === "refresh" || view === "available";

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
            (dot || view === "downloading") && "text-fg",
          )}
        >
          <Tip label={TIP[view]}>
            <span className="grid size-full place-items-center">
              {view === "checking" ? (
                <Spinner className="size-4" />
              ) : view === "error" ? (
                <AlertCircle className="size-[18px]" />
              ) : (
                <ArrowDownToLine className="size-[18px]" />
              )}
            </span>
          </Tip>
          {view === "downloading" && <ProgressRing percent={percent} />}
          {dot && (
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
        <UpdatePanel view={view} onCheck={() => void check()} onDone={() => setOpen(false)} />
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
        className="stroke-brand transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  );
}

function UpdatePanel({ view, onCheck, onDone }: { view: View; onCheck: () => void; onDone: () => void }) {
  const desktop = useUpdates((s) => s.desktop);
  const server = useUpdates((s) => s.server);
  const ownBuild = useUpdates((s) => s.ownBuild);
  const busy = useLocalAgentsWorking();
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const percent = Math.round(desktop?.percent ?? 0);
  const versions = [
    desktop ? `Yo app ${desktop.currentVersion}` : null,
    `server ${server?.web ?? server?.build ?? ownBuild}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const install = () => {
    if (busy && !confirming) return setConfirming(true);
    setRestarting(true);
    void updates.install().catch(() => setRestarting(false));
  };

  switch (view) {
    case "checking":
      return <Row icon={<Spinner className="size-4" />} title="Checking for updates…" line={versions} />;
    case "available":
      // Public builds can't install updates themselves: Download opens the release page on GitHub.
      if (isGithubDownload(desktop))
        return (
          <Row
            icon={<Sparkles />}
            tone="brand"
            title={`Yo ${desktop?.availableVersion} is available`}
            line="Download the new version from GitHub and replace Yo in Applications."
            note={
              // Ad-hoc signed builds get a new signature each version, so macOS asks again (#74).
              window.yoDesktop?.platform === "darwin"
                ? "After updating, macOS may ask about “Yo Safe Storage”: click Always Allow."
                : undefined
            }
            action={
              <>
                <Button size="sm" variant="ghost" onClick={onDone}>
                  Later
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  data-testid="update-download"
                  onClick={() => {
                    void updates.download();
                    onDone();
                  }}
                >
                  Download
                </Button>
              </>
            }
          />
        );
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
            line="Keep using Yo; you'll be asked to restart."
          />
          <div className="mt-3 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-active">
              <div
                className="h-full rounded-full bg-brand transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="text-muted text-xs tabular-nums">{percent}%</span>
          </div>
        </div>
      );
    case "ready":
      return (
        <Row
          icon={<Sparkles />}
          tone="brand"
          title={confirming ? "Agents are still working" : `Yo ${desktop?.downloadedVersion ?? ""} is ready`}
          line={
            confirming
              ? "Restarting Yo stops what they're doing on this Mac."
              : "Restart to update. It takes a few seconds."
          }
          action={
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => (confirming ? setConfirming(false) : onDone())}
              >
                {confirming ? "Wait" : "Later"}
              </Button>
              <Button
                size="sm"
                variant="primary"
                data-testid="update-restart"
                disabled={restarting}
                onClick={install}
              >
                {restarting ? "Restarting…" : confirming ? "Restart anyway" : "Restart"}
              </Button>
            </>
          }
        />
      );
    case "refresh":
      return (
        <Row
          icon={<RefreshCw />}
          tone="brand"
          title="Yo was updated"
          line="Refresh to load the new version."
          action={
            <>
              <Button size="sm" variant="ghost" onClick={onDone}>
                Later
              </Button>
              <Button size="sm" variant="primary" data-testid="update-refresh" onClick={updates.refresh}>
                Refresh
              </Button>
            </>
          }
        />
      );
    case "error":
      return (
        <Row
          icon={<AlertCircle />}
          title="Couldn't update"
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
  note,
  action,
  tone,
}: {
  icon: ReactNode;
  title: string;
  line: string;
  /** A smaller second line under `line`. */
  note?: string;
  action?: ReactNode;
  tone?: "brand";
}) {
  return (
    <div>
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-px grid size-7 shrink-0 place-items-center rounded-lg [&_svg]:size-[15px]",
            tone === "brand" ? "bg-brand/15 text-brand-ink" : "bg-active text-fg-2",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-base">{title}</div>
          <div className="text-muted text-sm">{line}</div>
          {note && (
            <div data-testid="update-note" className="mt-1.5 text-faint text-xs">
              {note}
            </div>
          )}
        </div>
      </div>
      {action && <div className="mt-2.5 flex justify-end gap-1.5">{action}</div>}
    </div>
  );
}
