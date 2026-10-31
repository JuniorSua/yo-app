import { Softie } from "@yo/avatar";
import { ArrowUpRight, LogIn } from "lucide-react";
import { type FormEvent, useState } from "react";
import { submitSignIn, useBrowserAuth } from "../../lib/browserAuth";
import { clientIsWindows } from "../../lib/platform";
import { CopyBox } from "../connect/parts";
import { Button, buttonClass } from "../ui/button";
import { Field, Input, Spinner } from "../ui/controls";

const BROWSERS = [
  { name: "Chrome", url: "https://www.google.com/chrome/" },
  { name: "Edge", url: "https://www.microsoft.com/edge" },
  { name: "Firefox", url: "https://www.mozilla.org/firefox/new/" },
];

/**
 * Shown instead of everything else while this browser isn't signed in to Yo (lib/browserAuth.ts). Yo opens with
 * a one-time sign-in link: from the Start menu shortcut or `yo-app signin` on the PC running Yo, or made in
 * Settings → Browsers & apps in a browser that's already signed in.
 */
export function SignIn() {
  const status = useBrowserAuth((s) => s.status);
  const info = useBrowserAuth((s) => s.info);
  const startError = useBrowserAuth((s) => s.error);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsupported = status === "unsupported";
  const pc = info?.edition === "pc";
  const helper = info?.helperCommand ?? (pc ? "yo-app" : null);
  const shownError = error ?? startError;

  async function signIn(e: FormEvent) {
    e.preventDefault();
    if (!link.trim() || busy) return;
    setBusy(true);
    setError(null);
    const err = await submitSignIn(link);
    setBusy(false);
    if (err) setError(err);
    else setLink("");
  }

  return (
    <div
      className="air-page relative flex h-full flex-col overflow-hidden"
      data-testid="sign-in"
      data-variant={unsupported ? "unsupported" : "signed-out"}
    >
      <div className="relative h-[52px] shrink-0" />
      <div className="relative flex flex-1 items-center justify-center overflow-y-auto px-6 pb-16">
        <div className="flex w-full max-w-[460px] flex-col items-center text-center">
          <Softie kind="yo" size={104} state={unsupported ? "needs" : "idle"} className="mb-6" />
          <h1 className="font-semibold text-3xl tracking-[-0.03em]" data-testid="sign-in-title">
            {unsupported ? "Update your browser" : "Sign in to Yo"}
          </h1>

          {unsupported ? (
            <div className="w-full" data-testid="sign-in-unsupported">
              <p className="mt-3 text-muted">
                Yo signs in with a secure key that stays in your browser, and this browser can't make one.
                Update Chrome, Edge or Firefox to the newest version (or open Yo in one of them), then open Yo
                again.
              </p>
              <div className="mt-7 flex flex-wrap justify-center gap-2">
                {BROWSERS.map((b) => (
                  <a
                    key={b.name}
                    href={b.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClass("secondary", "md")}
                  >
                    Get {b.name} <ArrowUpRight className="size-3.5" />
                  </a>
                ))}
              </div>
            </div>
          ) : (
            <>
              <p className="mt-3 text-muted">
                This browser isn't signed in to Yo yet. You sign in once with a one-time link, and then this
                browser stays signed in.
              </p>

              {pc ? (
                <div
                  className="mt-7 w-full rounded-[14px] border border-border bg-card p-4 text-left shadow-card"
                  data-testid="sign-in-pc"
                >
                  <div className="font-medium">On the PC running Yo</div>
                  <p className="mt-1 text-muted text-sm">
                    {clientIsWindows() ? (
                      <>
                        Open the Start menu and choose <span className="font-medium text-fg-2">Yo</span> (or
                        run <code className="font-mono text-fg-2">{helper} signin</code> in PowerShell). It
                        opens a sign-in link in your browser.
                      </>
                    ) : (
                      <>
                        Run <code className="font-mono text-fg-2">{helper} signin</code> in a terminal. It
                        opens a sign-in link in your browser.
                      </>
                    )}
                  </p>
                  <CopyBox command={`${helper} signin`} testId="sign-in-command" />
                </div>
              ) : helper ? (
                <div
                  className="mt-7 w-full rounded-[14px] border border-border bg-card p-4 text-left shadow-card"
                  data-testid="sign-in-helper"
                >
                  <div className="font-medium">On the computer running Yo</div>
                  <p className="mt-1 text-muted text-sm">Run this in a terminal. It opens a sign-in link.</p>
                  <CopyBox command={`${helper} signin`} testId="sign-in-command" />
                </div>
              ) : null}
              <p className="mt-4 text-muted text-sm" data-testid="sign-in-other-browser">
                {pc || helper ? "Or, in" : "In"} a browser that's signed in:{" "}
                <span className="text-fg-2">Settings → Browsers & apps → Sign in another browser</span>.
              </p>

              <div className="my-7 flex w-full items-center gap-3 text-muted text-xs">
                <span className="h-px flex-1 bg-border" /> Have a link?
                <span className="h-px flex-1 bg-border" />
              </div>

              <form onSubmit={signIn} className="w-full space-y-3 text-left">
                <Field label="Sign-in link" hint="Paste the whole link. It works once, for 10 minutes.">
                  <Input
                    value={link}
                    onChange={(e) => {
                      setLink(e.target.value);
                      setError(null);
                    }}
                    placeholder={`${location.origin}/#signin=…`}
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="sign-in-link"
                  />
                </Field>
                {shownError && (
                  <p role="alert" className="text-danger text-sm" data-testid="sign-in-error">
                    {shownError}
                  </p>
                )}
                <Button
                  type="submit"
                  variant="primary"
                  className="w-full"
                  disabled={!link.trim() || busy}
                  data-testid="sign-in-submit"
                >
                  {busy ? <Spinner /> : <LogIn className="size-4" />} Sign in
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
