/**
 * Settings → Browsers & apps: everything that can open this Yo (the Mac app, browsers signed in with a link), with
 * Rename and Sign out, and "Sign in another browser" (a one-time link + QR code). See lib/browserAuth.ts.
 */
import type { SignedInClient, SignInLink } from "@yo/contracts";
import { Check, Copy, Globe, LaptopMinimal, Link2, Pencil } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { ownControllerId, signInLinkUrl, signOutThisBrowser, useBrowserAuth } from "../../lib/browserAuth";
import { copyText } from "../../lib/clipboard";
import { friendlyError } from "../../lib/connection";
import { clientIsWindows } from "../../lib/platform";
import { qrSvg } from "../../lib/qr";
import { useNow } from "../../lib/useNow";
import { ago } from "../../lib/utils";
import { useUI } from "../../stores/ui";
import { CopyBox } from "../connect/parts";
import { Button } from "../ui/button";
import { Badge, Input, Spinner } from "../ui/controls";
import { Group, H } from "./parts";

/** While a new link waits to be used, the list refreshes this often (core pushes nothing when a browser signs in). */
const WAITING_REFRESH_MS = 3_000;

/** A link to localhost/127.0.0.1 only opens on the computer running Yo. */
function thisMachineOnly(link: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(link).hostname);
  } catch {
    return false;
  }
}

function LinkQr({ link }: { link: string }) {
  const qr = useMemo(() => qrSvg(link), [link]);
  return (
    <svg
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code of the sign-in link"
      className="size-40 shrink-0 rounded-[10px] border border-border"
      data-testid="signin-link-qr"
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.path} fill="#000" />
    </svg>
  );
}

function ClientRow({
  client,
  self,
  selfLabel,
  canSignOutSelf,
  onChanged,
}: {
  client: SignedInClient;
  self: boolean;
  selfLabel: string;
  canSignOutSelf: boolean;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "rename" | "confirm">("idle");
  const [name, setName] = useState(client.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browser = !/\bapp\b/i.test(client.label);

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api().call("auth.clients.rename", { id: client.id, label: name.trim() });
      setMode("idle");
      onChanged();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      if (self) {
        await signOutThisBrowser();
        // Signed back in later, Yo opens on the chat, not on Settings.
        useUI.setState({ settingsOpen: false });
      } else {
        await api().call("auth.clients.revoke", { id: client.id });
        onChanged();
      }
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-3" data-testid={`client-${client.id}`} data-self={self || undefined}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-elevated">
          {browser ? (
            <Globe className="size-4 text-muted" />
          ) : (
            <LaptopMinimal className="size-4 text-muted" />
          )}
        </div>
        <div className="min-w-0 flex-1 basis-40">
          {mode === "rename" ? (
            <form className="flex items-center gap-2" onSubmit={rename}>
              <Input
                value={name}
                autoFocus
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                aria-label="Name"
                data-testid="client-rename-input"
                className="h-8"
              />
              <Button
                type="submit"
                size="sm"
                variant="primary"
                disabled={busy}
                data-testid="client-rename-save"
              >
                {busy ? <Spinner /> : <Check className="size-3.5" />} Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMode("idle");
                  setName(client.label);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-2 font-medium">
                <span className="truncate" data-testid="client-label">
                  {client.label}
                </span>
                {self && (
                  <span data-testid="client-self">
                    <Badge tone="success">{selfLabel}</Badge>
                  </span>
                )}
              </div>
              <div className="text-muted text-sm">
                {self
                  ? "In use now"
                  : client.lastUsedAt
                    ? `Last used ${ago(client.lastUsedAt)}`
                    : "Not used yet"}
                {" · "}signed in {ago(client.createdAt)}
              </div>
            </>
          )}
        </div>
        {mode === "idle" && (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setName(client.label);
                setMode("rename");
              }}
              data-testid={`client-rename-${client.id}`}
            >
              <Pencil className="size-3.5" /> Rename
            </Button>
            {(!self || canSignOutSelf) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setMode("confirm")}
                data-testid={`client-signout-${client.id}`}
              >
                Sign out
              </Button>
            )}
          </div>
        )}
      </div>
      {mode === "confirm" && (
        <div
          className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-elevated px-3 py-2.5 text-sm"
          data-testid="client-signout-confirm-row"
        >
          <span className="min-w-0 flex-1 basis-48 text-fg-2">
            {self
              ? "Sign out this browser? You'll need a new sign-in link to open Yo here again."
              : `Sign out ${client.label}? It closes right away and needs a new sign-in link to open Yo again.`}
          </span>
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={signOut}
            data-testid="client-signout-confirm"
          >
            {busy ? <Spinner /> : null} Sign out
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode("idle")}>
            Cancel
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-danger text-sm" data-testid="client-error">
          {error}
        </p>
      )}
    </div>
  );
}

function NewLink({ link, onNew, busy }: { link: SignInLink; onNew: () => void; busy: boolean }) {
  const url = signInLinkUrl(link.token);
  const expired = useNow(5000) >= link.expiresAt;
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="mt-3 rounded-[14px] border border-border bg-card p-4 shadow-card"
      data-testid="signin-link-panel"
    >
      {expired ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-muted text-sm" data-testid="signin-link-expired">
            This link has expired.
          </p>
          <Button size="sm" variant="primary" disabled={busy} onClick={onNew}>
            {busy ? <Spinner /> : null} Make a new link
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              readOnly
              value={url}
              aria-label="Sign-in link"
              data-testid="signin-link"
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 basis-60 font-mono text-xs"
            />
            <Button
              variant="primary"
              onClick={async () => {
                setCopied(await copyText(url));
                setTimeout(() => setCopied(false), 1600);
              }}
              data-testid="signin-link-copy"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{" "}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            {/* A phone can't open a link to this PC's own address, so no QR code for those. */}
            {!thisMachineOnly(url) && <LinkQr link={url} />}
            <div className="min-w-0 flex-1 basis-48 space-y-1.5 text-fg-2 text-sm">
              <p className="font-medium" data-testid="signin-link-rules">
                Works once, for 10 minutes.
              </p>
              <p className="text-muted">
                {thisMachineOnly(url)
                  ? "Open it in the other browser on this computer. "
                  : "Open it in the browser you want to sign in. "}
                Anyone with this link can sign in to your Yo until it's used, so send it only to yourself.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function BrowsersSettings() {
  const browserMode = useBrowserAuth((s) => s.browserMode);
  const selfId = useBrowserAuth((s) => s.controllerId);
  const helper = useBrowserAuth((s) => s.info?.helperCommand ?? null);
  const pc = useBrowserAuth((s) => s.info?.edition === "pc");
  const [clients, setClients] = useState<SignedInClient[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [link, setLink] = useState<SignInLink | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setClients(await api().call("auth.clients.list", {}));
      setLoadError(null);
    } catch (e) {
      setLoadError(friendlyError(e));
    }
  }, []);

  useEffect(() => {
    void load();
    void ownControllerId();
  }, [load]);

  // A browser signing in with the new link shows up here on its own.
  const waiting = !!link && link.expiresAt > Date.now();
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => void load(), WAITING_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [waiting, load]);

  const makeLink = async () => {
    setLinkBusy(true);
    setLinkError(null);
    try {
      setLink(await api().call("auth.signInLink.create", {}));
    } catch (e) {
      setLinkError(friendlyError(e));
    } finally {
      setLinkBusy(false);
    }
  };

  return (
    <div data-testid="browsers-settings">
      <H desc="The apps and browsers that can open your Yo. Sign out any you don't use any more.">
        Browsers & apps
      </H>

      <div className="rounded-[14px] border border-border bg-card shadow-card">
        {loadError ? (
          <p className="px-4 py-3.5 text-danger text-sm" data-testid="clients-error">
            {loadError}
          </p>
        ) : !clients ? (
          <div className="flex items-center gap-2 px-4 py-3.5 text-muted text-sm">
            <Spinner /> Loading…
          </div>
        ) : clients.length === 0 ? (
          <p className="px-4 py-3.5 text-muted text-sm">Nothing is signed in yet.</p>
        ) : (
          <div className="divide-y divide-border" data-testid="clients">
            {clients.map((c) => (
              <ClientRow
                key={`${c.id}:${c.label}`}
                client={c}
                self={c.id === selfId}
                selfLabel={browserMode ? "This browser" : "This app"}
                // The Mac app signs in from its main process; signing it out here would only strand it.
                canSignOutSelf={browserMode}
                onChanged={load}
              />
            ))}
          </div>
        )}
      </div>

      <Group title="Sign in another browser" testId="signin-another">
        <p className="mb-3 px-1 text-muted text-sm">
          Make a one-time link, then open it in the other browser (Chrome, Edge or Firefox).
          {pc && helper ? (
            <>
              {" "}
              On the PC running Yo you can also {clientIsWindows() ? "choose Yo in the Start menu, or " : ""}
              run <code className="font-mono text-fg-2">{helper} signin</code>.
            </>
          ) : null}
        </p>
        {!link || link.expiresAt <= Date.now() ? (
          <Button variant="primary" onClick={makeLink} disabled={linkBusy} data-testid="signin-link-create">
            {linkBusy ? <Spinner /> : <Link2 className="size-3.5" />} Sign in another browser
          </Button>
        ) : (
          <Button variant="secondary" onClick={makeLink} disabled={linkBusy} data-testid="signin-link-new">
            {linkBusy ? <Spinner /> : <Link2 className="size-3.5" />} Make a new link
          </Button>
        )}
        {linkError && (
          <p role="alert" className="mt-2 px-1 text-danger text-sm" data-testid="signin-link-error">
            {linkError}
          </p>
        )}
        {link && <NewLink link={link} onNew={makeLink} busy={linkBusy} />}
        {pc && helper && !link && <CopyBox command={`${helper} signin`} testId="browsers-helper-command" />}
      </Group>
    </div>
  );
}
