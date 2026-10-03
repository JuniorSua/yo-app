/**
 * "Connect your model": the first-run walkthrough (onboarding) and Settings → Accounts → Connect.
 *
 * 1. Detects what's already there: subscriptions signed in on Yo's computer (accounts), and Claude Code /
 *    Codex installed and signed in on the machine Yo runs on (`connect.detect`, which never reads secrets).
 * 2. One path per provider, as numbered steps with copy boxes:
 *    - Claude: `claude setup-token` in Terminal, then paste the token here (`connect.claudeToken`).
 *    - ChatGPT: a separate Codex sign-in just for Yo (CODEX_HOME=~/.yo/codex). Yo polls for it
 *      (`connect.codexImport`) and turns green on its own. The user's own ~/.codex is never copied.
 * 3. A live status that turns green once Yo has the connection; every error says what to do next.
 *
 * The pasted token lives only in this component's state (a password field) until it's sent, and is cleared
 * once saved. It is never logged, shown, or put in an error message.
 */
import {
  type Account,
  CONNECT_COMMANDS,
  type ConnectDetection,
  type ConnectProvider,
  parseClaudeToken,
} from "@yo/contracts";
import { ArrowLeft, ArrowRight, Check, ChevronRight, RotateCw } from "lucide-react";
import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { isUsable, PROVIDER_NAME, planTier } from "../../lib/accounts";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { ProviderIcon } from "../brand";
import { LoginPanel } from "../settings/LoginPanel";
import { Button } from "../ui/button";
import { Badge, Input, Spinner } from "../ui/controls";
import { CopyBox, type LiveState, LiveStatus, Step, Steps } from "./parts";
import { startPoll } from "./poll";

/** How often Yo looks for the Codex sign-in, and when it stops to ask. */
export const CODEX_POLL_MS = 1500;
export const CODEX_POLL_TIMEOUT_MS = 10 * 60_000;

const CORE_UNREACHABLE = "Yo couldn't reach its core. Make sure Yo is still running, then try again.";

const BLURB: Record<ConnectProvider, string> = {
  claude: "Claude Pro or Max",
  codex: "ChatGPT Plus, Pro, Business or Enterprise",
};

type View = "pick" | ConnectProvider;

/** "Max plan, signed in on Yo's computer." */
const onComputer = (a: Account) => {
  const tier = planTier(a);
  return tier ? `${tier} plan, signed in on Yo's computer.` : "Signed in on Yo's computer.";
};

export interface ConnectModelProps {
  variant: "onboarding" | "settings";
  /** Open straight on one provider's steps (an account's Connect button in Settings). */
  initialProvider?: ConnectProvider;
  /** Connect this account (a second Claude account, say); default: the provider's default account. */
  accountId?: string;
  /** Onboarding: go to the next step. Settings: back to the accounts list. */
  onDone: () => void;
}

/** The account the walkthrough connects for a provider (mirrors core's AccountService.accountFor). */
export function accountForProvider(
  accounts: Account[],
  provider: ConnectProvider,
  accountId?: string,
): Account | undefined {
  if (accountId) return accounts.find((a) => a.id === accountId && a.provider === provider);
  const of = accounts.filter((a) => a.provider === provider);
  return of.find((a) => a.isDefault) ?? of[0];
}

export function ConnectModel(props: ConnectModelProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ConnectBoundary key={attempt} retry={() => setAttempt((n) => n + 1)} onDone={props.onDone}>
      <Walkthrough {...props} />
    </ConnectBoundary>
  );
}

function Walkthrough({ variant, initialProvider, accountId, onDone }: ConnectModelProps) {
  const [view, setView] = useState<View>(initialProvider ?? "pick");
  const [detection, setDetection] = useState<ConnectDetection | null>(null);
  const [detecting, setDetecting] = useState(true);
  const accounts = useApp((s) => s.accounts);

  // What's on this machine. Re-checked whenever the overview shows (the user may have installed something).
  useEffect(() => {
    let live = true;
    setDetecting(true);
    api()
      .call("connect.detect", {})
      .then((d) => live && setDetection(d))
      .catch(() => {
        // Not fatal: the steps still work, they just can't skip what's already installed.
      })
      .finally(() => live && setDetecting(false));
    return () => {
      live = false;
    };
  }, [view === "pick"]);

  // Each view starts at its top (the scrolling container is the onboarding page or the Settings pane).
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    for (let el = root.current?.parentElement; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) {
        el.scrollTo({ top: 0 });
        break;
      }
    }
  }, [view]);

  const onboarding = variant === "onboarding";
  return (
    <div
      ref={root}
      className={cn("w-full", onboarding && "max-w-[600px]")}
      data-testid="connect-model"
      data-view={view}
    >
      {view === "pick" ? (
        <Pick
          accounts={accounts}
          accountId={accountId}
          detection={detection}
          detecting={detecting}
          onboarding={onboarding}
          choose={setView}
          onDone={onDone}
        />
      ) : (
        <>
          <button
            type="button"
            // Opened on one provider from Settings: back goes to the accounts list.
            onClick={() => (!onboarding && initialProvider ? onDone() : setView("pick"))}
            data-testid="connect-back"
            className="-ml-2 mb-3 flex items-center gap-1.5 rounded-lg px-2 py-1 text-muted text-sm hover:bg-hover hover:text-fg"
          >
            <ArrowLeft className="size-3.5" /> {!onboarding && initialProvider ? "Accounts" : "All options"}
          </button>
          {view === "claude" ? (
            <ClaudeSteps
              account={accountForProvider(accounts, "claude", accountId)}
              detection={detection}
              onboarding={onboarding}
              onDone={onDone}
            />
          ) : (
            <CodexSteps
              account={accountForProvider(accounts, "codex", accountId)}
              detection={detection}
              onboarding={onboarding}
              onDone={onDone}
            />
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------- Overview ------------------------------- */

interface Found {
  provider: ConnectProvider;
  testId: string;
  title: string;
  detail: string;
  ready: boolean;
  action: string;
}

/** What the walkthrough found, best first: ready to use on Yo's computer, then logins on this machine. */
export function foundItems(accounts: Account[], d: ConnectDetection | null, accountId?: string): Found[] {
  const out: Found[] = [];
  const where = d?.host.platform === "darwin" ? "this Mac" : (d?.host.name ?? "this computer");
  for (const p of ["claude", "codex"] as const) {
    const a = accountForProvider(accounts, p, accountId);
    if (a && isUsable(a)) {
      out.push({
        provider: p,
        testId: `found-${p}-ready`,
        title: `${PROVIDER_NAME[p]} is connected`,
        detail:
          a.status === "authenticated" ? onComputer(a) : "Saved. Yo checks it when its computer starts.",
        ready: true,
        action: a.isDefault ? "Use it" : `Use ${PROVIDER_NAME[p]}`,
      });
      continue;
    }
    if (!d) continue;
    if (p === "codex" && d.codex.yoLogin)
      out.push({
        provider: p,
        testId: "found-codex-yologin",
        title: "Your ChatGPT sign-in for Yo is ready",
        detail: `Found on ${where}. Finish connecting it.`,
        ready: false,
        action: "Finish",
      });
    else if (p === "claude" && d.claude.signedIn)
      out.push({
        provider: p,
        testId: "found-claude-host",
        title: "Claude Code is signed in",
        detail: `On ${where}. Use the same plan in Yo.`,
        ready: false,
        action: "Use your Claude plan",
      });
    else if (p === "codex" && d.codex.signedIn)
      out.push({
        provider: p,
        testId: "found-codex-host",
        title: "Codex is signed in",
        detail: `On ${where}. Sign in once more to use it in Yo.`,
        ready: false,
        action: "Use your ChatGPT plan",
      });
  }
  return out;
}

function Pick({
  accounts,
  accountId,
  detection,
  detecting,
  onboarding,
  choose,
  onDone,
}: {
  accounts: Account[];
  accountId?: string;
  detection: ConnectDetection | null;
  detecting: boolean;
  onboarding: boolean;
  choose: (v: View) => void;
  onDone: () => void;
}) {
  const found = foundItems(accounts, detection, accountId);
  const anyReady = found.some((f) => f.ready);
  const [error, setError] = useState<string | null>(null);

  const pickReady = async (p: ConnectProvider) => {
    const a = accountForProvider(accounts, p, accountId);
    setError(null);
    if (a && !a.isDefault) {
      try {
        await api().call("account.setDefault", { id: a.id });
      } catch {
        setError(CORE_UNREACHABLE);
        return;
      }
    }
    onDone();
  };

  return (
    <div>
      <h1 className={cn("font-semibold tracking-[-0.03em]", onboarding ? "text-3xl" : "text-xl")}>
        Connect your model
      </h1>
      <p className="mt-2 text-muted">
        Yo runs on the Claude or ChatGPT plan you already pay for. No API key, no extra cost.
      </p>

      <section className="mt-6" data-testid="connect-found">
        <h2 className="mb-2 px-1 font-medium text-2xs text-muted uppercase tracking-[0.08em]">
          Already signed in
        </h2>
        {detecting && !detection && found.length === 0 ? (
          <div className="flex items-center gap-2.5 rounded-2xl border border-border border-dashed px-4 py-3.5 text-muted text-sm">
            <Spinner /> Looking for Claude and ChatGPT sign-ins…
          </div>
        ) : found.length === 0 ? (
          <div
            data-testid="connect-found-none"
            className="rounded-2xl border border-border border-dashed px-4 py-3.5 text-muted text-sm"
          >
            Nothing signed in yet. Choose one below. It takes about two minutes.
          </div>
        ) : (
          <div className="space-y-2">
            {found.map((f) => (
              <div
                key={f.testId}
                data-testid={f.testId}
                className={cn(
                  "flex items-center gap-3 rounded-2xl border px-4 py-3 animate-rise",
                  f.ready ? "border-success/35 bg-success/[0.07]" : "border-border bg-card shadow-card",
                )}
              >
                <div className="relative grid size-9 shrink-0 place-items-center rounded-xl bg-elevated">
                  <ProviderIcon provider={f.provider} className="size-[18px]" />
                  {f.ready && (
                    <span className="-right-1 -bottom-1 absolute grid size-4 place-items-center rounded-full bg-success ring-2 ring-card">
                      <Check className="size-2.5 text-black" strokeWidth={3.5} />
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{f.title}</div>
                  <div className="truncate text-muted text-sm">{f.detail}</div>
                </div>
                <Button
                  size="sm"
                  variant={f.ready ? "primary" : "secondary"}
                  data-testid={`${f.testId}-use`}
                  onClick={() => (f.ready ? void pickReady(f.provider) : choose(f.provider))}
                >
                  {f.action}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6">
        <h2 className="mb-2 px-1 font-medium text-2xs text-muted uppercase tracking-[0.08em]">
          {anyReady ? "Or connect another" : "Connect a subscription"}
        </h2>
        <div className="grid grid-cols-2 gap-2.5">
          {(["claude", "codex"] as const).map((p) => {
            const a = accountForProvider(accounts, p, accountId);
            const on = !!a && isUsable(a);
            return (
              <button
                key={p}
                type="button"
                data-testid={`connect-pick-${p}`}
                onClick={() => choose(p)}
                className="group flex items-start gap-3 rounded-2xl border border-border bg-card p-4 text-left shadow-card transition-colors hover:border-border-strong hover:bg-hover/40"
              >
                <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-elevated">
                  <ProviderIcon provider={p} className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{PROVIDER_NAME[p]}</span>
                    {on ? (
                      <Badge tone="success">Connected</Badge>
                    ) : (
                      p === "claude" && <Badge tone="brand">Recommended</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-muted text-sm leading-snug">{BLURB[p]}</div>
                </div>
                <ChevronRight className="mt-2.5 size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
              </button>
            );
          })}
        </div>
      </section>

      {error && (
        <p role="alert" className="mt-3 text-danger text-sm">
          {error}
        </p>
      )}

      <div className="mt-7 flex items-center justify-between gap-3">
        <span className="text-muted text-sm">
          {anyReady ? "You're connected." : "You can switch or add one anytime in Settings."}
        </span>
        {onboarding ? (
          <Button variant={anyReady ? "primary" : "ghost"} onClick={onDone} data-testid="onboarding-next">
            {anyReady ? "Continue" : "Skip for now"} <ArrowRight className="size-4" />
          </Button>
        ) : (
          <Button variant="ghost" onClick={onDone} data-testid="connect-close">
            Back to accounts
          </Button>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- Shared -------------------------------- */

function Header({ provider, title, sub }: { provider: ConnectProvider; title: string; sub: ReactNode }) {
  return (
    <div className="mb-5 flex items-start gap-3.5">
      <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-elevated">
        <ProviderIcon provider={provider} className="size-[22px]" />
      </div>
      <div>
        <h1 className="font-semibold text-2xl tracking-[-0.025em]">{title}</h1>
        <p className="mt-1 text-muted">{sub}</p>
      </div>
    </div>
  );
}

function DoneRow({
  onboarding,
  connected,
  onDone,
  provider,
}: {
  onboarding: boolean;
  connected: boolean;
  onDone: () => void;
  provider: ConnectProvider;
}) {
  return (
    <div className="mt-6 flex items-center justify-end gap-3">
      {onboarding && !connected && (
        <button type="button" onClick={onDone} className="mr-auto text-muted text-sm hover:text-fg">
          Skip for now
        </button>
      )}
      {connected && (
        <Button variant="primary" onClick={onDone} data-testid={`connect-${provider}-done`}>
          {onboarding ? "Continue" : "Done"} <ArrowRight className="size-4" />
        </Button>
      )}
    </div>
  );
}

/** The installers put the CLI in ~/.local/bin, which the Terminal window that ran them may not know yet. */
function NotFoundHint({ name, command, testId }: { name: string; command: string; testId: string }) {
  return (
    <>
      <div className="mt-2 text-xs">If Terminal says “command not found: {name}”, run this instead:</div>
      <CopyBox command={command} testId={testId} />
    </>
  );
}

const terminalHint = (d: ConnectDetection | null) =>
  d && d.host.platform !== "darwin"
    ? `Run these in a terminal on ${d.host.name}, the computer Yo runs on.`
    : "Open Terminal (press ⌘ Space, type Terminal), paste each command and press Return.";

/* -------------------------------- Claude -------------------------------- */

function ClaudeSteps({
  account,
  detection,
  onboarding,
  onDone,
}: {
  account: Account | undefined;
  detection: ConnectDetection | null;
  onboarding: boolean;
  onDone: () => void;
}) {
  const [token, setToken] = useState("");
  const [state, setState] = useState<LiveState>(account && isUsable(account) ? "connected" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState(false);
  const live = useRef(true);
  // Set on every mount: StrictMode mounts twice, and a stale `false` would swallow the result.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const installed = !!detection?.claude.installed;
  const connected = state === "connected";

  const submit = async () => {
    if (state === "checking") return;
    const check = parseClaudeToken(token);
    if (!check.ok) {
      setState("error");
      setError(check.error);
      return;
    }
    setState("checking");
    setError(null);
    try {
      const r = await api().call("connect.claudeToken", { token: check.token, accountId: account?.id });
      if (!live.current) return;
      if (r.ok) {
        setToken("");
        setAgain(false);
        setState("connected");
      } else {
        setState("error");
        setError(r.error);
      }
    } catch {
      if (!live.current) return;
      setState("error");
      setError(CORE_UNREACHABLE);
    }
  };

  const showSteps = !connected || again;
  return (
    <div data-testid="connect-steps-claude">
      <Header
        provider="claude"
        title="Connect Claude"
        sub="Uses your Claude Pro or Max plan. You'll make a sign-in token for Yo in Terminal."
      />
      {showSteps && (
        <>
          <p className="mb-2.5 text-muted text-sm">{terminalHint(detection)}</p>
          <Steps>
            <Step
              n={1}
              title={installed ? "Claude Code is installed" : "Install Claude Code"}
              done={installed}
            >
              {installed ? (
                "Found it, so you can skip this step."
              ) : (
                <>
                  Copy this, paste it in Terminal and press Return. Already have Claude Code? Skip this step.
                  <CopyBox command={CONNECT_COMMANDS.claudeInstall} testId="cmd-claude-install" />
                </>
              )}
            </Step>
            <Step n={2} title="Make a sign-in token for Yo">
              Copy this, paste it in Terminal and press Return. Your browser opens: sign in with the Claude
              account that has your plan. Terminal then prints a long token that starts with{" "}
              <code className="font-mono text-fg-2">sk-ant-oat</code>.
              <CopyBox command={CONNECT_COMMANDS.claudeToken} testId="cmd-claude-token" />
              <NotFoundHint
                name="claude"
                command={CONNECT_COMMANDS.claudeTokenDirect}
                testId="cmd-claude-token-direct"
              />
            </Step>
            <Step n={3} title="Paste the token here">
              Copy the whole token from Terminal. Yo stores it securely and never shows it again.
              <form
                className="mt-2.5 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Claude sign-in token"
                  placeholder="sk-ant-oat01-…"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    if (state === "error") {
                      setState("idle");
                      setError(null);
                    }
                  }}
                  data-testid="claude-token-input"
                />
                <Button
                  type="submit"
                  variant="brand"
                  disabled={!token.trim() || state === "checking"}
                  data-testid="claude-token-submit"
                >
                  {state === "checking" ? <Spinner /> : null} Connect
                </Button>
              </form>
            </Step>
          </Steps>
        </>
      )}
      <LiveStatus
        state={state}
        title={
          state === "connected"
            ? "Claude is connected"
            : state === "checking"
              ? "Saving your token…"
              : state === "error"
                ? "That didn't work"
                : "Waiting for your token"
        }
        detail={
          state === "connected"
            ? account?.status === "authenticated"
              ? onComputer(account)
              : "Yo checks it when its computer starts."
            : state === "error"
              ? error
              : state === "idle"
                ? "Paste it in step 3 and press Connect."
                : null
        }
        action={
          connected && !again ? (
            <Button variant="ghost" size="sm" onClick={() => setAgain(true)} data-testid="connect-again">
              Use a different token
            </Button>
          ) : null
        }
      />
      <DoneRow onboarding={onboarding} connected={connected} onDone={onDone} provider="claude" />
    </div>
  );
}

/* --------------------------------- Codex -------------------------------- */

function CodexSteps({
  account,
  detection,
  onboarding,
  onDone,
}: {
  account: Account | undefined;
  detection: ConnectDetection | null;
  onboarding: boolean;
  onDone: () => void;
}) {
  const alreadyOn = !!account && isUsable(account);
  const [state, setState] = useState<LiveState>(alreadyOn ? "connected" : "waiting");
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [again, setAgain] = useState(false);
  /** Bumped to (re)start polling. */
  const [round, setRound] = useState(0);
  const accountId = account?.id;
  const polling = state === "waiting" && !timedOut;

  useEffect(() => {
    if (!polling) return;
    return startPoll({
      tick: () => api().call("connect.codexImport", { accountId }),
      intervalMs: CODEX_POLL_MS,
      timeoutMs: CODEX_POLL_TIMEOUT_MS,
      onResult: (r) => {
        setUnreachable(false);
        if (r.state === "waiting") return false;
        if (r.state === "connected") {
          setAgain(false);
          setState("connected");
        } else {
          setError(r.error);
          setState("error");
        }
        return true;
      },
      onError: (n) => setUnreachable(n >= 2),
      onTimeout: () => setTimedOut(true),
    });
  }, [polling, round, accountId]);

  // Fallback when Terminal on the machine Yo runs on is out of reach (Yo runs on another computer): the
  // device-code sign-in on Yo's computer. Only offered while that computer is up.
  const computerUp = useApp((s) => !!s.computer?.connected);
  const [viaComputer, setViaComputer] = useState(false);
  const signedInThere = account?.status === "authenticated";
  useEffect(() => {
    if (viaComputer && signedInThere) {
      setViaComputer(false);
      setAgain(false);
      setState("connected");
    }
  }, [viaComputer, signedInThere]);
  // The account turned usable while we wait (core pushes account.updated): connected, even if the poll that
  // imported it was cut off before its answer arrived.
  const usableNow = !!account && isUsable(account);
  const wasUsable = useRef(usableNow);
  useEffect(() => {
    if (usableNow && !wasUsable.current && state === "waiting") setState("connected");
    wasUsable.current = usableNow;
  }, [usableNow, state]);
  const signInOnComputer = () => {
    if (!account) return;
    setViaComputer(true);
    api()
      .call("account.login.start", { id: account.id, restart: true })
      .catch(() => {
        setViaComputer(false);
        setError(CORE_UNREACHABLE);
        setState("error");
      });
  };

  const retry = () => {
    setError(null);
    setTimedOut(false);
    setUnreachable(false);
    setState("waiting");
    setRound((n) => n + 1);
  };

  const connected = state === "connected";
  const installed = !!detection?.codex.installed;
  const showSteps = !connected || again;
  return (
    <div data-testid="connect-steps-codex">
      <Header
        provider="codex"
        title="Connect ChatGPT"
        sub="Uses your ChatGPT plan through Codex. You'll sign in once more, just for Yo."
      />
      {showSteps && (
        <>
          <p className="mb-2.5 text-muted text-sm">{terminalHint(detection)}</p>
          <Steps>
            <Step n={1} title={installed ? "Codex is installed" : "Install Codex"} done={installed}>
              {installed ? (
                "Found it, so you can skip this step."
              ) : (
                <>
                  Copy this, paste it in Terminal and press Return. If it asks to start Codex now, press
                  Return for no.
                  <CopyBox command={CONNECT_COMMANDS.codexInstall} testId="cmd-codex-install" />
                  <div className="mt-1.5 text-xs">
                    Or with npm: <code className="font-mono">{CONNECT_COMMANDS.codexInstallNpm}</code>, or
                    Homebrew: <code className="font-mono">{CONNECT_COMMANDS.codexInstallBrew}</code>
                  </div>
                </>
              )}
            </Step>
            <Step n={2} title="Sign in with ChatGPT, just for Yo">
              Copy this, paste it in Terminal and press Return. Your browser opens: sign in with ChatGPT. It's
              a separate sign-in kept in its own folder, so the Codex sign-in you already use keeps working.
              <CopyBox command={CONNECT_COMMANDS.codexLogin} testId="cmd-codex-login" />
              <NotFoundHint
                name="codex"
                command={CONNECT_COMMANDS.codexLoginDirect}
                testId="cmd-codex-login-direct"
              />
            </Step>
            <Step n={3} title="Yo connects on its own" done={connected}>
              When the browser says you're signed in, come back here. This turns green by itself.
            </Step>
          </Steps>
        </>
      )}
      <LiveStatus
        state={timedOut && state === "waiting" ? "idle" : state}
        title={
          connected
            ? "ChatGPT is connected"
            : state === "error"
              ? "That didn't work"
              : timedOut
                ? "Still waiting for the sign-in"
                : "Waiting for you to sign in…"
        }
        detail={
          connected
            ? account?.status === "authenticated"
              ? onComputer(account)
              : "Yo checks it when its computer starts."
            : state === "error"
              ? error
              : timedOut
                ? "Run the command in step 2 again and finish signing in in the browser, then press Check again."
                : unreachable
                  ? "Yo can't reach its core right now. Keep Yo open: it keeps trying."
                  : "Yo is watching for the sign-in from step 2."
        }
        action={
          state === "error" || timedOut ? (
            <Button variant="secondary" size="sm" onClick={retry} data-testid="codex-retry">
              <RotateCw className="size-3.5" /> {timedOut ? "Check again" : "Try again"}
            </Button>
          ) : connected && !again ? (
            <Button variant="ghost" size="sm" onClick={() => setAgain(true)} data-testid="connect-again">
              Sign in again
            </Button>
          ) : null
        }
      />
      {again && connected && (
        <div className="mt-2 text-right">
          <Button variant="ghost" size="sm" onClick={retry} data-testid="codex-watch-again">
            I ran it: check for the new sign-in
          </Button>
        </div>
      )}
      {account && computerUp && showSteps && (
        <div className="mt-3 text-muted text-sm">
          {viaComputer ? (
            <LoginPanel account={account} />
          ) : (
            <>
              Using Yo from another computer?{" "}
              <button
                type="button"
                onClick={signInOnComputer}
                data-testid="codex-via-computer"
                className="text-fg-2 underline underline-offset-2 hover:text-fg"
              >
                Sign in on Yo's computer with a code instead
              </button>
            </>
          )}
        </div>
      )}
      <DoneRow onboarding={onboarding} connected={connected} onDone={onDone} provider="codex" />
    </div>
  );
}

/* ----------------------------- Error boundary ---------------------------- */

/** A render error here must never blank the app: offer a retry and a way past it. */
class ConnectBoundary extends Component<
  { children: ReactNode; retry: () => void; onDone: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.warn("connect walkthrough failed to render", err);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        data-testid="connect-crashed"
        className="w-full max-w-[600px] rounded-2xl border border-border bg-card p-5 shadow-card"
      >
        <div className="font-medium">Something went wrong showing this step.</div>
        <p className="mt-1 text-muted text-sm">
          Try again. You can also connect later in Settings → Accounts.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={this.props.onDone}>
            Skip for now
          </Button>
          <Button variant="primary" onClick={this.props.retry}>
            <RotateCw className="size-3.5" /> Try again
          </Button>
        </div>
      </div>
    );
  }
}
