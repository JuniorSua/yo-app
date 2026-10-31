/**
 * "Report a problem": one form for Settings → Bug reports and for the red draft card's "Report it". The user sees
 * exactly what's sent ("What's sent": the bundle's files and report.md), chooses whether the recent chat goes
 * along, and presses Send. Core encrypts it to the maintainer's Yo and drops it in the bug mailbox (no GitHub account
 * needed); if the mailbox is down it keeps it and retries, and only as a last resort offers the prefilled GitHub link.
 */
import type { BugReportPreview, BugReportSent } from "@yo/contracts";
import { Bug, Check, ChevronDown, Clock, ExternalLink, FileText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { GITHUB_PUBLIC, sendParams, sentMessage, sizeLabel } from "../lib/bugReport";
import { cn } from "../lib/utils";
import { run } from "../stores/sync";
import { useUI } from "../stores/ui";
import { Button } from "./ui/button";
import { Field, Spinner, Textarea } from "./ui/controls";
import { Modal } from "./ui/overlay";

const FILE_NOTES: Record<string, string> = {
  "report.md": "your report",
  "environment.json": "Yo's version, your Mac's system, and whether the computer and accounts are working",
  "core-log.txt": "Yo's recent log",
  "chat-excerpt.json": "the last 30 messages and steps of the chat",
};

export function BugReportDialog({
  open,
  onOpenChange,
  draft,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sending the agent's draft (the red card) instead of the form. */
  draft?: { draftId: string; title: string };
  onSent?: (r: BugReportSent) => void;
}) {
  const agentId = useUI((s) => s.agentId);
  const [what, setWhat] = useState("");
  const [expected, setExpected] = useState("");
  const [steps, setSteps] = useState("");
  const [includeChat, setIncludeChat] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState<BugReportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BugReportSent | null>(null);

  // A fresh form each time it opens.
  useEffect(() => {
    if (!open) return;
    setWhat("");
    setExpected("");
    setSteps("");
    setIncludeChat(false);
    setShowPreview(false);
    setPreview(null);
    setResult(null);
  }, [open]);

  const params = useMemo(
    () => sendParams({ draftId: draft?.draftId, agentId }, { what, expected, steps }, includeChat),
    [draft?.draftId, agentId, what, expected, steps, includeChat],
  );
  const ready = !!draft || what.trim().length > 0;

  // "What's sent": asks core for the exact bundle (debounced while typing).
  useEffect(() => {
    if (!open || !showPreview || !ready) return;
    let live = true;
    const t = setTimeout(() => {
      void api()
        .call("bugReports.preview", params)
        .then((p) => live && setPreview(p))
        .catch(() => live && setPreview(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, showPreview, ready, params]);

  const sendIt = async () => {
    setBusy(true);
    const r = await run(api().call("bugReports.send", params), "Couldn't send the report");
    setBusy(false);
    if (!r) return;
    setResult(r);
    onSent?.(r);
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={result ? undefined : draft ? "Send this bug report" : "Report a problem"}
      description={
        result
          ? undefined
          : draft
            ? draft.title
            : "Tell us what went wrong. It goes straight to the Yo team, no account needed."
      }
      hideClose={busy || !!result}
      className="w-[min(560px,calc(100vw-32px))]"
      testId="bug-report-dialog"
    >
      {result ? (
        <Done result={result} onClose={() => onOpenChange(false)} />
      ) : (
        <>
          <div className="max-h-[60vh] space-y-3.5 overflow-y-auto px-5 pt-3 pb-4">
            {!draft && (
              <>
                <Field label="What happened?">
                  <Textarea
                    autoFocus
                    value={what}
                    onChange={(e) => setWhat(e.target.value)}
                    placeholder="e.g. I asked Yo to add a reminder and nothing happened."
                    maxLength={10_000}
                    data-testid="bug-what"
                    className="min-h-24"
                  />
                </Field>
                <Field label="What did you expect? (optional)">
                  <Textarea
                    value={expected}
                    onChange={(e) => setExpected(e.target.value)}
                    maxLength={5_000}
                    data-testid="bug-expected"
                    className="min-h-14"
                  />
                </Field>
                <Field label="Steps to make it happen again (optional)" hint="One step per line.">
                  <Textarea
                    value={steps}
                    onChange={(e) => setSteps(e.target.value)}
                    placeholder={"Open Settings\nClick Save"}
                    data-testid="bug-steps"
                    className="min-h-14"
                  />
                </Field>
              </>
            )}
            {draft && (
              <p className="text-fg-2 text-sm">
                Your agent's write-up goes with a few details that help fix it. Nothing else is shared.
              </p>
            )}

            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5">
              <input
                type="checkbox"
                checked={includeChat}
                onChange={(e) => setIncludeChat(e.target.checked)}
                data-testid="bug-include-chat"
                className="mt-0.5 size-4 shrink-0 accent-[var(--color-link,#3b82f6)]"
              />
              <span className="min-w-0">
                <span className="block font-medium text-sm">Include recent chat (helps us fix it)</span>
                <span className="block text-muted text-xs">
                  The last 30 messages and steps of {draft ? "this" : "your current"} chat, with passwords,
                  keys, emails and personal folders removed.
                </span>
              </span>
            </label>

            <div className="rounded-xl border border-border">
              <button
                type="button"
                onClick={() => setShowPreview((s) => !s)}
                disabled={!ready}
                aria-expanded={showPreview}
                data-testid="bug-preview-toggle"
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left font-medium text-sm disabled:text-muted"
              >
                <FileText className="size-4 text-muted" />
                What's sent
                <ChevronDown
                  className={cn(
                    "ml-auto size-4 text-muted transition-transform",
                    showPreview && "rotate-180",
                  )}
                />
              </button>
              {showPreview && ready && (
                <div data-testid="bug-preview" className="space-y-2.5 border-border border-t px-3 py-2.5">
                  {!preview ? (
                    <span className="flex items-center gap-2 text-muted text-sm">
                      <Spinner /> Putting it together…
                    </span>
                  ) : (
                    <>
                      <ul className="space-y-1 text-sm">
                        {preview.files.map((f) => (
                          <li
                            key={f.name}
                            className="flex items-baseline gap-2"
                            data-testid="bug-preview-file"
                          >
                            <code className="font-mono text-[12.5px]">{f.name}</code>
                            <span className="min-w-0 flex-1 truncate text-muted text-xs">
                              {FILE_NOTES[f.name] ?? ""}
                            </span>
                            <span className="shrink-0 text-faint text-xs tabular-nums">
                              {sizeLabel(f.bytes)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <pre
                        data-testid="bug-preview-report"
                        className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg/50 px-3 py-2 font-mono text-[11.5px] text-fg-2 leading-relaxed"
                      >
                        {preview.reportMd}
                      </pre>
                      <p className="text-muted text-xs">
                        Removed before sending: passwords, keys and tokens, emails, your home folder's name,
                        private network addresses and phone links. Reports are encrypted so only the Yo team
                        can read them.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-border border-t bg-bg/30 px-5 py-3.5">
            <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="brand"
              disabled={busy || !ready}
              onClick={() => void sendIt()}
              data-testid="bug-send"
            >
              {busy ? <Spinner /> : <Bug className="size-3.5" />}
              {busy ? "Sending…" : "Send"}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Done({ result, onClose }: { result: BugReportSent; onClose: () => void }) {
  const ok = result.status === "sent" || result.status === "filed";
  return (
    <div data-testid="bug-sent" data-status={result.status} className="px-5 pt-6 pb-5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-full",
            ok ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
          )}
        >
          {ok ? <Check className="size-4.5" strokeWidth={2.5} /> : <Clock className="size-4.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-lg tracking-[-0.01em]">
            {ok ? "Report sent" : "Report saved"}
          </div>
          <p className="mt-1 text-fg-2 text-sm" data-testid="bug-sent-message">
            {sentMessage(result)}
          </p>
          {result.status === "failed" && result.fallbackUrl && (
            <a
              href={result.fallbackUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="bug-sent-github"
              className="mt-2 inline-flex items-center gap-1.5 text-link-ink text-sm hover:underline"
            >
              Open on GitHub instead <ExternalLink className="size-3.5" />
            </a>
          )}
          {result.status === "failed" && result.fallbackUrl && (
            <p className="mt-1 text-muted text-xs" data-testid="bug-github-public">
              {GITHUB_PUBLIC}
            </p>
          )}
        </div>
      </div>
      <div className="mt-5 flex justify-end">
        <Button variant="brand" onClick={onClose} data-testid="bug-sent-close">
          Done
        </Button>
      </div>
    </div>
  );
}
