import type { Account } from "@yo/contracts";
import { AlertCircle, Check, Copy, ExternalLink, KeyRound, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { isDesktop, openExternal } from "../../lib/desktop";
import { useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { Button } from "../ui/button";
import { Input, Spinner } from "../ui/controls";

/**
 * Inline sign-in flow driven by `account.login` pushes:
 *  - Claude: open the authorize URL (host.openExternal), then paste the code back (account.login.input).
 *  - Codex:  show the device code + URL; completes on its own.
 *  - Grok:   an API key (kept for when Grok is offered again; it isn't in ENABLED_PROVIDERS).
 */
export function LoginPanel({ account }: { account: Account }) {
  const login = useApp((s) => s.logins[account.id]);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");

  const opened = useRef<string | null>(null);
  // Open links on the machine the user is sitting at. In the desktop app that's this Mac, even when
  // core runs on the Home PC; in a plain browser (dev) core opens it.
  const openLink = (url: string) =>
    isDesktop ? openExternal(url) : void run(api().call("host.openExternal", { url }));
  const prompt = login?.phase === "prompt" && (login.url || login.userCode) ? login : null;

  // Open the sign-in page in the user's browser as soon as the link arrives (once per link).
  useEffect(() => {
    if (prompt?.url && opened.current !== prompt.url) {
      opened.current = prompt.url;
      openLink(prompt.url);
    }
  }, [prompt?.url]);

  const visible = account.status === "signing_in" || login?.phase === "prompt" || login?.phase === "error";
  if (!visible || account.status === "authenticated") return null;

  if (login?.phase === "error") {
    return (
      <div
        data-testid={`login-panel-${account.provider}`}
        className="mt-3 space-y-3 rounded-xl border border-danger/40 bg-danger/5 p-3.5 animate-rise"
      >
        <div className="flex items-start gap-2 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" />
          <span className="text-fg-2">{login.message ?? "Sign-in failed."}</span>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="brand"
            size="sm"
            data-testid="login-retry"
            onClick={() => {
              setCode("");
              void run(api().call("account.login.start", { id: account.id, restart: true }));
            }}
          >
            <RotateCw className="size-3.5" /> Try again
          </Button>
        </div>
      </div>
    );
  }

  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true);
    await run(api().call("account.login.input", { id: account.id, input: code.trim() }));
    // Keep the spinner until the result arrives (token capture takes a second or two).
    setTimeout(() => setBusy(false), 8000);
  };

  return (
    <div
      data-testid={`login-panel-${account.provider}`}
      className="mt-3 space-y-3 rounded-xl border border-border bg-bg/50 p-3.5 animate-rise"
    >
      {!prompt ? (
        <div className="flex items-center gap-2 text-muted text-sm">
          <Spinner />{" "}
          {login?.phase === "prompt" && login.message ? login.message : "Starting sign-in on Yo's computer…"}
        </div>
      ) : (
        <>
          {prompt.message && <div className="text-fg-2 text-sm">{prompt.message}</div>}
          {prompt.userCode && (
            <div className="flex items-center gap-3">
              <div
                data-testid="device-code"
                className="rounded-xl border border-border-strong bg-card px-4 py-2 font-mono font-semibold text-xl tracking-[0.18em]"
              >
                {prompt.userCode}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(prompt.userCode ?? "");
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{" "}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {prompt.url && (
              <Button
                variant="primary"
                size="sm"
                data-testid="open-login-url"
                onClick={() => openLink(prompt.url!)}
              >
                <ExternalLink className="size-3.5" /> Open sign-in page
              </Button>
            )}
            {prompt.userCode && !prompt.needsInput && (
              <span className="flex items-center gap-2 text-muted text-xs">
                <Spinner className="size-3" /> Waiting for you to finish in the browser…
              </span>
            )}
          </div>
          {prompt.needsInput && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Paste the code here"
                data-testid="login-code"
                className="font-mono"
              />
              <Button
                type="submit"
                variant="brand"
                disabled={!code.trim() || busy}
                data-testid="login-submit"
              >
                {busy ? <Spinner /> : "Connect"}
              </Button>
            </form>
          )}
          {account.provider === "grok" && (
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (key.trim())
                  await run(api().call("account.setApiKey", { id: account.id, key: key.trim() }));
              }}
            >
              <div className="relative flex-1">
                <KeyRound className="-translate-y-1/2 absolute top-1/2 left-3 size-3.5 text-faint" />
                <Input
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="xai-… API key"
                  type="password"
                  className="pl-8"
                />
              </div>
              <Button type="submit" variant="secondary" disabled={!key.trim()}>
                Use key
              </Button>
            </form>
          )}
        </>
      )}
      <div className="flex justify-end">
        <button
          onClick={() => run(api().call("account.login.cancel", { id: account.id }))}
          className="text-muted text-xs hover:text-fg"
        >
          Cancel sign-in
        </button>
      </div>
    </div>
  );
}
