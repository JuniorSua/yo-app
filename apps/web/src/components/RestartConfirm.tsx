/**
 * "Install Yo 0.1.N and restart?": every Restart button (update button, card, pill, Settings) opens this first,
 * so a misclick or a forgotten update never restarts Yo by surprise. It shows what's new (the notes published
 * with the build, see release.py publish-app / publish-server --notes) and warns when agents are working. After
 * Restart it stays open with the progress until Yo restarts (Yo.app) or reloads (a server update).
 *
 * With a published server update (Home PC) Restart applies that first: Yo is down for about 30 seconds, every
 * agent's task stops, and when the agent computer changes its browser reloads. A downloaded Yo.app installs
 * right after it.
 */
import { AlertCircle, AlertTriangle, Globe } from "lucide-react";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { busyLine, pendingServerUpdate } from "../lib/updates";
import { cn } from "../lib/utils";
import { useApp } from "../stores/app";
import { restartNotes, updates, useUpdates } from "../stores/updates";
import { useLocalAgentsWorking } from "./UpdateNotice";
import { ApplyBar, applyCopy, useApplyLate } from "./UpdateProgress";
import { Button } from "./ui/button";
import { Modal } from "./ui/overlay";

/** Names of the agents in the middle of a task (any host: a server restart stops them all). */
function useWorkingAgents() {
  return useApp(
    useShallow((s) =>
      Object.values(s.agents)
        .filter((a) => a.activity === "working")
        .map((a) => a.name),
    ),
  );
}

export function RestartConfirm() {
  const open = useUpdates((s) => s.confirmingRestart);
  const version = useUpdates((s) =>
    s.desktop?.status === "downloaded" ? s.desktop.downloadedVersion : null,
  );
  const server = useUpdates(useShallow((s) => pendingServerUpdate(s.server)));
  const notes = useUpdates(restartNotes);
  const error = useUpdates((s) => s.serverError);
  const applying = useUpdates((s) =>
    s.applying?.kind === "restart" || s.applying?.kind === "server" ? s.applying : null,
  );
  const late = useApplyLate(applying);
  const localBusy = useLocalAgentsWorking();
  const working = useWorkingAgents();
  const copy = applying ? applyCopy(applying, late) : null;
  const busy = server ? busyLine(working) : localBusy ? "busy-local" : null;

  const title = copy
    ? copy.title
    : server
      ? "Restart Yo to update?"
      : version
        ? `Install Yo ${version} and restart?`
        : "Install the update and restart?";
  const description = copy
    ? copy.line
    : server
      ? "Yo will restart and be back in about 30 seconds."
      : "Yo closes for a few seconds and opens again by itself.";

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && updates.cancelRestart()}
      title={title}
      description={description}
      hideClose
      className="w-[min(440px,calc(100vw-32px))]"
      testId="restart-confirm"
    >
      <div className="space-y-3 px-5 pt-3 pb-5">
        {notes && <WhatsNew notes={notes} />}
        {busy && !applying && (
          <Callout testId="restart-confirm-busy" icon={<AlertTriangle />} tone="warning">
            {busy === "busy-local" ? (
              <>
                <span className="font-medium">Your agents are still working.</span>{" "}
                <span className="text-fg-2">Restarting stops what they're doing on this Mac.</span>
              </>
            ) : (
              <span className="font-medium">{busy}</span>
            )}
          </Callout>
        )}
        {server?.restartsComputer && !applying && (
          <Callout testId="restart-confirm-browser" icon={<Globe />}>
            <span className="text-fg-2">
              Yo's browser will reload; you may need to sign in to some sites again.
            </span>
          </Callout>
        )}
        {error && !applying && (
          <Callout testId="restart-confirm-error" icon={<AlertCircle />} tone="danger">
            <span>{error}</span>
          </Callout>
        )}
        {applying && <ApplyBar applying={applying} />}
      </div>
      {!applying && (
        <div className="flex items-center justify-end gap-2 border-border border-t bg-bg/30 px-5 py-3.5">
          <Button
            variant="secondary"
            data-testid="restart-confirm-cancel"
            onClick={() => updates.cancelRestart()}
          >
            Cancel
          </Button>
          <Button
            variant="brand"
            data-testid="restart-confirm-ok"
            onClick={() => void updates.confirmRestart()}
          >
            {busy ? "Restart anyway" : error ? "Try again" : "Restart"}
          </Button>
        </div>
      )}
    </Modal>
  );
}

function Callout({
  icon,
  tone,
  testId,
  children,
}: {
  icon: ReactNode;
  tone?: "warning" | "danger";
  testId: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={
        tone === "warning"
          ? "flex gap-2.5 rounded-xl border border-warning/25 bg-warning/10 px-3 py-2.5 text-sm"
          : tone === "danger"
            ? "flex gap-2.5 rounded-xl border border-danger/25 bg-danger/10 px-3 py-2.5 text-sm"
            : "flex gap-2.5 rounded-xl border border-border bg-active/50 px-3 py-2.5 text-sm"
      }
    >
      <span
        className={cn(
          "mt-0.5 shrink-0 [&_svg]:size-4",
          tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : "text-muted",
        )}
      >
        {icon}
      </span>
      <span>{children}</span>
    </div>
  );
}

/** The notes as written: "- " lines become bullets, anything else a short paragraph. */
function WhatsNew({ notes }: { notes: string }) {
  const lines = notes
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <div data-testid="restart-confirm-notes" className="rounded-xl bg-active/50 px-3.5 py-3">
      <div className="mb-1.5 font-medium text-faint text-xs uppercase tracking-[0.06em]">What's new</div>
      <div className="space-y-1 text-fg-2 text-sm">
        {lines.map((l, i) =>
          l.startsWith("- ") ? (
            <div key={i} className="flex gap-2">
              <span className="mt-[7px] size-1 shrink-0 rounded-full bg-brand" aria-hidden />
              <span>{l.slice(2)}</span>
            </div>
          ) : (
            <p key={i}>{l}</p>
          ),
        )}
      </div>
    </div>
  );
}
