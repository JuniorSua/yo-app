/**
 * Mock 1Password (`onePassword.*`, Settings → Accounts → 1Password).
 *
 *   &mockOnePassword=off        not connected (default)
 *   &mockOnePassword=connected  connected to a "Yo" vault, with a recent sign-in
 *   &mockOnePassword=error      connected, but the token was revoked
 *
 * A token is accepted when it starts with "ops_"; one containing "bad" is turned down like a revoked token.
 * Chat: "sign in to github" (or "log in to …") runs a 1Password sign-in with its approval card.
 */
import type { OnePasswordStatus, OnePasswordUse } from "@yo/contracts";

export type MockOnePasswordScenario = "off" | "connected" | "error";

export function mockOnePasswordScenario(q: URLSearchParams): MockOnePasswordScenario {
  const v = q.get("mockOnePassword");
  return v === "connected" || v === "error" ? v : "off";
}

const VAULTS = [{ id: "vlt_yo", title: "Yo", items: 12 }];
const BAD_TOKEN =
  "1Password turned the token down. It may have been revoked, or copied incompletely. Make a new service account token and connect again.";

export class MockOnePassword {
  private s: OnePasswordStatus = {
    connected: false,
    state: "off",
    vaults: [],
    checkedAt: null,
    lastError: null,
    recent: [],
  };
  private revoked = false;

  constructor(scenario: MockOnePasswordScenario) {
    if (scenario === "off") return;
    this.s = {
      connected: true,
      state: scenario === "error" ? "error" : "ok",
      vaults: VAULTS,
      checkedAt: Date.now() - 3 * 60_000,
      lastError: scenario === "error" ? BAD_TOKEN : null,
      recent: [
        {
          at: Date.now() - 2 * 3_600_000,
          item: "GitHub",
          site: "github.com",
          fields: ["username", "password"],
          agentName: "Yo",
        },
      ],
    };
    this.revoked = scenario === "error";
  }

  get connected(): boolean {
    return this.s.connected && this.s.state !== "error";
  }

  status(): OnePasswordStatus {
    return structuredClone(this.s);
  }

  async connect(token: string): Promise<OnePasswordStatus> {
    const t = token.trim();
    await new Promise((r) => setTimeout(r, 400));
    if (!/^ops_\S{8,}$/.test(t))
      throw new Error(
        "That doesn't look like a service account token. It starts with ops_ and is shown once, when the service account is made.",
      );
    if (t.includes("bad")) throw new Error(BAD_TOKEN);
    this.revoked = false;
    this.s = {
      ...this.s,
      connected: true,
      state: "ok",
      vaults: VAULTS,
      checkedAt: Date.now(),
      lastError: null,
    };
    return this.status();
  }

  async test(): Promise<OnePasswordStatus> {
    await new Promise((r) => setTimeout(r, 300));
    if (!this.s.connected) return this.status();
    this.s = this.revoked
      ? { ...this.s, state: "error", lastError: BAD_TOKEN, checkedAt: Date.now() }
      : { ...this.s, state: "ok", lastError: null, checkedAt: Date.now(), vaults: VAULTS };
    return this.status();
  }

  disconnect(): OnePasswordStatus {
    this.revoked = false;
    this.s = { connected: false, state: "off", vaults: [], checkedAt: null, lastError: null, recent: [] };
    return this.status();
  }

  recordUse(use: OnePasswordUse) {
    this.s = { ...this.s, recent: [use, ...this.s.recent].slice(0, 5) };
  }
}
