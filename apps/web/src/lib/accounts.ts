import type { Account, ProviderKind } from "@yo/contracts";

/**
 * Presentation-only account wording. Stored accounts keep their raw `plan`/`label` values (adapters
 * sometimes put technical strings there, e.g. "Claude subscription (token)"); the UI shows the provider,
 * an honest connection state, a plan tier only when it's a known one, and the user's own identity text.
 */

export const PROVIDER_NAME: Record<ProviderKind, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  grok: "Grok",
};

/** Plan tiers the adapters report, keyed by provider (see ClaudeAdapter/CodexAdapter planLabel). */
const KNOWN_TIERS: Record<ProviderKind, string[]> = {
  claude: ["Max", "Pro", "Team", "Enterprise"],
  codex: ["Free", "Go", "Plus", "Pro", "Pro Lite", "Pro Max", "Team", "Business", "Enterprise", "Edu"],
  grok: [],
};

const API_KEY_PLANS = ["Anthropic API key", "OpenAI API key", "xAI API key"];

/** "Claude Max" → "Max"; anything technical or unrecognized → null (never a billing claim). */
export function planTier(a: Pick<Account, "provider" | "plan">): string | null {
  const plan = a.plan?.trim();
  if (!plan) return null;
  const name = PROVIDER_NAME[a.provider];
  const bare = plan.startsWith(`${name} `) ? plan.slice(name.length + 1) : plan;
  return KNOWN_TIERS[a.provider].find((t) => t.toLowerCase() === bare.toLowerCase()) ?? null;
}

export function usesApiKey(a: Pick<Account, "plan">): boolean {
  return !!a.plan && API_KEY_PLANS.includes(a.plan.trim());
}

/** Short state, e.g. "Connected", "Not connected", "Signing in…". */
export function accountState(a: Pick<Account, "status">): string {
  switch (a.status) {
    case "authenticated":
      return "Connected";
    case "signing_in":
      return "Signing in…";
    case "unverified":
      return "Connected · not checked yet";
    case "unauthenticated":
      return "Not connected";
    case "not_installed":
      return "Not installed";
    case "error":
      return "Error";
    default:
      return "Status unknown";
  }
}

/** Secondary line: "Max · Connected", "API access · Connected", "Not connected", … */
export function accountDetail(a: Pick<Account, "provider" | "plan" | "status">): string {
  if (a.status !== "authenticated") return accountState(a);
  const tier = planTier(a);
  const kind = usesApiKey(a) ? "API access" : null;
  return [tier, kind, "Connected"].filter(Boolean).join(" · ");
}

/** The user's own identity text for telling accounts apart (email, or a name that isn't just the provider). */
export function accountIdentity(a: Pick<Account, "provider" | "label" | "email">): string | null {
  const label = a.label.trim();
  const custom = label && label !== PROVIDER_NAME[a.provider] ? label : null;
  if (a.email && custom && custom !== a.email) return `${custom} · ${a.email}`;
  return a.email ?? custom;
}

/** Signed in, or saved by the "Connect your model" walkthrough and waiting for Yo's computer to check it. */
export function isUsable(a: Pick<Account, "status">): boolean {
  return a.status === "authenticated" || a.status === "unverified";
}
