import {
  type DeviceOperation,
  SECURE_FILL_FAILED,
  type SecureField,
  secureFormAskLine,
  secureFormFailedHint,
  secureFormPasswordCaution,
  secureFormReasonLabel,
  type TimelineEntry,
  type UserQuestion,
} from "@yo/contracts";
import {
  ArrowUp,
  Check,
  CircleHelp,
  CircleX,
  Clock,
  FilePen,
  LockKeyhole,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  TimerOff,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { api } from "../../lib/api";
import { chipText } from "../../lib/ruleLabel";
import { ago, cn, fileSize } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { load, run } from "../../stores/sync";
import { macApp } from "../macApps";
import { Input } from "../ui/controls";
import { DraftText, usePreviousDraft } from "./DraftText";
import { SensitiveWarning } from "./SensitiveWarning";

type Req = NonNullable<TimelineEntry["request"]>;

function Resolved({
  icon,
  children,
  tone,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  tone: string;
}) {
  return (
    <div className="ycard-resolved animate-fade-in">
      <div className={cn("ycard-resolved-icon", tone)}>{icon}</div>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function inputChips(req: Req) {
  const input = (req.input ?? {}) as Record<string, unknown>;
  return Object.entries(input)
    .filter(
      ([k, v]) =>
        ["category", "total", "recipient", "url", "amount", "site", "login"].includes(k) &&
        typeof v === "string",
    )
    .map(([k, v]) => ({ k, v: String(v) }));
}

/** Approvals whose details are the words Yo will send: shown as a draft, with edits highlighted. */
const DRAFT_TOOLS = new Set(["yo:message", "yo:post"]);
const sentDraft = (e: TimelineEntry) =>
  e.request && DRAFT_TOOLS.has(e.request.toolName ?? "") && e.request.detail ? e.request.detail : undefined;

/** A Mail draft card's line (its subject or body), for highlighting what a revised draft changed. */
const mailLine = (label: string) => (e: TimelineEntry) =>
  e.request?.deviceAction?.app === "mail"
    ? e.request.deviceAction.lines.find((l) => l.label === label)?.value
    : undefined;
const mailSubject = mailLine("Subject");
const mailBody = mailLine("Body");

export function ApprovalCard({
  entry,
  agentName,
  compact,
}: {
  entry: TimelineEntry;
  agentName: string;
  compact?: boolean;
}) {
  const req = entry.request!;
  if (req.deviceWrite) return <DeviceWriteCard entry={entry} agentName={agentName} compact={compact} />;
  if (req.deviceAction) return <DeviceActionCard entry={entry} agentName={agentName} compact={compact} />;
  return <ToolApprovalCard entry={entry} agentName={agentName} compact={compact} />;
}

function ToolApprovalCard({
  entry,
  agentName,
  compact,
}: {
  entry: TimelineEntry;
  agentName: string;
  compact?: boolean;
}) {
  const req = entry.request!;
  const [busy, setBusy] = useState<string | null>(null);
  const draft = sentDraft(entry);
  const previousDraft = usePreviousDraft(entry, sentDraft);
  const respond = async (decision: "allow" | "allowAlways" | "deny") => {
    setBusy(decision);
    await run(api().call("request.respond", { agentId: entry.agentId, requestId: req.requestId, decision }));
    setBusy(null);
  };

  if (req.status !== "pending") {
    const map = {
      allowed: {
        icon: <ShieldCheck className="size-3.5" />,
        tone: "bg-success/12 text-success",
        label: "Allowed",
      },
      denied: { icon: <ShieldX className="size-3.5" />, tone: "bg-danger/12 text-danger", label: "Denied" },
      expired: { icon: <TimerOff className="size-3.5" />, tone: "bg-active text-muted", label: "Expired" },
      answered: {
        icon: <Check className="size-3.5" />,
        tone: "bg-success/12 text-success",
        label: "Answered",
      },
    } as const;
    const m = map[req.status as keyof typeof map] ?? map.expired;
    return (
      <Resolved icon={m.icon} tone={m.tone}>
        <span className="font-medium text-fg">{m.label}</span> · {req.title}
      </Resolved>
    );
  }

  const chips = inputChips(req);
  const newAgent = req.toolName === "yo:create_agent";
  const phoneLink = req.toolName === "yo:create_phone_link";
  const phoneOff = req.toolName === "yo:turn_off_phone";
  // Approved one at a time: no "Always allow". Also when something sensitive is in it, so a standing rule can't
  // wave the next one through.
  const onceOnly = newAgent || phoneLink || phoneOff || !!req.sensitive?.length;
  // A 1Password sign-in: "Always allow" is for that one site.
  const site =
    req.toolName === "yo:1password"
      ? String((req.input as Record<string, unknown> | undefined)?.site ?? "")
      : "";
  // What allowing covers, in plain words: nothing happens before the OK.
  const scope =
    String((req.input as Record<string, unknown> | undefined)?.category ?? "") === "purchase"
      ? "Nothing is bought until you allow it."
      : draft
        ? "Nothing is sent until you allow it."
        : "Nothing happens until you allow it.";
  return (
    <div data-testid="approval-card" className={cn("ycard animate-rise", !compact && "ycard-max")}>
      <div className="ycard-head">
        <span className="ycard-icon is-warning">
          <ShieldAlert />
        </span>
        <div className="ycard-body">
          <div className="ycard-eyebrow">{agentName} needs your OK</div>
          <div className="ycard-title">{req.title}</div>
          {draft ? (
            <DraftText text={draft} previous={previousDraft} className="ycard-draft" />
          ) : (
            req.detail && <div className="ycard-detail">{req.detail}</div>
          )}
          {chips.length > 0 && (
            <div className="ycard-tags">
              {chips.map((c) => {
                const t = chipText(c.k, c.v);
                return (
                  <span key={c.k} title={c.v}>
                    {t.label && <span className="text-muted">{t.label}</span>} {t.value}
                  </span>
                );
              })}
            </div>
          )}
          <div className="ycard-scope">{scope}</div>
        </div>
      </div>
      <SensitiveWarning items={req.sensitive} />
      {/* "Always allow" sits apart, on the left, because it changes a rule; the two answers sit together. */}
      <div className="ycard-actions">
        {/* Adding an agent or a phone link is approved one at a time. */}
        {!onceOnly && (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => respond("allowAlways")}
            data-testid="approve-always"
            title={`Let ${agentName} do this without asking next time`}
            className="ycard-pill is-quiet"
          >
            {site ? `Always allow on ${site}` : "Always allow"}
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          className="ycard-pill"
          disabled={!!busy}
          onClick={() => respond("deny")}
          data-testid="approve-deny"
        >
          Refuse
        </button>
        <button
          type="button"
          className="ycard-pill is-primary"
          disabled={!!busy}
          onClick={() => respond("allow")}
          data-testid="approve-once"
        >
          {newAgent ? "Add agent" : phoneLink ? "Create link" : phoneOff ? "Turn off" : "Allow once"}
        </button>
      </div>
    </div>
  );
}

/**
 * After an exact-action approval: the approval is only consent, so what happened comes from the device
 * operation (saved, failed, outcome unknown, or still saving).
 */
function approvedOutcome(
  op: DeviceOperation | undefined,
  checkWhat: string,
): { icon: React.ReactNode; tone: string; label: string } {
  if (op?.status === "succeeded")
    return { icon: <Check className="size-3.5" />, tone: "bg-success/12 text-success", label: "Saved" };
  if (op?.status === "failed" || op?.status === "cancelled")
    return {
      icon: <CircleX className="size-3.5" />,
      tone: "bg-danger/12 text-danger",
      label: `Approved, but not saved${op.reason ? ` (${op.reason})` : ""}`,
    };
  if (op?.status === "unknown-outcome")
    return {
      icon: <TriangleAlert className="size-3.5" />,
      tone: "bg-warning/14 text-warning",
      label: `Outcome unknown — check ${checkWhat}`,
    };
  return { icon: <Clock className="size-3.5" />, tone: "bg-active text-muted", label: "Approved · saving…" };
}

function useNow(everyMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}

function expiryHint(expiresAt: number, now: number) {
  const ms = expiresAt - now;
  if (ms <= 0) return "This request has expired";
  const min = Math.round(ms / 60_000);
  return min < 1 ? "Expires in under a minute" : `Expires in ${min} min`;
}

/**
 * Exact-action approval for a change to a file on the user's Mac. The card shows the precise file and
 * content; approving covers only these bytes (core binds the approval to them). Never "always allow".
 */
function DeviceWriteCard({
  entry,
  agentName,
  compact,
}: {
  entry: TimelineEntry;
  agentName: string;
  compact?: boolean;
}) {
  const req = entry.request!;
  const w = req.deviceWrite!;
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const now = useNow(15_000);
  const op = useApp((s) => s.operations?.find((o) => o.id === w.operationId));
  const allowed = req.status === "allowed";
  useEffect(() => {
    // The approval is only consent; the save's own outcome comes from the operation record.
    if (allowed) void load.operations();
  }, [allowed]);

  const respond = async (decision: "allow" | "deny") => {
    setBusy(decision);
    await run(api().call("request.respond", { agentId: entry.agentId, requestId: req.requestId, decision }));
    setBusy(null);
  };

  const where = (
    <>
      <span className="font-mono text-[12.5px]">{w.displayPath}</span> on {w.deviceName}
    </>
  );

  if (req.status !== "pending") {
    if (req.status === "allowed") {
      const r = approvedOutcome(op, "the file");
      return (
        <Resolved icon={r.icon} tone={r.tone}>
          <span className="font-medium text-fg" data-testid="device-write-result">
            {r.label}
          </span>{" "}
          · {where}
        </Resolved>
      );
    }
    const m =
      req.status === "denied"
        ? { icon: <ShieldX className="size-3.5" />, tone: "bg-danger/12 text-danger", label: "Declined" }
        : { icon: <TimerOff className="size-3.5" />, tone: "bg-active text-muted", label: "Expired" };
    return (
      <Resolved icon={m.icon} tone={m.tone}>
        <span className="font-medium text-fg" data-testid="device-write-result">
          {m.label}
        </span>{" "}
        · {where} · nothing was changed
      </Resolved>
    );
  }

  const expired = w.expiresAt <= now;
  return (
    <div data-testid="device-write-card" className={cn("ycard animate-rise", !compact && "ycard-max")}>
      <div className="ycard-head">
        <span className="ycard-icon is-warning">
          <FilePen />
        </span>
        <div className="ycard-body">
          <div className="ycard-eyebrow">{agentName} wants to change a file on your Mac</div>
          <div className="ycard-title">{req.title}</div>
          <dl className="ycard-lines">
            <dt>File</dt>
            <dd data-testid="device-write-path">{where}</dd>
            <dt>Size</dt>
            <dd className="tabular-nums">{fileSize(w.bytes)}</dd>
            <dt>Effect</dt>
            <dd>
              {w.replaces
                ? `Replaces a ${fileSize(w.replaces.bytes)} file${w.replaces.modifiedAt ? ` modified ${ago(w.replaces.modifiedAt)}` : ""}`
                : "Creates a new file"}
            </dd>
          </dl>
        </div>
      </div>
      <div className="ycard-inset">
        {w.preview != null ? (
          <pre
            // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be reachable by keyboard
            tabIndex={0}
            role="region"
            aria-label={`New content of ${w.displayPath}`}
            data-testid="device-write-preview"
            className="ycard-preview"
          >
            {w.preview}
          </pre>
        ) : (
          <div className="ycard-preview is-empty">Binary file — preview not available</div>
        )}
        {w.preview != null && new TextEncoder().encode(w.preview).length < w.bytes && (
          <div className="ycard-scope">Showing the beginning of the file.</div>
        )}
      </div>
      <div className="ycard-actions">
        <span className="ycard-note" data-testid="device-write-expiry">
          {expiryHint(w.expiresAt, now)}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="ycard-pill"
          disabled={!!busy || expired}
          onClick={() => respond("deny")}
          data-testid="device-write-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          className="ycard-pill is-primary"
          disabled={!!busy || expired}
          onClick={() => respond("allow")}
          data-testid="device-write-save"
        >
          Save file
        </button>
      </div>
    </div>
  );
}

/**
 * Exact-action approval for a change in a Mac app (Calendar, Reminders, Notes, a Mail draft) or for a
 * window session (one window, a few minutes). The card lists exactly what will happen; approving covers
 * only this (core binds the approval to it). Never "always allow".
 */
function DeviceActionCard({
  entry,
  agentName,
  compact,
}: {
  entry: TimelineEntry;
  agentName: string;
  compact?: boolean;
}) {
  const req = entry.request!;
  const a = req.deviceAction!;
  const info = macApp(a.app);
  /** A window session (R3) is an allowance for a few minutes, not a change to save. */
  const screen = a.app === "screen";
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const now = useNow(15_000);
  const op = useApp((s) => s.operations?.find((o) => o.id === a.operationId));
  const previousSubject = usePreviousDraft(entry, mailSubject);
  const previousBody = usePreviousDraft(entry, mailBody);
  const allowed = req.status === "allowed";
  useEffect(() => {
    // The approval is only consent; the change's own outcome comes from the operation record.
    if (allowed) void load.operations();
  }, [allowed]);

  const respond = async (decision: "allow" | "deny") => {
    setBusy(decision);
    await run(api().call("request.respond", { agentId: entry.agentId, requestId: req.requestId, decision }));
    setBusy(null);
  };

  if (req.status !== "pending") {
    const r =
      req.status === "allowed"
        ? screen
          ? {
              icon: <ShieldCheck className="size-3.5" />,
              tone: "bg-success/12 text-success",
              label: "Allowed",
            }
          : approvedOutcome(op, info.label)
        : req.status === "denied"
          ? { icon: <ShieldX className="size-3.5" />, tone: "bg-danger/12 text-danger", label: "Declined" }
          : { icon: <TimerOff className="size-3.5" />, tone: "bg-active text-muted", label: "Expired" };
    return (
      <Resolved icon={r.icon} tone={r.tone}>
        <span className="font-medium text-fg" data-testid="device-action-result">
          {r.label}
        </span>{" "}
        · {req.title}
        {req.status !== "allowed"
          ? screen
            ? " · Yo didn't use the window"
            : ` · ${info.label} wasn't changed`
          : ""}
      </Resolved>
    );
  }

  const expired = a.expiresAt <= now;
  // Window sessions: "Allow for 10 min", from the card's own "Time" line ("Up to 10 min").
  const minutes = screen
    ? a.lines.find((l) => l.label === "Time")?.value.match(/(\d+)\s*min/)?.[1]
    : undefined;
  const heading = screen
    ? `${agentName} wants to use a window on your Mac`
    : a.app === "mail"
      ? `${agentName} wants to save a draft in Mail on your Mac`
      : `${agentName} wants to change ${info.label} on your Mac`;
  return (
    <div data-testid="device-action-card" className={cn("ycard animate-rise", !compact && "ycard-max")}>
      <div className="ycard-head">
        <span className="ycard-icon is-warning">
          <info.icon aria-hidden />
        </span>
        <div className="ycard-body">
          <div className="ycard-eyebrow" data-testid="device-action-heading">
            {heading}
          </div>
          <div className="ycard-title">{req.title}</div>
          <dl className="ycard-lines is-wide" data-testid="device-action-lines">
            {a.lines.map((l, i) => (
              // Labels can repeat, so the position keeps keys unique (the list never reorders).
              <div key={`${i}-${l.label}`} className="contents">
                <dt>{l.label}</dt>
                {a.app === "mail" && (l.label === "Subject" || l.label === "Body") ? (
                  <dd>
                    <DraftText
                      text={l.value}
                      previous={l.label === "Subject" ? previousSubject : previousBody}
                    />
                  </dd>
                ) : (
                  <dd className="whitespace-pre-wrap">{l.value}</dd>
                )}
              </div>
            ))}
          </dl>
        </div>
      </div>
      <div className="ycard-actions">
        <span className="ycard-note" data-testid="device-action-expiry">
          {expiryHint(a.expiresAt, now)}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="ycard-pill"
          disabled={!!busy || expired}
          onClick={() => respond("deny")}
          data-testid="device-action-cancel"
        >
          {screen ? "Don't allow" : "Cancel"}
        </button>
        <button
          type="button"
          className="ycard-pill is-primary"
          disabled={!!busy || expired}
          onClick={() => respond("allow")}
          data-testid="device-action-save"
        >
          {screen ? (minutes ? `Allow for ${minutes} min` : "Allow") : info.saveLabel}
        </button>
      </div>
    </div>
  );
}

/** A card waiting on the user's input: a secure form, or a question. */
export function AskUserCard({ entry, agentName }: { entry: TimelineEntry; agentName: string }) {
  if (entry.request?.secureForm) return <SecureFormCard entry={entry} agentName={agentName} />;
  return <QuestionCard entry={entry} agentName={agentName} />;
}

/** How each kind of secure field is typed: the right keyboard on a phone, autofill hints, hidden or not. */
function secureInputProps(f: SecureField): React.InputHTMLAttributes<HTMLInputElement> {
  switch (f.kind) {
    case "one_time_code":
      return { type: "text", inputMode: "numeric", autoComplete: "one-time-code" };
    case "password":
      return { type: "password", autoComplete: "current-password" };
    case "username":
      return { type: "text", autoComplete: "username", autoCapitalize: "none" };
    case "email":
      return { type: "email", autoComplete: "email", autoCapitalize: "none" };
    case "phone":
      return { type: "tel", autoComplete: "tel" };
    default:
      return { type: "text", autoComplete: "off" };
  }
}

/**
 * A secure form (request_secure_input): the user types a code, password or other private value here and Yo
 * types it straight into the page. The key line (who is asking, and the real page host) is app text. The
 * agent's reason sits apart from it. Values go to core once and are never shown again.
 */
function SecureFormCard({ entry, agentName }: { entry: TimelineEntry; agentName: string }) {
  const req = entry.request!;
  const form = req.secureForm!;
  const [values, setValues] = useState<string[]>(() => form.fields.map(() => ""));
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const ready = values.every((v) => v.trim());
  const id = useId();
  const password = form.fields.some((f) => f.kind === "password");

  const respond = async (decision: "allow" | "deny") => {
    if (decision === "allow" && !ready) return;
    setBusy(decision);
    await run(
      api().call("request.respond", {
        agentId: entry.agentId,
        requestId: req.requestId,
        decision,
        ...(decision === "allow" ? { secureValues: values } : {}),
      }),
    );
    // Don't keep them around once sent (on an error the card stays open, empty, to try again).
    setValues(form.fields.map(() => ""));
    setBusy(null);
  };

  if (req.status !== "pending") {
    if (req.status === "failed") {
      return (
        <Resolved icon={<TriangleAlert className="size-3.5" />} tone="bg-warning/15 text-warning">
          <span className="font-medium text-fg" data-testid="secure-form-result">
            {SECURE_FILL_FAILED}
          </span>{" "}
          · {secureFormFailedHint(agentName)} · Secure form for {form.site}
        </Resolved>
      );
    }
    const r =
      req.status === "answered" || req.status === "allowed"
        ? {
            icon: <ShieldCheck className="size-3.5" />,
            tone: "bg-success/12 text-success",
            label: "Submitted",
          }
        : req.status === "denied"
          ? { icon: <ShieldX className="size-3.5" />, tone: "bg-active text-muted", label: "Cancelled" }
          : { icon: <TimerOff className="size-3.5" />, tone: "bg-active text-muted", label: "Expired" };
    return (
      <Resolved icon={r.icon} tone={r.tone}>
        <span className="font-medium text-fg" data-testid="secure-form-result">
          {r.label}
        </span>{" "}
        · Secure form for {form.site}
      </Resolved>
    );
  }

  return (
    <form
      data-testid="secure-form-card"
      className="ycard ycard-max animate-rise"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        void respond("allow");
      }}
    >
      <div className="ycard-head">
        <span className="ycard-icon is-lock">
          <LockKeyhole />
        </span>
        <div className="ycard-body">
          <div className="ycard-eyebrow is-plain">Secure form</div>
          <div className="ycard-title" data-testid="secure-form-ask">
            {secureFormAskLine(agentName, form.site)}
          </div>
          {password && (
            <div className="ycard-warning" data-testid="secure-form-caution">
              <TriangleAlert aria-hidden />
              <span>{secureFormPasswordCaution(form.site)}</span>
            </div>
          )}
          {form.reason && (
            <div className="ycard-quote" data-testid="secure-form-reason">
              <div className="ycard-quote-label">{secureFormReasonLabel(agentName)}</div>
              <p>{form.reason}</p>
            </div>
          )}
        </div>
      </div>
      <div className="ycard-fields">
        {form.fields.map((f, i) => (
          <div key={`${i}-${f.label}`} className="ycard-field">
            <label htmlFor={`${id}-${i}`}>{f.label}</label>
            <Input
              id={`${id}-${i}`}
              {...secureInputProps(f)}
              value={values[i] ?? ""}
              onChange={(e) => setValues((all) => all.map((v, j) => (j === i ? e.target.value : v)))}
              disabled={!!busy}
              spellCheck={false}
              data-testid="secure-form-input"
            />
          </div>
        ))}
      </div>
      <div className="ycard-actions">
        <span className="ycard-note">
          Goes straight into {form.site}. {agentName} never sees it.
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="ycard-pill"
          disabled={!!busy}
          onClick={() => respond("deny")}
          data-testid="secure-form-cancel"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="ycard-pill is-primary"
          disabled={!ready || !!busy}
          data-testid="secure-form-submit"
        >
          Submit
        </button>
      </div>
    </form>
  );
}

/**
 * A question from the agent: every question it asked (one card for all of them), with its options as lettered
 * choices. "Pick any" questions take several picks; one plain question answers on the first tap.
 */
function QuestionCard({ entry, agentName }: { entry: TimelineEntry; agentName: string }) {
  const req = entry.request!;
  const qs: UserQuestion[] = req.questions?.length
    ? req.questions
    : [{ question: req.title, options: [], multiSelect: false }];
  const [picks, setPicks] = useState<string[][]>(() => qs.map(() => []));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // One question with one choice: a tap is the answer. Otherwise the picks go together with "Send".
  const instant = qs.length === 1 && !qs[0]!.multiSelect;
  const typed = text.trim();
  // A typed reply answers whatever wasn't picked.
  const answerOf = (i: number, chosen = picks[i]!) => (chosen.length ? chosen.join(", ") : typed);
  const ready = qs.every((_, i) => answerOf(i));

  const send = async (chosen = picks) => {
    const answers: Record<string, string> = {};
    qs.forEach((x, i) => {
      answers[x.question] = answerOf(i, chosen[i]!);
    });
    if (Object.values(answers).some((v) => !v)) return;
    setBusy(true);
    await run(
      api().call("request.respond", {
        agentId: entry.agentId,
        requestId: req.requestId,
        decision: "allow",
        answers,
        message: Object.values(answers).join("; "),
      }),
    );
    setBusy(false);
  };

  const pick = (qi: number, label: string) => {
    if (instant) return void send([[label]]);
    setPicks((all) =>
      all.map((cur, i) => {
        if (i !== qi) return cur;
        if (!qs[qi]!.multiSelect) return cur[0] === label ? [] : [label];
        return cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label];
      }),
    );
  };

  if (req.status !== "pending") {
    const input = req.input as { message?: string; answers?: Record<string, string> } | undefined;
    const answers = req.answers ?? input?.answers;
    const rows = qs
      .map((x) => ({ q: x.question, a: answers?.[x.question] }))
      .filter((r, i) => r.a || i === 0);
    if (rows.length === 1 && !rows[0]!.a) rows[0]!.a = input?.message ?? Object.values(answers ?? {})[0];
    return (
      <Resolved icon={<CircleHelp className="size-3.5" />} tone="bg-active text-muted">
        <span className="flex flex-col gap-0.5" data-testid="ask-answered">
          {rows.map((r) => (
            <span key={r.q}>
              {r.q}
              {r.a && (
                <>
                  {" "}
                  → <span className="font-medium text-fg">{r.a}</span>
                </>
              )}
            </span>
          ))}
        </span>
      </Resolved>
    );
  }

  return (
    <div data-testid="ask-card" className="ycard ycard-max animate-rise">
      <div className="ycard-head">
        <span className="ycard-icon is-question">
          <CircleHelp />
        </span>
        <div className="ycard-body">
          <div className="ycard-eyebrow is-plain">
            {agentName} is asking
            {qs.length > 1 ? ` · ${qs.length} questions` : qs[0]!.header ? ` · ${qs[0]!.header}` : ""}
          </div>
          <div className="ycard-questions">
            {qs.map((x, qi) => (
              <fieldset key={`${qi}-${x.question}`} className="min-w-0" data-testid="ask-question">
                <legend className="contents">
                  {qs.length > 1 && x.header && <span className="ycard-q-header">{x.header}</span>}
                  <span className="ycard-title">{x.question}</span>
                  {x.options.length > 0 && !instant && (
                    <span className="ycard-scope">{x.multiSelect ? "Pick any that apply" : "Pick one"}</span>
                  )}
                </legend>
                {/* Rounded chips in a row that wraps: a tap answers a plain question, otherwise picks. */}
                {x.options.length > 0 && (
                  <div className="ycard-options" role={x.multiSelect ? "group" : "radiogroup"}>
                    {x.options.map((o, oi) => {
                      const on = picks[qi]!.includes(o.label);
                      const body = (
                        <>
                          {on && <Check className="ycard-option-check" strokeWidth={2.6} />}
                          <span className="min-w-0">
                            <span className="font-medium">{o.label}</span>
                            {o.description && <span className="text-muted"> · {o.description}</span>}
                          </span>
                        </>
                      );
                      const props = {
                        type: "button" as const,
                        disabled: busy,
                        onClick: () => pick(qi, o.label),
                        "data-testid": "ask-option",
                        "data-on": on || undefined,
                        className: "ycard-option",
                      };
                      const key = `${oi}-${o.label}`;
                      // A tap answers a plain question; otherwise each option is a checkbox or a radio button.
                      return instant ? (
                        <button key={key} {...props}>
                          {body}
                        </button>
                      ) : x.multiSelect ? (
                        <button key={key} role="checkbox" aria-checked={on} {...props}>
                          {body}
                        </button>
                      ) : (
                        <button key={key} role="radio" aria-checked={on} {...props}>
                          {body}
                        </button>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            ))}
          </div>
        </div>
      </div>
      <form
        className="ycard-answer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            qs.every((x) => !x.options.length)
              ? "Type your answer…"
              : instant
                ? "Or type your own answer…"
                : "Add your own answer (optional)…"
          }
          aria-label="Your answer"
        />
        {instant ? (
          <button type="submit" className="ycard-send" disabled={!typed || busy} aria-label="Send answer">
            <ArrowUp />
          </button>
        ) : (
          <button
            type="submit"
            className="ycard-pill is-primary"
            disabled={!ready || busy}
            data-testid="ask-send"
          >
            Send {qs.length > 1 ? "answers" : "answer"}
          </button>
        )}
      </form>
    </div>
  );
}
