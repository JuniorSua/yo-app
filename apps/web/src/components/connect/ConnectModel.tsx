/**
 * "Connect your model": the first-run walkthrough (onboarding) and Settings → Accounts → Connect.
 *
 * 1. Detects what's already there: subscriptions signed in on Yo's computer (accounts), and Claude Code /
 *    Codex installed and signed in on the machine Yo runs on (`connect.detect`, which never reads secrets).
 * 2. One path per provider, as numbered steps. Nothing is typed in Terminal on any edition (Mac app, home server,
 *    PC edition): every provider signs in on Yo's own computer (`account.login.start`), and the person finishes in
 *    any browser.
 *    - Claude: Claude Code's own sign-in. The person signs in on Claude's page and pastes back the code it shows.
 *    - ChatGPT: Codex's own sign-in. The person signs in on ChatGPT's page, which then sends their browser to an
 *      address on Yo's computer that it can't open ("can't connect"); they paste that address into Yo. Or, with
 *      "device code sign-in" turned on once in ChatGPT's security settings, a one-time code.
 *    - Grok: `grok login --device-auth`. The person confirms a code. An xAI API key is the fallback.
 *    On a Mac whose computer isn't set up yet, Claude and ChatGPT sign in right after the setup chat.
 * 3. A live status that turns green once Yo has the connection; every error says what to do next.
 */
import {
  type Account,
  CHATGPT_SECURITY_SETTINGS_URL,
  type ConnectDetection,
  type ConnectProvider,
  codexCallbackOrigin,
  parseCodexCallback,
} from "@yo/contracts";
import { ArrowLeft, ArrowRight, Check, ChevronRight, ExternalLink, RotateCw } from "lucide-react";
import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { CLAUDE_SIGN_IN_CHANGED, isUsable, PROVIDER_NAME, planTier } from "../../lib/accounts";
import { api } from "../../lib/api";
import { useEdition } from "../../lib/browserAuth";
import { cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { type SignInAfterSetup, ui, useUI } from "../../stores/ui";
import { ProviderIcon } from "../brand";
import { Button } from "../ui/button";
import { Badge, Input, Spinner } from "../ui/controls";
import {
  CopyBox,
  canAutoOpen,
  type LiveState,
  LiveStatus,
  OpenSignInPage,
  openSignInPage,
  Step,
  Steps,
} from "./parts";
import { claudeSignInHint, codexSignInHint, grokSignInHint } from "./signInHint";

const CORE_UNREACHABLE = "Yo couldn't reach its core. Make sure Yo is still running, then try again.";

const BLURB: Record<ConnectProvider, string> = {
  claude: "Claude Pro or Max",
  codex: "ChatGPT Plus, Pro, Business or Enterprise",
  grok: "SuperGrok or X Premium",
};

/** Display order of the subscription cards. */
const CONNECT_PROVIDERS = ["claude", "codex", "grok"] as const satisfies readonly ConnectProvider[];

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
          ) : view === "codex" ? (
            <CodexSteps
              account={accountForProvider(accounts, "codex", accountId)}
              detection={detection}
              onboarding={onboarding}
              onDone={onDone}
            />
          ) : (
            <GrokSteps
              account={accountForProvider(accounts, "grok", accountId)}
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
  // Grok is only ever "ready": its sign-in lives on Yo's computer, never on the machine Yo runs on.
  for (const p of CONNECT_PROVIDERS) {
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
    if (p === "claude" && d.claude.signedIn)
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
        Yo runs on the Claude, ChatGPT or Grok plan you already pay for. No API key, no extra cost.
      </p>

      <section className="mt-6" data-testid="connect-found">
        <h2 className="mb-2 px-1 font-medium text-2xs text-muted uppercase tracking-[0.08em]">
          Already signed in
        </h2>
        {detecting && !detection && found.length === 0 ? (
          <div className="flex items-center gap-2.5 rounded-2xl border border-border border-dashed px-4 py-3.5 text-muted text-sm">
            <Spinner /> Looking for Claude, ChatGPT and Grok sign-ins…
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
          {CONNECT_PROVIDERS.map((p) => {
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

/**
 * A Mac whose computer was never set up: Claude and ChatGPT sign in on Yo's computer, so the setup chat comes first
 * (it checks the Mac) and ends with the sign-in. The PC edition and a home server (core on a Linux or Windows PC)
 * run Yo's computer next to core: always there to sign in on.
 */
function useNeedsComputer(detection: ConnectDetection | null): boolean {
  const pc = useEdition() === "pc" || (!!detection && detection.host.platform !== "darwin");
  const notSetUp = useApp(
    (s) =>
      s.computer?.host.kind === "local" &&
      (s.settings.computerSetup ?? "done") !== "done" &&
      !s.computer.connected,
  );
  return notSetUp && !pc;
}

/** "Set up the computer first, then sign in": the walkthrough's two steps on a Mac whose computer isn't set up. */
function SetUpComputerFirst({
  provider,
  onboarding,
  onDone,
}: {
  provider: SignInAfterSetup;
  onboarding: boolean;
  onDone: () => void;
}) {
  const primary = useApp((s) => Object.values(s.agents).find((a) => a.isPrimary));
  const name = PROVIDER_NAME[provider];
  const setUpFirst = () => {
    useUI.setState({ signInAfterSetup: provider });
    if (onboarding) return onDone();
    // From Settings: the setup chat in the first agent's chat (it checks this Mac first), then the sign-in.
    void run(api().call("settings.update", { computerSetup: "pending" }), "Couldn't save that");
    if (primary) ui.openAgent(primary.id);
    useUI.setState({ settingsOpen: false });
  };
  return (
    <>
      <p className="mb-2.5 text-muted text-sm" data-testid={`${provider}-signin-hint`}>
        {name} signs in inside Yo's private workspace, so that comes right after the computer is set up. Yo
        walks you through both.
      </p>
      <Steps>
        <Step n={1} title="Set up Yo's computer" testId={`${provider}-step-computer`}>
          {onboarding
            ? "Yo checks this Mac and sets up a private workspace with you in its first chat. It takes a few minutes."
            : "Yo checks this Mac and sets up a private workspace with you in its chat. It takes a few minutes."}
          <div className="mt-2.5">
            <Button variant="brand" size="sm" onClick={setUpFirst} data-testid={`${provider}-after-setup`}>
              {onboarding ? "Continue" : "Set up the computer"} <ArrowRight className="size-4" />
            </Button>
          </div>
        </Step>
        <Step n={2} title={`Sign in to ${name}`}>
          {provider === "claude"
            ? "Then Yo shows Claude's sign-in page and a box for the code Claude gives you."
            : "Then Yo shows ChatGPT's sign-in page and a box for the address your browser lands on."}
        </Step>
      </Steps>
      <LiveStatus
        state="idle"
        title="Not connected yet"
        detail={`${name} connects right after Yo's computer is set up.`}
      />
    </>
  );
}

/* -------------------------------- Claude -------------------------------- */

/**
 * Claude: Yo's computer runs Claude Code's own sign-in (`claude auth login`, core's `account.login.start`) and pushes
 * Claude's link (`account.login`). The person signs in on Claude's own page and pastes back the code it shows
 * (`account.login.input`). Claude Code keeps the sign-in on Yo's computer. Yo never sees the password. The same
 * on every edition (Mac app, home server, PC edition in a browser). On a Mac whose computer isn't set up yet, the
 * sign-in comes right after the setup chat.
 */
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
  const [again, setAgain] = useState(false);
  const needsComputer = useNeedsComputer(detection);
  // A Claude account still on a token from the old "paste a token" flow works, but isn't "done" until it's
  // signed in the new way.
  const legacy = !!account?.legacyToken;
  const connected = !!account && isUsable(account) && !legacy;
  const showSteps = !connected || again;

  return (
    <div data-testid="connect-steps-claude">
      <Header provider="claude" title="Connect Claude" sub={CLAUDE_SUB} />
      {legacy && (
        <p
          className="mb-3 rounded-xl bg-elevated px-3 py-2.5 text-fg-2 text-sm"
          data-testid="claude-signin-changed"
        >
          {CLAUDE_SIGN_IN_CHANGED}
        </p>
      )}
      {showSteps && needsComputer ? (
        <SetUpComputerFirst provider="claude" onboarding={onboarding} onDone={onDone} />
      ) : showSteps && account ? (
        <ClaudeSignIn
          account={account}
          hint={claudeSignInHint(detection)}
          again={connected}
          // Signed in again: back to the summary. (A failed try keeps its error on screen.)
          onSignedIn={() => setAgain(false)}
        />
      ) : (
        <LiveStatus
          state={connected ? "connected" : "idle"}
          title={connected ? "Claude is connected" : "Not connected yet"}
          detail={
            connected
              ? account?.status === "authenticated"
                ? onComputer(account)
                : "Yo checks it when its computer starts."
              : "Yo has no Claude account to connect. Restart Yo and try again."
          }
          action={
            connected && !again ? (
              <Button variant="ghost" size="sm" onClick={() => setAgain(true)} data-testid="connect-again">
                Sign in again
              </Button>
            ) : null
          }
        />
      )}
      <DoneRow onboarding={onboarding} connected={connected} onDone={onDone} provider="claude" />
    </div>
  );
}

const CLAUDE_SUB =
  "Uses your Claude Pro or Max plan. You sign in on Claude's own page, so Yo never sees your password. Your sign-in stays inside Yo's computer.";

/**
 * The Claude sign-in itself (three steps and a live status), for the walkthrough and the end of the setup chat.
 * Claude's link comes from Yo's computer, and the one-time code is handed straight back to Claude Code there.
 * The sign-in stays on Yo's computer. Yo never sees the password.
 */
export function ClaudeSignIn({
  account,
  hint,
  again,
  onSignedIn,
}: {
  account: Account;
  hint?: string;
  /** Already connected and signing in again: only a sign-in finished here counts. */
  again?: boolean;
  onSignedIn?: () => void;
}) {
  const login = useApp((s) => s.logins[account.id]);
  const [started, setStarted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Only news about the sign-in started here counts: not a link, error or "done" left from an earlier attempt.
  const before = useRef(login);
  const mine = started && login !== before.current ? login : undefined;
  const prompt = mine?.phase === "prompt" && mine.url ? mine : null;
  const error = startError ?? (mine?.phase === "error" ? (mine.message ?? "Sign-in failed.") : null);
  // Signed in the new way: Claude Code has its own sign-in (a legacy token alone doesn't count).
  const [doneHere, setDoneHere] = useState(false);
  useEffect(() => {
    if (mine?.phase === "done") setDoneHere(true);
  }, [mine?.phase]);
  const connected = account.status === "authenticated" && !account.legacyToken && (!again || doneHere);
  useEffect(() => {
    if (connected && doneHere) onSignedIn?.();
  }, [connected, doneHere]);
  const state: LiveState = connected
    ? "connected"
    : error
      ? "error"
      : sending
        ? "checking"
        : started
          ? "waiting"
          : "idle";

  useEffect(() => {
    if (!started) return;
    if (connected || mine?.phase === "done" || mine?.phase === "error") {
      setSending(false);
      // Signed in, or canceled elsewhere (e.g. in Settings): the steps start over.
      if (connected || mine?.phase === "done") setStarted(false);
    }
  }, [started, connected, mine?.phase]);

  // Open Claude's page on the machine the person is at (this Mac in the desktop app), once per link. A plain
  // browser would block that as a pop-up: there "Open sign-in page" is a real link.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (prompt?.url && opened.current !== prompt.url && canAutoOpen()) {
      opened.current = prompt.url;
      openSignInPage(prompt.url);
    }
  }, [prompt?.url]);

  const start = () => {
    before.current = login;
    setStartError(null);
    setCode("");
    setSending(false);
    setStarted(true);
    opened.current = null;
    api()
      .call("account.login.start", { id: account.id, restart: true })
      .catch(() => {
        if (!live.current) return;
        setStarted(false);
        setStartError(CORE_UNREACHABLE);
      });
  };

  const send = async () => {
    const text = code.trim();
    if (!text || !prompt || sending) return;
    setSending(true);
    try {
      await api().call("account.login.input", { id: account.id, input: text });
      if (live.current) setCode("");
    } catch (err) {
      if (!live.current) return;
      setSending(false);
      setStartError(err instanceof Error && /expired/i.test(err.message) ? err.message : CORE_UNREACHABLE);
      setStarted(false);
    }
  };

  const cancel = () => {
    setStarted(false);
    setSending(false);
    setCode("");
    void run(api().call("account.login.cancel", { id: account.id }));
  };

  const waitingMessage =
    mine?.phase === "prompt" && !prompt && mine.message
      ? mine.message
      : "Starting the sign-in on Yo's computer…";
  return (
    <div data-testid="claude-signin">
      {hint && (
        <p className="mb-2.5 text-muted text-sm" data-testid="claude-signin-hint">
          {hint}
        </p>
      )}
      <Steps>
        <Step n={1} title="Start the sign-in" done={!!prompt || connected} testId="claude-step-1">
          Yo starts Claude's sign-in in its private workspace. It takes a few seconds, longer if Yo's computer
          is asleep.
          {!prompt && !connected && (
            <div className="mt-2.5 flex items-center gap-3">
              <Button
                variant="brand"
                size="sm"
                onClick={start}
                disabled={started && !error}
                data-testid="claude-start"
              >
                {started && !error ? <Spinner /> : null} {error ? "Try again" : "Sign in to Claude"}
              </Button>
              {started && !error && <span className="text-xs">{waitingMessage}</span>}
            </div>
          )}
        </Step>
        <Step n={2} title="Sign in on Claude's page" done={connected} testId="claude-step-2">
          {prompt?.url ? (
            <>
              {canAutoOpen()
                ? "Yo opened it in your browser. If it didn't, copy the link, or open it on your phone."
                : "Open it below, or copy the link to open it on your phone."}{" "}
              Sign in with the Claude account that has your plan, then click Authorize.
              <CopyBox command={prompt.url} testId="claude-login-url" shell={false} />
              <OpenSignInPage url={prompt.url} variant="secondary" className="mt-2" testId="claude-open-url">
                <ExternalLink className="size-3.5" /> Open sign-in page
              </OpenSignInPage>
            </>
          ) : (
            "Claude's link shows up here once the sign-in has started."
          )}
        </Step>
        <Step n={3} title="Paste the code Claude shows" done={connected} testId="claude-step-3">
          After you click Authorize, Claude shows a code. Copy it and paste it here.
          <p className="mt-1.5 font-medium text-fg-2" data-testid="claude-not-api-key">
            This is not an API key. It uses your Claude Pro or Max subscription, with no API charges.
          </p>
          <form
            className="mt-2.5 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Input
              autoComplete="off"
              spellCheck={false}
              aria-label="Code from Claude's page"
              placeholder="Paste the code here"
              value={code}
              disabled={!prompt || connected}
              onChange={(e) => setCode(e.target.value)}
              className="font-mono"
              data-testid="claude-code-input"
            />
            <Button
              type="submit"
              variant="brand"
              disabled={!prompt || !code.trim() || sending}
              data-testid="claude-code-submit"
            >
              {sending ? <Spinner /> : null} Connect
            </Button>
          </form>
        </Step>
      </Steps>
      <LiveStatus
        state={state}
        title={
          connected
            ? "Claude is connected"
            : error
              ? "That didn't work"
              : sending
                ? "Checking the code…"
                : prompt
                  ? "Waiting for the code from Claude's page…"
                  : started
                    ? "Starting the sign-in…"
                    : "Not connected yet"
        }
        detail={
          connected
            ? onComputer(account)
            : error
              ? error
              : prompt
                ? "Paste it in step 3 and press Connect."
                : started
                  ? null
                  : "Press Sign in to Claude in step 1."
        }
        action={
          started && !error && !connected ? (
            <Button variant="ghost" size="sm" onClick={cancel} data-testid="claude-cancel">
              Cancel
            </Button>
          ) : null
        }
      />
    </div>
  );
}

/* --------------------------------- Codex -------------------------------- */

/**
 * ChatGPT: Yo's computer runs Codex's own sign-in (core's `account.login.start`), the same on every edition. Codex
 * keeps the sign-in on Yo's computer. Yo never sees the password. On a Mac whose computer isn't set up yet, the
 * sign-in comes right after the setup chat.
 */
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
  const [again, setAgain] = useState(false);
  const needsComputer = useNeedsComputer(detection);
  const connected = !!account && isUsable(account);
  const showSteps = !connected || again;
  return (
    <div data-testid="connect-steps-codex">
      <Header provider="codex" title="Connect ChatGPT" sub={CODEX_SUB} />
      {showSteps && needsComputer ? (
        <SetUpComputerFirst provider="codex" onboarding={onboarding} onDone={onDone} />
      ) : showSteps && account ? (
        <CodexSignIn
          account={account}
          hint={codexSignInHint(detection)}
          again={connected}
          onSignedIn={() => setAgain(false)}
        />
      ) : (
        <LiveStatus
          state={connected ? "connected" : "idle"}
          title={connected ? "ChatGPT is connected" : "Not connected yet"}
          detail={
            connected
              ? account?.status === "authenticated"
                ? onComputer(account)
                : "Yo checks it when its computer starts."
              : "Yo has no ChatGPT account to connect. Restart Yo and try again."
          }
          action={
            connected && !again ? (
              <Button variant="ghost" size="sm" onClick={() => setAgain(true)} data-testid="connect-again">
                Sign in again
              </Button>
            ) : null
          }
        />
      )}
      <DoneRow onboarding={onboarding} connected={connected} onDone={onDone} provider="codex" />
    </div>
  );
}

const CODEX_SUB =
  "Uses your ChatGPT plan (Plus, Pro, Business or Enterprise). You sign in on ChatGPT's own page; Yo never sees your password. Your sign-in stays inside Yo's computer.";

type CodexWay = "page" | "code";

/**
 * The ChatGPT sign-in itself, for the walkthrough and the end of the setup chat. Two ways, both on Yo's computer:
 *  - "page" (the default): ChatGPT's sign-in page. Afterwards ChatGPT sends the browser to an address on Yo's
 *    computer that the browser can't open ("can't connect"); the person copies that address and pastes it here.
 *    Works for every ChatGPT plan, with no settings to change.
 *  - "code": a one-time code (device code). ChatGPT only takes it once "device code sign-in" is turned on in its
 *    security settings (a workspace admin allows it for work accounts), so the steps start there.
 * A computer from before the sign-in page sends a code instead: the code steps show then too.
 */
export function CodexSignIn({
  account,
  hint,
  again,
  onSignedIn,
}: {
  account: Account;
  hint?: string;
  /** Already connected and signing in again: only a sign-in finished here counts. */
  again?: boolean;
  onSignedIn?: () => void;
}) {
  const login = useApp((s) => s.logins[account.id]);
  const [way, setWay] = useState<CodexWay>("page");
  const [started, setStarted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Only news about the sign-in started here counts: not a link, error or "done" left from an earlier attempt.
  const before = useRef(login);
  const mine = started && login !== before.current ? login : undefined;
  const prompt = mine?.phase === "prompt" && (mine.url || mine.userCode) ? mine : null;
  // A one-time code arrived (asked for, or an older computer that has no sign-in page yet).
  const codeWay = way === "code" || !!prompt?.userCode;
  const pagePrompt = !codeWay && prompt?.url ? prompt : null;
  const error = startError ?? (mine?.phase === "error" ? (mine.message ?? "Sign-in failed.") : null);
  const [doneHere, setDoneHere] = useState(false);
  useEffect(() => {
    if (mine?.phase === "done") setDoneHere(true);
  }, [mine?.phase]);
  const connected = account.status === "authenticated" && (!again || doneHere);
  useEffect(() => {
    if (connected && doneHere) onSignedIn?.();
  }, [connected, doneHere]);
  useEffect(() => {
    if (prompt?.userCode) setWay("code");
  }, [prompt?.userCode]);

  useEffect(() => {
    if (!started) return;
    if (connected || mine?.phase === "done" || mine?.phase === "error") {
      setSending(false);
      // Signed in, or canceled elsewhere (e.g. in Settings): the steps start over.
      if (connected || mine?.phase === "done") setStarted(false);
    }
  }, [started, connected, mine?.phase]);

  // Open ChatGPT's page on the machine the person is at (this Mac in the desktop app), once per link. A plain
  // browser would block that as a pop-up: there "Open sign-in page" is a real link.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (prompt?.url && opened.current !== prompt.url && canAutoOpen()) {
      opened.current = prompt.url;
      openSignInPage(prompt.url);
    }
  }, [prompt?.url]);

  const start = (how: CodexWay = way) => {
    before.current = login;
    setStartError(null);
    setAddress("");
    setAddressError(null);
    setSending(false);
    setStarted(true);
    opened.current = null;
    api()
      .call("account.login.start", {
        id: account.id,
        restart: true,
        ...(how === "code" ? { method: "code" } : {}),
      })
      .catch(() => {
        if (!live.current) return;
        setStarted(false);
        setStartError(CORE_UNREACHABLE);
      });
  };

  const cancel = () => {
    setStarted(false);
    setSending(false);
    setAddress("");
    setAddressError(null);
    void run(api().call("account.login.cancel", { id: account.id }));
  };

  /** Switch between the sign-in page and a one-time code. A sign-in already running the other way stops. */
  const switchTo = (how: CodexWay) => {
    if (started && !error) cancel();
    setStartError(null);
    setWay(how);
  };

  const send = async () => {
    if (!pagePrompt?.url || sending) return;
    // Checked here first, for an instant plain answer; Yo's computer checks it again before using it.
    const check = parseCodexCallback(address, pagePrompt.url);
    if (!check.ok) return setAddressError(check.error);
    setAddressError(null);
    setSending(true);
    try {
      await api().call("account.login.input", { id: account.id, input: address.trim() });
      if (live.current) setAddress("");
    } catch (err) {
      if (!live.current) return;
      setSending(false);
      const msg = err instanceof Error ? err.message : "";
      // Yo's computer turned the address down (or the sign-in ended): its sentence says what to do.
      if (/address|sign-in/i.test(msg) && msg.length < 240) setAddressError(msg);
      else setStartError(CORE_UNREACHABLE);
    }
  };

  const state: LiveState = connected
    ? "connected"
    : error
      ? "error"
      : sending
        ? "checking"
        : started
          ? "waiting"
          : "idle";
  const waitingMessage =
    mine?.phase === "prompt" && !prompt && mine.message
      ? mine.message
      : "Starting the sign-in on Yo's computer…";
  const origin = codexCallbackOrigin(pagePrompt?.url);

  return (
    <div data-testid="codex-signin" data-way={codeWay ? "code" : "page"}>
      {hint && (
        <p className="mb-2.5 text-muted text-sm" data-testid="codex-signin-hint">
          {hint}
        </p>
      )}
      {codeWay ? (
        <Steps>
          <Step n={1} title="Turn on code sign-in in ChatGPT (once)" testId="codex-code-step-1">
            ChatGPT only accepts sign-in codes after you allow them. Open ChatGPT's security settings and turn
            on <span className="font-medium text-fg-2">“Enable device code authorization for Codex”</span>. If
            ChatGPT opens on another page, click Security on the left. On a work or school account, your
            ChatGPT admin turns it on for everyone.
            <div className="mt-2.5">
              <OpenSignInPage
                url={CHATGPT_SECURITY_SETTINGS_URL}
                variant="secondary"
                testId="codex-open-security"
              >
                <ExternalLink className="size-3.5" /> Open ChatGPT's security settings
              </OpenSignInPage>
            </div>
          </Step>
          <Step n={2} title="Get your code" done={!!prompt?.userCode || connected} testId="codex-code-step-2">
            {prompt?.userCode ? (
              <>
                Your one-time code. It works for 15 minutes.
                <CopyBox command={prompt.userCode} testId="codex-login-code" shell={false} />
              </>
            ) : (
              <>
                Yo asks ChatGPT for a one-time code in its private workspace. It takes a few seconds, longer
                if Yo's computer is asleep.
                {!connected && (
                  <div className="mt-2.5 flex items-center gap-3">
                    <Button
                      variant="brand"
                      size="sm"
                      onClick={() => start("code")}
                      disabled={started && !error}
                      data-testid="codex-code-start"
                    >
                      {started && !error ? <Spinner /> : null} {error ? "Get a new code" : "Get my code"}
                    </Button>
                    {started && !error && <span className="text-xs">{waitingMessage}</span>}
                  </div>
                )}
              </>
            )}
          </Step>
          <Step n={3} title="Enter the code on ChatGPT's page" done={connected} testId="codex-code-step-3">
            {prompt?.url && prompt.userCode ? (
              <>
                {canAutoOpen()
                  ? "Yo opened it in your browser. If it didn't, copy the link, or open it on your phone."
                  : "Open it below, or copy the link to open it on your phone."}{" "}
                Sign in with the ChatGPT account that has your plan, type the code and click Continue. Yo
                connects on its own.
                <CopyBox command={prompt.url} testId="codex-login-url" shell={false} />
                <OpenSignInPage url={prompt.url} variant="secondary" className="mt-2" testId="codex-open-url">
                  <ExternalLink className="size-3.5" /> Open sign-in page
                </OpenSignInPage>
                <p className="mt-2.5 text-xs" data-testid="codex-code-off-help">
                  Does ChatGPT's page say code sign-in is turned off, or to ask your admin? Do step 1, then
                  enter the same code again.
                </p>
              </>
            ) : (
              "ChatGPT's sign-in page shows up here with your code. Yo connects on its own once you enter it."
            )}
          </Step>
        </Steps>
      ) : (
        <Steps>
          <Step n={1} title="Start the sign-in" done={!!pagePrompt || connected} testId="codex-step-1">
            Yo starts ChatGPT's sign-in in its private workspace. It takes a few seconds, longer if Yo's
            computer is asleep.
            {!pagePrompt && !connected && (
              <div className="mt-2.5 flex items-center gap-3">
                <Button
                  variant="brand"
                  size="sm"
                  onClick={() => start("page")}
                  disabled={started && !error}
                  data-testid="codex-start"
                >
                  {started && !error ? <Spinner /> : null} {error ? "Try again" : "Sign in to ChatGPT"}
                </Button>
                {started && !error && <span className="text-xs">{waitingMessage}</span>}
              </div>
            )}
          </Step>
          <Step n={2} title="Sign in on ChatGPT's page" done={connected} testId="codex-step-2">
            {pagePrompt?.url ? (
              <>
                {canAutoOpen()
                  ? "Yo opened it in your browser. If it didn't, copy the link, or open it on your phone."
                  : "Open it below, or copy the link to open it on your phone."}{" "}
                Sign in with the ChatGPT account that has your plan, then click Continue.
                <CopyBox command={pagePrompt.url} testId="codex-login-url" shell={false} />
                <OpenSignInPage
                  url={pagePrompt.url}
                  variant="secondary"
                  className="mt-2"
                  testId="codex-open-url"
                >
                  <ExternalLink className="size-3.5" /> Open sign-in page
                </OpenSignInPage>
              </>
            ) : (
              "ChatGPT's link shows up here once the sign-in has started."
            )}
          </Step>
          <Step n={3} title="Copy the address your browser lands on" done={connected} testId="codex-step-3">
            After you click Continue, your browser shows a page that says it can't connect (for example “This
            site can't be reached”). That's expected. Click the address bar at the top of that page, copy the
            whole address and paste it here. It starts with{" "}
            <span className="font-medium font-mono text-fg-2" data-testid="codex-callback-origin">
              {origin}
            </span>
            .
            <form
              className="mt-2.5 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <Input
                autoComplete="off"
                spellCheck={false}
                aria-label="Address from your browser"
                placeholder={`Paste the address here (${origin}/…)`}
                value={address}
                disabled={!pagePrompt || connected}
                onChange={(e) => {
                  setAddress(e.target.value);
                  setAddressError(null);
                }}
                className="font-mono"
                data-testid="codex-address-input"
              />
              <Button
                type="submit"
                variant="brand"
                disabled={!pagePrompt || !address.trim() || sending}
                data-testid="codex-address-submit"
              >
                {sending ? <Spinner /> : null} Connect
              </Button>
            </form>
            {addressError && (
              <p role="alert" className="mt-2 text-danger text-sm" data-testid="codex-address-error">
                {addressError}
              </p>
            )}
          </Step>
        </Steps>
      )}
      <LiveStatus
        state={state}
        title={
          connected
            ? "ChatGPT is connected"
            : error
              ? "That didn't work"
              : sending
                ? "Checking the sign-in…"
                : prompt
                  ? codeWay
                    ? "Waiting for you to enter the code…"
                    : "Waiting for the address from your browser…"
                  : started
                    ? codeWay
                      ? "Getting your code…"
                      : "Starting the sign-in…"
                    : "Not connected yet"
        }
        detail={
          connected
            ? onComputer(account)
            : error
              ? `${error} ${codeWay ? "Check step 1, then press Get a new code." : "Press Try again in step 1."}`
              : prompt
                ? codeWay
                  ? "This turns green by itself once ChatGPT accepts the code."
                  : "Paste it in step 3 and press Connect."
                : started
                  ? null
                  : codeWay
                    ? "Do step 1 once, then press Get my code."
                    : "Press Sign in to ChatGPT in step 1."
        }
        action={
          started && !error && !connected ? (
            <Button variant="ghost" size="sm" onClick={cancel} data-testid="codex-cancel">
              Cancel
            </Button>
          ) : null
        }
      />
      {!connected && (
        <div className="mt-3 text-muted text-sm">
          {codeWay ? (
            <>
              Rather not change a ChatGPT setting?{" "}
              <button
                type="button"
                onClick={() => switchTo("page")}
                data-testid="codex-use-page"
                className="text-fg-2 underline underline-offset-2 hover:text-fg"
              >
                Sign in on ChatGPT's page instead
              </button>
            </>
          ) : (
            <>
              Can't copy the address?{" "}
              <button
                type="button"
                onClick={() => switchTo("code")}
                data-testid="codex-use-code"
                className="text-fg-2 underline underline-offset-2 hover:text-fg"
              >
                Sign in with a one-time code instead
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* --------------------------------- Grok --------------------------------- */

/**
 * Grok: Yo's computer runs `grok login --device-auth` (core's `account.login.start`) and pushes the link and code
 * (`account.login`); the user confirms them in any browser and the account turns green on its own. Nothing runs in
 * Terminal, so it's the same for the owner and for a friend whose Mac app talks to Yo on someone else's PC.
 */
function GrokSteps({
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
  const login = useApp((s) => (account ? s.logins[account.id] : undefined));
  const usableNow = !!account && isUsable(account);
  const [started, setStarted] = useState(false);
  const [again, setAgain] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [key, setKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Only news about the sign-in started here counts: not a link, error or "done" left from an earlier attempt.
  const before = useRef(login);
  const mine = started && login !== before.current ? login : undefined;
  const prompt = mine?.phase === "prompt" && (mine.url || mine.userCode) ? mine : null;
  const error = startError ?? (mine?.phase === "error" ? (mine.message ?? "Sign-in failed.") : null);
  // While a new sign-in runs, core marks the account "signing_in", so it isn't usable (green) until it's done.
  const connected = usableNow;
  const state: LiveState = connected ? "connected" : error ? "error" : started ? "waiting" : "idle";

  useEffect(() => {
    if (!started) return;
    // Signed in: the steps turn green ("Sign in again" starts over).
    if (account?.status === "authenticated") {
      setStarted(false);
      setAgain(false);
    }
    // Canceled (e.g. in Settings): back to the start.
    else if (mine?.phase === "done") setStarted(false);
  }, [started, account?.status, mine?.phase]);

  // Open the sign-in page on the machine the user is at (this Mac in the desktop app), once per link. A plain
  // browser would block that as a pop-up: there "Open sign-in page" is a real link.
  const opened = useRef<string | null>(null);
  const openLink = openSignInPage;
  useEffect(() => {
    if (prompt?.url && opened.current !== prompt.url && canAutoOpen()) {
      opened.current = prompt.url;
      openLink(prompt.url);
    }
  }, [prompt?.url]);

  const start = () => {
    if (!account) return;
    before.current = login;
    setStartError(null);
    setStarted(true);
    opened.current = null;
    api()
      .call("account.login.start", { id: account.id, restart: true })
      .catch(() => {
        if (!live.current) return;
        setStarted(false);
        setStartError(CORE_UNREACHABLE);
      });
  };

  const saveKey = async () => {
    if (!account || !key.trim() || savingKey) return;
    setSavingKey(true);
    try {
      await api().call("account.setApiKey", { id: account.id, key: key.trim() });
      if (!live.current) return;
      setKey("");
      setShowKey(false);
    } catch {
      if (live.current) setStartError(CORE_UNREACHABLE);
    } finally {
      if (live.current) setSavingKey(false);
    }
  };

  const showSteps = !connected || again;
  const waitingMessage =
    mine?.phase === "prompt" && !prompt && mine.message
      ? mine.message
      : "Starting the sign-in on Yo's computer…";
  return (
    <div data-testid="connect-steps-grok">
      <Header
        provider="grok"
        title="Connect Grok"
        sub="Uses your Grok plan (SuperGrok or X Premium). You sign in once with a code, in any browser."
      />
      {showSteps && (
        <>
          <p className="mb-2.5 text-muted text-sm" data-testid="grok-signin-hint">
            {grokSignInHint(detection)}
          </p>
          <Steps>
            <Step n={1} title="Get a sign-in code" done={!!prompt} testId="grok-step-1">
              Yo asks Grok for a one-time code in its private workspace. It takes a few seconds, longer if
              Yo's computer is asleep.
              {!prompt && (
                <div className="mt-2.5 flex items-center gap-3">
                  <Button
                    variant="brand"
                    size="sm"
                    onClick={start}
                    disabled={!account || (started && !error)}
                    data-testid="grok-start"
                  >
                    {started && !error ? <Spinner /> : null} {error ? "Try again" : "Get my code"}
                  </Button>
                  {started && !error && <span className="text-xs">{waitingMessage}</span>}
                </div>
              )}
            </Step>
            <Step n={2} title="Open the sign-in page" testId="grok-step-2">
              {prompt?.url ? (
                <>
                  {canAutoOpen()
                    ? "Yo opened it in your browser. If it didn't, copy the link, or open it on your phone."
                    : "Open it below, or copy the link to open it on your phone."}{" "}
                  Sign in with the X or Grok account that has your plan.
                  <CopyBox command={prompt.url} testId="grok-login-url" shell={false} />
                  <OpenSignInPage
                    url={prompt.url}
                    variant="secondary"
                    className="mt-2"
                    testId="grok-open-url"
                  >
                    <ExternalLink className="size-3.5" /> Open sign-in page
                  </OpenSignInPage>
                </>
              ) : (
                "The link shows up here once you have a code."
              )}
            </Step>
            <Step n={3} title="Confirm the code" done={connected} testId="grok-step-3">
              {prompt?.userCode ? (
                <>
                  Check that the page shows this code, then approve. Yo connects on its own.
                  <CopyBox command={prompt.userCode} testId="grok-login-code" shell={false} />
                </>
              ) : (
                "Check that the page shows the same code as Yo, then approve. Yo connects on its own."
              )}
            </Step>
          </Steps>
        </>
      )}
      <LiveStatus
        state={state}
        title={
          connected
            ? "Grok is connected"
            : error
              ? "That didn't work"
              : prompt
                ? "Waiting for you to confirm the code…"
                : started
                  ? "Getting your code…"
                  : "Not connected yet"
        }
        detail={
          connected
            ? account?.status === "authenticated"
              ? onComputer(account)
              : "Yo checks it when its computer starts."
            : error
              ? `${error} Press Try again in step 1.`
              : prompt
                ? "This turns green by itself once you approve."
                : started
                  ? null
                  : "Press Get my code in step 1."
        }
        action={
          connected && !again ? (
            <Button variant="ghost" size="sm" onClick={() => setAgain(true)} data-testid="connect-again">
              Sign in again
            </Button>
          ) : null
        }
      />
      {account && showSteps && (
        <div className="mt-3 text-muted text-sm">
          {showKey ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void saveKey();
              }}
            >
              <span>
                An xAI API key works too. It's billed by xAI per use, separately from your Grok plan. Yo keeps
                this key in its secret storage (the Keychain on a Mac).
              </span>
              <div className="flex gap-2">
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="xAI API key"
                  placeholder="xai-…"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  data-testid="grok-api-key-input"
                />
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={!key.trim() || savingKey}
                  data-testid="grok-api-key-save"
                >
                  {savingKey ? <Spinner /> : null} Use key
                </Button>
              </div>
            </form>
          ) : (
            <>
              Have an xAI API key instead?{" "}
              <button
                type="button"
                onClick={() => setShowKey(true)}
                data-testid="grok-use-api-key"
                className="text-fg-2 underline underline-offset-2 hover:text-fg"
              >
                Use the key
              </button>
            </>
          )}
        </div>
      )}
      <DoneRow onboarding={onboarding} connected={connected} onDone={onDone} provider="grok" />
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
