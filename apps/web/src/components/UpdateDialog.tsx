/**
 * The update window: the one place to decide on an update and watch it happen (stores/updates.ts dialogView).
 *   decide    what's new, what will happen ("Yo restarts for about a minute; your chats are safe"), who is busy,
 *             with Later (focused first, so a stray Enter never restarts) and Restart now / Reload now
 *   download  a public build: the version, Download, and the three steps to swap the app in by hand
 *   progress  the steps with real states and the time so far; slow and stuck say what's happening
 *   failed    what happened and what to do
 *   whatsnew  after "Updated to Yo 2.0.N · What's new"
 * Opened from the notice, the update button or Settings. Never opens by itself.
 */
import { AlertTriangle, Check, Globe, Info } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  applyEstimate,
  applySteps,
  busyLine,
  elapsedText,
  failureAdvice,
  pendingServerUpdate,
} from "../lib/updates";
import { useNow } from "../lib/useNow";
import { cn } from "../lib/utils";
import { useApp } from "../stores/app";
import {
  currentOffer,
  dialogView,
  failure,
  justUpdated,
  restartNotes,
  updates,
  useUpdates,
} from "../stores/updates";
import { ApplySteps } from "./UpdateProgress";
import { Button } from "./ui/button";
import { DialogDescription, DialogTitle, Modal } from "./ui/overlay";

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

/** Restarting Yo.app restarts a core that runs on this Mac, which stops agents mid-task. */
function useLocalAgentsWorking() {
  return useApp(
    (s) => s.computer?.host.kind === "local" && Object.values(s.agents).some((a) => a.activity === "working"),
  );
}

export function UpdateDialog() {
  const view = useUpdates(dialogView);
  const dialog = useUpdates((s) => s.dialog);
  // Nothing left to show (the update finished on another device, say): close instead of reopening later.
  useEffect(() => {
    if (dialog && !view) updates.hide();
  }, [dialog, view]);

  const content =
    view === "decide" ? (
      <Decide />
    ) : view === "download" ? (
      <Download />
    ) : view === "progress" ? (
      <Progress />
    ) : view === "failed" ? (
      <Failed />
    ) : view === "whatsnew" ? (
      <WhatsNewView />
    ) : null;

  return (
    <Modal
      open={!!view}
      onOpenChange={(o) => !o && updates.close()}
      hideClose
      bare
      className="flex w-[min(420px,calc(100vw-32px))] flex-col"
      testId="update-dialog"
    >
      <div data-view={view ?? undefined} data-testid="update-dialog-body" className="contents">
        {content}
      </div>
    </Modal>
  );
}

/* ---------------------------------- Layout ---------------------------------- */

function Head({ title, line, aside }: { title: ReactNode; line?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-5 pt-5 pb-1">
      <div className="min-w-0 flex-1">
        <DialogTitle data-testid="update-dialog-title" className="font-semibold text-lg tracking-[-0.01em]">
          {title}
        </DialogTitle>
        {line && (
          <DialogDescription data-testid="update-dialog-line" className="mt-1 text-muted text-sm">
            {line}
          </DialogDescription>
        )}
      </div>
      {aside}
    </div>
  );
}

function Body({ children }: { children: ReactNode }) {
  return <div className="space-y-3 px-5 pt-3 pb-5">{children}</div>;
}

function Foot({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 border-border border-t bg-bg/30 px-5 py-3.5">
      {children}
    </div>
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
      className={cn(
        "flex gap-2.5 rounded-xl border px-3 py-2.5 text-sm",
        tone === "warning"
          ? "border-warning/25 bg-warning/10"
          : tone === "danger"
            ? "border-danger/25 bg-danger/10"
            : "border-border bg-active/50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 shrink-0 [&_svg]:size-4",
          tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : "text-muted",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">{children}</span>
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
    <div data-testid="update-dialog-notes" className="rounded-xl bg-active/50 px-3.5 py-3">
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

/* ---------------------------------- Decide ---------------------------------- */

function Decide() {
  const offer = useUpdates(currentOffer);
  const server = useUpdates(useShallow((s) => pendingServerUpdate(s.server)));
  const version = useUpdates((s) =>
    s.desktop?.status === "downloaded" ? s.desktop.downloadedVersion : null,
  );
  const notes = useUpdates(restartNotes);
  const error = useUpdates((s) => s.serverError);
  const working = useWorkingAgents();
  const localBusy = useLocalAgentsWorking();

  if (offer === "refresh")
    return (
      <>
        <Head title="Update ready" line="Reload this window to use the new version. It takes a second." />
        <Body>
          <Callout testId="update-dialog-safe" icon={<Info />}>
            <span className="text-fg-2">
              Only this window reloads: agents keep working and your chats are safe.
            </span>
          </Callout>
        </Body>
        <Foot>
          <Button variant="secondary" data-testid="update-later" onClick={() => updates.close()}>
            Later
          </Button>
          <Button variant="brand" data-testid="update-confirm" onClick={() => void updates.confirm()}>
            Reload now
          </Button>
        </Foot>
      </>
    );

  const busy = server ? busyLine(working) : localBusy ? "Your agents are still working." : null;
  const line = server
    ? server.restartsComputer
      ? "Yo and its browser restart for 1–2 minutes. Your chats are safe."
      : "Yo restarts for about a minute. Your chats are safe."
    : "Yo closes and opens again in about 10 seconds. Your chats are safe.";

  return (
    <>
      <Head title={server || !version ? "Update ready" : `Yo ${version} is ready`} line={line} />
      <Body>
        {notes && <WhatsNew notes={notes} />}
        {busy && (
          <Callout testId="update-dialog-busy" icon={<AlertTriangle />} tone="warning">
            <span className="font-medium">{busy}</span>{" "}
            {!server && <span className="text-fg-2">Restarting stops what they're doing on this Mac.</span>}
          </Callout>
        )}
        {server?.restartsComputer && (
          <Callout testId="update-dialog-browser" icon={<Globe />}>
            <span className="text-fg-2">You may need to sign in to some sites again afterwards.</span>
          </Callout>
        )}
        {error && (
          <Callout testId="update-dialog-error" icon={<AlertTriangle />} tone="danger">
            {error}
          </Callout>
        )}
      </Body>
      <Foot>
        <Button variant="secondary" data-testid="update-later" onClick={() => updates.close()}>
          Later
        </Button>
        <Button variant="brand" data-testid="update-confirm" onClick={() => void updates.confirm()}>
          {busy ? "Restart anyway" : error ? "Try again" : "Restart now"}
        </Button>
      </Foot>
    </>
  );
}

/* --------------------------------- Download --------------------------------- */

function Download() {
  const version = useUpdates((s) => s.desktop?.availableVersion);
  const opened = useUpdates((s) => s.downloadOpened);
  const mac = window.yoDesktop?.platform === "darwin";
  const steps = [
    {
      title: `Download Yo ${version ?? ""}`.trim(),
      detail: opened ? "It's downloading in your browser." : "It comes from Yo's page on GitHub.",
    },
    { title: "Quit Yo", detail: "Press ⌘Q. Closing the window keeps Yo running." },
    { title: "Drag the new Yo into Applications", detail: "Choose Replace. Your chats and settings stay." },
  ];
  return (
    <>
      <Head
        title={`Yo ${version} is out`}
        line="The free download updates by hand. It takes about a minute."
      />
      <Body>
        <ol data-testid="update-download-steps" className="space-y-3">
          {steps.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span
                className={cn(
                  "mt-px grid size-5 shrink-0 place-items-center rounded-full font-semibold text-2xs tabular-nums",
                  i === 0 && opened ? "bg-success/15 text-success" : "bg-active text-fg-2",
                )}
              >
                {i === 0 && opened ? <Check className="size-3" strokeWidth={2.6} aria-label="Done" /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-base">{s.title}</div>
                <div className="text-muted text-sm">{s.detail}</div>
              </div>
            </li>
          ))}
        </ol>
        <div
          data-testid="update-note"
          className="space-y-1 rounded-xl bg-active/50 px-3.5 py-2.5 text-muted text-xs"
        >
          <p>
            This is normal for the free download: apps without Apple's paid signature can't replace
            themselves.
          </p>
          {/* Ad-hoc signed builds get a new signature each version, so macOS asks again (#74). */}
          {mac && <p>Afterwards macOS may ask about “Yo Safe Storage”: choose Always Allow.</p>}
        </div>
      </Body>
      <Foot>
        {opened ? (
          <>
            <Button variant="ghost" data-testid="update-download" onClick={() => void updates.download()}>
              Download again
            </Button>
            <Button variant="primary" data-testid="update-done" onClick={() => updates.close()}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" data-testid="update-later" onClick={() => updates.close()}>
              Later
            </Button>
            <Button variant="brand" data-testid="update-download" onClick={() => void updates.download()}>
              Download
            </Button>
          </>
        )}
      </Foot>
    </>
  );
}

/* --------------------------------- Progress --------------------------------- */

function Progress() {
  const applying = useUpdates((s) => s.applying);
  const stuck = useUpdates((s) => s.stuck);
  const now = useNow(1000);
  if (!applying) return null;
  const elapsed = now - applying.startedAt;
  const estimate = applyEstimate(applying);
  const time = (
    <span data-testid="update-elapsed" className="shrink-0 pt-1 text-faint text-sm tabular-nums">
      {elapsedText(elapsed)}
    </span>
  );

  if (applying.adopted)
    return (
      <>
        <Head title="Yo is updating" line="It was started from another window." aside={time} />
        <Body>
          <p className="text-fg-2 text-sm">
            This window offers to reload once Yo is back on the new version.
          </p>
        </Body>
        <Foot>
          <Button variant="secondary" data-testid="update-hide" onClick={() => updates.hide()}>
            Hide
          </Button>
        </Foot>
      </>
    );

  if (applying.kind === "web")
    return <Head title="Reloading Yo…" line="Agents keep working while this window reloads." />;

  const steps = applySteps(applying);
  const current = steps.find((s) => s.state === "active");
  const done = applying.phase === "done";
  const slow = !stuck && !done && elapsed > estimate.slowAfterMs;

  if (stuck)
    return (
      <>
        <Head
          title="Yo hasn't come back yet"
          line="The update may still be finishing. This window keeps checking."
          aside={time}
        />
        <Body>
          <ApplySteps steps={steps} />
          <Callout testId="update-dialog-stuck" icon={<AlertTriangle />} tone="warning">
            <span className="text-fg-2">
              If Yo isn't back in a few minutes, restart the PC that runs Yo. Your chats are saved.
            </span>
          </Callout>
        </Body>
        <Foot>
          <Button variant="secondary" data-testid="update-hide" onClick={() => updates.hide()}>
            Hide
          </Button>
          <Button
            variant="primary"
            data-testid="update-check-again"
            onClick={() => void updates.checkAgain()}
          >
            Check now
          </Button>
        </Foot>
      </>
    );

  return (
    <>
      <Head
        title={done ? "Done" : applying.kind === "app" ? "Restarting Yo" : "Updating Yo"}
        line={
          done
            ? "Loading the new version…"
            : applying.kind === "app"
              ? `Yo closes, updates and opens again by itself. ${estimate.text}.`
              : `${estimate.text}. This window reloads when Yo is back.`
        }
        aside={done ? null : time}
      />
      <Body>
        <ApplySteps steps={steps} />
        {slow && (
          <Callout testId="update-dialog-slow" icon={<Info />}>
            <span className="text-fg-2">
              This is taking longer than usual. Yo is still on “{current?.label}”; nothing is lost while it
              finishes.
            </span>
          </Callout>
        )}
      </Body>
      {slow && (
        <Foot>
          <Button variant="secondary" data-testid="update-hide" onClick={() => updates.hide()}>
            Hide
          </Button>
        </Foot>
      )}
    </>
  );
}

/* ---------------------------------- Failed ---------------------------------- */

function Failed() {
  const f = useUpdates(useShallow((s) => failure(s)));
  if (!f) return null;
  const server = f.kind === "server";
  return (
    <>
      <Head
        title={server ? "The update didn't finish" : "Yo couldn't restart to update"}
        line={f.message || (server ? "Yo stays on the version it had." : undefined)}
      />
      <Body>
        <Callout testId="update-dialog-advice" icon={<Info />}>
          <span className="text-fg-2">
            {server
              ? failureAdvice(f.message)
              : "Quit Yo (⌘Q) and open it again. The update installs while Yo is closed."}
          </span>
        </Callout>
      </Body>
      <Foot>
        <Button variant="primary" data-testid="update-ok" onClick={() => updates.close()}>
          OK
        </Button>
      </Foot>
    </>
  );
}

/* --------------------------------- What's new -------------------------------- */

function WhatsNewView() {
  const done = useUpdates(useShallow((s) => justUpdated(s)));
  return (
    <>
      <Head title={done?.version ? `Updated to Yo ${done.version}` : "Yo was updated"} />
      <Body>
        {done?.notes ? (
          <WhatsNew notes={done.notes} />
        ) : (
          <p className="text-fg-2 text-sm">You're on the latest version.</p>
        )}
      </Body>
      <Foot>
        <Button variant="primary" data-testid="update-ok" onClick={() => updates.close()}>
          Close
        </Button>
      </Foot>
    </>
  );
}
