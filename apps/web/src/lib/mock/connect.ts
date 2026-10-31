/**
 * Mock of the "Connect your model" walkthrough's host side (`connect.detect`).
 *
 * `&mockConnect=` picks what the walkthrough finds on first run:
 *   none       (default) nothing installed, nothing connected
 *   cli        Claude Code and Codex are installed on this Mac (and signed in with the user's own logins)
 *   computer   Yo's computer is already running and Claude is signed in on it ("Already connected")
 *
 * `&mockHost=pc` makes core run on a Linux PC ("ProDesktop") instead of this Mac, like a friend using the Mac
 * app against the owner's Home PC.
 *
 * Nothing is imported: Claude, ChatGPT and Grok all sign in on Yo's computer (`account.login.*`, in ./index.ts).
 */
import type { Account, ComputerOverview, ConnectDetection } from "@yo/contracts";

export type MockConnectScenario = "none" | "cli" | "computer";

export function mockConnectHost(q: URLSearchParams): ConnectDetection["host"] {
  return q.get("mockHost") === "pc"
    ? { platform: "linux", name: "ProDesktop" }
    : { platform: "darwin", name: "This Mac" };
}

export function mockConnectScenario(q: URLSearchParams): MockConnectScenario {
  const v = q.get("mockConnect");
  return v === "cli" || v === "computer" ? v : "none";
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

export class MockConnect {
  constructor(
    readonly scenario: MockConnectScenario,
    private host: ConnectDetection["host"] = { platform: "darwin", name: "This Mac" },
  ) {}

  detect(): ConnectDetection {
    const cli = this.scenario === "cli";
    return {
      host: this.host,
      claude: { installed: cli, signedIn: cli ? true : null },
      codex: { installed: cli, signedIn: cli },
    };
  }
}
