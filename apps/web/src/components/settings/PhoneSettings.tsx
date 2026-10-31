/**
 * Settings → Phone: Yo Phone, a web app for texting Yo from any phone (docs/phone/PROTOCOL.md). Core makes a
 * link that carries the key; the owner opens it on the phone and adds it to the Home Screen. A new link (or
 * Turn off) revokes the old one.
 */
import type { PhoneStatus } from "@yo/contracts";
import { ChevronRight, Copy, QrCode, Share, ShieldAlert, Smartphone } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { qrSvg } from "../../lib/qr";
import { ago, cn } from "../../lib/utils";
import { run } from "../../stores/sync";
import { Button } from "../ui/button";
import { Badge, Input, Spinner } from "../ui/controls";
import { Group, H } from "./parts";

/** How often the status refreshes: often while a new link waits for the phone, slowly otherwise. */
const REFRESH_MS = 15_000;
const WAITING_REFRESH_MS = 3_000;

function statusLine(s: PhoneStatus): {
  tone: "neutral" | "warning" | "success";
  badge: string;
  text: string;
} {
  if (!s.enabled) return { tone: "neutral", badge: "Off", text: "No phone link yet." };
  if (!s.lastPhoneAt)
    return { tone: "warning", badge: "Link ready", text: "Link ready — waiting for the phone" };
  return {
    tone: "success",
    badge: "Connected",
    text: `Connected · last seen ${ago(s.lastPhoneAt)}${s.device ? ` · ${s.device}` : ""}`,
  };
}

/** The ready-made prompt for "Let Yo do it". */
export const PHONE_PROMPT = "Set up Yo Phone on my phone.";

/** A phone link is personal: whoever holds it acts as the owner. */
const WARNING =
  "This link is your Yo in your pocket. Keep it to yourself: anyone with it can talk to Yo as you, including your chats, files and approvals. Turn it off anytime.";

/** Copy text, with a toast either way. */
async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Couldn't copy. Select the text and copy it yourself.");
  }
}

/** Summary of docs/phone/GUIDE.md. */
const HOW_IT_WORKS = [
  "Make a link here with Create phone link, or let Yo do it. Yo asks for your OK first.",
  "Send the link to your own phone. Open it there, then tap Share → Add to Home Screen → Add.",
  "Open Yo from the Home Screen and text it like a person. Yes-or-no questions show up as Approve / Deny cards, and Stop stops what Yo is doing.",
  "Driving mode: tap Drive, tap the microphone and talk. Yo sends it 3 seconds after you stop and reads its replies out loud. Set it up before you drive.",
  "To turn it off, tap Turn off or New link here, or ask Yo. The old link stops working right away.",
];

/** The phone link as a QR code. Always dark on white, whatever the theme: some scanners can't read light-on-dark. */
function LinkQr({ link }: { link: string }) {
  const qr = useMemo(() => qrSvg(link), [link]);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 px-1" data-testid="phone-qr">
      <svg
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        shapeRendering="crispEdges"
        role="img"
        aria-label="QR code of the phone link"
        className="size-48 shrink-0 rounded-[10px] border border-border"
        data-testid="phone-qr-code"
      >
        <rect width={qr.size} height={qr.size} fill="#fff" />
        <path d={qr.path} fill="#000" />
      </svg>
      <p className="min-w-0 flex-1 basis-40 text-fg-2 text-sm">Scan with the Yo app or your iPhone Camera.</p>
    </div>
  );
}

export function PhoneSettings() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [busy, setBusy] = useState<"pair" | "off" | null>(null);
  const [confirm, setConfirm] = useState<"pair" | "off" | null>(null);
  const [howOpen, setHowOpen] = useState(false);
  // The QR code is the secret on screen, so it's hidden until asked for. It belongs to one link: a new link (or
  // Turn off) hides it again, and so does leaving the section, which unmounts this component.
  const [qrFor, setQrFor] = useState<string | null>(null);
  const qrShown = !!status?.link && qrFor === status.link;

  const load = useCallback(async (quiet = false) => {
    const s = quiet
      ? await api()
          .call("channels.phone.status", {})
          .catch(() => null)
      : await run(api().call("channels.phone.status", {}), "Couldn't load phone settings");
    if (s) setStatus(s);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // "Last seen" and "waiting for the phone" change on their own.
  const waiting = !!status?.enabled && !status.lastPhoneAt;
  useEffect(() => {
    const t = window.setInterval(() => void load(true), waiting ? WAITING_REFRESH_MS : REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load, waiting]);

  const pair = async () => {
    setBusy("pair");
    const r = await run(api().call("channels.phone.pair", {}), "Couldn't make a phone link");
    setBusy(null);
    setConfirm(null);
    if (!r) return;
    await load(true);
    toast.success(status?.enabled ? "New link made. The old one no longer works." : "Phone link ready");
  };

  const off = async () => {
    setBusy("off");
    const s = await run(api().call("channels.phone.off", {}), "Couldn't turn off Yo Phone");
    setBusy(null);
    setConfirm(null);
    if (!s) return;
    setStatus(s);
    toast.success("Yo Phone is off. The link no longer works.");
  };

  const copy = async () => {
    if (status?.link) await copyText(status.link, "Link copied");
  };

  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const share = async () => {
    if (!status?.link) return;
    try {
      await navigator.share({ title: "Yo", text: "Text Yo from this phone", url: status.link });
    } catch {
      // Closed the share sheet: nothing to do.
    }
  };

  const line = status ? statusLine(status) : null;

  // Yo Phone needs Yo's relay key, which only invited copies of Yo have for now. Everyone else gets a plain
  // "coming soon" instead of a link they can't make (an existing link keeps working and can still be turned off).
  if (status && !status.registerKeySet && !status.enabled)
    return (
      <div data-testid="phone-settings">
        <H desc="Text Yo from your own phone.">Phone</H>
        <div className="rounded-[14px] border border-border bg-card shadow-card p-4">
          <div className="flex items-start gap-3">
            <Smartphone className="mt-0.5 size-5 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 font-medium">
                Yo Phone <Badge>Coming soon</Badge>
              </div>
              <p className="mt-1 text-muted text-sm" data-testid="phone-key-missing">
                Texting Yo from your phone isn't open to everyone yet. It will turn on here in a future
                update, with nothing for you to install.
              </p>
            </div>
          </div>
        </div>
      </div>
    );

  return (
    <div data-testid="phone-settings">
      <H desc="Text Yo from your own phone. Open the link on your phone and add it to the Home Screen.">
        Phone
      </H>

      <div className="rounded-[14px] border border-border bg-card shadow-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Smartphone className="size-5 shrink-0 text-muted" />
          <div className="min-w-0 flex-1 basis-48">
            <div className="flex flex-wrap items-center gap-x-2 font-medium">
              Yo Phone
              {line && <Badge tone={line.tone}>{line.badge}</Badge>}
            </div>
            <div className="text-muted text-sm" data-testid="phone-status">
              {line?.text ?? "Loading…"}
            </div>
          </div>
          {status &&
            (confirm === "pair" ? (
              <div className="flex items-center gap-2">
                <span className="text-muted text-sm">The old link will stop working.</span>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!!busy}
                  onClick={pair}
                  data-testid="phone-new-link-confirm"
                >
                  {busy === "pair" ? <Spinner /> : null} New link
                </Button>
                <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </div>
            ) : status.enabled ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={!!busy}
                onClick={() => setConfirm("pair")}
                data-testid="phone-new-link"
              >
                New link
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={!!busy || !status.registerKeySet}
                onClick={pair}
                data-testid="phone-create"
              >
                {busy === "pair" ? <Spinner /> : null} Create phone link
              </Button>
            ))}
        </div>
        {status?.revokePending && (
          <p className="mt-3 text-warning text-sm" data-testid="phone-revoke-pending">
            Couldn't turn off the old link yet. Retrying.
          </p>
        )}
        {status?.lastError && (
          <p className="mt-3 text-danger text-sm" data-testid="phone-error">
            {status.lastError}
          </p>
        )}
      </div>

      <Group title="Let Yo do it" testId="phone-ask-yo">
        <p className="mb-3 px-1 text-muted text-sm">
          Paste this into Yo's chat on your computer. Yo asks you to approve first, then the link shows up
          here.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="min-w-0 flex-1 basis-60 truncate rounded-[10px] border border-border-strong/60 bg-bg/40 px-3 py-1.5 text-fg-2 text-sm"
            data-testid="phone-prompt"
          >
            {PHONE_PROMPT}
          </div>
          <Button onClick={() => copyText(PHONE_PROMPT, "Prompt copied")} data-testid="phone-prompt-copy">
            <Copy className="size-3.5" /> Copy
          </Button>
        </div>
      </Group>

      {status?.enabled && status.link && (
        <Group title="Phone link">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              readOnly
              value={status.link}
              aria-label="Phone link"
              data-testid="phone-link"
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 basis-60 font-mono text-xs"
            />
            <Button variant="primary" onClick={copy} data-testid="phone-copy">
              <Copy className="size-3.5" /> Copy link
            </Button>
            {canShare && (
              <Button onClick={share} data-testid="phone-share">
                <Share className="size-3.5" /> Share
              </Button>
            )}
            <Button
              aria-expanded={qrShown}
              onClick={() => setQrFor(qrShown ? null : (status.link ?? null))}
              data-testid="phone-qr-toggle"
            >
              <QrCode className="size-3.5" /> {qrShown ? "Hide" : "Show QR code"}
            </Button>
          </div>
          {qrShown && <LinkQr link={status.link} />}
          <p className="mt-3 flex items-start gap-2 px-1 text-sm text-warning" data-testid="phone-warning">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            {WARNING}
          </p>
        </Group>
      )}

      {!status?.enabled && (
        <p className="mt-4 flex items-start gap-2 px-1 text-muted text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          {WARNING}
        </p>
      )}

      {status?.enabled && (
        <Group title="Turn off">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 px-1 text-muted text-sm">
              Stops Yo Phone. The link stops working and the phone can't text Yo anymore.
            </p>
            {confirm === "off" ? (
              <>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={!!busy}
                  onClick={off}
                  data-testid="phone-off-confirm"
                >
                  {busy === "off" ? <Spinner /> : null} Turn off
                </Button>
                <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={!!busy}
                onClick={() => setConfirm("off")}
                data-testid="phone-off"
              >
                Turn off
              </Button>
            )}
          </div>
        </Group>
      )}

      <section className="mt-7" data-testid="phone-how">
        <button
          type="button"
          aria-expanded={howOpen}
          onClick={() => setHowOpen((o) => !o)}
          className="flex items-center gap-1 px-1 font-medium text-2xs text-muted uppercase tracking-[0.08em] transition-colors hover:text-fg"
          data-testid="phone-how-toggle"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", howOpen && "rotate-90")} />
          How it works
        </button>
        {howOpen && (
          <div className="mt-2.5 rounded-[14px] border border-border bg-card p-4 text-sm shadow-card">
            <ol className="list-decimal space-y-1.5 pl-5 text-fg-2">
              {HOW_IT_WORKS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="mt-3 border-border border-t pt-3 text-muted">
              Messages are end-to-end encrypted, so the relay in the middle can't read them, and your computer
              stays closed to the internet. Yo signs its replies, so the phone only shows what your Yo wrote.
              The link is the key: whoever has it talks to Yo as you.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
