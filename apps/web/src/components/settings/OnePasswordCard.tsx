/**
 * Settings → Accounts → 1Password: connect a 1Password service account limited to the vault(s) Yo may use. Yo
 * then signs in to sites with those logins: it types them into its own browser and asks the user the first time
 * on each site. The token is write-only here (core keeps it in its secret storage); the card shows the vaults Yo
 * can see and the last few sign-ins, never a value.
 */
import { fieldList, type OnePasswordStatus } from "@yo/contracts";
import { ChevronRight, ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { ago, cn } from "../../lib/utils";
import { run } from "../../stores/sync";
import { Button } from "../ui/button";
import { Badge, Input, Spinner } from "../ui/controls";

/** 1Password's page for making a service account (it opens the user's own account). */
export const SERVICE_ACCOUNT_URL =
  "https://my.1password.com/developer-tools/infrastructure-secrets/serviceaccount/";

export const SETUP_STEPS = [
  "In 1Password, make a vault just for Yo (for example “Yo”) and put the logins Yo may use in it. Yo can't see your other vaults.",
  "Open 1Password.com, go to Developer → Directory → Service account, and make one named “Yo”.",
  "Give it read access to the Yo vault only. It doesn't need to create vaults.",
  "Copy the token it shows once (it starts with ops_), save it in 1Password, and paste it below.",
];

function line(s: OnePasswordStatus): {
  tone: "neutral" | "success" | "warning" | "danger";
  badge: string;
  text: string;
} {
  if (!s.connected) return { tone: "neutral", badge: "Off", text: "Not connected." };
  if (s.state === "error")
    return { tone: "danger", badge: "Needs attention", text: s.lastError ?? "It stopped working." };
  const vaults = s.vaults.map((v) => v.title).join(", ");
  const n = s.vaults.length;
  return {
    tone: s.state === "ok" ? "success" : "neutral",
    badge: "Connected",
    text: `${n} vault${n === 1 ? "" : "s"}: ${vaults || "none"}${s.checkedAt ? ` · checked ${ago(s.checkedAt)}` : ""}`,
  };
}

export function OnePasswordCard() {
  const [status, setStatus] = useState<OnePasswordStatus | null>(null);
  const [setup, setSetup] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"connect" | "test" | "off" | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [howOpen, setHowOpen] = useState(false);

  const load = useCallback(async () => {
    const s = await api()
      .call("onePassword.status", {})
      .catch(() => null);
    if (s) setStatus(s);
  }, []);

  useEffect(() => {
    void load();
    return api().on("onePassword.updated", setStatus);
  }, [load]);

  const connect = async () => {
    if (!token.trim()) return;
    setBusy("connect");
    setError(null);
    try {
      const s = await api().call("onePassword.connect", { token: token.trim() });
      setStatus(s);
      setToken("");
      setSetup(false);
      toast.success("1Password connected");
    } catch (err) {
      // The token is never echoed back: the message is core's plain words.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    const s = await run(api().call("onePassword.test", {}), "Couldn't check 1Password");
    setBusy(null);
    if (!s) return;
    setStatus(s);
    if (s.state === "ok") toast.success("1Password works");
  };

  const disconnect = async () => {
    setBusy("off");
    const s = await run(api().call("onePassword.disconnect", {}), "Couldn't disconnect 1Password");
    setBusy(null);
    setConfirmOff(false);
    if (!s) return;
    setStatus(s);
    toast.success("1Password disconnected. Yo forgot the token.");
  };

  const l = status ? line(status) : null;
  const showSetup = setup;

  return (
    <div
      data-testid="onepassword-card"
      className="rounded-[14px] border border-border bg-card shadow-card px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-elevated">
          <KeyRound className="size-5 text-fg-2" />
        </div>
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-x-2 font-semibold">
            1Password
            {l && (
              <Badge tone={l.tone} className="font-medium">
                {l.badge}
              </Badge>
            )}
          </div>
          <div
            className={cn("text-sm", status?.state === "error" ? "text-danger" : "text-muted")}
            data-testid="onepassword-status"
          >
            {l?.text ?? "Loading…"}
          </div>
        </div>
        {status &&
          (!status.connected ? (
            !setup && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSetup(true)}
                data-testid="onepassword-connect"
              >
                Connect
              </Button>
            )
          ) : confirmOff ? (
            <div className="flex items-center gap-2">
              <span className="text-muted text-sm">Yo forgets the token.</span>
              <Button
                variant="danger"
                size="sm"
                disabled={!!busy}
                onClick={disconnect}
                data-testid="onepassword-disconnect-confirm"
              >
                {busy === "off" ? <Spinner /> : null} Disconnect
              </Button>
              <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setConfirmOff(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              {status.state === "error" && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setSetup(true)}
                  data-testid="onepassword-new-token"
                >
                  New token
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={!!busy}
                onClick={test}
                data-testid="onepassword-test"
              >
                {busy === "test" ? <Spinner /> : null} Test
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!!busy}
                onClick={() => setConfirmOff(true)}
                data-testid="onepassword-disconnect"
              >
                Disconnect
              </Button>
            </div>
          ))}
      </div>

      {showSetup && (
        <div className="mt-3.5 border-border border-t pt-3.5" data-testid="onepassword-setup">
          <p className="mb-2 text-fg-2 text-sm">
            Yo uses a 1Password service account: a key that opens only the vault you choose.
          </p>
          <ol className="list-decimal space-y-1.5 pl-5 text-fg-2 text-sm">
            {SETUP_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <a
            href={SERVICE_ACCOUNT_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-2.5 inline-flex items-center gap-1 text-link-ink text-sm hover:underline"
            data-testid="onepassword-open"
          >
            Open 1Password's service account page <ExternalLink className="size-3.5" />
          </a>
          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void connect();
            }}
          >
            <Input
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setError(null);
              }}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="ops_…"
              aria-label="Service account token"
              data-testid="onepassword-token"
              className="min-w-0 flex-1 basis-60 font-mono"
            />
            <Button
              type="submit"
              variant="primary"
              disabled={!token.trim() || !!busy}
              data-testid="onepassword-save"
            >
              {busy === "connect" ? <Spinner /> : null} Connect
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={!!busy}
              onClick={() => {
                setSetup(false);
                setToken("");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </form>
          {error && (
            <p className="mt-2 text-danger text-sm" data-testid="onepassword-error">
              {error}
            </p>
          )}
        </div>
      )}

      {status?.connected && status.recent.length > 0 && (
        <div className="mt-3.5 border-border border-t pt-3" data-testid="onepassword-recent">
          <div className="mb-1.5 text-muted text-xs">Recent sign-ins</div>
          <ul className="space-y-1 text-fg-2 text-sm">
            {status.recent.map((u) => (
              <li key={`${u.at}-${u.site}`} className="truncate">
                {u.agentName} used <span className="text-fg">{u.item}</span> on {u.site} (
                {fieldList(u.fields)}) · <span className="text-muted">{ago(u.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3">
        <button
          type="button"
          aria-expanded={howOpen}
          onClick={() => setHowOpen((o) => !o)}
          className="flex items-center gap-1 text-muted text-xs transition-colors hover:text-fg"
          data-testid="onepassword-how-toggle"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", howOpen && "rotate-90")} />
          How Yo keeps your passwords safe
        </button>
        {howOpen && (
          <ul className="mt-2 space-y-1.5 pl-1 text-fg-2 text-sm" data-testid="onepassword-how">
            {[
              "Yo only sees the vaults you gave the service account. Your other vaults stay out of reach.",
              "Yo's assistants never see a password, username or code: Yo types them into its own browser, only on the website the login is saved for.",
              "The first time on each site, Yo asks you. “Always allow” is for that one site, and you can take it back in Rules.",
              "The token is kept in Yo's secret storage (the Keychain on a Mac), never in chats, logs or bug reports.",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
                {t}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
