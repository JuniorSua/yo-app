import type { Account, AgentView } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { accountFor, applyAccountUpdate, offeredAccounts } from "./app";

const acc = (over: Partial<Account>): Account => ({
  id: "acc_claude",
  provider: "claude",
  label: "Claude",
  email: null,
  plan: null,
  status: "authenticated",
  message: null,
  isDefault: false,
  models: [],
  rateLimit: null,
  createdAt: 0,
  ...over,
});

const agent = (accountId: string | null) => ({ id: "agt_1", accountId }) as AgentView;

const claude = acc({ id: "acc_claude", isDefault: true });
const codex = acc({ id: "acc_codex", provider: "codex", label: "ChatGPT" });
const grok = acc({ id: "acc_grok", provider: "grok", label: "Grok" });

describe("accounts of providers Yo doesn't offer (e.g. Grok from an older core)", () => {
  it("never reach the UI", () => {
    expect(offeredAccounts([claude, grok, codex]).map((a) => a.id)).toEqual(["acc_claude", "acc_codex"]);
  });

  it("are dropped, not added, when a push updates them", () => {
    expect(applyAccountUpdate([claude], grok)).toEqual([claude]);
    expect(applyAccountUpdate([claude, grok], { ...grok, status: "error" })).toEqual([claude]);
    expect(applyAccountUpdate([claude], codex).map((a) => a.id)).toEqual(["acc_claude", "acc_codex"]);
  });

  it("leave an agent pinned to one on the default account", () => {
    const shown = offeredAccounts([claude, codex, grok]);
    expect(accountFor(agent("acc_grok"), shown)?.id).toBe("acc_claude");
  });

  it("show 'Choose model' (no account) when the old default was the hidden one", () => {
    const shown = offeredAccounts([
      { ...claude, isDefault: false },
      { ...grok, isDefault: true },
    ]);
    expect(accountFor(agent("acc_grok"), shown)).toBeUndefined();
    expect(accountFor(agent(null), shown)).toBeUndefined();
  });
});
