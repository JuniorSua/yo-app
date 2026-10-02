import type { Account } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { accountDetail, accountIdentity, planTier } from "./accounts";

const acc = (p: Partial<Account>): Account => ({
  id: "acc_1",
  provider: "claude",
  label: "Claude",
  status: "authenticated",
  email: null,
  plan: null,
  message: null,
  isDefault: true,
  models: [],
  rateLimit: null,
  createdAt: 0,
  ...p,
});

describe("account presentation", () => {
  it("hides the technical token fallback instead of repeating the provider", () => {
    const a = acc({ plan: "Claude subscription (token)" });
    expect(planTier(a)).toBeNull();
    expect(accountDetail(a)).toBe("Connected");
    expect(accountIdentity(a)).toBeNull();
  });

  it("shows a known plan without the provider name", () => {
    expect(accountDetail(acc({ plan: "Claude Max" }))).toBe("Max · Connected");
    expect(accountDetail(acc({ provider: "codex", label: "ChatGPT", plan: "ChatGPT Plus" }))).toBe(
      "Plus · Connected",
    );
  });

  it("never turns unknown values into a plan", () => {
    expect(accountDetail(acc({ plan: "Claude Mystery" }))).toBe("Connected");
    expect(accountDetail(acc({ provider: "codex", plan: "ChatGPT (me@example.com)" }))).toBe("Connected");
    expect(accountDetail(acc({ provider: "grok", plan: "Grok account" }))).toBe("Connected");
  });

  it("labels API keys as API access, not a subscription", () => {
    expect(accountDetail(acc({ plan: "Anthropic API key" }))).toBe("API access · Connected");
    expect(accountDetail(acc({ provider: "grok", plan: "xAI API key" }))).toBe("API access · Connected");
  });

  it("reports the real state when not connected", () => {
    expect(accountDetail(acc({ status: "unauthenticated", plan: "Claude Max" }))).toBe("Not connected");
    expect(accountDetail(acc({ status: "error" }))).toBe("Error");
    expect(accountDetail(acc({ status: "unknown" }))).toBe("Status unknown");
    expect(accountDetail(acc({ status: "signing_in" }))).toBe("Signing in…");
  });

  it("keeps multiple accounts distinguishable by email or custom name", () => {
    expect(accountIdentity(acc({ label: "Claude 2" }))).toBe("Claude 2");
    expect(accountIdentity(acc({ email: "me@example.com" }))).toBe("me@example.com");
    expect(accountIdentity(acc({ label: "Work", email: "me@work.example" }))).toBe("Work · me@work.example");
  });
});
