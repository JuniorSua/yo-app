/**
 * Mock of the "Connect your model" walkthrough's host side (`connect.*`).
 *
 * `&mockConnect=` picks what the walkthrough finds on first run:
 *   none       (default) nothing installed, nothing connected
 *   cli        Claude Code and Codex are installed on this Mac (and signed in with the user's own logins)
 *   computer   Yo's computer is already running and Claude is signed in on it ("Already connected")
 *   codexError the dedicated Codex login turns out unusable (shows the error and the way out)
 *
 * The dedicated Codex login "appears" after a few polls, or right away via the test hook
 * `__yoMock.connect.finishCodexLogin()`. With `&fast=1` (E2E) it only appears through the hook.
 */
import { type Account, type ComputerOverview, type ConnectDetection, parseClaudeToken } from "@yo/contracts";

export type MockConnectScenario = "none" | "cli" | "computer" | "codexError";

export function mockConnectScenario(q: URLSearchParams): MockConnectScenario {
  const v = q.get("mockConnect");
  return v === "cli" || v === "computer" || v === "codexError" ? v : "none";
}

/** First run: start from what the scenario says is already connected. */
export function applyConnectScenario(
  s: { accounts: Account[]; computer: ComputerOverview },
  scenario: MockConnectScenario,
) {
  for (const a of s.accounts) {
    if (a.provider !== "claude" && a.provider !== "codex") continue;
    const on = scenario === "computer" && a.provider === "claude";
    Object.assign(a, on ? { status: "authenticated", plan: "Max", message: null } : NOT_CONNECTED);
  }
  if (scenario === "computer")
    Object.assign(s.computer, {
      runtime: "running",
      connected: true,
      imageReady: true,
      memMB: 1180,
      message: null,
    } satisfies Partial<ComputerOverview>);
}

const NOT_CONNECTED = { status: "unauthenticated", plan: null, email: null, message: null } as const;

/** Save a login like core does: "unverified" until Yo's computer can check it. */
export function markConnected(
  accounts: Account[],
  provider: "claude" | "codex",
  computerOn: boolean,
  accountId?: string,
): Account | null {
  const of = accounts.filter((a) => a.provider === provider);
  const a = accountId ? of.find((x) => x.id === accountId) : (of.find((x) => x.isDefault) ?? of[0]);
  if (!a) return null;
  Object.assign(
    a,
    computerOn
      ? { status: "authenticated", plan: provider === "claude" ? "Max" : "ChatGPT Plus", message: null }
      : {
          status: "unverified",
          plan: null,
          email: null,
          message: "Connected. Yo will check it when its computer starts.",
        },
  );
  return a;
}

/** Polls of `connect.codexImport` before the mock login appears on its own (not with &fast=1). */
const AUTO_POLLS = 4;

export class MockConnect {
  private codexPolls = 0;
  private codexDone = false;
  /** Test hook: what the last `connect.claudeToken` saved (never shown in the UI). */
  savedClaudeToken: string | null = null;

  constructor(
    readonly scenario: MockConnectScenario,
    private auto: boolean,
    /** Save a login: mark the account connected and push it, like core does. */
    private connect: (provider: "claude" | "codex", accountId?: string) => Account | null,
  ) {}

  /** Test hook: the user finished `codex login` in Terminal. */
  finishCodexLogin() {
    this.codexDone = true;
  }

  detect(): ConnectDetection {
    const cli = this.scenario === "cli";
    return {
      host: { platform: "darwin", name: "This Mac" },
      claude: { installed: cli, signedIn: cli ? true : null },
      codex: { installed: cli, signedIn: cli, yoLogin: this.codexDone },
    };
  }

  claudeToken(
    token: string,
    accountId?: string,
  ): { ok: true; account: Account } | { ok: false; error: string } {
    const check = parseClaudeToken(token);
    if (!check.ok) return check;
    const account = this.connect("claude", accountId);
    if (!account)
      return { ok: false, error: "Yo has no Claude account to connect. Restart Yo and try again." };
    this.savedClaudeToken = check.token;
    return { ok: true, account };
  }

  codexImport(
    accountId?: string,
  ): { state: "waiting" } | { state: "connected"; account: Account } | { state: "error"; error: string } {
    this.codexPolls++;
    if (this.auto && this.codexPolls >= AUTO_POLLS) this.codexDone = true;
    if (!this.codexDone) return { state: "waiting" };
    if (this.scenario === "codexError") {
      this.codexDone = false;
      this.codexPolls = 0;
      return {
        state: "error",
        error:
          "Codex finished, but Yo can't use what it saved. Run the sign-in command again and finish signing in with ChatGPT in the browser.",
      };
    }
    const account = this.connect("codex", accountId);
    this.codexDone = false;
    if (!account)
      return { state: "error", error: "Yo has no ChatGPT account to connect. Restart Yo and try again." };
    return { state: "connected", account };
  }
}
